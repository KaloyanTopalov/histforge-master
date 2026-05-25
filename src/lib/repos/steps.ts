import type { Database as DatabaseType } from "better-sqlite3";
import type { VideoStep, VideoStepStatus } from "@/types";
import {
  getWorkflowFromDb,
  materializeStepList,
  resolveSnapshot,
} from "@/lib/workflows";

/**
 * video_steps repository — atomic SQL wrappers over the `video_steps`
 * table. Each exported function is either a single prepared statement OR
 * a single conceptual write that intrinsically spans rows (`deleteAllForVideo`,
 * `resetToPending`). Multi-statement compositions across distinct concerns
 * (retry, restart, recordStepFailure, enterStep) live in
 * `src/lib/lifecycle/video.ts` and compose these helpers.
 */

/**
 * Return all step rows for a video, sorted by the live workflow row's
 * materialized step ordering. Rows whose name is not in the materialized
 * list are dropped (orphan-safe). Returns an empty array when the video
 * row is missing or references an unknown workflow.
 *
 * Note: this is the dashboard-side render of step rows; the orchestrator
 * runs the snapshot pinned on the video. For an already-queued video,
 * the live workflow row may diverge from the snapshot if the workflow
 * was edited mid-flight — the dashboard view tracks the live row, which
 * is acceptable per Phase 1 plan (the snapshot pinned at queue time is
 * the orchestrator's source of truth, not this view).
 */
export function findByVideo(
  db: DatabaseType,
  videoId: string
): VideoStep[] {
  const video = db
    .prepare("SELECT workflow_id FROM videos WHERE id = ?")
    .get(videoId) as { workflow_id: string } | undefined;
  if (!video) return [];
  const workflow = getWorkflowFromDb(db, video.workflow_id);
  if (!workflow) return [];

  const slugs = materializeStepList(resolveSnapshot(db, workflow.id));

  const rows = db
    .prepare("SELECT * FROM video_steps WHERE video_id = ?")
    .all(videoId) as VideoStep[];
  const byName = new Map(rows.map((r) => [r.step_name, r]));
  return slugs
    .map((name) => byName.get(name))
    .filter((s): s is VideoStep => s !== undefined);
}

export function getStatus(
  db: DatabaseType,
  videoId: string,
  stepName: string
): VideoStepStatus | undefined {
  const row = db
    .prepare(
      "SELECT status FROM video_steps WHERE video_id = ? AND step_name = ?"
    )
    .get(videoId, stepName) as { status: VideoStepStatus } | undefined;
  return row?.status;
}

/**
 * Idempotent create of a pending row — used by the orchestrator's
 * pre-loop seeding. No-op if the (video_id, step_name) row already exists.
 */
export function upsertPending(
  db: DatabaseType,
  videoId: string,
  stepName: string
): void {
  db.prepare(
    "INSERT OR IGNORE INTO video_steps (video_id, step_name, status) VALUES (?, ?, 'pending')"
  ).run(videoId, stepName);
}

export function markRunning(
  db: DatabaseType,
  videoId: string,
  stepName: string,
  startedAt: number
): void {
  db.prepare(
    "UPDATE video_steps SET status = 'running', started_at = ?, finished_at = NULL WHERE video_id = ? AND step_name = ?"
  ).run(startedAt, videoId, stepName);
}

export function markDone(
  db: DatabaseType,
  videoId: string,
  stepName: string,
  finishedAt: number
): void {
  db.prepare(
    "UPDATE video_steps SET status = 'done', finished_at = ? WHERE video_id = ? AND step_name = ?"
  ).run(finishedAt, videoId, stepName);
}

export function markFailed(
  db: DatabaseType,
  videoId: string,
  stepName: string,
  finishedAt: number
): void {
  db.prepare(
    "UPDATE video_steps SET status = 'failed', finished_at = ? WHERE video_id = ? AND step_name = ?"
  ).run(finishedAt, videoId, stepName);
}

/**
 * Reset a specific step to pending and clear both timestamps. Used by
 * the retry flow.
 */
export function resetToPending(
  db: DatabaseType,
  videoId: string,
  stepName: string
): void {
  db.prepare(
    "UPDATE video_steps SET status = 'pending', started_at = NULL, finished_at = NULL WHERE video_id = ? AND step_name = ?"
  ).run(videoId, stepName);
}

/**
 * Crash-recovery normalization: flip every 'running' row in the DB to
 * 'pending'. Runs once at worker startup.
 */
export function resetAllRunningToPending(db: DatabaseType): void {
  db.prepare(
    "UPDATE video_steps SET status = 'pending' WHERE status = 'running'"
  ).run();
}

export function deleteAllForVideo(
  db: DatabaseType,
  videoId: string
): void {
  db.prepare("DELETE FROM video_steps WHERE video_id = ?").run(videoId);
}

export interface RuntimeSnapshot {
  /**
   * Sum of (finished_at - started_at) across every step that has both
   * timestamps set (done + failed). Always >= 0; videos with no started
   * steps yet read as 0 here.
   */
  runtime_ms: number;
  /**
   * `started_at` of the open step (started but not finished) for this
   * video, or null. The list page uses this to extrapolate the timer to
   * `now` between server polls — `runtime_ms` is the snapshot of work
   * already done, this is the in-flight piece.
   *
   * Only one open step is expected; if there were several MAX picks the
   * latest, but the orchestrator's one-step-at-a-time invariant rules
   * that out.
   */
  running_step_started_at: number | null;
}

/**
 * Per-video aggregate of step durations, used by the videos list API to
 * surface the same "total time" the detail page shows. Returned as a Map
 * keyed by video_id; videos with no step rows do not appear (the API
 * route falls back to {0, null} for them).
 */
export function runtimeSnapshots(
  db: DatabaseType
): Map<string, RuntimeSnapshot> {
  const rows = db
    .prepare(
      `SELECT
         video_id,
         COALESCE(SUM(CASE
           WHEN started_at IS NOT NULL AND finished_at IS NOT NULL
           THEN finished_at - started_at
           ELSE 0
         END), 0) AS runtime_ms,
         MAX(CASE
           WHEN started_at IS NOT NULL AND finished_at IS NULL
           THEN started_at
           ELSE NULL
         END) AS running_step_started_at
       FROM video_steps
       GROUP BY video_id`
    )
    .all() as Array<{
      video_id: string;
      runtime_ms: number;
      running_step_started_at: number | null;
    }>;

  const map = new Map<string, RuntimeSnapshot>();
  for (const row of rows) {
    map.set(row.video_id, {
      runtime_ms: row.runtime_ms,
      running_step_started_at: row.running_step_started_at,
    });
  }
  return map;
}
