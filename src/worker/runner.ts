import type { Database as DatabaseType } from "better-sqlite3";
import * as videosRepo from "@/lib/repos/videos";
import * as stepsRepo from "@/lib/repos/steps";
import { getSetting } from "@/lib/settings";

/**
 * Startup normalization for crash recovery.
 *
 * After a crash, video_steps rows can be left in 'running' state — the worker
 * was definitely not running them at the moment it died, so they're stale.
 * Reset them to 'pending' once on startup so the orchestrator never has
 * to handle a 'running' row mid-iteration.
 */
export function resetStaleRunningSteps(db: DatabaseType): void {
  stepsRepo.resetAllRunningToPending(db);
}

/**
 * The reason a video was selected for execution. The runner uses this to
 * decide whether to set `started_at` (only on `start`, not on `resume`).
 */
export type PickReason = "resume" | "start";

export interface PickedVideo {
  id: string;
  reason: PickReason;
}

/**
 * Decide what the worker should run next, or `null` if it should idle.
 *
 * Resolution order:
 *   1. `delete_requested=1` short-circuit: pick it regardless of queue
 *      pause, video pause, or defer. The orchestrator's between-step
 *      hook is the only place that wipes the project dir + rows, so if
 *      we let pause gates block us here the delete stays stuck forever
 *      (spec: delete wins over pause).
 *   2. Global pause short-circuit: if `queue_state='paused'`, idle.
 *   3. If any unpaused video has status='in_progress', that's a crash-
 *      recovery resume.
 *   4. If a paused in_progress video exists but the unpaused lookup
 *      returned none, idle rather than fall through to a queued row —
 *      preserves the one-at-a-time invariant.
 *   5. Otherwise, return the oldest unpaused queued video (FIFO by
 *      created_at).
 *
 * The `paused=0` filter for steps 3 and 5 is enforced at the SQL layer
 * in `findInProgressId` / `findOldestQueuedId`.
 */
export function pickNextVideo(db: DatabaseType): PickedVideo | null {
  const deleteId = videosRepo.findDeleteRequestedId(db);
  if (deleteId) {
    return { id: deleteId, reason: "resume" };
  }

  if (getSetting("queue_state", db) === "paused") {
    return null;
  }

  const inProgressId = videosRepo.findInProgressId(db);
  if (inProgressId) {
    return { id: inProgressId, reason: "resume" };
  }

  if (videosRepo.anyInProgressExists(db)) {
    return null;
  }

  const queuedId = videosRepo.findOldestQueuedId(db);
  if (queuedId) {
    return { id: queuedId, reason: "start" };
  }

  return null;
}

/**
 * Outcome of a single iteration. The loop uses this to decide its next sleep:
 *   - "worked"     → a video ran; try again immediately
 *   - "idle-empty" → no work; sleep 5s
 */
export type TickResult = "worked" | "idle-empty";

export type RunPipelineFn = (videoId: string) => Promise<void>;

/**
 * One iteration of the main loop. Picks a video (if any), marks it
 * `in_progress` (and stamps `started_at` only when fresh), then awaits
 * runPipeline.
 *
 * Pipeline failures are caught here so the loop never dies — failure
 * isolation per spec :693-694. The pipeline itself is responsible for
 * recording per-step status; this layer only ensures the worker keeps
 * running.
 */
export async function tickOnce(
  db: DatabaseType,
  runPipeline: RunPipelineFn
): Promise<TickResult> {
  const picked = pickNextVideo(db);
  if (!picked) {
    return "idle-empty";
  }

  // Mark in_progress and stamp started_at only if it is currently NULL.
  // The IS NULL guard preserves the original pickup time across resume
  // cycles (crash recovery).
  videosRepo.markInProgress(db, picked.id, Date.now());

  try {
    await runPipeline(picked.id);
  } catch {
    // Failure isolation: a failing pipeline must not stop the loop.
    // The pipeline itself records the failed status on the video row;
    // we deliberately swallow here.
  }
  return "worked";
}

/**
 * Sleep durations per result type.
 *  - "worked": 0 — try the next iteration immediately
 *  - "idle-empty": 5000 — no work, longest sleep
 */
const SLEEP_MS: Record<TickResult, number> = {
  worked: 0,
  "idle-empty": 5000,
};

export interface RunLoopOptions {
  /** Async sleep — overridable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Returns true to break the loop. Defaults to "never" (production). */
  shouldStop?: () => boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The worker's main loop. In production, runs forever — `shouldStop` exists
 * for tests and for graceful-shutdown hooks added later. Each iteration
 * calls `tickOnce`, then sleeps based on the result. Sleep happens AFTER
 * the tick (not before), so the loop is responsive to shutdown signals.
 */
export async function runLoop(
  db: DatabaseType,
  runPipeline: RunPipelineFn,
  options: RunLoopOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const shouldStop = options.shouldStop ?? (() => false);

  while (true) {
    const result = await tickOnce(db, runPipeline);
    await sleep(SLEEP_MS[result]);
    if (shouldStop()) {
      return;
    }
  }
}
