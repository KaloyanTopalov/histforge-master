import type { Database as DatabaseType } from "better-sqlite3";
import type {
  MagnificQueueItem,
  MagnificQueueMode,
  MagnificQueueStatus,
} from "@/types";

/**
 * Magnific repository — atomic SQL wrappers over the `magnific_queue`
 * table for the music-video kind's image-hitl and image-to-video steps.
 *
 * Single-account semantics: no assigned_account_id, no per-account FK.
 * The single Magnific token lives in the settings table; route auth
 * compares the URL [token] segment against that key. Per ADR-0012.
 *
 * Queue is keyed on (video, mode): each music-video row enqueues at
 * most one row per mode, and `findOpenTaskForVideo({video, mode})`
 * lets the worker step skip re-enqueueing on re-entry.
 */

// ─── Insert + lookup ──────────────────────────────────────────────────

/**
 * Insert a pending queue row for a (video, mode). Returns the auto-
 * assigned numeric id. Callers are responsible for idempotence — use
 * `findOpenTaskForVideo` before enqueuing on re-entry.
 *
 * `no_timeout` defaults to 0 (reaper-eligible). The image-hitl step
 * passes `no_timeout: 1` because operator selection can legitimately
 * take days; image-to-video leaves it 0.
 */
export function enqueueTask(
  db: DatabaseType,
  input: {
    video_id: string;
    mode: MagnificQueueMode;
    prompt: string;
    output_path: string;
    reference_image?: string | null;
    no_timeout?: 0 | 1;
    created_at: number;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO magnific_queue (
         video_id, mode, prompt, reference_image, output_path,
         status, no_timeout, created_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      input.video_id,
      input.mode,
      input.prompt,
      input.reference_image ?? null,
      input.output_path,
      input.no_timeout ?? 0,
      input.created_at
    );
  return Number(info.lastInsertRowid);
}

export function findTaskById(
  db: DatabaseType,
  id: number
): MagnificQueueItem | undefined {
  return db
    .prepare("SELECT * FROM magnific_queue WHERE id = ?")
    .get(id) as MagnificQueueItem | undefined;
}

export function findTaskByExternalId(
  db: DatabaseType,
  externalTaskId: string
): MagnificQueueItem | undefined {
  return db
    .prepare("SELECT * FROM magnific_queue WHERE external_task_id = ?")
    .get(externalTaskId) as MagnificQueueItem | undefined;
}

/**
 * Any non-done, non-failed row for the (video, mode) — used by the
 * step to avoid re-enqueueing on re-entry. Mode-keyed because the
 * two music-video producer steps (generate_loop_image,
 * generate_loop_clip) coexist for the same video.
 */
export function findOpenTaskForVideo(
  db: DatabaseType,
  videoId: string,
  mode: MagnificQueueMode
): MagnificQueueItem | undefined {
  return db
    .prepare(
      `SELECT * FROM magnific_queue
        WHERE video_id = ? AND mode = ?
          AND status NOT IN ('done', 'failed')
        LIMIT 1`
    )
    .get(videoId, mode) as MagnificQueueItem | undefined;
}

// ─── Atomic claim ─────────────────────────────────────────────────────

/**
 * Atomically claim the oldest pending row. Returns the dispatched row
 * or null when no pending row exists.
 *
 * `external_task_id` is minted as `${id}_${nowUnix}` so each claim
 * yields a fresh value — the extension's in-memory dedup
 * (processedJobIds) never blocks a requeued row. HistForge never
 * parses this value; lookups go through `findTaskByExternalId`.
 *
 * The SELECT + UPDATE-with-status='pending' guard inside a single
 * transaction is equivalent to SQLite's RETURNING idiom and avoids
 * introducing a new syntax for this repo.
 *
 * The JOIN on `videos` filters out rows belonging to a paused video so
 * the extension never picks up work the user has asked us to halt.
 */
export function takeNextTask(
  db: DatabaseType,
  nowUnix: number
): MagnificQueueItem | null {
  return db.transaction(() => {
    const head = db
      .prepare(
        `SELECT q.id FROM magnific_queue q
            JOIN videos v ON v.id = q.video_id
          WHERE q.status = 'pending' AND v.paused = 0
          ORDER BY q.id ASC
          LIMIT 1`
      )
      .get() as { id: number } | undefined;
    if (!head) return null;
    const externalTaskId = `${head.id}_${nowUnix}`;
    const info = db
      .prepare(
        `UPDATE magnific_queue
            SET status = 'dispatched',
                dispatched_at = ?,
                external_task_id = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(nowUnix, externalTaskId, head.id);
    if (info.changes === 0) return null; // another claim won the race.
    return findTaskById(db, head.id) ?? null;
  })();
}

// ─── Completion + failure ─────────────────────────────────────────────

export function submitResult(
  db: DatabaseType,
  id: number,
  resultUrl: string,
  completedAtUnix: number
): void {
  db.prepare(
    `UPDATE magnific_queue
        SET status = 'done', result_url = ?, completed_at = ?
      WHERE id = ?`
  ).run(resultUrl, completedAtUnix, id);
}

export function failTask(
  db: DatabaseType,
  id: number,
  reason: string
): void {
  db.prepare(
    "UPDATE magnific_queue SET status = 'failed', error_reason = ? WHERE id = ?"
  ).run(reason, id);
}

// ─── Requeue + reset ──────────────────────────────────────────────────

/**
 * Reset a row back to pending and clear the dispatch quality-of-life
 * fields. The external_task_id reset is the important one: the next
 * claim mints a fresh value so the extension's dedup doesn't skip the
 * row. retry_count is intentionally preserved — callers bump it
 * separately if they want.
 */
export function requeueTask(db: DatabaseType, id: number): void {
  db.prepare(
    `UPDATE magnific_queue
        SET status = 'pending',
            dispatched_at = NULL,
            external_task_id = NULL,
            error_reason = NULL
      WHERE id = ?`
  ).run(id);
}

/**
 * Worker-boot recovery: flip every dispatched row back to pending and
 * wipe the dispatch quality-of-life fields. Any extension submissions
 * that arrive afterwards hit `findTaskByExternalId` misses — the
 * submit-result handler treats those as duplicates (state-tolerant).
 */
export function resetAllDispatchedOnStartup(db: DatabaseType): void {
  db.prepare(
    `UPDATE magnific_queue
        SET status = 'pending',
            dispatched_at = NULL,
            external_task_id = NULL
      WHERE status = 'dispatched'`
  ).run();
}

// ─── HITL gate (no_timeout) ───────────────────────────────────────────

export function setNoTimeout(db: DatabaseType, id: number): void {
  db.prepare("UPDATE magnific_queue SET no_timeout = 1 WHERE id = ?").run(id);
}

export function clearNoTimeout(db: DatabaseType, id: number): void {
  db.prepare("UPDATE magnific_queue SET no_timeout = 0 WHERE id = ?").run(id);
}

// ─── Read-side helpers ────────────────────────────────────────────────

/**
 * Zero-filled status histogram for (video, mode). Used by the wait
 * helper and the queue-summary endpoint.
 */
export function countByStatusForVideo(
  db: DatabaseType,
  videoId: string,
  mode: MagnificQueueMode
): Record<MagnificQueueStatus, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
         FROM magnific_queue
        WHERE video_id = ? AND mode = ?
        GROUP BY status`
    )
    .all(videoId, mode) as Array<{ status: MagnificQueueStatus; n: number }>;
  const out: Record<MagnificQueueStatus, number> = {
    pending: 0,
    dispatched: 0,
    done: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/**
 * Video-wide status histogram across both modes. Used by the dashboard
 * queue-summary endpoint; the wait helper still uses the mode-keyed
 * `countByStatusForVideo` because it polls one mode at a time.
 */
export function countByStatusForVideoAllModes(
  db: DatabaseType,
  videoId: string
): Record<MagnificQueueStatus, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
         FROM magnific_queue
        WHERE video_id = ?
        GROUP BY status`
    )
    .all(videoId) as Array<{ status: MagnificQueueStatus; n: number }>;
  const out: Record<MagnificQueueStatus, number> = {
    pending: 0,
    dispatched: 0,
    done: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

/**
 * Output paths of non-failed rows for a (video, mode). The narrative
 * image-batch provider uses this for resume idempotency: the magnific_queue
 * has no chunk_id column, so output_path is the per-chunk identity. Rows in
 * pending/dispatched/done all count as "already covered" and are skipped on
 * re-entry; failed rows are excluded so a re-run enqueues a fresh attempt
 * (mirrors the google_flow producer's treatment of settled failed rows).
 */
export function listActiveOutputPaths(
  db: DatabaseType,
  videoId: string,
  mode: MagnificQueueMode
): string[] {
  return (
    db
      .prepare(
        `SELECT output_path FROM magnific_queue
          WHERE video_id = ? AND mode = ? AND status != 'failed'`
      )
      .all(videoId, mode) as Array<{ output_path: string }>
  ).map((r) => r.output_path);
}

/**
 * Latest dispatched HITL row for a video, if any. Powers the magnific
 * HITL banner: the banner pops only once the row is dispatched (the
 * extension has claimed it and opened/focused the Magnific tab), and
 * only for no_timeout=1 rows (operator-blocking image-hitl in v1; the
 * image-to-video mode rides the reaper requeue path on hang).
 */
export function findDispatchedHitlForVideo(
  db: DatabaseType,
  videoId: string
): MagnificQueueItem | undefined {
  return db
    .prepare(
      `SELECT * FROM magnific_queue
        WHERE video_id = ?
          AND status = 'dispatched'
          AND no_timeout = 1
        ORDER BY id DESC
        LIMIT 1`
    )
    .get(videoId) as MagnificQueueItem | undefined;
}

/**
 * Rows stuck in `dispatched` past the age cutoff. Used by the reaper.
 * `nowUnix` is injected so tests can freeze time; production callers
 * pass `Math.floor(Date.now() / 1000)`.
 *
 * `onlyNoTimeoutZero=true` excludes HITL rows (no_timeout=1) so the
 * reaper's dispatch-age requeue pass never disrupts operator-blocking
 * work — per ADR-0012 §Decision 4. Passing false includes every
 * dispatched row regardless of the HITL gate (used only by tests /
 * diagnostic listings).
 */
export function listStaleDispatched(
  db: DatabaseType,
  maxAgeSec: number,
  nowUnix: number,
  onlyNoTimeoutZero: boolean
): MagnificQueueItem[] {
  const cutoff = nowUnix - maxAgeSec;
  const noTimeoutClause = onlyNoTimeoutZero ? " AND no_timeout = 0" : "";
  return db
    .prepare(
      `SELECT * FROM magnific_queue
        WHERE status = 'dispatched' AND dispatched_at < ?${noTimeoutClause}
        ORDER BY id ASC`
    )
    .all(cutoff) as MagnificQueueItem[];
}
