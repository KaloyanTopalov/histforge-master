import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import {
  getLlmProvider,
  type ChatMessage,
  type ChatOpts,
  type LlmProviderName,
} from "@/lib/llm";
import { getTtsProvider, type TtsProvider } from "@/lib/tts";
import { getImageProvider, type ImageProvider } from "@/lib/image";
import { getVideoProvider, type VideoProvider } from "@/lib/video";
import { createPromptModerator, type PromptModerator } from "@/lib/moderator";
import * as videosRepo from "@/lib/repos/videos";
import * as stepsRepo from "@/lib/repos/steps";
import * as videoLifecycle from "@/lib/lifecycle/video";
import { materializeStepList } from "@/lib/workflows";
import type { WorkflowSnapshot } from "@/types";
import {
  deleteRequestedSource,
  startCancellationWatcher,
  type CancellationSource,
} from "./cancellation";
import { runStep } from "./run-step";

/**
 * Cross-cutting dependencies the orchestrator resolves once per pipeline
 * run and threads into each step via `Step.run(videoId, ctx)`. `log` is
 * per-step (bound to `step.name`) so steps don't have to repeat their own
 * name on every log call.
 *
 * Step-specific deps that are *not* cross-cutting (aeneas AlignOpts,
 * ffmpeg exec) stay on each step's own *Deps shape and keep their
 * existing defaults.
 */
export interface StepContext {
  db: DatabaseType;
  projectsDir: string;
  promptsDir: string;
  log: (message: string) => void;
  chat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  visualPromptChat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  /**
   * Bounded-parallelism cap for step 09's batched LLM calls. Resolved
   * per-purpose from the snapshot-pinned `script_llm_provider` —
   * OpenRouter (HTTP-bound) gets a wider knob than Claude CLI
   * (process-spawn-bound). Independent of K (the batch size).
   */
  visualPromptsConcurrency: number;
  ttsProvider: TtsProvider;
  imageProvider: ImageProvider;
  videoProvider: VideoProvider;
  /**
   * Pinned per-video workflow snapshot. Read once per pipeline run by
   * `resolveDeps` and surfaced here so steps can branch on provider
   * without re-reading `videos.workflow_snapshot`. The chunker is the
   * first consumer (Phase 2 makes the hook clip-seconds provider-aware).
   */
  snapshot: WorkflowSnapshot;
  /**
   * Cancellation signal. The orchestrator owns one AbortController per
   * pipeline run; a supervisor watcher flips it when the user requests
   * deletion (`videos.delete_requested = 1`). Long-running steps must
   * thread this into provider opts so an in-flight fetch / spawn aborts
   * promptly instead of running to completion.
   */
  signal: AbortSignal;
}

/**
 * Sentinel a step returns when it's choosing to yield back to the
 * orchestrator instead of failing or completing. Used by the Google Flow
 * step when every account is in cooldown. The orchestrator stamps
 * `videos.deferred_until = retryAfter` (unix seconds), leaves the step
 * row in `running`, and returns — the runner's defer filter skips the
 * video until the timestamp passes, then re-enters the step which is
 * expected to be idempotent.
 */
export interface DeferSignal {
  deferred: true;
  retryAfter: number;
}

/**
 * Step taxonomy. `module` is the user-facing classification surfaced by
 * the workflow editor (Phase 2): `script` steps are user-authored prose
 * generation, `tts`/`image`/`video` are provider-driven media steps,
 * and `glue` is everything the system always inserts (assemble, align,
 * chunk, render, cleanup). `music_video` is the music-video-kind backbone
 * (loop image, loop clip, thumbnail, music gen/download, mux) — the
 * `materializeStepList` switch on `snapshot.kind` keeps these isolated
 * from the narrative pipeline; `workflows-schema.ts` filters its
 * SCRIPT_STEP_NAMES enum on `module === "script"` so this tag never
 * leaks into the editor's script-step picker.
 */
export type ModuleId = "script" | "tts" | "image" | "video" | "music_video";

/**
 * `for_each` signals a step with multi-output behavior keyed off a
 * sub-iteration: `chapters` for `write_chapters`, `chunks` for the
 * enrich/image/video steps. Read-only metadata in Phase 1; consumed by
 * Phase 2's editor as a UI badge.
 */
export type ForEach = "chapters" | "chunks";

/**
 * One pipeline step. Steps are stateless modules; the orchestrator owns
 * step row transitions, cleanup, and pause/resume. A step's `run` reads
 * inputs from disk and writes outputs to disk; on success it returns
 * normally, on failure it throws (and the orchestrator handles the rest).
 * A step may also return a `DeferSignal` to yield without success or
 * failure — the orchestrator treats that as "come back later".
 *
 * `outputs` declares the paths (relative to `projects/<video_id>/`) the
 * default cleanup deletes when the step throws. Empty array means either
 * there's nothing to delete or the step provides its own `cleanup` hook.
 *
 * `cleanup` is optional. The orchestrator falls back to deleting the
 * step's `outputs` paths when `cleanup` is not defined; only steps with
 * non-trivial output layouts need to override.
 *
 * Metadata fields (`module`, `label`, `description`, `inputs`, `produces`,
 * `for_each`) are declared on every production step per the Phase 1 table;
 * they're optional on the type so test fixtures can stay minimal. Phase 2's
 * editor reads `module`/`label`/`description`/`for_each`; Phase 3's
 * input-availability validator reads `inputs`/`produces`. `produces`
 * defaults to `outputs` at the consumer when omitted.
 */
export interface Step {
  name: string;
  module: ModuleId | "glue";
  label: string;
  description: string;
  inputs?: readonly string[];
  outputs: readonly string[];
  produces?: readonly string[];
  for_each?: ForEach;
  run(videoId: string, ctx: StepContext): Promise<void | DeferSignal>;
  cleanup?(videoId: string, ctx: StepContext): Promise<void>;
}

/**
 * Dependencies injected into runPipeline. Everything is optional — the
 * orchestrator fills defaults via `resolveDeps` plus a per-run setup
 * block in `runPipeline` that builds the moderator and the
 * moderator-dependent image/video providers. Tests pass only what they
 * need (typically `db`, `steps`, `projectsDir`); fake steps don't
 * consume ctx fields, so the defaults are harmless.
 *
 * Per-step output paths live on `Step.outputs` (Phase 4), so there is no
 * separate `stepOutputs` dep.
 *
 * `log` is deliberately not here — it's per-step (bound to `step.name`)
 * and built inside the loop.
 */
export type RunPipelineDeps = {
  steps?: readonly Step[];
  /**
   * Cancellation source override. Production uses
   * `deleteRequestedSource(db, videoId)` (a closure over the videos
   * repo); tests inject a fake predicate so they can drive cancellation
   * deterministically without touching the DB.
   */
  cancellationSource?: CancellationSource;
  /**
   * Watcher poll interval in ms. Forwarded to the cancellation watcher.
   * Tests override to 0 / a small value; production uses the default.
   */
  cancellationIntervalMs?: number;
  /**
   * Moderator override for tests that want to drive the moderation seam
   * without standing up a chat wrapper. When unset, `runPipeline` builds
   * one via `createPromptModerator` over the signal-folded
   * `visualPromptChat`.
   */
  moderator?: PromptModerator;
} & Partial<Omit<StepContext, "log" | "signal">>;

/**
 * Orchestrator-internal fully-resolved dependency struct. Every field
 * set. Built by `resolveDeps` from the optional public `RunPipelineDeps`.
 * Chat wrappers are un-signal-folded here — `runPipeline` folds them once
 * after constructing the per-run AbortController, and the moderator +
 * image/video providers are built downstream in the same setup block.
 */
export interface ResolvedDeps {
  steps: readonly Step[];
  db: DatabaseType;
  projectsDir: string;
  promptsDir: string;
  chat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  visualPromptChat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  visualPromptsConcurrency: number;
  ttsProvider: TtsProvider;
  snapshot: WorkflowSnapshot;
}

/**
 * Per-pipeline-run primitives that can only be built once the
 * AbortController exists: signal-folded chat wrappers and the
 * moderator-dependent image/video providers. Built once in `runPipeline`
 * and passed into every `buildStepContext` call.
 */
export interface PerRunDeps {
  chat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  visualPromptChat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;
  imageProvider: ImageProvider;
  videoProvider: VideoProvider;
}

function readSnapshot(
  db: DatabaseType,
  videoId: string
): WorkflowSnapshot {
  const row = db
    .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
    .get(videoId) as { workflow_snapshot: string | null } | undefined;
  if (!row) {
    throw new Error(`Video ${videoId} not found`);
  }
  if (row.workflow_snapshot === null) {
    throw new Error(
      `Video ${videoId} has no workflow snapshot — invariant violation`
    );
  }
  return JSON.parse(row.workflow_snapshot) as WorkflowSnapshot;
}

/**
 * Resolve production defaults. `REAL_STEPS` is imported lazily so tests
 * that pass their own `steps` don't pull real step modules into the test
 * runtime, and to avoid an import cycle (steps import the `Step` type
 * from this file).
 *
 * The pinned `videos.workflow_snapshot` (Invariant B) is parsed once and
 * feeds two consumers: `chat`/`visualPromptChat` resolution (both via the
 * snapshot's `script_llm_provider`) and the step list
 * (`materializeStepList`). The snapshot is the source of truth for
 * in-flight runs; `resolveDeps` never re-reads the live `workflows` row.
 *
 * Per-purpose model resolution happens here so providers stay pure
 * transports: `chat` injects `<provider>_script_model`, `visualPromptChat`
 * injects `<provider>_visual_model`. Both wrappers reuse the same
 * snapshot-pinned provider — visual-prompt generation and Google Flow
 * moderation therefore inherit script writing's provider choice, with
 * their own (cheaper) model. The moderator's
 * `google_flow_content_moderation_model` override still wins because callers
 * pass it via `opts.model`, which the wrapper layers on top of the
 * visual-model fallback.
 *
 * `tts_provider` reads from the snapshot, so toggling Settings mid-flight
 * cannot redirect an in-flight video's TTS either. `image_provider` and
 * `video_provider` get the same snapshot-pinning treatment, but their
 * construction lives in `runPipeline`'s per-run setup block so the
 * moderator's chat can close over the signal-folded `visualPromptChat`.
 *
 * `music_video` snapshots short-circuit the LLM/image/video provider
 * resolution entirely. They pin `script_llm_provider=null` and
 * `image_provider`/`video_provider='magnific'`; the six steps in
 * MUSIC_VIDEO_STEPS never read `ctx.chat` / `ctx.visualPromptChat` /
 * `ctx.imageProvider` / `ctx.videoProvider`, so leaving those fields as
 * null markers is safe and avoids hitting the LLM registry with `null`
 * or the image/video registries with `'magnific'` (the magnific provider
 * dispatches via the magnific_queue worker step, not via the
 * generateBatch interface). Narrative kind keeps the existing logic
 * verbatim.
 */
async function resolveDeps(
  videoId: string,
  deps?: RunPipelineDeps
): Promise<ResolvedDeps> {
  const db = deps?.db ?? getDb();
  const projectsDir =
    deps?.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";
  const promptsDir = deps?.promptsDir ?? "prompts";

  const snapshot = readSnapshot(db, videoId);

  // music_video kind short-circuits LLM/visual-prompt/concurrency
  // resolution — none of its steps consume those fields. The cast keeps
  // the ResolvedDeps shape non-optional; the `null` value is consistent
  // with how the image/video providers are exposed under their own null
  // snapshot columns.
  const isMusicVideo = snapshot.kind === "music_video";

  let chat: ResolvedDeps["chat"];
  let visualPromptChat: ResolvedDeps["visualPromptChat"];
  let visualPromptsConcurrency: number;

  if (isMusicVideo) {
    chat =
      deps?.chat ??
      (null as unknown as ResolvedDeps["chat"]);
    visualPromptChat =
      deps?.visualPromptChat ??
      (null as unknown as ResolvedDeps["visualPromptChat"]);
    visualPromptsConcurrency = deps?.visualPromptsConcurrency ?? 0;
  } else {
    // getLlmProvider already validates the provider name at runtime; the
    // cast is purely for the template-literal SettingKey lookups below.
    const providerName = snapshot.script_llm_provider as LlmProviderName;
    const scriptModel = getSetting(`${providerName}_script_model`, db);
    const visualModel = getSetting(`${providerName}_visual_model`, db);
    const provider = getLlmProvider(providerName);

    chat =
      deps?.chat ??
      ((messages, opts) =>
        provider.chat(messages, {
          ...opts,
          db,
          model: opts?.model ?? scriptModel,
        }));
    visualPromptChat =
      deps?.visualPromptChat ??
      ((messages, opts) =>
        provider.chat(messages, {
          ...opts,
          db,
          model: opts?.model ?? visualModel,
        }));
    // Per-purpose concurrency: same resolution shape as the script/visual
    // model split above. The snapshot picks the provider; the provider
    // picks which concurrency knob is consulted.
    visualPromptsConcurrency =
      deps?.visualPromptsConcurrency ??
      (providerName === "claude_cli"
        ? getSetting("claude_cli_visual_prompts_concurrency", db)
        : getSetting("openrouter_visual_prompts_concurrency", db));
  }
  // TTS provider resolves from the snapshot. A null column means the
  // corresponding slot is skipped at materialization, so steps consuming
  // ctx.ttsProvider never run; the cast keeps the field non-optional.
  // (image/video providers are built downstream in `runPipeline` once
  // the moderator exists.)
  const ttsProvider =
    deps?.ttsProvider ??
    (snapshot.tts_provider
      ? getTtsProvider(snapshot.tts_provider)
      : (null as unknown as TtsProvider));

  let steps = deps?.steps;
  if (!steps) {
    const slugs = materializeStepList(snapshot);
    const { REAL_STEPS } = await import("./steps");
    const bySlug = new Map(REAL_STEPS.map((s) => [s.name, s] as const));
    steps = slugs.map((slug) => {
      const s = bySlug.get(slug);
      if (!s) {
        throw new Error(
          `Workflow "${snapshot.workflow_id}" references unknown step "${slug}"`
        );
      }
      return s;
    });
  }

  return {
    steps,
    db,
    projectsDir,
    promptsDir,
    chat,
    visualPromptChat,
    visualPromptsConcurrency,
    ttsProvider,
    snapshot,
  };
}

export async function runPipeline(
  videoId: string,
  depsOverride?: RunPipelineDeps
): Promise<void> {
  // Honor delete_requested BEFORE resolveDeps. The for-loop's between-step
  // check at the bottom is the only other honor site; it sits after
  // resolveDeps, so if the snapshot pins an unresolvable provider
  // (today: a music_video row pins script_llm_provider=null and
  // resolveDeps throws on getLlmProvider(null)) the throw is swallowed
  // by tickOnce's failure-isolation try/catch and the delete request
  // stays stuck forever. Honoring it up front makes deletion robust
  // against any snapshot-provider gap, present or future.
  const earlyDb = depsOverride?.db ?? getDb();
  if (videosRepo.readDeleteRequested(earlyDb, videoId)) {
    const earlyProjectsDir =
      depsOverride?.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";
    videoLifecycle.deleteFully(earlyDb, videoId, earlyProjectsDir);
    return;
  }

  const deps = await resolveDeps(videoId, depsOverride);
  const { db, steps } = deps;

  // Pre-loop: upsert one pending row per step. Idempotent so resume runs
  // are no-ops.
  for (const step of steps) {
    stepsRepo.upsertPending(db, videoId, step.name);
  }

  // Cancellation primitive: one controller per pipeline run; a watcher
  // polls the cancellation source (default: videos.delete_requested) and
  // aborts the controller when the flag flips. Steps see ctx.signal.
  const controller = new AbortController();
  const cancellationSource =
    depsOverride?.cancellationSource ?? deleteRequestedSource(db, videoId);
  const stopWatcher = startCancellationWatcher(controller, cancellationSource, {
    intervalMs: depsOverride?.cancellationIntervalMs,
  });

  // Per-run dependency construction. Sits after the AbortController so
  // chat wrappers can close over its signal — folding cancellation in
  // once at the boundary means steps don't repeat `{ signal: ctx.signal }`
  // on every call. The moderator closes over the folded visualPromptChat
  // so its in-flight LLM call aborts on cancellation; image/video
  // providers close over the moderator so the moderation seam lives at
  // the coordinator rather than leaking through provider opts.
  const foldedChat: ResolvedDeps["chat"] = (messages, opts) =>
    deps.chat(messages, { signal: controller.signal, ...opts });
  const foldedVisualPromptChat: ResolvedDeps["visualPromptChat"] = (
    messages,
    opts
  ) => deps.visualPromptChat(messages, { signal: controller.signal, ...opts });
  const moderator =
    depsOverride?.moderator ??
    createPromptModerator({
      chat: foldedVisualPromptChat,
      promptsDir: deps.promptsDir,
      db,
    });
  // A null snapshot column means the corresponding slot is skipped at
  // materialization, so steps consuming the provider never run; the cast
  // keeps the field non-optional for the StepContext shape.
  //
  // music_video kind: the snapshot pins image/video provider to 'magnific',
  // but the MUSIC_VIDEO_STEPS dispatch via the magnific_queue worker step,
  // not via the registry's generateBatch interface. Treat 'magnific' the
  // same as a null slot to avoid a registry lookup that would throw.
  const isMusicVideo = deps.snapshot.kind === "music_video";
  const imageProvider =
    depsOverride?.imageProvider ??
    (deps.snapshot.image_provider && !isMusicVideo
      ? getImageProvider(deps.snapshot.image_provider, { moderator })
      : (null as unknown as ImageProvider));
  const videoProvider =
    depsOverride?.videoProvider ??
    (deps.snapshot.video_provider && !isMusicVideo
      ? getVideoProvider(deps.snapshot.video_provider, { moderator })
      : (null as unknown as VideoProvider));
  const perRun: PerRunDeps = {
    chat: foldedChat,
    visualPromptChat: foldedVisualPromptChat,
    imageProvider,
    videoProvider,
  };

  try {
    for (const step of steps) {
      // Between-step delete-request check. The user can set delete_requested
      // while a step is running; we honor it at the next step boundary so
      // no partial state from the next step ever lands on disk. The
      // controller may already be aborted by the watcher — same outcome.
      if (
        controller.signal.aborted ||
        videosRepo.readDeleteRequested(db, videoId)
      ) {
        videoLifecycle.deleteFully(db, videoId, deps.projectsDir);
        return;
      }

      // Between-step pause check. Delete is checked first above so delete
      // wins when both flags are set. On pause we leave the video in
      // status='in_progress' with current_step untouched — the runner's
      // paused=0 filters (Task 2.1) keep it from being re-picked until the
      // flag clears.
      if (
        getSetting("queue_state", db) === "paused" ||
        videosRepo.readPaused(db, videoId)
      ) {
        return;
      }

      if (stepsRepo.getStatus(db, videoId, step.name) === "done") {
        continue;
      }

      // Delegate the step body to the harness. The harness owns the
      // step-row transitions (`enterStep`), step.run dispatch, outcome
      // discrimination, and the matching side-effects (`markDone` /
      // `setDeferredUntil` / `deleteFully` / `recordStepFailure`). The
      // loop only cares about the binary decision: keep going or stop.
      const result = await runStep(
        deps,
        perRun,
        step,
        videoId,
        controller.signal
      );
      if (result.kind === "stop") return;
    }

    // Post-loop: every step succeeded (or a late delete/pause snuck in
    // between the last step's markDone and this point). Honor the delete
    // first so the done-transition doesn't clobber the wipe.
    if (
      controller.signal.aborted ||
      videosRepo.readDeleteRequested(db, videoId)
    ) {
      videoLifecycle.deleteFully(db, videoId, deps.projectsDir);
      return;
    }

    if (
      getSetting("queue_state", db) === "paused" ||
      videosRepo.readPaused(db, videoId)
    ) {
      return;
    }

    videosRepo.markDone(
      db,
      videoId,
      `projects/${videoId}/final.mp4`,
      Date.now()
    );
  } finally {
    // Stop the watcher unconditionally — the alternative is a setInterval
    // leak per pipeline run.
    stopWatcher();
  }
}
