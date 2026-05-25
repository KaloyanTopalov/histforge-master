/**
 * Named composed multi-write transactional transitions over the
 * `google_flow_accounts` + `google_flow_queue` + (banner) `settings`
 * aggregates. Each exported method opens its own `db.transaction()` and
 * composes atomic helpers from `lib/repos/google-flow` (and, for the
 * cross-module cascade, `videoLifecycle.unfailToQueued`).
 *
 * Reentrant transactions are safe: better-sqlite3 nests an inner
 * `db.transaction(fn)` call as a SAVEPOINT. The cross-module cascade
 * (`requeueFailedTask` → `videoLifecycle.unfailToQueued`) relies on
 * this for atomic rollback across both aggregates.
 *
 * Banner setting keys are centralized in `flow-banner-keys.ts`. The
 * `setSetting()` writes for the banner side live inline inside the
 * transitions here (set) and at the three dismiss routes (clear); both
 * sides key off `FlowBannerKeys.*` so a grep for "banner write site" is
 * exhaustive. Banner READ sites intentionally stay on string literals
 * per ADR-0007 §5 and the followups doc §1 known-gap entry.
 *
 * Single-statement transitions live in callers, not here (narrow scope
 * per ADR-0007 §4): `gfRepo.failTask` from `handleContentPolicy`,
 * `gfRepo.requeueTask` from `handleAuth`, single-field account PATCH
 * writes (when the row is the only side effect).
 *
 * See ADR-0007 (`docs/adr/0007-video-and-flow-lifecycle-modules.md`)
 * for the full design rationale.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import type {
  GoogleFlowAccount,
  GoogleFlowQueueItem,
  GoogleFlowQueueKind,
  Video,
} from "@/types";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import * as videoLifecycle from "@/lib/lifecycle/video";
import { getSetting, setSetting } from "@/lib/settings";
import { FlowBannerKeys } from "@/lib/lifecycle/flow-banner-keys";
import type { FlowBucket } from "@/lib/flow-constants";

/**
 * Operator deleted the Flow project in labs.google's UI (or it
 * otherwise disappeared from upstream). Wipe the (video, account) project
 * row so the next dispatch's `flowProjectId` comes back null and the SW
 * mints a fresh project, then requeue the task. No retry-count bump —
 * stale project IDs are an account-state problem, not a task-shape one.
 */
export function handleStaleProjectId(
  db: DatabaseType,
  taskId: number,
  videoId: string,
  accountId: string
): void {
  db.transaction(() => {
    gfRepo.clearFlowProjectForAccount(db, videoId, accountId);
    gfRepo.requeueTask(db, taskId);
  })();
}

/**
 * Quota / rate-limit hit on an account: pause it for the cooldown the
 * caller already resolved against settings, then requeue the task. No
 * retry-count bump — quota is an account-state problem, not a task-shape
 * problem; the same task will succeed on another account or after the
 * pause elapses.
 */
export function handleQuota(
  db: DatabaseType,
  taskId: number,
  accountId: string,
  pauseUntil: number
): void {
  db.transaction(() => {
    gfRepo.pauseAccount(db, accountId, pauseUntil);
    gfRepo.requeueTask(db, taskId);
  })();
}

/**
 * reCAPTCHA challenge surfaced on an account (ADR-0003). Stamp the
 * operator-gated recovery flag and requeue the task. No `paused_until`
 * write — captcha can't be cleared by a time cooldown; the operator must
 * re-engage the Flow session in the right Chrome profile. No retry-count
 * bump — same reasoning as quota: account-state, not task-shape, so the
 * same task will succeed on another account or after recovery.
 */
export function handleCaptcha(
  db: DatabaseType,
  taskId: number,
  accountId: string,
  nowSec: number
): void {
  db.transaction(() => {
    gfRepo.setAccountRecoveryReason(db, accountId, "captcha", nowSec);
    gfRepo.requeueTask(db, taskId);
  })();
}

/**
 * The SW couldn't talk to `project.createProject` (typically a trpc
 * envelope drift). Three writes in one txn: pause the account for the
 * supplied cooldown to stop dispatching to a broken extension, requeue
 * without burning retry budget, and surface the failure to the dashboard
 * via the operator-attention banner. Caller builds `flagPayload` (JSON of
 * `{errorCode, httpStatus, taskId, when, accountId}`).
 */
export function handleCreateProjectFailed(
  db: DatabaseType,
  taskId: number,
  accountId: string,
  pauseUntil: number,
  flagPayload: string
): void {
  db.transaction(() => {
    gfRepo.pauseAccount(db, accountId, pauseUntil);
    gfRepo.requeueTask(db, taskId);
    setSetting(FlowBannerKeys.createProjectFailed, flagPayload, db);
  })();
}

/**
 * Veo backend congestion (`PUBLIC_ERROR_HIGH_TRAFFIC`). Minute-scale
 * per-account pause (ADR-0004), requeue without burning retry budget,
 * stamp the dashboard banner timestamp. Three writes — one transaction
 * so a crash can't pause-without-banner or vice versa. The banner is
 * always overwritten: a fresh event pushes it forward.
 */
export function handleServiceOverload(
  db: DatabaseType,
  taskId: number,
  accountId: string,
  pauseUntil: number
): void {
  db.transaction(() => {
    gfRepo.pauseAccount(db, accountId, pauseUntil);
    gfRepo.requeueTask(db, taskId);
    setSetting(FlowBannerKeys.serviceOverloadUntil, String(pauseUntil), db);
  })();
}

/**
 * Transient error path: always bump `retry_count`, then either requeue
 * (when the bump leaves room under the cap) or terminally fail with
 * `errorText` (when the cap is reached). Bump-and-branch must run in the
 * same txn so a crash can't leave the row requeued without a bump (or
 * vice versa).
 *
 * Caller passes the already-loaded `task` row and the already-resolved
 * `maxRetries` setting — the lifecycle module is settings-agnostic.
 */
export function handleTransient(
  db: DatabaseType,
  task: GoogleFlowQueueItem,
  errorText: string,
  maxRetries: number
): void {
  const newCount = task.retry_count + 1;
  db.transaction(() => {
    gfRepo.bumpRetryCount(db, task.id);
    if (newCount < maxRetries) {
      gfRepo.requeueTask(db, task.id);
    } else {
      gfRepo.failTask(db, task.id, errorText);
    }
  })();
}

/**
 * Operator-driven account edit from the dashboard. Up to three
 * conditional writes in one txn so a crash can't leave the row in a
 * mixed state across name / enabled / paused_until.
 *
 * Caller pre-resolves `pausedUntil` to a unix-seconds number (or `null`
 * to clear) and handles ISO parsing + validation; the lifecycle method
 * takes a typed primitive.
 */
export function editAccount(
  db: DatabaseType,
  accountId: string,
  patch: { name?: string; enabled?: boolean; pausedUntil?: number | null }
): void {
  db.transaction(() => {
    if (patch.name !== undefined) {
      gfRepo.setAccountName(db, accountId, patch.name);
    }
    if (patch.enabled !== undefined) {
      gfRepo.setAccountEnabled(db, accountId, patch.enabled);
    }
    if (patch.pausedUntil !== undefined) {
      if (patch.pausedUntil === null) {
        gfRepo.resumeAccount(db, accountId);
      } else {
        gfRepo.pauseAccount(db, accountId, patch.pausedUntil);
      }
    }
  })();
}

/**
 * Operator deleted a Flow account from the dashboard. Explicitly
 * requeue every dispatched row first — the `ON DELETE SET NULL` FK is
 * a safety net for stray pending rows, but the extension may still be
 * mid-flight on dispatched rows; requeueing them is what lets another
 * account pick up the work. One txn so the requeue + delete commit
 * together (no observable window with a deleted account still owning
 * dispatched rows).
 */
export function requeueAllOnAccountDeletion(
  db: DatabaseType,
  accountId: string
): void {
  db.transaction(() => {
    const dispatched = gfRepo.listDispatchedForAccount(db, accountId);
    for (const row of dispatched) {
      gfRepo.requeueTask(db, row.id);
    }
    gfRepo.deleteAccount(db, accountId);
  })();
}

export interface ClaimedTask {
  row: GoogleFlowQueueItem;
  video: Video;
}

/**
 * Atomic claim of the next pending row for an account. Caller has
 * already cleared the dispatch gates (queue_state paused, recovery_reason,
 * paused_until > now); this method only enters when the account is
 * dispatchable.
 *
 * One txn covers four concerns:
 *   1. Conditional `resumeAccount` when the supplied account row carries
 *      an elapsed `paused_until` — this route is the canonical place a
 *      time-based pause clears.
 *   2. `takeNextTaskForAccount` claims the next pending row. Its internal
 *      `db.transaction()` nests as a SAVEPOINT under this outer one.
 *   3. Guarded `setSetting(reloginNeeded, false)` — a successful claim
 *      proves this session is healthy. Guarded so the steady-state
 *      already-false hot path doesn't issue a redundant UPSERT.
 *   4. `videosRepo.findById` for the claimed row's parent video — kept
 *      inside the txn so the read agrees with the claimed-row snapshot.
 *
 * Response-shaping reads (image/video model settings, the per-(video,
 * account) flowProjectId) live at the caller, after this method returns
 * — those aren't lifecycle writes and need no transactional coupling.
 */
export function claimNextTask(
  db: DatabaseType,
  account: GoogleFlowAccount,
  nowSec: number,
  wantBucket?: FlowBucket
): ClaimedTask | null {
  return db.transaction<() => ClaimedTask | null>(() => {
    if (account.paused_until !== null) {
      gfRepo.resumeAccount(db, account.id);
    }
    const row = gfRepo.takeNextTaskForAccount(db, account.id, nowSec, wantBucket);
    if (!row) return null;
    if (getSetting(FlowBannerKeys.reloginNeeded, db)) {
      setSetting(FlowBannerKeys.reloginNeeded, false, db);
    }
    const video = videosRepo.findById(db, row.video_id);
    if (!video) return null;
    return { row, video };
  })();
}

export interface ModerationBatchWrite {
  videoId: string;
  chunkId: string;
  kind: GoogleFlowQueueKind;
  round: number;
  originalPrompt: string;
  rewritten: string;
  reasonTag: string | null;
  createdAt: number;
  rowId: number;
}

/**
 * Atomic moderation batch: for each entry insert a `moderation_events`
 * row and requeue the matching queue row with the moderator's rewritten
 * prompt. moderation_events is the canonical record of every rewrite,
 * and a partial commit would leave a queue row requeued without an
 * audit trail (or vice versa) — so the loop runs in a single txn.
 *
 * The `chunks.json` filesystem write stays at the caller, after this
 * method returns. Disk writes have no business inside a SQLite txn,
 * and a crash between commit and the disk write leaves chunks.json
 * slightly stale (missing the new prompt_history entry) — harmless,
 * because the queue rows already carry the new prompt and
 * moderation_events is canonical.
 */
export function recordModerationBatch(
  db: DatabaseType,
  writes: readonly ModerationBatchWrite[]
): void {
  if (writes.length === 0) return;
  db.transaction(() => {
    for (const w of writes) {
      gfRepo.insertModerationEvent(db, {
        video_id: w.videoId,
        chunk_id: w.chunkId,
        kind: w.kind,
        round: w.round,
        original_prompt: w.originalPrompt,
        rewritten_prompt: w.rewritten,
        reason_tag: w.reasonTag,
        created_at: w.createdAt,
      });
      gfRepo.requeueWithNewPrompt(db, w.rowId, w.rewritten, w.round);
    }
  })();
}

export interface RequeueFailedTaskOpts {
  /**
   * When present, the row is rewritten via `requeueWithNewPrompt` with
   * `moderation_round = 0` and a `moderation_events` row is inserted with
   * the supplied `chunkId` / `originalPrompt` / `reasonTag` (typically
   * `"manual_edit"`). When absent, the row is requeued in place via
   * `requeueTask` and no audit row is written.
   */
  newPrompt?: string;
  chunkId?: string | null;
  originalPrompt?: string;
  reasonTag?: string;
  nowSec: number;
}

export interface RequeueFailedTaskResult {
  /** True when the parent video was in `failed` status and was reset
   * back to `queued` via the cross-module cascade. */
  videoUnfailed: boolean;
}

/**
 * Operator-driven requeue of a Flow queue row that needs another shot.
 * The 11th FlowLifecycle method and the only one that crosses aggregate
 * boundaries: when the parent video is currently `failed`, the same txn
 * also resets the failed step row and clears failure metadata, so the
 * runner re-enters the step that consumes the row.
 *
 * The cross-module cascade goes lifecycle-to-lifecycle: FlowLifecycle
 * delegates the entire video-side decision (predicate + writes) to
 * `videoLifecycle.unfailToQueued` rather than reaching into `videosRepo`
 * / `stepsRepo` directly (ADR-0007 §3 standing rule). The inner method's
 * `db.transaction()` nests as a SAVEPOINT under this outer one, so a
 * throw anywhere inside `unfailToQueued` rolls the entire requeue back.
 *
 * Two modes, keyed off `opts.newPrompt`:
 *
 *   - **Edit + retry**: rewrite the row's prompt, reset
 *     `moderation_round` to 0, append a `moderation_events` row tagged
 *     with `reasonTag` (typically `"manual_edit"`).
 *   - **Plain retry**: requeue in place via `requeueTask`; no audit row.
 *
 * Filesystem writes (chunks.json) stay at callers and run after this
 * method commits — same convention as `recordModerationBatch`.
 */
export function requeueFailedTask(
  db: DatabaseType,
  task: GoogleFlowQueueItem,
  opts: RequeueFailedTaskOpts
): RequeueFailedTaskResult {
  return db.transaction<() => RequeueFailedTaskResult>(() => {
    if (opts.newPrompt !== undefined) {
      gfRepo.requeueWithNewPrompt(db, task.id, opts.newPrompt, 0);
      if (opts.chunkId != null) {
        gfRepo.insertModerationEvent(db, {
          video_id: task.video_id,
          chunk_id: opts.chunkId,
          kind: task.kind,
          round: 0,
          original_prompt: opts.originalPrompt ?? task.prompt,
          rewritten_prompt: opts.newPrompt,
          reason_tag: opts.reasonTag ?? "manual_edit",
          created_at: opts.nowSec,
        });
      }
    } else {
      gfRepo.requeueTask(db, task.id);
    }
    const videoUnfailed = videoLifecycle.unfailToQueued(db, task.video_id);
    return { videoUnfailed };
  })();
}
