/**
 * Phase-3 auto-resume: when an album is paused with status='awaiting_suno_relogin'
 * because of a bridge / sidecar / Chrome disruption (Phase-1 marker), the worker
 * polls the Suno bridge for liveness on each tick. As soon as the bridge AND
 * Suno auth come back, the paused album is patched back to 'queued' and the
 * suno_bridge_disrupted flag is cleared. The runner picks it up on the next
 * tick and step 03 / step 04 resumes from where they left off.
 *
 * Cookie-rotation pauses (suno_cookie_rotated flag) are intentionally NOT
 * auto-resumed: they require `npm run suno:login` to re-capture the
 * `__client` cookie. If both flags are set, the cookie issue takes
 * precedence — wait for the operator.
 */

import { getRawSetting, setSetting } from '@/lib/settings';
import * as albumsRepo from '@/lib/repos/albums';
import { getDb, type Db } from '@/lib/db';

const DEFAULT_BRIDGE_URL =
  process.env.SUNO_BRIDGE_URL ?? 'http://127.0.0.1:7341';
const DEFAULT_CDP_URL =
  process.env.SUNO_CDP_URL ?? `http://127.0.0.1:${process.env.SUNO_CDP_PORT ?? 9333}`;
const HEALTH_TIMEOUT_MS = 2_000;
const CREDITS_TIMEOUT_MS = 5_000;
const CDP_TIMEOUT_MS = 2_000;
// Probe at most once every 30s. The runner ticks every 1s; without the
// throttle we'd spam the Suno bridge / sidecar / Chrome chain.
const PROBE_INTERVAL_MS = 30_000;

// `-Infinity` so the first probe after worker startup always fires regardless
// of whether tests pass nowMs=0. Reset by tests via __resetBridgeRecoveryThrottle.
let lastProbeAt = Number.NEGATIVE_INFINITY;

export type AutoResumeOpts = {
  /** Override for tests. */
  fetchImpl?: typeof fetch;
  /** Override the bridge URL (for tests / staging). */
  bridgeUrl?: string;
  /** Override the Chrome CDP URL (for tests). */
  cdpUrl?: string;
  /** When provided, throttle uses this instead of Date.now() — tests can
   *  fast-forward. */
  nowMs?: number;
  /** Reset the throttle. Tests use this to force a fresh probe. */
  resetThrottle?: boolean;
};

/**
 * Result for telemetry + tests. `attempted` is true iff a probe actually
 * fired (i.e., flag was set AND throttle window elapsed).
 */
export type AutoResumeResult = {
  attempted: boolean;
  resumed: number;
  reason?:
    | 'no-flag'
    | 'cookie-rotation-takes-precedence'
    | 'throttled'
    | 'bridge-down'
    | 'sidecar-down'
    | 'chrome-down'
    | 'auth-down'
    | 'flag-stale-cleared'
    | 'malformed-flag-cleared'
    | 'resumed';
};

export async function tryAutoResumeAfterBridgeRecovery(
  db: Db = getDb(),
  opts: AutoResumeOpts = {},
): Promise<AutoResumeResult> {
  const flag = getRawSetting('suno_bridge_disrupted', db);
  if (!flag || flag.length === 0) {
    return { attempted: false, resumed: 0, reason: 'no-flag' };
  }
  // Cookie issues require human action — don't paper over them.
  const cookieFlag = getRawSetting('suno_cookie_rotated', db);
  if (cookieFlag && cookieFlag.length > 0) {
    return { attempted: false, resumed: 0, reason: 'cookie-rotation-takes-precedence' };
  }
  const now = opts.nowMs ?? Date.now();
  if (opts.resetThrottle) lastProbeAt = 0;
  if (now - lastProbeAt < PROBE_INTERVAL_MS) {
    return { attempted: false, resumed: 0, reason: 'throttled' };
  }
  lastProbeAt = now;

  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.bridgeUrl ?? DEFAULT_BRIDGE_URL;
  const cdpUrl = opts.cdpUrl ?? DEFAULT_CDP_URL;

  // 1. Bridge alive AND sidecar alive?
  let bridgeStatus: { sidecarAlive?: boolean } | null = null;
  try {
    const r = await fetchImpl(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    if (r.ok) bridgeStatus = (await r.json()) as { sidecarAlive?: boolean };
  } catch {
    /* bridge down */
  }
  if (!bridgeStatus) {
    return { attempted: true, resumed: 0, reason: 'bridge-down' };
  }
  if (!bridgeStatus.sidecarAlive) {
    return { attempted: true, resumed: 0, reason: 'sidecar-down' };
  }

  // 2. Chrome CDP alive? The submit path goes through Chrome (captcha solver
  // + Advanced-tab form fill) even when no captcha is required, so a dead
  // Chrome window means SIDECAR_INTERNAL on every submit. /health and
  // /credits both pass without Chrome (credits hits Suno's API directly with
  // the persisted cookie), so we MUST probe CDP separately here — otherwise
  // we'd auto-resume into a guaranteed re-failure loop.
  try {
    const r = await fetchImpl(`${cdpUrl}/json/version`, {
      signal: AbortSignal.timeout(CDP_TIMEOUT_MS),
    });
    if (!r.ok) {
      return { attempted: true, resumed: 0, reason: 'chrome-down' };
    }
  } catch {
    return { attempted: true, resumed: 0, reason: 'chrome-down' };
  }

  // 3. Suno auth healthy? /credits exercises bridge → sidecar → cookie path
  // (no Chrome required for this call — cookie alone). A 401 here means the
  // cookie expired and the operator must run npm run suno:login.
  try {
    const r = await fetchImpl(`${baseUrl}/credits`, {
      signal: AbortSignal.timeout(CREDITS_TIMEOUT_MS),
    });
    if (!r.ok) {
      return { attempted: true, resumed: 0, reason: 'auth-down' };
    }
  } catch {
    return { attempted: true, resumed: 0, reason: 'auth-down' };
  }

  // 3. Recover the specific album recorded in the flag.
  let albumId: string | null = null;
  let parseFailed = false;
  try {
    const parsed = JSON.parse(flag) as { albumId?: string };
    albumId = parsed.albumId ?? null;
  } catch {
    parseFailed = true;
  }
  if (parseFailed || !albumId) {
    // Malformed flag — clear it so it doesn't block forever. ALSO scan for any
    // album stuck in `awaiting_suno_relogin`: when the flag is corrupt we
    // can't tell which album to re-queue, so we re-queue every paused one.
    // Worker is serial, so in practice there's at most one.
    setSetting('suno_bridge_disrupted', '', db);
    const orphaned = albumsRepo.listByStatus('awaiting_suno_relogin', db);
    for (const a of orphaned) {
      albumsRepo.patch(a.id, { status: 'queued' }, db);
      console.log(
        `[runner] re-queued orphaned album ${a.id} after malformed bridge-disrupted flag cleanup`,
      );
    }
    return {
      attempted: true,
      resumed: orphaned.length,
      reason: 'malformed-flag-cleared',
    };
  }

  const album = albumsRepo.get(albumId, db);
  if (!album || album.status !== 'awaiting_suno_relogin') {
    // The flag's album is no longer in the right state (operator may have
    // already resumed manually, or the row was deleted). Clear the flag.
    setSetting('suno_bridge_disrupted', '', db);
    return { attempted: true, resumed: 0, reason: 'flag-stale-cleared' };
  }

  albumsRepo.patch(albumId, { status: 'queued' }, db);
  setSetting('suno_bridge_disrupted', '', db);
  console.log(
    `[runner] auto-resumed album ${albumId} after bridge / Suno chain returned healthy`,
  );
  return { attempted: true, resumed: 1, reason: 'resumed' };
}

/** Test-only seam: reset the throttle without using opts.resetThrottle. */
export function __resetBridgeRecoveryThrottle(): void {
  lastProbeAt = Number.NEGATIVE_INFINITY;
}
