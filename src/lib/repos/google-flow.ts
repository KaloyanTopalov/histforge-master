import type { Database as DatabaseType } from "better-sqlite3";
import type {
  GoogleFlowAccount,
  GoogleFlowQueueItem,
  GoogleFlowQueueKind,
  GoogleFlowQueueMode,
  GoogleFlowQueueStatus,
  GoogleFlowVideoProject,
  ModerationEvent,
} from "@/types";
import { isContentPolicyError } from "@/lib/flow-error-classify";
import { FLOW_BUCKET_MODES, type FlowBucket } from "@/lib/flow-constants";

/**
 * Google Flow repository — atomic SQL wrappers over the
 * `google_flow_accounts` + `google_flow_queue` + `moderation_events` +
 * `google_flow_video_projects` tables. Each exported function is either
 * a single prepared statement OR a single conceptual write that
 * intrinsically spans tables/rows (e.g. `takeNextTaskForAccount`).
 * Multi-statement compositions across distinct concerns (the
 * submit-result category handlers, the claim flow, the moderation batch,
 * the account-deletion requeue, the cross-module requeue+unfail cascade)
 * live in `src/lib/lifecycle/flow.ts` and compose these helpers.
 *
 * Reaper, step-level enqueue/wait flow, and webhook handlers consume
 * either this repo or `flowLifecycle` depending on whether they're doing
 * a single-aggregate write or a multi-write transition.
 */

// ─── Accounts ─────────────────────────────────────────────────────────

export function listAccounts(db: DatabaseType): GoogleFlowAccount[] {
  return db
    .prepare("SELECT * FROM google_flow_accounts ORDER BY id ASC")
    .all() as GoogleFlowAccount[];
}

export function findAccountById(
  db: DatabaseType,
  id: string
): GoogleFlowAccount | undefined {
  return db
    .prepare("SELECT * FROM google_flow_accounts WHERE id = ?")
    .get(id) as GoogleFlowAccount | undefined;
}

export function findAccountByToken(
  db: DatabaseType,
  token: string
): GoogleFlowAccount | undefined {
  return db
    .prepare("SELECT * FROM google_flow_accounts WHERE token = ?")
    .get(token) as GoogleFlowAccount | undefined;
}

export function insertAccount(
  db: DatabaseType,
  input: { id: string; name: string; token: string; created_at: number }
): void {
  db.prepare(
    "INSERT INTO google_flow_accounts (id, name, token, created_at) VALUES (?, ?, ?, ?)"
  ).run(input.id, input.name, input.token, input.created_at);
}

export function deleteAccount(db: DatabaseType, id: string): void {
  db.prepare("DELETE FROM google_flow_accounts WHERE id = ?").run(id);
}

export function setAccountName(
  db: DatabaseType,
  id: string,
  name: string
): void {
  db.prepare("UPDATE google_flow_accounts SET name = ? WHERE id = ?").run(
    name,
    id
  );
}

export function setAccountEnabled(
  db: DatabaseType,
  id: string,
  enabled: boolean
): void {
  db.prepare("UPDATE google_flow_accounts SET enabled = ? WHERE id = ?").run(
    enabled ? 1 : 0,
    id
  );
}

export function pauseAccount(
  db: DatabaseType,
  id: string,
  untilUnix: number
): void {
  db.prepare(
    "UPDATE google_flow_accounts SET paused_until = ? WHERE id = ?"
  ).run(untilUnix, id);
}

export function resumeAccount(db: DatabaseType, id: string): void {
  db.prepare(
    "UPDATE google_flow_accounts SET paused_until = NULL WHERE id = ?"
  ).run(id);
}

/**
 * Stamp an operator-gated recovery state on the account. `reason` is a
 * discriminated union slot (`'captcha'` today; future reasons later) —
 * declared as raw string here so future entries can plug in without
 * touching the repo. The dispatch gate in next-task short-circuits while
 * `recovery_reason IS NOT NULL`; the operator clears via
 * {@link clearAccountRecovery} after re-engaging the Flow session.
 */
export function setAccountRecoveryReason(
  db: DatabaseType,
  id: string,
  reason: string,
  atUnix: number
): void {
  db.prepare(
    "UPDATE google_flow_accounts SET recovery_reason = ?, recovery_required_at = ? WHERE id = ?"
  ).run(reason, atUnix, id);
}

/**
 * Clear both recovery columns together. Partial clears would create
 * ambiguity about what `recovery_required_at IS NOT NULL` means without a
 * matching `recovery_reason` — symmetric NULL keeps the invariant tight.
 */
export function clearAccountRecovery(db: DatabaseType, id: string): void {
  db.prepare(
    "UPDATE google_flow_accounts SET recovery_reason = NULL, recovery_required_at = NULL WHERE id = ?"
  ).run(id);
}

/**
 * Narrow projection of accounts currently in operator-gated recovery,
 * ordered oldest-stuck-first so the banner surfaces the most-overdue
 * account at the top. Disabled accounts are filtered out — they never
 * dispatch, so prompting the operator to recover them would be wrong
 * (disabled wins over recovery_needed in `getAccountStatus` too).
 */
export function listRecoveryAccounts(
  db: DatabaseType
): Array<{ id: string; name: string; required_at: number }> {
  return db
    .prepare(
      `SELECT id, name, recovery_required_at AS required_at
         FROM google_flow_accounts
        WHERE recovery_reason IS NOT NULL
          AND enabled = 1
        ORDER BY recovery_required_at ASC`
    )
    .all() as Array<{ id: string; name: string; required_at: number }>;
}

export function updateAccountLastSeen(
  db: DatabaseType,
  id: string,
  atUnix: number
): void {
  db.prepare(
    "UPDATE google_flow_accounts SET last_seen_at = ? WHERE id = ?"
  ).run(atUnix, id);
}

export function updateAccountCredits(
  db: DatabaseType,
  id: string,
  credits: number,
  atUnix: number
): void {
  db.prepare(
    "UPDATE google_flow_accounts SET credits = ?, credits_updated_at = ? WHERE id = ?"
  ).run(credits, atUnix, id);
}

/**
 * Earliest `paused_until` across enabled accounts that are currently
 * paused. Used by the Flow step to compute `retryAfter` when it defers.
 * Returns null when no enabled+paused accounts exist.
 */
export function firstAccountPausedUntil(db: DatabaseType): number | null {
  const row = db
    .prepare(
      `SELECT MIN(paused_until) AS t
         FROM google_flow_accounts
        WHERE enabled = 1 AND paused_until IS NOT NULL`
    )
    .get() as { t: number | null };
  return row.t;
}

/**
 * True iff any enabled account is currently not paused. The deferred-
 * video watcher uses this to decide whether to wake a deferred video.
 */
export function anyAccountAvailable(db: DatabaseType): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS one
         FROM google_flow_accounts
        WHERE enabled = 1 AND paused_until IS NULL
        LIMIT 1`
    )
    .get() as { one: number } | undefined;
  return row !== undefined;
}

// ─── Queue ────────────────────────────────────────────────────────────

/**
 * Insert a pending queue row for a (video, chunk, kind). Returns the
 * auto-assigned numeric id. Callers are responsible for idempotence —
 * use findOpenTaskForChunk before enqueuing on re-entry.
 */
export function enqueueTask(
  db: DatabaseType,
  input: {
    video_id: string;
    chunk_id: string | null;
    kind: GoogleFlowQueueKind;
    mode: GoogleFlowQueueMode;
    prompt: string;
    output_path: string;
    reference_image?: string | null;
    start_frame?: string | null;
    end_frame?: string | null;
    priority?: number;
    created_at: number;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO google_flow_queue (
         video_id, chunk_id, kind, mode, prompt,
         reference_image, start_frame, end_frame,
         output_path, status, priority, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
    )
    .run(
      input.video_id,
      input.chunk_id,
      input.kind,
      input.mode,
      input.prompt,
      input.reference_image ?? null,
      input.start_frame ?? null,
      input.end_frame ?? null,
      input.output_path,
      input.priority ?? 0,
      input.created_at
    );
  return Number(info.lastInsertRowid);
}

export function findTaskById(
  db: DatabaseType,
  id: number
): GoogleFlowQueueItem | undefined {
  return db
    .prepare("SELECT * FROM google_flow_queue WHERE id = ?")
    .get(id) as GoogleFlowQueueItem | undefined;
}

export function findTaskByExternalId(
  db: DatabaseType,
  externalTaskId: string
): GoogleFlowQueueItem | undefined {
  return db
    .prepare("SELECT * FROM google_flow_queue WHERE external_task_id = ?")
    .get(externalTaskId) as GoogleFlowQueueItem | undefined;
}

/**
 * Any non-done, non-failed row for the (video, kind, chunk) — used by
 * the step to avoid re-enqueueing on re-entry. Returns undefined when
 * no open row exists.
 */
export function findOpenTaskForChunk(
  db: DatabaseType,
  videoId: string,
  kind: GoogleFlowQueueKind,
  chunkId: string | null
): GoogleFlowQueueItem | undefined {
  return db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE video_id = ? AND kind = ? AND chunk_id IS ?
          AND status NOT IN ('done', 'failed')
        LIMIT 1`
    )
    .get(videoId, kind, chunkId) as GoogleFlowQueueItem | undefined;
}

/**
 * Any `failed` row for the (video, kind, chunk) whose `error_reason`
 * the moderator will revive on the next pass. Used by the step to
 * avoid double-enqueueing on re-entry after a `Retry failed step`:
 * the failed row is *not* settled in spirit — the moderation loop
 * will pick it up and requeue with a rewritten prompt — so enqueueing
 * a parallel new row would double both the dispatch cost and the
 * eventual `done` rows (race on the same output_path). Returns
 * undefined when no such row exists or when every failure is
 * non-moderation-eligible (timeout, download_failed, etc.) — those
 * are genuinely settled and a fresh enqueue is the right behavior.
 *
 * Scans every failed row for the (video, kind, chunk) rather than
 * `LIMIT 1`. A chunk can accumulate multiple failed rows — e.g. a
 * timeout-exhausted row from a prior run plus a content-policy row
 * from a retry — and the moderator decides eligibility per row via
 * {@link listFailedContentPolicyForVideo}. Mirroring that filter here
 * keeps the two predicates in lockstep, so anything the moderator
 * will revive blocks the re-enqueue.
 */
export function findRevivableFailedTaskForChunk(
  db: DatabaseType,
  videoId: string,
  kind: GoogleFlowQueueKind,
  chunkId: string | null
): GoogleFlowQueueItem | undefined {
  const rows = db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE video_id = ? AND kind = ? AND chunk_id IS ?
          AND status = 'failed' AND error_reason IS NOT NULL`
    )
    .all(videoId, kind, chunkId) as GoogleFlowQueueItem[];
  return rows.find((r) => isContentPolicyError(r.error_reason ?? ""));
}

/**
 * Atomically claim the highest-priority pending row for the account.
 * Returns the dispatched row or null when no pending row exists.
 *
 * Dispatch-qualifies external_task_id as `${id}_${now}` — each claim
 * mints a fresh value so the extension's in-memory dedup
 * (processedJobIds) never blocks a requeued row. HistForge never
 * parses this value; lookups go through findTaskByExternalId.
 *
 * The SELECT + UPDATE-with-status='pending' guard inside a single
 * transaction is equivalent to SQLite's RETURNING idiom and avoids
 * introducing a new syntax for this repo.
 *
 * The JOIN on `videos` filters out rows belonging to a paused video so
 * the extension never picks up work the user has asked us to halt.
 * In-flight (`dispatched`) rows are not affected — the extension will
 * finish those and submit results normally; only NEW dispatches are
 * gated.
 */
export function takeNextTaskForAccount(
  db: DatabaseType,
  accountId: string,
  nowUnix: number,
  bucket?: FlowBucket
): GoogleFlowQueueItem | null {
  return db.transaction(() => {
    // When `bucket` is set we narrow the SELECT to its mode set so the
    // extension's free-capacity bucket actually gets a matching row
    // (or null, never a wrong-bucket dispatch).
    const modes = bucket ? FLOW_BUCKET_MODES[bucket] : null;
    const modeClause = modes
      ? ` AND q.mode IN (${modes.map(() => "?").join(", ")})`
      : "";
    const head = db
      .prepare(
        `SELECT q.id FROM google_flow_queue q
            JOIN videos v ON v.id = q.video_id
          WHERE q.status = 'pending' AND v.paused = 0${modeClause}
          ORDER BY q.priority DESC, q.id ASC
          LIMIT 1`
      )
      .get(...(modes ?? [])) as { id: number } | undefined;
    if (!head) return null;
    const externalTaskId = `${head.id}_${nowUnix}`;
    const info = db
      .prepare(
        `UPDATE google_flow_queue
            SET status = 'dispatched',
                assigned_account_id = ?,
                dispatched_at = ?,
                external_task_id = ?
          WHERE id = ? AND status = 'pending'`
      )
      .run(accountId, nowUnix, externalTaskId, head.id);
    if (info.changes === 0) return null; // another claim won the race.
    return findTaskById(db, head.id) ?? null;
  })();
}

/**
 * Record the Google operation a successful submit returned, so a later
 * requeue can resume polling instead of re-submitting (and creating a
 * duplicate gallery entry). Last-writer-wins: a NOT_FOUND fallback that
 * triggers a fresh submit just overwrites the stale pair. Touches only
 * the two operation columns — status, retry_count, external_task_id and
 * the rest of the dispatch quality-of-life fields are untouched.
 */
export function setOperationStarted(
  db: DatabaseType,
  id: number,
  operationId: string,
  operationProjectId: string
): void {
  db.prepare(
    `UPDATE google_flow_queue
        SET google_operation_id = ?,
            google_operation_project_id = ?
      WHERE id = ?`
  ).run(operationId, operationProjectId, id);
}

export function completeTask(
  db: DatabaseType,
  id: number,
  resultUrl: string,
  completedAtUnix: number
): void {
  db.prepare(
    `UPDATE google_flow_queue
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
    "UPDATE google_flow_queue SET status = 'failed', error_reason = ? WHERE id = ?"
  ).run(reason, id);
}

/**
 * Increment retry_count by 1. Decoupled from requeueTask so callers
 * can decide whether to bump (transient errors) or preserve (reaper
 * recovery) the retry tally.
 */
export function bumpRetryCount(db: DatabaseType, id: number): void {
  db.prepare(
    "UPDATE google_flow_queue SET retry_count = retry_count + 1 WHERE id = ?"
  ).run(id);
}

/**
 * Reset a row back to pending and clear the dispatch quality-of-life
 * fields (assigned_account_id, dispatched_at, external_task_id). The
 * external_task_id reset is the important one: the next claim will
 * mint a fresh value so the extension's dedup doesn't skip the row.
 * retry_count is intentionally preserved — callers bump it separately.
 *
 * `google_operation_id` is cleared *only* when the current row status
 * is `failed`. A failed operation on Google's side is in a terminal
 * state — having the SW resume-poll it (via the `googleOperationId`
 * resume hint in next-task) just returns the same failure forever. A
 * `dispatched` row, by contrast, may still have a live operation on
 * Google's side (reaper-account-stale, worker-restart, transient retry
 * paths); keeping operation_id lets the SW resume the live op instead
 * of submitting fresh and creating a duplicate gallery entry.
 */
export function requeueTask(db: DatabaseType, id: number): void {
  db.prepare(
    `UPDATE google_flow_queue
        SET status = 'pending',
            assigned_account_id = NULL,
            dispatched_at = NULL,
            external_task_id = NULL,
            google_operation_id = CASE
              WHEN status = 'failed' THEN NULL
              ELSE google_operation_id
            END,
            google_operation_project_id = CASE
              WHEN status = 'failed' THEN NULL
              ELSE google_operation_project_id
            END
      WHERE id = ?`
  ).run(id);
}

export function countByStatusForVideo(
  db: DatabaseType,
  videoId: string,
  kind: GoogleFlowQueueKind
): Record<GoogleFlowQueueStatus, number> {
  const rows = db
    .prepare(
      `SELECT status, COUNT(*) AS n
         FROM google_flow_queue
        WHERE video_id = ? AND kind = ?
        GROUP BY status`
    )
    .all(videoId, kind) as Array<{ status: GoogleFlowQueueStatus; n: number }>;
  const out: Record<GoogleFlowQueueStatus, number> = {
    pending: 0,
    dispatched: 0,
    done: 0,
    failed: 0,
  };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

export function listFailedForVideo(
  db: DatabaseType,
  videoId: string
): GoogleFlowQueueItem[] {
  return db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE video_id = ? AND status = 'failed'
        ORDER BY id ASC`
    )
    .all(videoId) as GoogleFlowQueueItem[];
}

/**
 * Rows the operator may want to intervene on: every `failed` row, plus
 * any non-`done` row that the moderation loop has already rewritten
 * (`moderation_round > 0`). The second set lets the dashboard keep the
 * "manual review" card visible while an automatic rewrite is mid-flight —
 * without this, the card disappears the moment moderation requeues a row
 * and reappears only if the next attempt also fails, which leaves the
 * operator with no affordance to override a still-in-progress retry.
 */
export function listRowsNeedingReview(
  db: DatabaseType,
  videoId: string
): GoogleFlowQueueItem[] {
  return db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE video_id = ?
          AND (
            status = 'failed'
            OR (status != 'done' AND moderation_round > 0)
          )
        ORDER BY id ASC`
    )
    .all(videoId) as GoogleFlowQueueItem[];
}

/**
 * Failed rows for (video, kind) whose error_reason looks like a
 * content-policy rejection — input to the moderation loop. The regex
 * doesn't live in SQL: the per-kind row count is small (one per chunk)
 * so an in-memory filter via the shared classifier keeps the policy
 * definition in one place.
 */
export function listFailedContentPolicyForVideo(
  db: DatabaseType,
  videoId: string,
  kind: GoogleFlowQueueKind
): GoogleFlowQueueItem[] {
  const rows = db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE video_id = ? AND kind = ? AND status = 'failed'
          AND error_reason IS NOT NULL
        ORDER BY id ASC`
    )
    .all(videoId, kind) as GoogleFlowQueueItem[];
  return rows.filter((r) => isContentPolicyError(r.error_reason ?? ""));
}

/**
 * Single transactional update for a moderation rewrite: install the
 * new prompt, flip back to pending, bump moderation_round, and clear
 * the dispatch quality-of-life fields + error_reason. retry_count is
 * intentionally preserved — moderation is a separate dimension from
 * transient retries, and prior transient attempts on this row should
 * still count toward the cap.
 *
 * `google_operation_id` is *always* cleared (regardless of source
 * status) because a different prompt is by definition a different
 * operation — resuming an existing operation would silently still run
 * the old prompt on Google, ignoring the rewrite. Same applies to
 * operator manual_edit calls (they share this function).
 */
export function requeueWithNewPrompt(
  db: DatabaseType,
  id: number,
  newPrompt: string,
  newRound: number
): void {
  db.prepare(
    `UPDATE google_flow_queue
        SET prompt = ?,
            status = 'pending',
            moderation_round = ?,
            error_reason = NULL,
            assigned_account_id = NULL,
            dispatched_at = NULL,
            external_task_id = NULL,
            google_operation_id = NULL,
            google_operation_project_id = NULL
      WHERE id = ?`
  ).run(newPrompt, newRound, id);
}

export function listDispatchedForVideo(
  db: DatabaseType,
  videoId: string
): GoogleFlowQueueItem[] {
  return db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE video_id = ? AND status = 'dispatched'
        ORDER BY id ASC`
    )
    .all(videoId) as GoogleFlowQueueItem[];
}

export function listDispatchedForAccount(
  db: DatabaseType,
  accountId: string
): GoogleFlowQueueItem[] {
  return db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE assigned_account_id = ? AND status = 'dispatched'
        ORDER BY id ASC`
    )
    .all(accountId) as GoogleFlowQueueItem[];
}

/**
 * Worker-boot recovery: flip every dispatched row back to pending and
 * wipe the dispatch quality-of-life fields. Any extension submissions
 * that arrive afterwards hit findTaskByExternalId misses — the
 * submit-result handler treats those as duplicates (state-tolerant).
 */
export function resetAllDispatchedOnStartup(db: DatabaseType): void {
  db.prepare(
    `UPDATE google_flow_queue
        SET status = 'pending',
            assigned_account_id = NULL,
            dispatched_at = NULL,
            external_task_id = NULL
      WHERE status = 'dispatched'`
  ).run();
}

/**
 * Rows stuck in `dispatched` past the age cutoff. Used by the per-
 * dispatch timeout reaper. nowUnix is injected so tests can freeze
 * time; production callers pass `Math.floor(Date.now()/1000)`.
 */
export function listStaleDispatched(
  db: DatabaseType,
  maxAgeSec: number,
  nowUnix: number
): GoogleFlowQueueItem[] {
  const cutoff = nowUnix - maxAgeSec;
  return db
    .prepare(
      `SELECT * FROM google_flow_queue
        WHERE status = 'dispatched' AND dispatched_at < ?
        ORDER BY id ASC`
    )
    .all(cutoff) as GoogleFlowQueueItem[];
}

// ─── Video projects ───────────────────────────────────────────────────

export function findFlowProjectForAccount(
  db: DatabaseType,
  videoId: string,
  accountId: string
): GoogleFlowVideoProject | undefined {
  return db
    .prepare(
      "SELECT * FROM google_flow_video_projects WHERE video_id = ? AND account_id = ?"
    )
    .get(videoId, accountId) as GoogleFlowVideoProject | undefined;
}

/**
 * First-writer-wins per (video_id, account_id). On PK conflict, the
 * existing row is preserved and `inserted` is false; the caller can
 * compare `existingProjectId` against the posted id to detect a
 * stale-vs-fresh divergence and log a warning.
 */
export function upsertFlowProjectForAccount(
  db: DatabaseType,
  videoId: string,
  accountId: string,
  flowProjectId: string,
  nowUnix: number
): { inserted: boolean; existingProjectId: string | null } {
  const info = db
    .prepare(
      `INSERT INTO google_flow_video_projects
         (video_id, account_id, flow_project_id, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(video_id, account_id) DO NOTHING`
    )
    .run(videoId, accountId, flowProjectId, nowUnix);
  if (info.changes > 0) {
    return { inserted: true, existingProjectId: null };
  }
  const existing = findFlowProjectForAccount(db, videoId, accountId);
  return {
    inserted: false,
    existingProjectId: existing?.flow_project_id ?? null,
  };
}

export function clearFlowProjectForAccount(
  db: DatabaseType,
  videoId: string,
  accountId: string
): void {
  db.prepare(
    "DELETE FROM google_flow_video_projects WHERE video_id = ? AND account_id = ?"
  ).run(videoId, accountId);
}

export function listFlowProjectsForVideo(
  db: DatabaseType,
  videoId: string
): GoogleFlowVideoProject[] {
  return db
    .prepare("SELECT * FROM google_flow_video_projects WHERE video_id = ?")
    .all(videoId) as GoogleFlowVideoProject[];
}

// ─── Moderation events ────────────────────────────────────────────────

/**
 * Append one moderation_events row. Returns the auto-assigned id.
 * Rows are video-scoped and cascade-deleted with their parent video.
 */
export function insertModerationEvent(
  db: DatabaseType,
  input: {
    video_id: string;
    chunk_id: string;
    kind: GoogleFlowQueueKind;
    round: number;
    original_prompt: string;
    rewritten_prompt: string;
    reason_tag: string | null;
    created_at: number;
  }
): number {
  const info = db
    .prepare(
      `INSERT INTO moderation_events (
         video_id, chunk_id, kind, round,
         original_prompt, rewritten_prompt, reason_tag, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.video_id,
      input.chunk_id,
      input.kind,
      input.round,
      input.original_prompt,
      input.rewritten_prompt,
      input.reason_tag,
      input.created_at
    );
  return Number(info.lastInsertRowid);
}

export function listModerationEventsForVideo(
  db: DatabaseType,
  videoId: string
): ModerationEvent[] {
  return db
    .prepare(
      `SELECT * FROM moderation_events
        WHERE video_id = ?
        ORDER BY created_at ASC, id ASC`
    )
    .all(videoId) as ModerationEvent[];
}
