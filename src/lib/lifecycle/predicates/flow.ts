/**
 * Pure predicates over `GoogleFlowAccount` row state. No DB access, no
 * logging, no side effects. The Flow lifecycle module guards and the
 * `next-task` dispatch gates should consume these instead of inlining
 * `account.recovery_reason !== null` / `account.paused_until > now` etc.
 *
 * Ordering note (mirrors `lib/flow-account-status.ts:71-114`, the
 * presentation-layer mapper):
 *   1. !enabled — disabled accounts never dispatch.
 *   2. recovery_reason — operator-gated recovery (e.g. captcha). Sits
 *      BEFORE the time-pause branch so a stale past `paused_until` cannot
 *      flip a recovery-needed account back into dispatchable.
 *   3. paused_until > now — time-based pause.
 * `accountIsDispatchable` returns true only when none of the above gates
 * trip.
 */

import type { GoogleFlowAccount } from "@/types";

/**
 * True when `paused_until` is set and still in the future. The pause
 * has elapsed (and therefore the account is dispatchable again) when
 * this returns false — the `next-task` route clears the stamp via
 * `gfRepo.resumeAccount` on the next claim.
 */
export function accountIsPaused(
  account: GoogleFlowAccount,
  nowSec: number
): boolean {
  return account.paused_until !== null && account.paused_until > nowSec;
}

/**
 * True when the account carries an operator-gated recovery flag (e.g.
 * captcha). Recovery cannot clear with elapsed time; it requires an
 * explicit operator action.
 */
export function accountNeedsRecovery(account: GoogleFlowAccount): boolean {
  return account.recovery_reason !== null;
}

/**
 * True when the account is eligible to receive a fresh task dispatch:
 * enabled, not in recovery, and not currently within a time-pause window.
 * Matches the gate ordering used by `next-task/route.ts` and the
 * presentation-layer `getAccountStatus` mapper (first-match-wins).
 */
export function accountIsDispatchable(
  account: GoogleFlowAccount,
  nowSec: number
): boolean {
  if (account.enabled === 0) return false;
  if (accountNeedsRecovery(account)) return false;
  if (accountIsPaused(account, nowSec)) return false;
  return true;
}
