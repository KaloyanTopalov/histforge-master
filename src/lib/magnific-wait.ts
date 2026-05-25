import type { Database as DatabaseType } from "better-sqlite3";
import type { MagnificQueueMode } from "@/types";
import * as magnificRepo from "@/lib/repos/magnific";
import * as videosRepo from "@/lib/repos/videos";
import { getSetting } from "@/lib/settings";

export type MagnificWaitResult =
  | { ok: true }
  | { ok: false; reason: "paused"; retryAfter: number }
  | { ok: false; reason: "deleted"; retryAfter: number };

export interface WaitForMagnificQueueOpts {
  db: DatabaseType;
  pollIntervalMs?: number;
  log?: (message: string) => void;
  signal?: AbortSignal;
  nowSec?: () => number;
  onTick?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;

/**
 * Wait for a Magnific queue slice (one video + mode) to drain. Returns
 * {ok: true} when every row is done/failed, or {ok: false, reason:
 * "paused" | "deleted"} when the orchestrator should yield back.
 *
 * Differs from waitForFlowQueue in two ways: (1) no "stalled" return —
 * Magnific is single-account, so there is no "no account available"
 * condition; (2) no 24h cap — HITL can legitimately take days while the
 * operator gets around to picking a variation (handoff §HITL absorbs
 * latency).
 *
 * The AbortSignal is the primary cancellation path; the DB
 * delete_requested poll remains as a fallback for callers without a
 * signal.
 */
export async function waitForMagnificQueue(
  videoId: string,
  mode: MagnificQueueMode,
  opts: WaitForMagnificQueueOpts
): Promise<MagnificWaitResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  while (true) {
    const counts = magnificRepo.countByStatusForVideo(opts.db, videoId, mode);
    const openRows = counts.pending + counts.dispatched;
    if (openRows === 0) {
      return { ok: true };
    }

    if (
      opts.signal?.aborted ||
      videosRepo.readDeleteRequested(opts.db, videoId)
    ) {
      const retryAfter = nowSec();
      opts.log?.(
        `waitForMagnificQueue: delete requested — yielding`
      );
      return { ok: false, reason: "deleted", retryAfter };
    }

    if (
      getSetting("queue_state", opts.db) === "paused" ||
      videosRepo.readPaused(opts.db, videoId)
    ) {
      const retryAfter = nowSec();
      opts.log?.(
        `waitForMagnificQueue: paused — ${counts.pending} pending, ${counts.dispatched} dispatched; yielding`
      );
      return { ok: false, reason: "paused", retryAfter };
    }

    await sleep(pollIntervalMs);
    opts.onTick?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
