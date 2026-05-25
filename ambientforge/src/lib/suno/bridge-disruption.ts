import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { SunoError } from './client';

/**
 * Error codes that indicate the Suno chain (bridge → sidecar → Chrome CDP →
 * Suno) is disrupted but the failure is *not* a permanent track-level
 * failure. The right response is to pause the album, surface a banner /
 * setting flag, and let either the operator or the watchdog re-establish
 * connectivity. Once the chain comes back, the unsubmitted tracks resume
 * exactly where they left off.
 *
 * Distinguishing characteristic: bridge-disrupted errors invalidate the
 * whole submission session, not just one track. Marking 5 individual
 * tracks as 'failed' when the bridge is just temporarily down is wasteful
 * and unrecoverable without manual DB intervention.
 *
 * NOT included: SUNO_AUTH / SUNO_COOKIE_ROTATED — those are handled
 * separately because they require a different recovery (re-run
 * suno:login). They DO also pause the album, just via the existing
 * suno_cookie_rotated flag, not this one.
 */
export const BRIDGE_DISRUPTED_CODES = new Set<string>([
  'SUNO_BRIDGE_UNREACHABLE',
  'SUNO_BRIDGE_TIMEOUT',
  'SUNO_BRIDGE_ERROR',
  'SUNO_SIDECAR_CRASHED',
  'SIDECAR_INTERNAL',
]);

export function isBridgeDisrupted(err: unknown): err is SunoError {
  if (!(err instanceof SunoError)) return false;
  return BRIDGE_DISRUPTED_CODES.has(err.code);
}

/**
 * Pause an in-flight album because the Suno chain is disrupted, then throw
 * the underlying SunoError so step 03 / step 04 halt immediately and the
 * orchestrator's catch records it as the branch cause.
 *
 *   1. Stamp the `suno_bridge_disrupted` setting with a JSON payload so the
 *      dashboard / watchdog / worker know what hit and which album.
 *   2. Patch the album to `awaiting_suno_relogin`. The runner detects this
 *      status after `runPipeline` returns and skips the terminal status
 *      write, so the resume endpoint can patch back to 'queued' for a
 *      clean retry.
 *   3. Throw `err` — return type `never` enforces at the type level that
 *      callers can't accidentally fall through and continue the loop.
 *
 * Log lines describing the pause should fire BEFORE this call (the throw
 * skips anything afterwards).
 */
export function pauseAlbumForBridgeDisruption(
  albumId: string,
  channelId: string,
  err: SunoError,
): never {
  setSetting(
    'suno_bridge_disrupted',
    JSON.stringify({
      albumId,
      channelId,
      code: err.code,
      detail: err.message,
      at: Date.now(),
    }),
  );
  albumsRepo.patch(albumId, { status: 'awaiting_suno_relogin' });
  throw err;
}
