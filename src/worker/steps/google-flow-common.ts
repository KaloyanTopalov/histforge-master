import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DeferSignal } from "@/worker/pipeline";
import type {
  Chunk,
  ChunkKind,
  GoogleFlowQueueKind,
  GoogleFlowQueueMode,
} from "@/types";
import { waitForFlowQueue } from "@/lib/flow-wait";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import * as flowLifecycle from "@/lib/lifecycle/flow";
import { getSetting } from "@/lib/settings";
import { extractContentPolicyTag } from "@/lib/flow-error-classify";
import type { ModerationItem, PromptModerator } from "@/lib/moderator";

export interface GoogleFlowStepDeps {
  db: DatabaseType;
  projectsDir: string;
  log: (message: string) => void;
  pollIntervalMs?: number;
  nowSec?: () => number;
  nowMs?: () => number;
  /**
   * Prompt moderator constructed once per pipeline run by the
   * coordinator. The "moderation off" branch is controlled by the
   * `google_flow_content_moderation_enabled` setting, not by the
   * presence of this dep.
   */
  moderator: PromptModerator;
  /** Cancellation signal forwarded to waitForFlowQueue. */
  signal?: AbortSignal;
}

// Belt-and-suspenders cap on the moderation re-entry loop. The configured
// max_rounds setting is the real bound; this guards against arithmetic
// bugs in the round counter.
const MAX_MODERATION_ITERATIONS_GUARD = 10;

/**
 * Shape of a Google Flow step. The `generate_images` and `generate_clips`
 * steps differ only in these constants + the per-chunk filter; the
 * orchestration (enqueue → wait → aggregate-failures → clear-defer) is
 * identical.
 */
export interface GoogleFlowStepSpec {
  /** Step slug, used in error messages. */
  stepName: string;
  /** Which kind of Chunk rows this step processes. */
  chunkKind: ChunkKind;
  /** Queue kind this step writes. */
  queueKind: GoogleFlowQueueKind;
  /** Flow API mode for enqueued tasks. */
  mode: GoogleFlowQueueMode;
  /** Relative (to project) output directory. */
  outputDir: string;
  /** Output file extension including dot (e.g. `.png`, `.mp4`). */
  outputExt: string;
}

/**
 * The "enqueue-and-wait" orchestration shared by both Google Flow steps.
 * Returns void on success, DeferSignal when every account is in cooldown
 * and the queue can't progress. Throws on timeout, aggregated row
 * failures, or when nothing is enqueueable and no outputs exist yet.
 */
export async function runGoogleFlowStep(
  videoId: string,
  deps: GoogleFlowStepDeps,
  spec: GoogleFlowStepSpec
): Promise<void | DeferSignal> {
  const { db, projectsDir } = deps;
  const projectDir = join(projectsDir, videoId);
  const chunksPath = join(projectDir, "chunks", "chunks.json");
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
  const targetChunks = chunks.filter((c) => c.kind === spec.chunkKind);

  const { existingOutputs, enqueueableChunks } = enqueueChunks(
    videoId,
    targetChunks,
    projectDir,
    deps,
    spec,
    nowSec
  );

  // Hard stop: step has nothing to do AND nothing to show for it. Better
  // to surface the bug than hand the render step an empty directory.
  if (enqueueableChunks === 0 && existingOutputs === 0) {
    throw new Error(
      `${spec.stepName}: no enqueueable chunks and no existing outputs for video ${videoId}`
    );
  }

  const deferSignal = await runModerationLoop(
    videoId,
    chunksPath,
    deps,
    spec,
    nowSec
  );
  if (deferSignal !== null) return deferSignal;

  aggregateFailures(videoId, projectDir, deps, spec);

  videosRepo.clearDeferredUntil(db, videoId);
}

/**
 * Walk targetChunks: skip those whose output already exists on disk,
 * count those with an open queue row as in-flight (no enqueue), enqueue
 * the rest unless their prompt is null.
 *
 * A chunk with a null Chunk.prompt but an existing open queue row still
 * counts as in-flight work — the row was enqueued with a non-null prompt
 * in a prior pass and is the thing the wait is actually on.
 *
 * A `failed` row whose `error_reason` is moderation-eligible
 * (`findRevivableFailedTaskForChunk`) also counts as in-flight: the
 * upcoming `runModerationLoop` pass will requeue it with a rewritten
 * prompt. Enqueueing a parallel new row would double the dispatch cost
 * and race on the same `output_path`. Non-moderation-eligible failed
 * rows (timeout, download_failed) remain settled and get a fresh
 * enqueue — the only path out of those is a clean re-attempt.
 */
function enqueueChunks(
  videoId: string,
  targetChunks: Chunk[],
  projectDir: string,
  deps: GoogleFlowStepDeps,
  spec: GoogleFlowStepSpec,
  nowSec: () => number
): { existingOutputs: number; enqueueableChunks: number } {
  const { db, log } = deps;
  const outDir = join(projectDir, spec.outputDir);
  let existingOutputs = 0;
  let enqueueableChunks = 0;
  for (const c of targetChunks) {
    const outPath = join(outDir, `${c.id}${spec.outputExt}`);
    if (existsSync(outPath)) {
      existingOutputs++;
      continue;
    }
    if (gfRepo.findOpenTaskForChunk(db, videoId, spec.queueKind, c.id)) {
      enqueueableChunks++;
      continue;
    }
    if (
      gfRepo.findRevivableFailedTaskForChunk(
        db,
        videoId,
        spec.queueKind,
        c.id
      )
    ) {
      enqueueableChunks++;
      continue;
    }
    if (c.prompt == null) {
      log(`skipping chunk ${c.id}: prompt is null`);
      continue;
    }
    enqueueableChunks++;
    gfRepo.enqueueTask(db, {
      video_id: videoId,
      chunk_id: c.id,
      kind: spec.queueKind,
      mode: spec.mode,
      prompt: c.prompt,
      output_path: `${spec.outputDir}/${c.id}${spec.outputExt}`,
      created_at: nowSec(),
    });
  }
  return { existingOutputs, enqueueableChunks };
}

/**
 * Wait → moderate → wait, looping until either no content-policy
 * failures remain, the round budget is exhausted, or moderation is
 * disabled. The first iteration always runs; subsequent iterations only
 * run when the moderator successfully rewrote at least one blocked
 * prompt.
 *
 * Returns:
 *   null → loop completed; caller should run aggregation.
 *   DeferSignal → cooldown deferral; caller should return it as-is.
 * Throws on timeout.
 */
async function runModerationLoop(
  videoId: string,
  chunksPath: string,
  deps: GoogleFlowStepDeps,
  spec: GoogleFlowStepSpec,
  nowSec: () => number
): Promise<DeferSignal | null> {
  const { db, log } = deps;

  const waitOpts = {
    db,
    pollIntervalMs: deps.pollIntervalMs,
    nowMs: deps.nowMs,
    nowSec: deps.nowSec,
    log,
    signal: deps.signal,
  };

  let waitResult = await waitForFlowQueue(videoId, spec.queueKind, waitOpts);
  if (!waitResult.ok) {
    if (waitResult.reason === "timeout") {
      throw new Error(
        `${spec.stepName}: timed out waiting for queue to drain`
      );
    }
    return { deferred: true, retryAfter: waitResult.retryAfter };
  }

  for (let iter = 0; iter < MAX_MODERATION_ITERATIONS_GUARD; iter++) {
    const didRewrite = await maybeModerate(
      videoId,
      chunksPath,
      deps,
      spec,
      nowSec
    );
    if (!didRewrite) break;

    waitResult = await waitForFlowQueue(videoId, spec.queueKind, waitOpts);
    if (!waitResult.ok) {
      if (waitResult.reason === "timeout") {
        throw new Error(
          `${spec.stepName}: timed out waiting for queue to drain`
        );
      }
      return { deferred: true, retryAfter: waitResult.retryAfter };
    }
  }

  return null;
}

/**
 * Failure aggregation is driven by "is the chunk's output missing?"
 * rather than "does a failed row exist?". After a Restart or a
 * Requeue-failed followed by a successful retry, stale `failed` rows can
 * reference a chunk whose file now exists on disk; those must not trip
 * the throw.
 */
function aggregateFailures(
  videoId: string,
  projectDir: string,
  deps: GoogleFlowStepDeps,
  spec: GoogleFlowStepSpec
): void {
  const { db } = deps;
  const failed = gfRepo
    .listFailedForVideo(db, videoId)
    .filter((r) => r.kind === spec.queueKind)
    .filter((r) => !existsSync(join(projectDir, r.output_path)));
  if (failed.length > 0) {
    const summary = failed
      .map((r) => `${r.chunk_id ?? `#${r.id}`}: ${r.error_reason ?? "unknown"}`)
      .join("; ");
    throw new Error(
      `${spec.stepName}: ${failed.length} chunk(s) failed — ${summary}`
    );
  }
}

/**
 * Run one moderation round if conditions allow. Returns true iff at
 * least one queue row was actually rewritten and requeued (so the caller
 * should re-enter waitForFlowQueue). False signals "fall through to the
 * existing aggregation throw" — moderation disabled, no content-policy
 * failures, or the round budget is exhausted.
 *
 * Atomicity contract: moderation_events inserts and queue requeues land
 * in a single SQLite transaction; chunks.json is written once after the
 * txn commits. A crash between the txn and the disk write leaves
 * chunks.json slightly stale (missing the new prompt_history entry),
 * which is harmless — the queue rows already carry the new prompt and
 * moderation_events is the canonical record.
 */
async function maybeModerate(
  videoId: string,
  chunksPath: string,
  deps: GoogleFlowStepDeps,
  spec: GoogleFlowStepSpec,
  nowSec: () => number
): Promise<boolean> {
  const { db, log } = deps;
  if (!getSetting("google_flow_content_moderation_enabled", db)) {
    return false;
  }

  const failed = gfRepo.listFailedContentPolicyForVideo(
    db,
    videoId,
    spec.queueKind
  );
  if (failed.length === 0) return false;

  const maxRounds = getSetting(
    "google_flow_content_moderation_max_rounds",
    db
  );
  const nextRound =
    Math.max(...failed.map((r) => r.moderation_round)) + 1;
  if (nextRound > maxRounds) return false;

  const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
  const { items, reasonTagById } = buildModerationItems(
    chunks,
    failed,
    spec
  );
  if (items.length === 0) return false;

  log(`[moderation] round ${nextRound}: rewriting ${items.length} blocked prompt(s)`);
  const rewrites = await deps.moderator.moderate(items, nextRound);

  const writes = applyModerationRewrites(
    chunks,
    failed,
    rewrites,
    reasonTagById
  );
  if (writes.length === 0) return false;

  const created_at = nowSec();
  flowLifecycle.recordModerationBatch(
    db,
    writes.map((w) => ({
      videoId,
      chunkId: w.chunkId,
      kind: spec.queueKind,
      round: nextRound,
      originalPrompt: w.originalPrompt,
      rewritten: w.rewritten,
      reasonTag: w.reasonTag,
      createdAt: created_at,
      rowId: w.row.id,
    }))
  );

  // Logs and the chunks.json write happen after the txn — both touch
  // the filesystem and have no business inside a SQLite transaction.
  for (const w of writes) {
    log(
      `[moderation r${nextRound}] ${w.chunkId} (${w.reasonTag ?? "?"}) → ${w.rewritten.slice(0, 80)}…`
    );
  }
  writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  return true;
}

type FailedRow = ReturnType<typeof gfRepo.listFailedContentPolicyForVideo>[number];

/**
 * Build the ModerationItem array the LLM consumes plus a side-table
 * mapping chunk_id → its canonical reason_tag (used later when writing
 * moderation_events).
 */
function buildModerationItems(
  chunks: Chunk[],
  failed: FailedRow[],
  spec: GoogleFlowStepSpec
): { items: ModerationItem[]; reasonTagById: Map<string, string | null> } {
  const indexById = new Map(chunks.map((c, i) => [c.id, i] as const));
  const items: ModerationItem[] = [];
  const reasonTagById = new Map<string, string | null>();
  for (const row of failed) {
    if (!row.chunk_id) continue;
    const idx = indexById.get(row.chunk_id);
    if (idx === undefined) continue;
    const tag = extractContentPolicyTag(row.error_reason ?? "");
    reasonTagById.set(row.chunk_id, tag);
    items.push({
      id: row.chunk_id,
      kind: spec.queueKind,
      reason_tag: tag ?? row.error_reason ?? "",
      prev_text: idx > 0 ? chunks[idx - 1].text : "",
      current_text: chunks[idx].text,
      next_text: idx < chunks.length - 1 ? chunks[idx + 1].text : "",
      original_prompt: row.prompt,
    });
  }
  return { items, reasonTagById };
}

interface ModerationWrite {
  row: FailedRow;
  chunkId: string;
  rewritten: string;
  reasonTag: string | null;
  originalPrompt: string;
}

/**
 * Mutate `chunks` in place with the moderator's rewrites and return the
 * write list the caller will commit to SQLite. Only chunks the moderator
 * actually returned a rewrite for are touched. The previous prompt
 * (when non-null) is appended to prompt_history before the new prompt
 * lands.
 */
function applyModerationRewrites(
  chunks: Chunk[],
  failed: FailedRow[],
  rewrites: Map<string, string>,
  reasonTagById: Map<string, string | null>
): ModerationWrite[] {
  const byId = new Map(chunks.map((c) => [c.id, c] as const));
  const writes: ModerationWrite[] = [];
  for (const row of failed) {
    if (!row.chunk_id) continue;
    const rewritten = rewrites.get(row.chunk_id);
    if (!rewritten) continue;
    const chunk = byId.get(row.chunk_id);
    if (!chunk) continue;
    const history = chunk.prompt_history ?? [];
    if (chunk.prompt != null) history.push(chunk.prompt);
    chunk.prompt_history = history;
    chunk.prompt = rewritten;
    writes.push({
      row,
      chunkId: row.chunk_id,
      rewritten,
      reasonTag: reasonTagById.get(row.chunk_id) ?? null,
      originalPrompt: row.prompt,
    });
  }
  return writes;
}
