/**
 * One-click orchestrator for a single medieval-path (ambient-video) video.
 *
 * Launched by make-medieval-video.bat AFTER the suno + freepik bridges, the
 * freepik Chrome window, and the cover-pick popup are up. This:
 *   1. Forces DK into mock (this machine has no DistroKid profile) +
 *      distrokid_dry_run=true (step 06 hard-fails otherwise) so branch A
 *      succeeds and the pipeline reaches step 11 / 'done'.
 *   2. Runs the FULL 30-track album. With dual-variant on (it is, for this
 *      channel) that is 15 real Suno generations — a REAL Suno bill. This is
 *      NOT a smoke run anymore (operator chose to hardcode 30).
 *   3. Queues exactly one medieval-path album (reuses an already-open one
 *      so a double-click never double-queues / double-bills Suno).
 *   4. Runs the worker loop in THIS process until stopped.
 *
 * The only manual gate is the cover pick — it now appears in the always-on-top
 * popup (scripts/pick-popup.ps1); everything after it is unattended.
 */

// Must be set before the DK client reads it (it's read at step-06 call time,
// so even setting it here — after imports — is effective).
process.env.DISTROKID_MODE = process.env.DISTROKID_MODE || 'mock';

import { getDb } from '@/lib/db';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { setSetting } from '@/lib/settings';
import { runForever } from '@/worker/runner';
import { resolveAmbientVideoLoopFactor } from '@/worker/workflows/ambient-video';

const CHANNEL_ID = '01KRNX8PRFD4MNF5T20P0GXV0C'; // "medieval path", ambient-video
// Full album. Operator chose to hardcode 30 (was 4-track smoke). With
// channel.sunoDualVariant ON, 30 tracks = 15 Suno generations = REAL bill.
const TRACK_CAP = 30;

function main(): void {
  const channel = channelsRepo.get(CHANNEL_ID);
  if (!channel) {
    console.error(`[make-medieval-video] channel ${CHANNEL_ID} not found — aborting.`);
    process.exit(1);
  }
  if (channel.workflow !== 'ambient-video') {
    console.error(
      `[make-medieval-video] channel ${CHANNEL_ID} workflow is "${channel.workflow}", expected "ambient-video" — aborting.`,
    );
    process.exit(1);
  }

  // Full 30-track run, worker running, DK dry-run (required even in mock mode).
  setSetting('tracks_per_album_override', TRACK_CAP);
  setSetting('queue_state', 'running');
  setSetting('distrokid_dry_run', true);

  // Clear any stale cover-pick offer from a prior (killed) run so the popup
  // can't surface last run's covers. Best-effort: the .bat starts a fresh
  // bridge (already empty) — this only matters when a long-lived bridge is
  // reused. The bridge's own 15-min TTL is the other guard.
  void fetch('http://localhost:7344/pick-clear', { method: 'POST' }).catch(() => {});

  // Re-runnable: reuse the most recent album for this channel unless it's
  // fully done. A 'failed' or mid-flight album is REQUEUED (steps 01-04 are
  // idempotent — cached Suno tracks + scene.json are reused, so NO Suno
  // re-bill). Only a 'done' album (or none) triggers a fresh, billable run.
  const recent = albumsRepo.getMostRecentByChannel(CHANNEL_ID);
  let album;
  if (recent && recent.status !== 'done') {
    getDb()
      .prepare("UPDATE albums SET status='queued', last_error=NULL, updated_at=? WHERE id=?")
      .run(Date.now(), recent.id);
    album = albumsRepo.get(recent.id)!;
    console.log(
      `[make-medieval-video] RESUMING album ${album.id} (was '${recent.status}') — ` +
        `steps 01-04 idempotent, no Suno re-bill.`,
    );
  } else {
    album = albumsRepo.create({
      channelId: CHANNEL_ID,
      artistName: channel.distrokidArtistName ?? 'medieval path',
    });
    console.log(
      `[make-medieval-video] created NEW album ${album.id} (workflow=${album.workflow}) — ` +
        `${recent ? "previous run was 'done'" : 'no prior album'}.`,
    );
  }

  const dualVariant =
    (channel as { sunoDualVariant?: unknown }).sunoDualVariant === true ||
    (channel as { sunoDualVariant?: unknown }).sunoDualVariant === 1;
  const sunoGenerations = dualVariant ? Math.ceil(TRACK_CAP / 2) : TRACK_CAP;
  const loopFactor = resolveAmbientVideoLoopFactor();

  console.log('');
  console.log('==================================================================');
  console.log(`  medieval path — FULL ${TRACK_CAP}-track video (NOT a smoke run)`);
  console.log(`  album:    ${album.id}`);
  console.log(`  output:   projects/${CHANNEL_ID}/${album.id}/final.mp4`);
  console.log('  DK:       mock + dry-run (no real DistroKid release)');
  console.log(
    `  Suno:     ${TRACK_CAP} tracks via ${sunoGenerations} ${
      dualVariant ? 'dual-variant ' : ''
    }generation(s) — *** REAL SUNO BILL ***`,
  );
  console.log(`  Loop:     every song repeats x${loopFactor} in the final video`);
  console.log('');
  console.log('  Worker is running. Suno generates first (a captcha may appear');
  console.log('  in the :9333 Chrome). When the 4 cover candidates are ready');
  console.log('  the cover-picker window pops to the front with a sound —');
  console.log('  click the one you want. Everything after that is unattended.');
  console.log('==================================================================');
  console.log('');

  void runForever();
}

main();
