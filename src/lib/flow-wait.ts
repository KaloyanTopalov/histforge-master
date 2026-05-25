import type { Database as DatabaseType } from "better-sqlite3";
import type { GoogleFlowQueueKind } from "@/types";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import { getSetting } from "@/lib/settings";

export type FlowWaitResult =
  | { ok: true }
  | { ok: false; reason: "stalled"; retryAfter: number }
  | { ok: false; reason: "paused"; retryAfter: number }
  | { ok: false; reason: "deleted"; retryAfter: number }
  | { ok: false; reason: "timeout" };

export interface WaitForFlowQueueOpts {
  /** Database handle. */
  db: DatabaseType;
  /** Poll interval in ms. Default 5000. */
  pollIntervalMs?: number;
  /** Wall-clock cap per call. Default 24h. */
  timeoutMs?: number;
  /** Optional log sink — the caller's per-step appendLog binding. */
  log?: (message: string) => void;
  /**
   * Cancellation signal from the orchestrator. When aborted, the wait
   * yields with reason="deleted" exactly like the readDeleteRequested
   * branch — the signal path lowers cancellation latency to "next
   * iteration" instead of waiting for the next DB poll.
   */
  signal?: AbortSignal;
  /**
   * Test hooks: `nowMs` and `nowSec` are independent so tests can
   * exercise the timeout path without advancing wall-clock time for the
   * stalled-retryAfter fallback. `onTick` runs after each poll and is
   * used to mutate the queue in-flight.
   */
  nowMs?: () => number;
  nowSec?: () => number;
  onTick?: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const STALLED_FALLBACK_SEC = 30 * 60;

/**
 * Wait for a Flow queue slice (one video + kind) to drain. Terminates with
 * {ok: true} when every row is done/failed, {ok: false, reason: "stalled"}
 * when nothing is in flight and no account is available to pick up
 * pending rows, or {ok: false, reason: "timeout"} after the wall-clock
 * cap. Failed rows are surfaced to the caller through {ok: true} — the
 * caller inspects the queue separately and throws an aggregated error.
 *
 * The 24h cap is per re-entry, not cumulative across defers. A video can
 * stay in the Flow step indefinitely while accounts cycle through
 * cooldowns; the orchestrator just moves on to other videos.
 */
export async function waitForFlowQueue(
  videoId: string,
  kind: GoogleFlowQueueKind,
  opts: WaitForFlowQueueOpts
): Promise<FlowWaitResult> {
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const nowMs = opts.nowMs ?? (() => Date.now());
  const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const startMs = nowMs();
  while (true) {
    const counts = gfRepo.countByStatusForVideo(opts.db, videoId, kind);
    const openRows = counts.pending + counts.dispatched;
    if (openRows === 0) {
      return { ok: true };
    }

    // Delete-requested: yield immediately so the orchestrator's
    // between-step delete hook can wipe the project + rows. Without this
    // the runner stays blocked on `await runPipeline` while the wait
    // function polls forever, and `delete_requested=1` never gets read
    // (spec: delete wins over pause; this is the in-flight equivalent).
    // The orchestrator-driven AbortSignal is the lower-latency path; the
    // DB poll remains as a fallback for callers that don't pass a signal.
    if (
      opts.signal?.aborted ||
      videosRepo.readDeleteRequested(opts.db, videoId)
    ) {
      const retryAfter = nowSec();
      opts.log?.(
        `waitForFlowQueue: delete requested — yielding`
      );
      return { ok: false, reason: "deleted", retryAfter };
    }

    // Hard-pause: global queue pause or per-video pause yields the step
    // back to the orchestrator so it can honor the pause between steps.
    // retryAfter is now() so the defer clears the moment pause lifts —
    // the orchestrator's paused=0 / queue_state filters keep the video
    // from being picked up again until then.
    if (
      getSetting("queue_state", opts.db) === "paused" ||
      videosRepo.readPaused(opts.db, videoId)
    ) {
      const retryAfter = nowSec();
      opts.log?.(
        `waitForFlowQueue: paused — ${counts.pending} pending, ${counts.dispatched} dispatched; yielding`
      );
      return { ok: false, reason: "paused", retryAfter };
    }

    // "Stalled" means we're not just waiting for in-flight work — no row
    // is dispatched, and there's nothing that can claim the pending
    // rows. Yielding lets the orchestrator move on.
    if (counts.dispatched === 0 && !gfRepo.anyAccountAvailable(opts.db)) {
      const paused = gfRepo.firstAccountPausedUntil(opts.db);
      const retryAfter = paused ?? nowSec() + STALLED_FALLBACK_SEC;
      opts.log?.(
        `waitForFlowQueue: stalled — ${counts.pending} pending, no account available; retryAfter=${retryAfter}`
      );
      return { ok: false, reason: "stalled", retryAfter };
    }

    if (nowMs() - startMs >= timeoutMs) {
      opts.log?.(
        `waitForFlowQueue: timeout after ${timeoutMs}ms — pending=${counts.pending} dispatched=${counts.dispatched}`
      );
      return { ok: false, reason: "timeout" };
    }

    await sleep(pollIntervalMs);
    opts.onTick?.();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
