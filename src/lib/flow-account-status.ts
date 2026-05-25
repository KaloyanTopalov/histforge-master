/**
 * Derive a Flow account's health state from its raw row fields. Shared
 * between the Settings > Google Flow credits cell and the compact
 * accounts strip on the video-detail page so the two surfaces stay in
 * agreement on labels and thresholds.
 */

import { DEFAULT_STALE_ACCOUNT_MINUTES } from "@/lib/flow-constants";

export type AccountStatusKind =
  | "online"
  | "paused"
  | "recovery_needed"
  | "stopped";

export interface AccountStatusInput {
  enabled: 0 | 1;
  paused_until: number | null;
  last_seen_at: number | null;
  recovery_reason: string | null;
  recovery_required_at: number | null;
}

/**
 * Full shape returned by `GET /api/flow/accounts`. Kept here so every
 * surface that shows Flow account health (settings table, video-detail
 * strip) imports the same type.
 */
export interface AccountListItem {
  id: string;
  name: string;
  token_display: string;
  paused_until: number | null;
  last_seen_at: number | null;
  credits: number | null;
  credits_updated_at: number | null;
  enabled: 0 | 1;
  recovery_reason: string | null;
  recovery_required_at: number | null;
  created_at: number;
}

export interface AccountStatus {
  kind: AccountStatusKind;
  label: string;
}

export function relative(fromUnix: number | null, nowSec: number): string {
  if (fromUnix === null) return "never";
  const deltaSec = Math.max(0, Math.floor(nowSec - fromUnix));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  return `${Math.floor(deltaSec / 86400)}d ago`;
}

export function futureDelta(
  untilUnix: number | null,
  nowSec: number
): string | null {
  if (untilUnix === null) return null;
  const deltaSec = Math.floor(untilUnix - nowSec);
  if (deltaSec <= 0) return null;
  if (deltaSec < 60) return `${deltaSec}s left`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m left`;
  const hours = Math.floor(deltaSec / 3600);
  const mins = Math.floor((deltaSec % 3600) / 60);
  return mins > 0 ? `${hours}h ${mins}m left` : `${hours}h left`;
}

export function getAccountStatus(
  account: AccountStatusInput,
  nowSec: number
): AccountStatus {
  // First-match-wins ordering (ADR-0003 §4):
  //   1. !enabled — disabled accounts never dispatch, regardless of
  //      any other state.
  //   2. recovery_reason — operator-gated recovery (e.g. captcha).
  //      Cannot clear with elapsed time, so it sits BEFORE the time-
  //      pause branch.
  //   3. paused_until > now — time-based account pause.
  //   4. stale last_seen_at — polling stopped.
  //   5. online.
  if (account.enabled === 0) {
    return { kind: "stopped", label: "disabled" };
  }
  if (account.recovery_reason !== null) {
    const duration = relative(account.recovery_required_at, nowSec).replace(
      " ago",
      ""
    );
    return {
      kind: "recovery_needed",
      label: `reCAPTCHA recovery needed (${duration})`,
    };
  }
  const pausedFor = futureDelta(account.paused_until, nowSec);
  if (pausedFor !== null) {
    return { kind: "paused", label: `paused ${pausedFor}` };
  }
  const stale =
    account.last_seen_at === null ||
    nowSec - account.last_seen_at > DEFAULT_STALE_ACCOUNT_MINUTES * 60;
  if (stale) {
    return {
      kind: "stopped",
      label: `polling stopped · last seen ${relative(account.last_seen_at, nowSec)}`,
    };
  }
  return {
    kind: "online",
    label: `seen ${relative(account.last_seen_at, nowSec)}`,
  };
}
