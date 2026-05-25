import fs from 'node:fs';
import path from 'node:path';
import * as tracksRepo from '@/lib/repos/tracks';
import * as albumsRepo from '@/lib/repos/albums';
import { ffprobeAudio, validateAudio, audioFileValid } from '@/lib/suno/audio';
import { makeSunoClient, SunoError, type SunoClient } from '@/lib/suno/client';
import {
  isBridgeDisrupted,
  pauseAlbumForBridgeDisruption,
} from '@/lib/suno/bridge-disruption';
import { setSetting } from '@/lib/settings';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const step04SunoDownload: PipelineStep = async (album, log) =>
  step04Internal(
    album,
    log,
    makeSunoClient(),
    process.env.SUNO_MODE === 'mock' ? { pollIntervalMs: 0, pollTimeoutMs: 30_000 } : {},
  );

export type Step04Opts = {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  projectsDir?: string;
};

export async function step04Internal(
  album: Album,
  log: LogFn,
  client: SunoClient,
  opts: Step04Opts = {},
): Promise<void> {
  log('step 04', 'start');
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');

  const tracks = tracksRepo.listByAlbum(album.id);
  if (tracks.length === 0) {
    log('step 04', 'noop (no tracks)');
    return;
  }

  const songsDir = path.join(projectsDir, album.channelId, album.id, 'songs');
  await fs.promises.mkdir(songsDir, { recursive: true });

  const eligible: typeof tracks = [];
  const corrupted: typeof tracks = [];
  for (const t of tracks) {
    if (t.sunoTaskId == null) continue;
    if (t.status === 'failed') continue;
    if (t.audioPath) {
      // Check disk before deciding to re-download. If a file is on disk for a
      // track that already had audio_path set, treat that as the operator's
      // only copy — re-downloading would clobber it with garbage when the
      // Suno WAV URL has expired (URLs are time-limited; retries an hour
      // later get an empty/error response and we lose the original audio).
      const exists = fs.existsSync(t.audioPath);
      if (exists && (await audioFileValid(t.audioPath))) continue;
      if (exists) {
        // File present but ffprobe fails. Don't re-download — surface the
        // failure but keep the bytes around so the operator can inspect.
        corrupted.push(t);
        continue;
      }
    }
    eligible.push(t);
  }
  for (const t of corrupted) {
    tracksRepo.patch(t.id, { status: 'failed' });
    log(
      'step 04',
      `failed track=${t.trackNumber} (audio_path file exists at ${t.audioPath} but ffprobe rejected — preserved, not re-downloading; resubmit the track if you need a clean retry)`,
    );
  }
  if (eligible.length === 0 && corrupted.length === 0) {
    log('step 04', `noop (all ${tracks.length} tracks already downloaded)`);
    return;
  }
  if (eligible.length === 0) {
    // Everything corrupted; nothing left to download. Let the rest of the
    // pipeline fail loudly downstream rather than silently succeeding here.
    log('step 04', `corrupted=${corrupted.length}/${tracks.length} eligible=0`);
    return;
  }
  log(
    'step 04',
    `eligible=${eligible.length}/${tracks.length}${corrupted.length > 0 ? ` corrupted=${corrupted.length}` : ''}`,
  );

  for (const track of eligible) {
    tracksRepo.patch(track.id, { status: 'downloading' });
    log('step 04', `polling track=${track.trackNumber} taskId=${track.sunoTaskId}`);

    const pollStartedAt = Date.now();
    let pollStatus: 'pending' | 'ready' | 'failed' = 'pending';
    while (Date.now() - pollStartedAt < pollTimeoutMs) {
      try {
        pollStatus = await client.poll(track.sunoTaskId!);
      } catch (err) {
        // C4: cookie rotation is non-recoverable mid-album. Halt the album,
        // surface the banner, and bubble the error so the runner detects the
        // awaiting_suno_relogin state. The currently-polling track stays at
        // status='downloading' — operator-driven resume picks it up via the
        // existing audio_path idempotency.
        if (err instanceof SunoError && err.code === 'SUNO_COOKIE_ROTATED') {
          setSetting(
            'suno_cookie_rotated',
            JSON.stringify({
              albumId: album.id,
              channelId: album.channelId,
              at: Date.now(),
            }),
          );
          albumsRepo.patch(album.id, { status: 'awaiting_suno_relogin' });
          log(
            'step 04',
            `halted album for cookie rotation track=${track.trackNumber}`,
          );
          throw err;
        }
        // Bridge / sidecar / Chrome chain disruption — same pause-and-resume
        // pattern as cookie rotation, but the recovery is auto-recoverable
        // by the watchdog (Phase 2). Don't burn the track on retries; the
        // resume path will re-poll the same sunoTaskId once the chain is back.
        if (isBridgeDisrupted(err)) {
          log(
            'step 04',
            `halted album for bridge disruption code=${err.code} track=${track.trackNumber}`,
          );
          pauseAlbumForBridgeDisruption(album.id, album.channelId, err);
        }
        const msg = err instanceof Error ? err.message : String(err);
        log('step 04', `poll error track=${track.trackNumber} err=${msg}`);
        pollStatus = 'pending';
      }
      if (pollStatus !== 'pending') break;
      await sleep(pollIntervalMs);
    }
    if (pollStatus === 'failed') {
      tracksRepo.patch(track.id, { status: 'failed' });
      log('step 04', `task failed track=${track.trackNumber}`);
      continue;
    }
    if (pollStatus !== 'ready') {
      tracksRepo.patch(track.id, { status: 'failed' });
      log('step 04', `task timeout track=${track.trackNumber} after ${pollTimeoutMs}ms`);
      continue;
    }

    const destPath = path.join(songsDir, track.fileName);
    let attempts = 0;
    let succeeded = false;
    let lastErr: unknown;
    while (attempts < 2) {
      try {
        // sunoClipIndex is NULL for legacy/single-clip tracks → undefined →
        // bridge/sidecar default to clip 0 (byte-identical to pre-dual).
        // Suno-dual-variant tracks carry 0/1 to fetch their specific clip
        // from the generation they share with their pair partner.
        await client.download(
          track.sunoTaskId!,
          destPath,
          track.sunoClipIndex ?? undefined,
        );
        const meta = await ffprobeAudio(destPath);
        validateAudio(meta);
        tracksRepo.patch(track.id, {
          audioPath: destPath,
          duration: meta.duration,
          status: 'done',
        });
        log(
          'step 04',
          `done track=${track.trackNumber} duration=${meta.duration.toFixed(2)}s file=${track.fileName}`,
        );
        succeeded = true;
        break;
      } catch (err) {
        // Same pause-and-resume on bridge disruption as the poll loop above.
        // Don't burn the track when the chain is just temporarily down.
        if (isBridgeDisrupted(err)) {
          await fs.promises.unlink(destPath).catch(() => {});
          log(
            'step 04',
            `halted album for bridge disruption code=${(err as SunoError).code} track=${track.trackNumber} (download)`,
          );
          pauseAlbumForBridgeDisruption(album.id, album.channelId, err);
        }
        lastErr = err;
        attempts++;
        await fs.promises.unlink(destPath).catch(() => {});
        if (attempts < 2) {
          const msg = err instanceof Error ? err.message : String(err);
          log('step 04', `retry track=${track.trackNumber} (after attempt ${attempts}) err=${msg}`);
        }
      }
    }
    if (!succeeded) {
      tracksRepo.patch(track.id, { status: 'failed' });
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      const code = lastErr instanceof SunoError ? lastErr.code : 'UNKNOWN';
      log('step 04', `failed track=${track.trackNumber} code=${code} err=${msg}`);
    }
  }

  const after = tracksRepo.listByAlbum(album.id);
  const doneCount = after.filter((t) => t.status === 'done').length;
  const failedCount = after.filter((t) => t.status === 'failed').length;
  log('step 04', `done done=${doneCount}/${tracks.length} failed=${failedCount}`);
}
