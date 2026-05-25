import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { getSettings } from '@/lib/settings';
import { resolveChannelPrompt } from '@/lib/prompts';
import { generateImagePrompt } from '@/lib/flow/llm-image-prompt';
import { FlowError, makeFlowClient, type FlowClient } from '@/lib/flow/client';
import {
  compressToJpeg,
  cropAndScaleSquare,
  ffprobe,
  resizeWithMode,
  type ResizeMode,
} from '@/lib/audio/ffmpeg';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const COVER_PX = 3000;
const YT_W = 1920;
const YT_H = 1080;
const ASPECT_TOLERANCE = 1.3; // flag images more extreme than 1:1.3 either way

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Step05aOpts = {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  projectsDir?: string;
};

export const step05aCoverImage: PipelineStep = async (album, log) =>
  step05aInternal(
    album,
    log,
    makeFlowClient(),
    process.env.FLOW_MODE === 'mock' ? { pollIntervalMs: 0, pollTimeoutMs: 30_000 } : {},
  );

export async function step05aInternal(
  album: Album,
  log: LogFn,
  client: FlowClient,
  opts: Step05aOpts = {},
): Promise<void> {
  log('step 05a', 'start');
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
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
    log('step 05a', `noop (cover and ytImage already present and valid)`);
    return;
  }

  await fs.promises.mkdir(albumDir, { recursive: true });

  // ---- 1. Generate visual prompt + Flow call (with one aspect-retry pass). ----
  const coverPrompt = resolveChannelPrompt(channel, 'cover-image');
  log(
    'step 05a',
    `prompt loaded source=${coverPrompt.source} kind=${coverPrompt.kind} origin=${coverPrompt.origin}`,
  );
  let prompt = await generateImagePrompt({
    album: fresh,
    channel,
    templateContent: coverPrompt.content,
  });
  log('step 05a', `prompt="${prompt.slice(0, 80).replace(/\s+/g, ' ')}..."`);
  await runFlow(client, prompt, '1:1', rawPath, log, pollIntervalMs, pollTimeoutMs);

  let probe = await ffprobe(rawPath);
  if (!probe.width || !probe.height) {
    throw new FlowError('FFMPEG_POSTPROCESS_FAILED', `ffprobe could not read ${rawPath}`, false);
  }
  const aspect = probe.width / probe.height;
  if (aspect > ASPECT_TOLERANCE || aspect < 1 / ASPECT_TOLERANCE) {
    log(
      'step 05a',
      `aspect-retry: got ${probe.width}x${probe.height} (aspect=${aspect.toFixed(3)}), regenerating with square emphasis`,
    );
    prompt = await generateImagePrompt({
      album: fresh,
      channel,
      templateContent: coverPrompt.content,
      forceSquare: true,
    });
    await fs.promises.unlink(rawPath).catch(() => {});
    await runFlow(client, prompt, '1:1', rawPath, log, pollIntervalMs, pollTimeoutMs);
    probe = await ffprobe(rawPath);
    if (!probe.width || !probe.height) {
      throw new FlowError(
        'FFMPEG_POSTPROCESS_FAILED',
        `ffprobe could not read retried image ${rawPath}`,
        false,
      );
    }
    const retryAspect = probe.width / probe.height;
    if (retryAspect > ASPECT_TOLERANCE || retryAspect < 1 / ASPECT_TOLERANCE) {
      log(
        'step 05a',
        `aspect-retry exhausted: still ${probe.width}x${probe.height}, accepting and force-cropping`,
      );
    }
  }

  // ---- 2. FFmpeg post-process: cover.png 3000x3000 + ytImage.png 1920x1080. ----
  const settings = getSettings();
  // Per-channel youtube_image_aspect overrides the global setting when set.
  const aspectChoice = channel.youtubeImageAspect ?? settings.youtube_image_aspect;
  const ytMode: ResizeMode = aspectChoice === 'crop' ? 'crop' : 'letterbox';
  // Auto-resample target. DistroKid's hard cap is 10 MB; the configured
  // threshold sits below it so the JPEG never lands flush against DK's
  // limit. Step 05a writes cover.jpg only when cover.png exceeds this.
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
  // Auto-resample to JPEG when cover.png approaches DK's 10 MB cap. The PNG
  // stays in place — step 05b derives the thumbnail from it (high-quality
  // source preferred), and step 06 prefers the JPEG sibling when present.
  let coverJpgSize: number | null = null;
  let coverJpgQ: number | null = null;
  if (coverSize > coverResampleTargetBytes) {
    log(
      'step 05a',
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
      'step 05a',
      `cover.jpg q=${result.qScale} size=${(result.finalSizeBytes / 1024 / 1024).toFixed(
        2,
      )}MB attempts=${result.attempts}`,
    );
  } else {
    log(
      'step 05a',
      `cover.png ${(coverSize / 1024 / 1024).toFixed(2)}MB <= ${(
        coverResampleTargetBytes /
        1024 /
        1024
      ).toFixed(1)}MB threshold; no resample needed`,
    );
    if (fs.existsSync(coverJpgPath)) {
      // Stale jpeg from a prior over-threshold run. cover.png is now small
      // enough on its own — drop the leftover so step 06 doesn't pick up a
      // stale jpeg that doesn't reflect the current cover.
      await fs.promises.unlink(coverJpgPath).catch(() => {});
    }
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

  albumsRepo.patch(album.id, {
    coverImagePath: coverPath,
    ytImagePath,
  });

  const jpgSummary =
    coverJpgSize != null
      ? ` cover.jpg=${(coverJpgSize / 1024).toFixed(0)}KB q=${coverJpgQ}`
      : '';
  log(
    'step 05a',
    `done cover=${COVER_PX}x${COVER_PX} (${(coverSize / 1024).toFixed(
      0,
    )}KB)${jpgSummary} ytImage=${YT_W}x${YT_H} mode=${ytMode}`,
  );
}

async function runFlow(
  client: FlowClient,
  prompt: string,
  aspect: '1:1' | '16:9' | '9:16',
  destPath: string,
  log: LogFn,
  pollIntervalMs: number,
  pollTimeoutMs: number,
): Promise<void> {
  const taskId = await client.submitPrompt(prompt, aspect);
  log('step 05a', `submitted taskId=${taskId} aspect=${aspect}`);

  const startedAt = Date.now();
  let status: 'pending' | 'ready' | 'failed' = 'pending';
  while (Date.now() - startedAt < pollTimeoutMs) {
    try {
      status = await client.poll(taskId);
    } catch (err) {
      if (err instanceof FlowError && err.code === 'FLOW_PROMPT_REJECTED') {
        throw err;
      }
      const msg = err instanceof Error ? err.message : String(err);
      log('step 05a', `poll error ${msg}`);
      status = 'pending';
    }
    if (status !== 'pending') break;
    await sleep(pollIntervalMs);
  }
  if (status !== 'ready') {
    throw new FlowError(
      'FLOW_TASK_FAILED',
      `task ${taskId} ended with status=${status} after ${Date.now() - startedAt}ms`,
      true,
    );
  }
  await client.download(taskId, destPath);
  log('step 05a', `downloaded -> ${path.basename(destPath)}`);
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
