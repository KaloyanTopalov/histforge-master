import type { Database as DatabaseType } from "better-sqlite3";
import * as gfRepo from "@/lib/repos/google-flow";
import * as magnificRepo from "@/lib/repos/magnific";
import { DEFAULT_STALE_ACCOUNT_MINUTES } from "@/lib/flow-constants";

/**
 * Reaper — runs on a 30-second interval in the worker process.
 *
 * Per tick:
 *   1. Account-level salvage (Flow). Requeue dispatched rows whose
 *      assigned account has gone silent (stale `last_seen_at`) or is
 *      disabled. Protects against a Chrome profile that crashed or was
 *      turned off with work in flight.
 *   2. Per-dispatch age timeout (Flow + Magnific). Requeue dispatched
 *      rows older than the configured timeout regardless of account
 *      liveness. Catches jobs the backend silently dropped, or
 *      extension-side retry loops that never POST back. Magnific rows
 *      with `no_timeout=1` (image-hitl, operator-blocking) are exempt
 *      per ADR-0012 §Decision 4.
 *   3. Early wake (Flow only). When all accounts were in cooldown the
 *      Flow step yields with a `deferred_until` timestamp; as soon as
 *      an account becomes available we clear the defer so the video can
 *      resume without waiting out the full cooldown.
 *
 * All three operate through existing repo helpers. The tick is a pure
 * function of (db, now, thresholds) so tests can freeze time.
 */

export interface ReaperOptions {
  /** Returns the current unix-seconds timestamp. Injected for tests. */
  now?: () => number;
  /**
   * Stale-account threshold in minutes. A dispatched row under an
   * account whose `last_seen_at` is older than this is requeued. The
   * plan pins this at 10 minutes.
   */
  staleAccountTimeoutMinutes?: number;
  /**
   * Per-dispatch age cap in minutes for the Google Flow queue. Sourced
   * from `google_flow_dispatch_timeout_minutes` in production
   * (default 30).
   */
  dispatchTimeoutMinutes?: number;
  /**
   * Per-dispatch age cap in minutes for the Magnific queue. Sourced
   * from `magnific_dispatch_timeout_minutes` in production (default 30).
   * Separate from the Flow cap so operators can tune the two providers
   * independently — Magnific image-to-video has different hang
   * characteristics than Veo.
   */
  magnificDispatchTimeoutMinutes?: number;
  /** Optional log sink — otherwise silent. */
  log?: (message: string) => void;
}

const DEFAULT_DISPATCH_TIMEOUT_MINUTES = 30;

/**
 * Run one reaper pass synchronously. Returns nothing — observability is
 * via `opts.log`. Ordering inside the tick is deliberate: account-level
 * salvage runs first so the per-dispatch timeout only rescues rows under
 * still-live accounts, and the deferred-video wake runs last so the wake
 * sees the freshest queue state.
 */
export function runReaperTick(
  db: DatabaseType,
  opts: ReaperOptions = {}
): void {
  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const staleAccountMinutes =
    opts.staleAccountTimeoutMinutes ?? DEFAULT_STALE_ACCOUNT_MINUTES;
  const dispatchTimeoutMinutes =
    opts.dispatchTimeoutMinutes ?? DEFAULT_DISPATCH_TIMEOUT_MINUTES;
  const magnificDispatchTimeoutMinutes =
    opts.magnificDispatchTimeoutMinutes ?? DEFAULT_DISPATCH_TIMEOUT_MINUTES;
  const log = opts.log;
  const nowUnix = now();

  // Step 1: account-level salvage. We pull dispatched rows + account
  // liveness in one query and requeue the stale ones.
  const staleCutoff = nowUnix - staleAccountMinutes * 60;
  const stuckUnderDeadAccounts = db
    .prepare(
      `SELECT q.id AS task_id, q.assigned_account_id AS account_id,
              a.last_seen_at AS last_seen_at, a.enabled AS enabled
         FROM google_flow_queue q
         JOIN google_flow_accounts a ON a.id = q.assigned_account_id
        WHERE q.status = 'dispatched'
          AND (a.enabled = 0
               OR a.last_seen_at IS NULL
               OR a.last_seen_at < ?)`
    )
    .all(staleCutoff) as Array<{
    task_id: number;
    account_id: string;
    last_seen_at: number | null;
    enabled: number;
  }>;

  for (const row of stuckUnderDeadAccounts) {
    gfRepo.requeueTask(db, row.task_id);
    log?.(
      `reaper: requeued task ${row.task_id} — account ${row.account_id} ` +
        (row.enabled === 0
          ? "disabled"
          : `last_seen_at=${row.last_seen_at ?? "never"}`)
    );
  }

  // Step 2: per-dispatch age timeout. This only catches rows under
  // still-live accounts — step 1 already handled the stale/disabled
  // account case.
  // listStaleDispatched runs after step 1's requeues, so any row step 1
  // just flipped to 'pending' is automatically excluded by the query.
  const staleDispatches = gfRepo.listStaleDispatched(
    db,
    dispatchTimeoutMinutes * 60,
    nowUnix
  );
  for (const row of staleDispatches) {
    gfRepo.requeueTask(db, row.id);
    const ageSec = nowUnix - (row.dispatched_at ?? nowUnix);
    log?.(
      `reaper: dispatch timeout — requeued task ${row.id} ` +
        `(account=${row.assigned_account_id ?? "?"}, age=${ageSec}s)`
    );
  }

  // Step 2b: same age-timeout pass for magnific_queue. The
  // `onlyNoTimeoutZero=true` argument tells the repo to filter out
  // image-hitl rows (no_timeout=1) — operator-blocking selection can
  // legitimately exceed the dispatch cap and must not be requeued
  // (ADR-0012 §Decision 4). Single-bucket queue, no account FK, so
  // there is no analogue to Step 1's stale-account salvage.
  const staleMagnific = magnificRepo.listStaleDispatched(
    db,
    magnificDispatchTimeoutMinutes * 60,
    nowUnix,
    true
  );
  for (const row of staleMagnific) {
    magnificRepo.requeueTask(db, row.id);
    const ageSec = nowUnix - (row.dispatched_at ?? nowUnix);
    log?.(
      `reaper: magnific dispatch timeout — requeued task ${row.id} ` +
        `(mode=${row.mode}, age=${ageSec}s)`
    );
  }

  // Step 3: wake deferred videos early when any account is available.
  // Only touch videos that still have pending work — a video whose Flow
  // step finished has no pending rows and shouldn't be woken artificially.
  if (gfRepo.anyAccountAvailable(db)) {
    const woken = db
      .prepare(
        `UPDATE videos
            SET deferred_until = NULL
          WHERE deferred_until IS NOT NULL
            AND deferred_until > ?
            AND EXISTS (
              SELECT 1 FROM google_flow_queue q
               WHERE q.video_id = videos.id
                 AND q.status = 'pending'
            )`
      )
      .run(nowUnix);
    if (woken.changes > 0) {
      log?.(`reaper: woke ${woken.changes} deferred video(s) — account available`);
    }
  }
}

export interface StartReaperOptions extends ReaperOptions {
  /** Interval between ticks in milliseconds. Defaults to 30 000. */
  intervalMs?: number;
}

/**
 * Start the periodic reaper. Returns a stop function that clears the
 * interval — tests call it to tear down, the worker doesn't because the
 * loop runs until the process exits.
 *
 * The `isReaping` guard is belt-and-braces: `runReaperTick` is
 * synchronous today so setInterval cannot overlap with itself, but if
 * the tick ever goes async the guard prevents pile-up.
 */
export function startReaper(
  db: DatabaseType,
  opts: StartReaperOptions = {}
): () => void {
  const intervalMs = opts.intervalMs ?? 30_000;
  let isReaping = false;
  const handle = setInterval(() => {
    if (isReaping) return;
    isReaping = true;
    try {
      runReaperTick(db, opts);
    } catch (err) {
      opts.log?.(
        `reaper: tick threw ${err instanceof Error ? err.message : String(err)}`
      );
    } finally {
      isReaping = false;
    }
  }, intervalMs);
  return () => clearInterval(handle);
}
