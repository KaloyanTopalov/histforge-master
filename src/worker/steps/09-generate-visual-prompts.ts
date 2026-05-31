import type { Database as DatabaseType } from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type {
  BeatType,
  Shot,
  ShotCamera,
  ShotReference,
  ShotSubjectKind,
} from "@/types";
import { getSetting } from "@/lib/settings";
import { render } from "@/lib/prompts";
import * as videosRepo from "@/lib/repos/videos";
import { parseVisualStyleSnapshot } from "@/lib/visual-styles";
import { IMAGE_STYLE_DEFINITIONS } from "@/lib/image/styles";
import type { ChatMessage } from "@/lib/llm/types";

/**
 * Allowed `camera` values, kept in sync with `ShotCamera` in `src/types.ts`.
 * Used by `parseEnvelopeReply` to validate LLM-supplied framing.
 */
const VALID_CAMERAS: ReadonlySet<ShotCamera> = new Set<ShotCamera>([
  "wide",
  "medium",
  "close-up",
  "over-shoulder",
  "pov",
  "static",
]);

/**
 * Allowed `subject_kind` values, kept in sync with `ShotSubjectKind` in
 * `src/types.ts`.
 */
const VALID_SUBJECT_KINDS: ReadonlySet<ShotSubjectKind> = new Set<ShotSubjectKind>([
  "character",
  "environment",
  "object",
  "title-card",
]);

/**
 * Allowed `beat_type` values, kept in sync with `BeatType` in
 * `src/types.ts`. Editorial-intent classifier the LLM emits alongside
 * scene/camera/subject_kind; pure metadata (does not influence chunk
 * timing — owned by the chunker step 08).
 */
const VALID_BEAT_TYPES: ReadonlySet<BeatType> = new Set<BeatType>([
  "establishing",
  "narrative",
  "fact_card",
  "reveal",
  "emphasis",
]);

/**
 * Per-entry payload returned by `parseEnvelopeReply`. `scene` is the
 * authoritative description and is REQUIRED under the phase 2b
 * contract. `prompt` is the LLM-emitted prompt string (if any) —
 * stored for round-trip visibility but NOT used as the assembler's
 * base. The other fields are optional structured-IR additions.
 */
interface ShotExtras {
  scene: string;
  prompt: string;
  camera?: ShotCamera;
  subject_kind?: ShotSubjectKind;
  trigger_text?: string;
  references?: ShotReference[];
  negative_prompt?: string;
  beat_type?: BeatType;
}

interface BatchItem {
  id: string;
  prev_text: string;
  current_text: string;
  next_text: string;
}

const MAX_PARSE_ATTEMPTS = 2;

/**
 * Character-lock + style-lock: hard system instruction prepended to every
 * visual-prompt LLM call. Tells the model not to describe the character's
 * appearance or art style — the style and negative-prompt blocks are
 * appended verbatim by post-processing below, and re-describing them in
 * the LLM output is wasted tokens and a drift risk.
 */
const SYSTEM_INSTRUCTION =
  "Do not describe the character's appearance or art style. Only describe " +
  "the environment, the character's posture and action, and what is around " +
  "the character. The character is locked by a reference ingredient and the " +
  "style is appended by code.";

/**
 * Append the two operator-editable lock segments verbatim onto a single
 * LLM-returned prompt. Empty segments are skipped — an operator who
 * wants no lock leaves the textarea blank, and the final prompt has no
 * dangling ". Negative: ." artifact.
 *
 * Format (with both non-empty):
 *   `<prompt>. <styleLock>. Negative: <negativeLock>.`
 *
 * The exact form (separators, trailing period on each segment) is the
 * plan's spec; see __tests__/image/prompt-assembly.test.ts.
 *
 * Kept exported-via-call from `assembleShotPrompt` (which adds per-shot
 * negative_prompt composition); `applyLocks` itself remains the simple
 * two-lock composer used when there is no per-shot negative.
 */
function applyLocks(
  prompt: string,
  styleLock: string,
  negativeLock: string
): string {
  const segments: string[] = [];
  if (styleLock.length > 0) segments.push(styleLock);
  if (negativeLock.length > 0) segments.push(`Negative: ${negativeLock}`);
  if (segments.length === 0) return prompt;
  return `${prompt}. ${segments.join(". ")}.`;
}

/**
 * Phase 2b assembler: code (not the LLM) is the authority that produces
 * a shot's final `prompt` string. The parser guarantees `extras.scene`
 * is a non-empty string under the 2b contract, so this assembler has
 * exactly one base.
 *
 * Appended segments, in order, each optional:
 *   - `stylePrompt`: the per-video `visual_style_snapshot.prompt`
 *     (e.g. "watercolor pastoral"). Empty when the operator picked
 *     "Default (no style)". Always appended so style is byte-identical
 *     across every shot of the video.
 *   - `styleLock`: the global `style_lock_description` setting
 *     (operator-editable catch-all style, applied to every video).
 *   - `Negative:` clause folding per-shot `negative_prompt` (first)
 *     with `negativeLock` (second), comma-separated, so providers see
 *     exactly one `Negative:` clause regardless of where the cues
 *     originated.
 *
 * Output shape (identical to the legacy `applyLocks` shape when
 * stylePrompt is empty AND no per-shot negative is supplied — see
 * prompt-assembly.test.ts):
 *   `<scene>. <stylePrompt>. <styleLock>. Negative: <perShotNeg, globalNeg>.`
 */
function assembleShotPrompt(
  extras: ShotExtras,
  deps: { stylePrompt: string; styleLock: string; negativeLock: string }
): string {
  const base = extras.scene;

  const negativeParts: string[] = [];
  if (extras.negative_prompt && extras.negative_prompt.length > 0) {
    negativeParts.push(extras.negative_prompt);
  }
  if (deps.negativeLock.length > 0) {
    negativeParts.push(deps.negativeLock);
  }

  const segments: string[] = [];
  if (deps.stylePrompt.length > 0) segments.push(deps.stylePrompt);
  if (deps.styleLock.length > 0) segments.push(deps.styleLock);
  if (negativeParts.length > 0)
    segments.push(`Negative: ${negativeParts.join(", ")}`);

  if (segments.length === 0) return base;
  return `${base}. ${segments.join(". ")}.`;
}

/**
 * Raised by `parseEnvelopeReply` when the LLM's response is malformed.
 * The per-chunk fallback in `runOneBatch` only fires on this class —
 * transport errors (network, abort, etc.) bubble up to the orchestrator
 * untouched.
 */
class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

/**
 * Step 9 — generate_visual_prompts. Spec section 11.
 *
 * Per ADR-0002: batched JSON envelopes, per-provider bounded
 * concurrency, skip-already-enriched resume, retry-once-then-per-chunk
 * parse fallback, eager `prompt_history` reset on the to-regenerate
 * subset, and an in-process write mutex.
 */
export const step: Step = {
  name: "generate_visual_prompts",
  module: "glue",
  label: "Generate visual prompts",
  description: "Generates a visual prompt for each chunk via batched LLM calls.",
  for_each: "chunks",
  inputs: ["chunks/chunks.json"],
  // Re-running fills missing prompts only (skip-already-enriched);
  // partial state is harmless to leave.
  outputs: [],
  produces: ["chunks/chunks.json"],
  async run(videoId, ctx) {
    const projectDir = resolve(ctx.projectsDir, videoId);
    const chunksPath = join(projectDir, "chunks", "chunks.json");

    // Read the chunks file as Shot[]: legacy files written before this
    // step landed contain only Chunk fields, which the optional Shot
    // extension fields tolerate (all undefined). New writes from this
    // step persist the structured-IR fields the LLM supplies.
    const chunks: Shot[] = JSON.parse(readFileSync(chunksPath, "utf-8"));

    // Skip-already-enriched: only null-prompt chunks need work. If the
    // working set is empty the file already reflects the final state —
    // no LLM calls, no write.
    const workingIndexes = chunks
      .map((c, i) => (c.prompt === null ? i : -1))
      .filter((i) => i >= 0);
    if (workingIndexes.length === 0) return;

    // Per-video style snapshot pinned at create/queue time. NULL =
    // "Default (no style)" — empty string into the `style_prompt`
    // template variable. The image-styles PR routes this through the
    // doodle-vs-cinematic branch below: cinematic keeps the gallery
    // prompt (pre-doodle behavior); doodle drops it because the
    // workflow's prompt_prefix is the authoritative style.
    const video = videosRepo.findById(ctx.db, videoId);
    const gallerySnapshot = parseVisualStyleSnapshot(
      video?.visual_style_snapshot
    );
    const galleryStylePrompt = gallerySnapshot?.prompt ?? "";
    const K = getSetting("visual_prompts_batch_size", ctx.db);
    // Global lock settings — the cinematic-path fallback. Per-style
    // locks (lib/image/styles.ts) replace these for non-cinematic
    // styles whose registry entry declares a non-null lock. Cinematic's
    // entry carries null for both locks, so the assembler picks the
    // globals here verbatim — backwards-compat anchor.
    const globalStyleLock = getSetting("style_lock_description", ctx.db);
    const globalNegativeLock = getSetting("character_lock_negative", ctx.db);

    // Resolve per-workflow image style. NULL/absent on the workflow
    // snapshot → "cinematic" (the pre-doodle baseline). Doodle variants
    // are workflow-authoritative: their `prompt_prefix` REPLACES the
    // per-video gallery prompt, and their locks REPLACE the globals.
    // The branch is on the variant name so a future style designer
    // makes an explicit decision about gallery behavior — there's no
    // hidden "empty prompt_prefix = use gallery" coupling.
    const imageStyleName = (ctx.snapshot.image_style ?? "cinematic") as
      | "cinematic"
      | "doodle_polished"
      | "doodle_rough";
    const styleDef =
      IMAGE_STYLE_DEFINITIONS[imageStyleName] ??
      IMAGE_STYLE_DEFINITIONS.cinematic;
    const isDoodleVariant =
      imageStyleName === "doodle_polished" ||
      imageStyleName === "doodle_rough";

    const stylePrompt = isDoodleVariant
      ? styleDef.prompt_prefix
      : galleryStylePrompt;
    const styleLock = styleDef.style_lock ?? globalStyleLock;
    const negativeLock = styleDef.negative_lock ?? globalNegativeLock;

    // Doodle variants get the narration-to-visual-metaphor skill
    // appended to the LLM system prompt — the intelligence layer that
    // steers the LLM toward concrete visual metaphors for abstract
    // narration beats (the channel-quality output the doodle prompts
    // need). Cinematic / null keeps the bare SYSTEM_INSTRUCTION
    // byte-for-byte (regression-net contract).
    //
    // Load-once at step entry: the file read is paid one time per step
    // run, not per LLM batch call. The composed string is then sent on
    // every batch's system message. See `docs/perf-notes.md` for the
    // per-call / per-video token accounting.
    let systemInstruction = SYSTEM_INSTRUCTION;
    if (isDoodleVariant) {
      const skillPath = resolve(
        ctx.promptsDir,
        "09_doodle_visual_metaphor_skill.md"
      );
      const skill = readFileSync(skillPath, "utf-8");
      systemInstruction = `${SYSTEM_INSTRUCTION}\n\n${skill}`;
    }
    // Few-shot examples slot: resolve once at step entry so every batch
    // sees the same block. Always supplied (defaults to "") because the
    // render dialect strict-throws on unresolved {{good_examples}}.
    const goodExamples = renderGoodExamples(
      getSetting("step_09_examples_json", ctx.db),
      (msg) => ctx.log(msg)
    );

    // Eager prompt_history + structured-IR sweep: clear lineage AND any
    // prior optional Shot fields on the to-regenerate subset *before* any
    // LLM call so a mid-step crash leaves consistent state. Without this
    // the persist step would only overwrite extras the new LLM reply
    // includes — a sparser reply would leave stale `scene`/`camera`/etc.
    // describing a prompt that has since been replaced. Persist once.
    for (const i of workingIndexes) {
      chunks[i].prompt_history = [];
      delete chunks[i].scene;
      delete chunks[i].camera;
      delete chunks[i].subject_kind;
      delete chunks[i].trigger_text;
      delete chunks[i].references;
      delete chunks[i].negative_prompt;
      delete chunks[i].beat_type;
    }
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");

    // Build BatchItem[] for each working-set chunk, drawing prev/next
    // from the *full* chunks array (not the batch) — neighbourliness is
    // global, not per-batch.
    const items: BatchItem[] = workingIndexes.map((i) => ({
      id: chunks[i].id,
      prev_text: i > 0 ? chunks[i - 1].text : "",
      current_text: chunks[i].text,
      next_text: i < chunks.length - 1 ? chunks[i + 1].text : "",
    }));

    // Slice into K-sized batches, preserving order.
    const batches: BatchItem[][] = [];
    for (let i = 0; i < items.length; i += K) {
      batches.push(items.slice(i, i + K));
    }

    // In-process write mutex. A Promise chain held in `writeLock`
    // serializes all file writes so concurrent batches can't tear JSON.
    let writeLock: Promise<void> = Promise.resolve();
    const persistBatch = (results: Map<string, ShotExtras>): Promise<void> => {
      writeLock = writeLock.then(() => {
        for (const c of chunks) {
          const extras = results.get(c.id);
          if (extras === undefined) continue;
          c.prompt = extras.prompt;
          // Persist the optional structured-IR fields the LLM supplied.
          // Phase 2a stores them but doesn't change downstream behaviour;
          // a later phase will assemble provider prompts from them.
          if (extras.scene !== undefined) c.scene = extras.scene;
          if (extras.camera !== undefined) c.camera = extras.camera;
          if (extras.subject_kind !== undefined) c.subject_kind = extras.subject_kind;
          if (extras.trigger_text !== undefined) c.trigger_text = extras.trigger_text;
          if (extras.references !== undefined) c.references = extras.references;
          if (extras.negative_prompt !== undefined) c.negative_prompt = extras.negative_prompt;
          if (extras.beat_type !== undefined) c.beat_type = extras.beat_type;
        }
        writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
      });
      return writeLock;
    };

    // Phase 2b: code assembles each shot's final `prompt` from its
    // structured fields (`scene` is authoritative; `extras.prompt` is a
    // legacy fallback). The assembler appends the per-video style
    // snapshot (formerly baked into the LLM's prompt) and the global
    // style/negative locks, and folds per-shot `negative_prompt` into
    // the negative lock so providers see one `Negative:` clause.
    // Applied uniformly on the main batch and per-chunk fallback paths
    // so all persisted prompts go through the assembler. Other
    // structured fields pass through unchanged.
    const enrich = (raw: Map<string, ShotExtras>): Map<string, ShotExtras> => {
      const out = new Map<string, ShotExtras>();
      for (const [id, extras] of raw) {
        out.set(id, {
          ...extras,
          prompt: assembleShotPrompt(extras, {
            stylePrompt,
            styleLock,
            negativeLock,
          }),
        });
      }
      return out;
    };

    const runOneBatch = async (batch: BatchItem[]): Promise<void> => {
      try {
        const results = await callBatchWithRetry(batch, {
          chat: ctx.visualPromptChat,
          db: ctx.db,
          promptsDir: ctx.promptsDir,
          stylePrompt,
          goodExamples,
          systemInstruction,
        });
        await persistBatch(enrich(results));
      } catch (err) {
        // Only parse failures trigger the per-chunk fallback. Transport
        // errors (network, abort) propagate up to the orchestrator.
        if (!(err instanceof ParseError)) throw err;
        // Parse failure persisted across retry — fall back to per-chunk
        // (K=1) calls for *this batch only*. Other batches still run
        // batched at full concurrency. A per-chunk call that also
        // parse-fails twice throws out of here, and the orchestrator
        // marks the step failed.
        for (const item of batch) {
          const results = await callBatchWithRetry([item], {
            chat: ctx.visualPromptChat,
            db: ctx.db,
            promptsDir: ctx.promptsDir,
            stylePrompt,
            goodExamples,
            systemInstruction,
          });
          await persistBatch(enrich(results));
        }
      }
    };

    // Bounded-concurrency worker pool. Each worker pulls the next batch
    // index from a shared cursor until exhausted. `concurrency` workers
    // run in parallel; if N batches < concurrency, the extra workers
    // exit immediately. The shared `stop` flag short-circuits sibling
    // workers once one has thrown: without it, a failed step keeps
    // burning LLM calls + disk writes in the background while the
    // orchestrator is already marking it failed. The current in-flight
    // batch on each sibling still completes (preserves its persist
    // primitive); subsequent batches are not picked up.
    let cursor = 0;
    let stop = false;
    const worker = async (): Promise<void> => {
      while (!stop) {
        const i = cursor++;
        if (i >= batches.length) return;
        try {
          await runOneBatch(batches[i]);
        } catch (err) {
          stop = true;
          throw err;
        }
      }
    };
    const workers: Promise<void>[] = [];
    for (let w = 0; w < Math.max(1, ctx.visualPromptsConcurrency); w++) {
      workers.push(worker());
    }
    await Promise.all(workers);

    // Drain the write queue so anything still in flight lands before
    // we return.
    await writeLock;
  },
};

/**
 * Send a batch through the LLM with retry-once-on-parse-failure
 * semantics (MAX_PARSE_ATTEMPTS = 2). On the retry, append a stricter
 * envelope reminder to give the model a chance to fix its shape. Any
 * call that returns a parseable envelope satisfying the id-keyed
 * invariants resolves; otherwise the last parse error propagates.
 */
async function callBatchWithRetry(
  batch: BatchItem[],
  deps: {
    chat: (
      messages: ChatMessage[],
      opts?: { db?: DatabaseType }
    ) => Promise<string>;
    db: DatabaseType;
    promptsDir: string;
    stylePrompt: string;
    goodExamples: string;
    systemInstruction: string;
  }
): Promise<Map<string, ShotExtras>> {
  const expectedIds = new Set(batch.map((b) => b.id));
  const userPrompt = render(
    "09_generate_visual_prompts.md",
    {
      batch_json: JSON.stringify(batch, null, 2),
      style_prompt: deps.stylePrompt,
      good_examples: deps.goodExamples,
    },
    deps.promptsDir
  );
  const retryReminder =
    "\n\nREMINDER: Respond with a single JSON object of the exact shape " +
    '`{"prompts": [{"id": "<chunk_id>", "scene": "<non-empty string>"}, ...]}`. ' +
    "Each entry MUST include `id` and a non-empty `scene` — `scene` is the " +
    "required authoritative description. One entry per input id, using the " +
    "input ids exactly. No preamble, no commentary, no markdown fences. " +
    "Begin your response with `{` and end with `}`.";

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt++) {
    const content = attempt === 0 ? userPrompt : `${userPrompt}${retryReminder}`;
    const reply = await deps.chat(
      [
        { role: "system", content: deps.systemInstruction },
        { role: "user", content },
      ],
      { db: deps.db }
    );
    try {
      return parseEnvelopeReply(reply, expectedIds);
    } catch (err) {
      if (!(err instanceof ParseError)) throw err;
      lastError = err;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new ParseError(String(lastError));
}

/**
 * Strict envelope validation. Returns an `id → ShotExtras` map iff:
 *   - the reply parses as JSON,
 *   - it has a top-level `prompts` array,
 *   - every entry has string `id` and non-empty string `scene`. Phase
 *     2b makes `scene` the sole authoritative description; the legacy
 *     prompt-only contract is no longer accepted (it was ambiguous —
 *     code could not tell whether the LLM's template baked style into
 *     `prompt` or not, leading to either duplicated or missing per-
 *     video style). Operators on an older template must migrate; the
 *     ParseError message points at the missing field.
 *   - the entry id set equals `expectedIds` exactly (no missing, no
 *     extra, no duplicates).
 *
 * Structured-IR extension fields (`camera`, `subject_kind`,
 * `trigger_text`, `references`, `negative_prompt`) are OPTIONAL and
 * forgivingly parsed via `extractShotExtras` — a malformed extension
 * field is silently dropped rather than failing the whole entry.
 *
 * `ShotExtras.prompt` is the LLM-supplied prompt string when present
 * (kept for round-trip persistence) but is NOT used as a base by the
 * assembler — `scene` is. The assembler always overwrites `prompt`
 * with the assembled output.
 */
function parseEnvelopeReply(
  reply: string,
  expectedIds: Set<string>
): Map<string, ShotExtras> {
  const cleaned = stripCodeFence(reply);
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new ParseError(
      `generate_visual_prompts: JSON.parse failed: ${(err as Error).message}`
    );
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !Array.isArray((parsed as { prompts?: unknown }).prompts)
  ) {
    throw new ParseError(
      `generate_visual_prompts: response missing prompts[]: ${reply.slice(0, 200)}`
    );
  }
  const out = new Map<string, ShotExtras>();
  const entries = (parsed as { prompts: unknown[] }).prompts;
  for (const e of entries) {
    if (
      !e ||
      typeof e !== "object" ||
      typeof (e as { id?: unknown }).id !== "string"
    ) {
      throw new ParseError(
        `generate_visual_prompts: bad entry: ${JSON.stringify(e).slice(0, 200)}`
      );
    }
    const obj = e as Record<string, unknown>;
    const id = obj.id as string;
    if (typeof obj.scene !== "string" || obj.scene.length === 0) {
      throw new ParseError(
        `generate_visual_prompts: entry ${id} missing non-empty 'scene' (phase 2b contract: scene is required; the legacy prompt-only shape is no longer accepted)`
      );
    }
    const sceneStr: string = obj.scene;
    if (!expectedIds.has(id)) {
      throw new ParseError(
        `generate_visual_prompts: unexpected id ${id}`
      );
    }
    if (out.has(id)) {
      throw new ParseError(
        `generate_visual_prompts: duplicate id ${id}`
      );
    }
    // Pass through the LLM-emitted `prompt` if present (informational —
    // assembler overwrites `prompt` with the assembled output, so this
    // is just for round-trip visibility in chunks.json).
    const promptStr =
      typeof obj.prompt === "string" ? obj.prompt : "";
    out.set(id, {
      scene: sceneStr,
      prompt: promptStr,
      ...extractShotExtras(obj),
    });
  }
  if (out.size !== expectedIds.size) {
    const missing = [...expectedIds].filter((id) => !out.has(id));
    throw new ParseError(
      `generate_visual_prompts: missing ids ${missing.join(", ")}`
    );
  }
  return out;
}

/**
 * Pluck the optional structured-IR fields off an envelope entry,
 * dropping anything malformed. Returns a partial `ShotExtras` (without
 * the strict `scene` + `prompt` pair, which the caller sets explicitly
 * from already-validated values).
 *
 * Lenient on purpose: an LLM that emits `camera: "closeup"` (no hyphen)
 * or omits half the new fields should not fail the whole batch. The
 * worst case is "structured fields aren't populated for this shot",
 * which is the same as today's behaviour.
 */
function extractShotExtras(
  entry: Record<string, unknown>
): Omit<ShotExtras, "prompt" | "scene"> {
  const out: Omit<ShotExtras, "prompt" | "scene"> = {};

  if (
    typeof entry.camera === "string" &&
    VALID_CAMERAS.has(entry.camera as ShotCamera)
  ) {
    out.camera = entry.camera as ShotCamera;
  }
  if (
    typeof entry.subject_kind === "string" &&
    VALID_SUBJECT_KINDS.has(entry.subject_kind as ShotSubjectKind)
  ) {
    out.subject_kind = entry.subject_kind as ShotSubjectKind;
  }
  if (
    typeof entry.beat_type === "string" &&
    VALID_BEAT_TYPES.has(entry.beat_type as BeatType)
  ) {
    out.beat_type = entry.beat_type as BeatType;
  }
  if (typeof entry.trigger_text === "string" && entry.trigger_text.length > 0) {
    out.trigger_text = entry.trigger_text;
  }
  if (
    typeof entry.negative_prompt === "string" &&
    entry.negative_prompt.length > 0
  ) {
    out.negative_prompt = entry.negative_prompt;
  }
  if (Array.isArray(entry.references)) {
    const refs: ShotReference[] = [];
    for (const r of entry.references) {
      const parsed = parseShotReference(r);
      if (parsed !== null) refs.push(parsed);
    }
    if (refs.length > 0) out.references = refs;
  }

  return out;
}

/**
 * Validate one `references[]` element. Returns null when the shape is
 * malformed so the caller can skip it without failing the batch. The
 * envelope's `references` array is itself optional, so dropping all
 * entries simply leaves the shot with no references attached.
 */
function parseShotReference(raw: unknown): ShotReference | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.role !== "character" && obj.role !== "style") return null;
  if (!obj.source || typeof obj.source !== "object") return null;
  const source = obj.source as Record<string, unknown>;
  if (source.kind === "entity" && typeof source.entity_id === "string") {
    return { role: obj.role, source: { kind: "entity", entity_id: source.entity_id } };
  }
  if (source.kind === "image" && typeof source.url === "string") {
    return { role: obj.role, source: { kind: "image", url: source.url } };
  }
  return null;
}

// The prompt forbids markdown fences but LLMs sometimes wrap JSON in
// ```json ... ``` anyway. Strip a single surrounding fence so JSON.parse
// can consume the body. Mirrors lib/moderator.ts.
function stripCodeFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/, "");
}

/**
 * Build the <good_examples> block injected at the top of the step 09
 * prompt from the operator-set `step_09_examples_json` setting. The
 * `{{good_examples}}` template slot is ALWAYS supplied (the render
 * dialect strict-throws on unresolved vars), so on empty / invalid
 * inputs we return "" and the prompt body simply has no example block.
 *
 * Failure modes (non-empty + unparseable, or non-empty + parseable but
 * not an array) are logged via `warn` and treated as "no examples";
 * the step proceeds without blocking.
 */
function renderGoodExamples(
  raw: string,
  warn: (msg: string) => void
): string {
  if (raw.length === 0) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    warn(
      `WARN: step_09_examples_json is non-empty but failed to JSON.parse ` +
        `(${(err as Error).message}); proceeding without <good_examples> block.`
    );
    return "";
  }
  if (!Array.isArray(parsed)) {
    warn(
      `WARN: step_09_examples_json must be a JSON array; got ${typeof parsed}; ` +
        `proceeding without <good_examples> block.`
    );
    return "";
  }
  const lines = parsed.map((item) => JSON.stringify(item)).join("\n");
  return (
    `<good_examples>\n` +
    `Here are example scenes from a video the operator considers high-quality. ` +
    `Match this voice and density.\n\n` +
    `${lines}\n` +
    `</good_examples>\n\n`
  );
}
