/**
 * ambient-video variant of step 05a. Produces `cover.png` (3000×3000) and
 * `ytImage.png` (1920×1080) for the album.
 *
 * Source resolution order (first match wins):
 *   1. `projects/<ch>/<alb>/source.jpg` (operator drop-in for this album)
 *   2. Freepik runner generates from `album.scene_image_prompt` (Pass 2)
 *   3. `projects/<channel_id>/source.jpg` (channel-level operator fallback)
 *
 * The same `source.jpg` is reused by step 08 (Seedance first+last frame) so
 * the cover, thumbnail base, and video bed all share one image.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { getSettings } from '@/lib/settings';
import { FlowError } from '@/lib/flow/client';
import {
  compressToJpeg,
  cropAndScaleSquare,
  ffprobe,
  resizeWithMode,
  type ResizeMode,
} from '@/lib/audio/ffmpeg';
import {
  makeFreepikClient,
  FreepikError,
  type FreepikClient,
} from '@/lib/freepik/client';
import { sourceJpgPath } from '../workflows/checks';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const COVER_PX = 3000;
const YT_W = 1920;
const YT_H = 1080;
const SOURCE_JPG_MIN_BYTES = 50 * 1024;
const FREEPIK_POLL_INTERVAL_MS = 5_000;
const FREEPIK_POLL_TIMEOUT_MS = 5 * 60_000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Step05aAmbientVideoOpts = {
  projectsDir?: string;
  /** Optional client override for tests. Production resolves via factory. */
  freepikClient?: FreepikClient;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export const step05aAmbientVideoCover: PipelineStep = async (album, log) =>
  step05aAmbientVideoInternal(album, log);

export async function step05aAmbientVideoInternal(
  album: Album,
  log: LogFn,
  opts: Step05aAmbientVideoOpts = {},
): Promise<void> {
  log('step 05a-amv', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');

  const fresh = albumsRepo.get(album.id) ?? album;
  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new FlowError(
      'CHANNEL_NOT_FOUND',
      `channel ${fresh.channelId} not found for album ${album.id}`,
      false,
    );
  }

  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  const albumSourcePath = path.join(albumDir, 'source.jpg');
  const coverPath = path.join(albumDir, 'cover.png');
  const coverJpgPath = path.join(albumDir, 'cover.jpg');
  const ytImagePath = path.join(albumDir, 'ytImage.png');
  const rawPath = path.join(albumDir, '_raw-cover.png');

  if (
    fresh.coverImagePath &&
    fresh.ytImagePath &&
    (await imageHasDimensions(fresh.coverImagePath, COVER_PX, COVER_PX)) &&
    (await imageHasDimensions(fresh.ytImagePath, YT_W, YT_H))
  ) {
    log('step 05a-amv', 'noop (cover and ytImage already present and valid)');
    return;
  }

  await fs.promises.mkdir(albumDir, { recursive: true });

  // ---- 1. Resolve source.jpg: album folder > Freepik gen > channel folder ----
  const resolvedSource = await resolveSourceImage({
    log,
    channelId: fresh.channelId,
    scenePrompt: fresh.sceneImagePrompt,
    styleName: channel.imageStyleName,
    albumSourcePath,
    opts,
  });
  if (!resolvedSource.ok) {
    throw new FlowError(resolvedSource.code, resolvedSource.message, false);
  }
  log('step 05a-amv', `source=${resolvedSource.origin} bytes=${resolvedSource.size}`);

  // Copy whichever source we resolved to the album-local `_raw-cover.png` so
  // the post-process helpers can reuse the existing reference. cropAndScale
  // re-encodes to a real PNG; the input extension doesn't matter.
  await fs.promises.copyFile(resolvedSource.path, rawPath);

  // ---- 2. FFmpeg post-process (same shape as the ambient Flow path). ----
  const settings = getSettings();
  const aspectChoice = channel.youtubeImageAspect ?? settings.youtube_image_aspect;
  const ytMode: ResizeMode = aspectChoice === 'crop' ? 'crop' : 'letterbox';
  const coverResampleTargetBytes = Math.floor(
    settings.cover_resample_threshold_mb * 1024 * 1024,
  );

  await cropAndScaleSquare(rawPath, coverPath, COVER_PX);
  const coverProbe = await ffprobe(coverPath);
  if (coverProbe.width !== COVER_PX || coverProbe.height !== COVER_PX) {
    throw new FlowError(
      'FFMPEG_POSTPROCESS_FAILED',
      `cover.png dimensions ${coverProbe.width}x${coverProbe.height} != ${COVER_PX}x${COVER_PX}`,
      false,
    );
  }
  const coverSize = (await fs.promises.stat(coverPath)).size;
  let coverJpgSize: number | null = null;
  let coverJpgQ: number | null = null;
  if (coverSize > coverResampleTargetBytes) {
    log(
      'step 05a-amv',
      `cover.png ${(coverSize / 1024 / 1024).toFixed(2)}MB > ${(
        coverResampleTargetBytes /
        1024 /
        1024
      ).toFixed(1)}MB threshold; resampling to cover.jpg for DistroKid upload`,
    );
    const result = await compressToJpeg(coverPath, coverJpgPath, coverResampleTargetBytes);
    coverJpgSize = result.finalSizeBytes;
    coverJpgQ = result.qScale;
    log(
      'step 05a-amv',
      `cover.jpg q=${result.qScale} size=${(result.finalSizeBytes / 1024 / 1024).toFixed(2)}MB attempts=${result.attempts}`,
    );
  } else if (fs.existsSync(coverJpgPath)) {
    await fs.promises.unlink(coverJpgPath).catch(() => {});
  }

  await resizeWithMode(rawPath, ytImagePath, YT_W, YT_H, ytMode);
  const ytProbe = await ffprobe(ytImagePath);
  if (ytProbe.width !== YT_W || ytProbe.height !== YT_H) {
    throw new FlowError(
      'FFMPEG_POSTPROCESS_FAILED',
      `ytImage.png dimensions ${ytProbe.width}x${ytProbe.height} != ${YT_W}x${YT_H}`,
      false,
    );
  }

  await fs.promises.unlink(rawPath).catch(() => {});

  albumsRepo.patch(fresh.id, {
    coverImagePath: coverPath,
    ytImagePath,
  });

  const jpgSummary =
    coverJpgSize != null
      ? ` cover.jpg=${(coverJpgSize / 1024).toFixed(0)}KB q=${coverJpgQ}`
      : '';
  log(
    'step 05a-amv',
    `done cover=${COVER_PX}x${COVER_PX} (${(coverSize / 1024).toFixed(0)}KB)${jpgSummary} ytImage=${YT_W}x${YT_H} mode=${ytMode}`,
  );
}

type ResolveResult =
  | { ok: true; path: string; size: number; origin: 'album-folder' | 'freepik-runner' | 'channel-folder' }
  | { ok: false; code: string; message: string };

async function resolveSourceImage(args: {
  log: LogFn;
  channelId: string;
  scenePrompt: string | null;
  styleName: string | null;
  albumSourcePath: string;
  opts: Step05aAmbientVideoOpts;
}): Promise<ResolveResult> {
  // (1) Operator drop-in at the album folder always wins.
  const albumStat = await safeStat(args.albumSourcePath);
  if (albumStat && albumStat.size > SOURCE_JPG_MIN_BYTES) {
    return { ok: true, path: args.albumSourcePath, size: albumStat.size, origin: 'album-folder' };
  }

  // (2) Freepik runner — when there's a scene prompt, ask the bridge.
  if (args.scenePrompt && args.scenePrompt.trim().length > 0) {
    args.log('step 05a-amv', 'invoking freepik runner via scene_image_prompt');
    const generated = await tryFreepik(args);
    if (generated.ok) return generated;
    args.log('step 05a-amv', `freepik attempt failed: ${generated.code} — ${generated.message}`);
    // fall through to channel-folder fallback so an operator can still
    // override manually with a pre-dropped source.jpg.
  }

  // (3) Channel-level operator fallback at projects/<ch>/source.jpg.
  const channelPath = sourceJpgPath(args.channelId);
  const channelStat = await safeStat(channelPath);
  if (channelStat && channelStat.size > SOURCE_JPG_MIN_BYTES) {
    return { ok: true, path: channelPath, size: channelStat.size, origin: 'channel-folder' };
  }

  return {
    ok: false,
    code: 'SOURCE_JPG_MISSING',
    message:
      `no source.jpg available for album. Tried: album ${args.albumSourcePath}, ` +
      `freepik runner (scene_image_prompt=${args.scenePrompt ? 'set' : 'null'}), ` +
      `channel ${channelPath}.`,
  };
}

async function tryFreepik(args: {
  channelId: string;
  scenePrompt: string | null;
  albumSourcePath: string;
  styleName: string | null;
  opts: Step05aAmbientVideoOpts;
}): Promise<ResolveResult> {
  const client = args.opts.freepikClient ?? makeFreepikClient();
  const settings = getSettings();
  const model = settings.freepik_model_name ?? 'seedream-5';
  const pollIntervalMs = args.opts.pollIntervalMs ?? FREEPIK_POLL_INTERVAL_MS;
  const pollTimeoutMs = args.opts.pollTimeoutMs ?? FREEPIK_POLL_TIMEOUT_MS;

  let taskId: string;
  try {
    taskId = await client.submit({
      prompt: args.scenePrompt!,
      model,
      aspectRatio: '16:9',
      styleName: args.styleName ?? undefined,
    });
  } catch (err) {
    if (err instanceof FreepikError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: 'FREEPIK_SUBMIT_FAILED', message: String(err) };
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < pollTimeoutMs) {
    let status: 'pending' | 'ready' | 'failed';
    try {
      status = await client.poll(taskId);
    } catch (err) {
      if (err instanceof FreepikError && !err.retriable) {
        return { ok: false, code: err.code, message: err.message };
      }
      // Transient — keep polling.
      await sleep(pollIntervalMs);
      continue;
    }
    if (status === 'ready') break;
    if (status === 'failed') {
      return { ok: false, code: 'FREEPIK_TASK_FAILED', message: `task ${taskId} failed` };
    }
    await sleep(pollIntervalMs);
  }

  try {
    await client.download(taskId, args.albumSourcePath);
  } catch (err) {
    if (err instanceof FreepikError) {
      return { ok: false, code: err.code, message: err.message };
    }
    return { ok: false, code: 'FREEPIK_DOWNLOAD_FAILED', message: String(err) };
  }

  const stat = await safeStat(args.albumSourcePath);
  if (!stat || stat.size <= SOURCE_JPG_MIN_BYTES) {
    return {
      ok: false,
      code: 'FREEPIK_RESULT_TOO_SMALL',
      message: `freepik produced ${stat?.size ?? 0} bytes at ${args.albumSourcePath}`,
    };
  }
  return { ok: true, path: args.albumSourcePath, size: stat.size, origin: 'freepik-runner' };
}

async function safeStat(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(p);
  } catch {
    return null;
  }
}

async function imageHasDimensions(file: string, w: number, h: number): Promise<boolean> {
  if (!fs.existsSync(file)) return false;
  try {
    const probe = await ffprobe(file);
    return probe.width === w && probe.height === h;
  } catch {
    return false;
  }
}
