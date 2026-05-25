import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import * as tracksRepo from '@/lib/repos/tracks';
import { getRawSetting, getSettings, setSetting } from '@/lib/settings';
import {
  DistrokidError,
  makeDistrokidClient,
  type DistrokidClient,
  type DistrokidMetadata,
} from '@/lib/distrokid/client';
import { resolveTracksPerAlbum } from '@/lib/tracks-per-album';
import { getWorkflow } from '../workflows';
import type { Album } from '@/lib/repos/albums';
import type { Channel } from '@/lib/repos/channels';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const TRACKS_PER_BATCH = 15;
const RELEASE_OFFSET_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Split a unified "First Middle Last" name string into DK form fields.
 * DK requires both first and last; middle is optional. When the channel
 * stores a unified name, we split on whitespace and assume the last token
 * is the surname. Single-word names map to first only (DK form will reject
 * but that is the operator's problem to fix).
 */
function splitSongwriter(full: string | null | undefined): {
  first: string;
  middle: string;
  last: string;
} {
  if (!full || full.trim().length === 0) return { first: '', middle: '', last: '' };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], middle: '', last: '' };
  if (parts.length === 2) return { first: parts[0], middle: '', last: parts[1] };
  return {
    first: parts[0],
    middle: parts.slice(1, -1).join(' '),
    last: parts[parts.length - 1],
  };
}

export type Step06Opts = {
  projectsDir?: string;
  /** When set, used instead of `Date.now()` (test seam). */
  now?: () => number;
};

export const step06DistrokidSubmit: PipelineStep = async (album, log) =>
  step06Internal(album, log, makeDistrokidClient(), {});

export async function step06Internal(
  album: Album,
  log: LogFn,
  client: DistrokidClient,
  opts: Step06Opts = {},
): Promise<void> {
  log('step 06', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const nowFn = opts.now ?? (() => Date.now());

  // --- A. Hard live-mode gate (Session 13 unlocks). Must be first DB read. ---
  const dryRunSetting = getRawSetting('distrokid_dry_run');
  if (dryRunSetting !== 'true') {
    setSetting('distrokid_live_mode_blocked_at', String(nowFn()));
    log('step 06', 'live mode requested but blocked — Session 13 unlocks');
    throw new DistrokidError(
      'DISTROKID_LIVE_MODE_DISABLED',
      'Live DistroKid submission is hard-disabled until Session 13. Set distrokid_dry_run=true.',
      false,
    );
  }

  // --- B. Refresh from DB (other steps may have written). ---
  const fresh = albumsRepo.get(album.id) ?? album;
  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new DistrokidError(
      'CHANNEL_NOT_FOUND',
      `channel ${fresh.channelId} not found for album ${album.id}`,
      false,
    );
  }

  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  const screenshotPath = path.join(albumDir, 'distrokid-dryrun.png');
  const payloadPath = path.join(albumDir, 'distrokid-payload.json');

  // --- C. Idempotency: artifact-already-exists noop. ---
  if (
    fresh.distrokidDryRunArtifact &&
    fs.existsSync(fresh.distrokidDryRunArtifact) &&
    fs.statSync(fresh.distrokidDryRunArtifact).size > 0
  ) {
    log('step 06', `noop (dry-run artifact already exists at ${fresh.distrokidDryRunArtifact})`);
    return;
  }

  await fs.promises.mkdir(albumDir, { recursive: true });

  // --- D. Pre-flight verify_artist. ---
  try {
    const v = await client.verifyArtist(fresh.artistName);
    if (!v.found) {
      setSetting(
        'distrokid_artist_missing',
        JSON.stringify({
          albumId: fresh.id,
          channelId: channel.id,
          artistName: fresh.artistName,
          at: nowFn(),
        }),
      );
      throw new DistrokidError(
        'DISTROKID_ARTIST_NOT_FOUND',
        `Artist "${fresh.artistName}" not in DistroKid dropdown`,
        false,
      );
    }
  } catch (err) {
    if (err instanceof DistrokidError && err.code === 'DISTROKID_ARTIST_NOT_FOUND') {
      setSetting(
        'distrokid_artist_missing',
        JSON.stringify({
          albumId: fresh.id,
          channelId: channel.id,
          artistName: fresh.artistName,
          at: nowFn(),
        }),
      );
    }
    throw err;
  }
  setSetting('distrokid_artist_missing', '');
  log('step 06', `verify_artist ok artistName="${fresh.artistName}"`);

  // --- E. Verify cover + N tracks on disk (N=30 in prod, override for tests). ---
  if (!fresh.coverImagePath || !fs.existsSync(fresh.coverImagePath)) {
    throw new DistrokidError(
      'DISTROKID_COVER_MISSING',
      `cover.png not found at ${fresh.coverImagePath ?? '(null)'}`,
      false,
    );
  }
  const workflow = getWorkflow(channel.workflow);
  const expectedTracks = resolveTracksPerAlbum(channel as Channel, workflow);
  const tracks = tracksRepo.listByAlbum(fresh.id);
  const playable = tracks.filter((t) => t.audioPath && fs.existsSync(t.audioPath));
  if (playable.length !== expectedTracks) {
    throw new DistrokidError(
      'DISTROKID_TRACK_FILES_MISSING',
      `expected ${expectedTracks} playable tracks on disk, found ${playable.length}`,
      false,
    );
  }

  // --- F. Start release + set metadata. ---
  const { releaseToken } = await client.startRelease();
  log('step 06', `releaseToken=${releaseToken}`);

  const now = nowFn();
  const releaseDate = new Date(now + RELEASE_OFFSET_DAYS * DAY_MS).toISOString().slice(0, 10);
  const allSettings = getSettings();
  // Credit precedence: channel-level overrides win, fall back to global
  // settings. Channel.distrokidSongwriterName is unified ("First Last");
  // we split into DK's first/middle/last fields when present.
  const channelSongwriter = splitSongwriter(channel.distrokidSongwriterName);
  const songwriterFirst =
    channelSongwriter.first || allSettings.distrokid_songwriter_first_name;
  const songwriterMiddle =
    channelSongwriter.middle || allSettings.distrokid_songwriter_middle_name;
  const songwriterLast =
    channelSongwriter.last || allSettings.distrokid_songwriter_last_name;
  const fullSongwriterName = [songwriterFirst, songwriterMiddle, songwriterLast]
    .filter((s) => s && s.length > 0)
    .join(' ');
  const creditPerformerName =
    channel.distrokidPerformerName ||
    allSettings.distrokid_credit_performer_name ||
    fullSongwriterName;
  const creditPerformerRole =
    channel.distrokidPerformerRole || allSettings.distrokid_credit_performer_role || '';
  const creditProducerName =
    channel.distrokidProducerName ||
    allSettings.distrokid_credit_producer_name ||
    fullSongwriterName;
  const creditProducerRole =
    channel.distrokidProducerRole || allSettings.distrokid_credit_producer_role || '';
  const metadata: DistrokidMetadata = {
    albumTitle: fresh.albumTitle,
    artistName: fresh.artistName,
    genre: channel.distrokidPrimaryGenre,
    language: 'English',
    explicit: false,
    releaseDate,
    label: channel.distrokidLabelName ?? '',
    numSongs: expectedTracks,
    songwriterFirstName: songwriterFirst || undefined,
    songwriterMiddleName: songwriterMiddle || undefined,
    songwriterLastName: songwriterLast || undefined,
    creditPerformerName: creditPerformerRole ? creditPerformerName : undefined,
    creditPerformerRole: creditPerformerRole || undefined,
    creditProducerName: creditProducerRole ? creditProducerName : undefined,
    creditProducerRole: creditProducerRole || undefined,
  };
  await client.setMetadata(releaseToken, metadata);
  log(
    'step 06',
    `metadata set title="${fresh.albumTitle}" genre="${metadata.genre}" date=${releaseDate}`,
  );

  // --- G. Upload cover. ---
  // Step 05a writes cover.jpg next to cover.png whenever the PNG exceeded the
  // configured cover_resample_threshold_mb (DK rejects covers > 10 MB). Prefer
  // the JPEG sibling only when its mtime is at least as recent as the PNG —
  // otherwise it's a stale leftover from a prior over-threshold run and would
  // misrepresent the current cover.
  const coverJpgCandidate = fresh.coverImagePath.replace(/\.png$/i, '.jpg');
  let coverForUpload = fresh.coverImagePath;
  if (coverJpgCandidate !== fresh.coverImagePath && fs.existsSync(coverJpgCandidate)) {
    const pngMtime = fs.statSync(fresh.coverImagePath).mtimeMs;
    const jpgMtime = fs.statSync(coverJpgCandidate).mtimeMs;
    if (jpgMtime >= pngMtime) {
      coverForUpload = coverJpgCandidate;
    } else {
      log(
        'step 06',
        `stale cover.jpg ignored (jpg mtime < png mtime); using cover.png`,
      );
    }
  }
  const coverResult = await client.uploadCover(releaseToken, coverForUpload);
  if (coverResult.requiresManualUpload) {
    log('step 06', `cover requires manual upload (operator drag-drop ${path.basename(coverForUpload)})`);
  } else {
    log('step 06', `cover uploaded from ${path.basename(coverForUpload)}`);
  }

  // --- H. Upload tracks in 2 batches of 15, verify count after each. ---
  const sorted = [...tracks].sort((a, b) => a.trackNumber - b.trackNumber);
  const batches: typeof sorted[] = [];
  for (let i = 0; i < sorted.length; i += TRACKS_PER_BATCH) {
    batches.push(sorted.slice(i, i + TRACKS_PER_BATCH));
  }
  let uploaded = 0;
  let manualBatches = 0;
  for (let b = 0; b < batches.length; b++) {
    for (const t of batches[b]) {
      const r = await client.uploadTrack(releaseToken, t.audioPath!, t.trackNumber, t.title);
      if (r.requiresManualUpload) manualBatches++;
      uploaded++;
    }
    const verify = await client.verifyTrackCount(releaseToken, uploaded);
    if (!verify.matches) {
      throw new DistrokidError(
        'DISTROKID_TRACK_UPLOAD_MISMATCH',
        `after batch ${b + 1}: expected ${uploaded} tracks, server reports ${verify.count}`,
        true,
      );
    }
    log('step 06', `batch ${b + 1}/${batches.length} verified count=${verify.count}`);
  }

  // --- I. Submit or screenshot — captcha may pause here. ---
  const result = await client.submitOrScreenshot(releaseToken, screenshotPath, true, {
    channelName: channel.name,
  });

  if (result.status === 'captcha_required') {
    setSetting(
      'distrokid_captcha_pending',
      JSON.stringify({ albumId: fresh.id, channelId: channel.id, at: nowFn() }),
    );
    albumsRepo.patch(fresh.id, { status: 'awaiting_captcha' });
    log('step 06', 'captcha_required — album paused, awaiting operator');
    return; // CLEAN RETURN. Runner respects awaiting_captcha to skip status='done'.
  }

  if (result.status !== 'screenshot_saved') {
    throw new DistrokidError(
      'DISTROKID_UNEXPECTED_STATUS',
      `unexpected submit_or_screenshot status: ${result.status}`,
      false,
    );
  }

  // --- J. Verify screenshot exists on disk. ---
  if (!fs.existsSync(screenshotPath) || fs.statSync(screenshotPath).size === 0) {
    throw new DistrokidError(
      'DISTROKID_SCREENSHOT_MISSING',
      `extension/mock did not write screenshot to ${screenshotPath}`,
      false,
    );
  }

  // --- K. Save payload JSON for audit. ---
  const payload = {
    metadata,
    cover: coverForUpload,
    coverPng: fresh.coverImagePath,
    tracks: sorted.map((t) => ({
      trackNumber: t.trackNumber,
      title: t.title,
      fileName: t.fileName,
      duration: t.duration,
      audioPath: t.audioPath,
    })),
    releaseToken,
    requiresManualUpload: manualBatches > 0 || coverResult.requiresManualUpload === true,
    capturedAt: now,
  };
  await fs.promises.writeFile(payloadPath, JSON.stringify(payload, null, 2));

  // --- L. Content ID hold timestamps + final album state. ---
  const settings = getSettings();
  const holdMs = settings.content_id_hold_days * DAY_MS;
  albumsRepo.patch(fresh.id, {
    distrokidStatus: 'dryrun',
    distrokidDryRunArtifact: screenshotPath,
    distrokidSubmittedAt: now,
    safeToUploadAfter: now + holdMs,
  });

  log(
    'step 06',
    `done dryrun screenshot=${path.basename(screenshotPath)} payload=${path.basename(
      payloadPath,
    )} safeAfter=+${settings.content_id_hold_days}d`,
  );
}
