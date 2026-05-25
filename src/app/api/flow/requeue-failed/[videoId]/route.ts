import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import * as flowLifecycle from "@/lib/lifecycle/flow";
import type { Chunk, GoogleFlowQueueItem } from "@/types";

interface RouteCtx {
  params: { videoId: string };
}

/**
 * Bulk-requeue Flow queue rows for a video. Acts on two row sets:
 *
 *   - `failed` rows whose `retry_count` is under `google_flow_max_retries`
 *     (force=1 bypasses the cap).
 *   - `dispatched` rows ("in flight"). The extension can drop these
 *     silently when its stop flag fires mid-task (STOP_REQUESTED is
 *     swallowed in runner.js without submitFailure), so operators need a
 *     manual on-demand path that doesn't wait for the reaper's
 *     google_flow_dispatch_timeout_minutes window.
 *
 * Uses `requeueTask` so the dispatch quality-of-life fields (including
 * `external_task_id`) are cleared — the next claim mints a fresh id so
 * the extension's in-memory dedup doesn't skip the row.
 *
 * On entry we re-read chunks.json and, for any failed row whose chunk
 * carries a prompt that has diverged from the queue row's `prompt`,
 * sync the queue row to the chunks.json prompt via `requeueWithNewPrompt`
 * with `moderation_round = 0`. This is the manual-override channel: the
 * automated moderation loop only writes back to chunks.json after its
 * own rewrites, so a divergent chunks.json prompt is *by construction*
 * an operator edit. Resetting `moderation_round` gives the new prompt a
 * fresh moderation budget if it still fails. A `moderation_events` row
 * with `round = 0, reason_tag = "manual_edit"` records the override for
 * audit. Dispatched rows are intentionally NOT prompt-synced: the
 * extension may submit a result for the old prompt before re-dispatch
 * lands, and the submit-result handler would then store an old-prompt
 * result against the new row.
 *
 * Coupling with the failed-step retry: when at least one row is
 * requeued AND the video is currently in `failed` status, the same
 * transaction also resets the failed step row to pending and clears
 * the video's failure metadata (mirroring `/api/videos/:id/retry`).
 * Without this, requeued rows sit pending forever — the runner only
 * picks `in_progress`/`queued` videos, so a `failed` video never
 * re-enters the step that would consume them.
 */
export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.videoId);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const force = new URL(req.url).searchParams.get("force") === "1";
  const maxRetries = getSetting("google_flow_max_retries", db);
  const failed = gfRepo.listFailedForVideo(db, ctx.params.videoId);
  const dispatched = gfRepo.listDispatchedForVideo(db, ctx.params.videoId);

  const eligibleFailed: GoogleFlowQueueItem[] = force
    ? failed
    : failed.filter((r) => r.retry_count < maxRetries);

  const totalRequeued = eligibleFailed.length + dispatched.length;

  const chunkPromptById = loadChunkPromptsByIdMap(ctx.params.videoId);
  const now = Math.floor(Date.now() / 1000);
  let promptsSynced = 0;
  let resumedFailedStep = false;

  // Outer txn so every per-row `requeueFailedTask` call (each opening its
  // own `db.transaction()`) commits or rolls back together. Inner
  // transactions nest as SAVEPOINTs under better-sqlite3.
  db.transaction(() => {
    for (const row of eligibleFailed) {
      const newPrompt =
        row.chunk_id != null ? chunkPromptById.get(row.chunk_id) : undefined;
      const result = flowLifecycle.requeueFailedTask(db, row, {
        newPrompt:
          newPrompt != null && newPrompt !== row.prompt ? newPrompt : undefined,
        chunkId: row.chunk_id,
        originalPrompt: row.prompt,
        reasonTag: "manual_edit",
        nowSec: now,
      });
      if (newPrompt != null && newPrompt !== row.prompt) promptsSynced++;
      if (result.videoUnfailed) resumedFailedStep = true;
    }
    for (const row of dispatched) {
      const result = flowLifecycle.requeueFailedTask(db, row, { nowSec: now });
      if (result.videoUnfailed) resumedFailedStep = true;
    }
  })();

  return NextResponse.json({
    ok: true,
    requeued: totalRequeued,
    requeuedFailed: eligibleFailed.length,
    requeuedDispatched: dispatched.length,
    promptsSynced,
    resumedFailedStep,
  });
}

/**
 * Read chunks.json for the video and return a map of `chunk_id → prompt`
 * for every chunk whose prompt is currently non-null. Missing files
 * yield an empty map — the bulk requeue still runs, it just skips the
 * sync step. Read failures are swallowed for the same reason: the
 * caller's failure mode is "no sync this round," not 500.
 */
function loadChunkPromptsByIdMap(videoId: string): Map<string, string> {
  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const chunksPath = join(projectsDir, videoId, "chunks", "chunks.json");
  if (!existsSync(chunksPath)) return new Map();
  try {
    const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    const out = new Map<string, string>();
    for (const c of chunks) {
      if (c.prompt != null) out.set(c.id, c.prompt);
    }
    return out;
  } catch {
    return new Map();
  }
}
