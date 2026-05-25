import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { chatCompletionJSON } from '@/lib/llm/openrouter';
import { renderTemplate, resolveChannelPrompt } from '@/lib/prompts';
import { FlowError, makeFlowClient, type FlowClient } from '@/lib/flow/client';
import { drawText, ffprobe, resizeWithMode } from '@/lib/audio/ffmpeg';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const POLL_INTERVAL_MS = 15_000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;
const THUMB_W = 1920;
const THUMB_H = 1080;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ThumbnailDecisionSchema = z.union([
  z.object({ useCover: z.literal(true) }),
  z.object({ useCover: z.literal(false), imagePrompt: z.string().min(1) }),
]);

export type Step05bOpts = {
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  projectsDir?: string;
  /** Override font path (tests). Defaults to prompts/defaults/thumbnail-font.ttf */
  fontPath?: string;
};

export const step05bThumbnail: PipelineStep = async (album, log) =>
  step05bInternal(
    album,
    log,
    makeFlowClient(),
    process.env.FLOW_MODE === 'mock' ? { pollIntervalMs: 0, pollTimeoutMs: 30_000 } : {},
  );

export async function step05bInternal(
  album: Album,
  log: LogFn,
  client: FlowClient,
  opts: Step05bOpts = {},
): Promise<void> {
  log('step 05b', 'start');
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const fontPath =
    opts.fontPath ?? path.join(process.cwd(), 'prompts', 'defaults', 'thumbnail-font.ttf');

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
  const thumbPath = path.join(albumDir, 'thumb.png');

  if (
    fresh.thumbnailPath &&
    (await imageHasDimensions(fresh.thumbnailPath, THUMB_W, THUMB_H))
  ) {
    log('step 05b', 'noop (thumbnail already present and valid)');
    return;
  }

  if (!fresh.coverImagePath || !fs.existsSync(fresh.coverImagePath)) {
    throw new FlowError(
      'COVER_MISSING',
      `step 05a output not found at ${fresh.coverImagePath ?? '(null)'}`,
      false,
    );
  }

  await fs.promises.mkdir(albumDir, { recursive: true });

  // ---- 1. Decide via thumbnail prompt (workflow-aware default + channel override). ----
  const resolved = resolveChannelPrompt(channel, 'thumbnail');
  log(
    'step 05b',
    `prompt loaded source=${resolved.source} kind=${resolved.kind} origin=${resolved.origin}`,
  );
  const rendered = renderTemplate(resolved.content, { album: fresh, channel });
  const decision = await chatCompletionJSON({
    rendered,
    schema: ThumbnailDecisionSchema,
  });

  const rawThumb = path.join(albumDir, '_raw-thumb.png');

  if (decision.useCover) {
    log('step 05b', 'deriving thumbnail from cover (no second Flow call)');
    await resizeWithMode(fresh.coverImagePath, rawThumb, THUMB_W, THUMB_H, 'crop');
  } else {
    log('step 05b', `generating separate thumbnail via Flow prompt="${decision.imagePrompt.slice(0, 80)}..."`);
    await runFlow(
      client,
      decision.imagePrompt,
      '16:9',
      rawThumb,
      log,
      pollIntervalMs,
      pollTimeoutMs,
    );
    // Crop/letterbox to exact 1920x1080.
    const probe = await ffprobe(rawThumb);
    if (probe.width !== THUMB_W || probe.height !== THUMB_H) {
      const adjusted = path.join(albumDir, '_raw-thumb-adj.png');
      await resizeWithMode(rawThumb, adjusted, THUMB_W, THUMB_H, 'crop');
      await fs.promises.rename(adjusted, rawThumb);
    }
  }

  // ---- 2. Optional overlay text. ----
  if (channel.thumbnailOverlayText && channel.thumbnailOverlayText.trim().length > 0) {
    if (fs.existsSync(fontPath)) {
      log('step 05b', `applying drawtext overlay="${channel.thumbnailOverlayText}"`);
      await drawText(rawThumb, thumbPath, {
        text: channel.thumbnailOverlayText,
        fontPath,
        position: 'lower-third',
      });
      await fs.promises.unlink(rawThumb).catch(() => {});
    } else {
      log(
        'step 05b',
        `WARNING thumbnail font missing at ${fontPath}; skipping overlay (drop a TTF there to enable)`,
      );
      await fs.promises.rename(rawThumb, thumbPath);
    }
  } else {
    await fs.promises.rename(rawThumb, thumbPath);
  }

  const probe = await ffprobe(thumbPath);
  if (probe.width !== THUMB_W || probe.height !== THUMB_H) {
    throw new FlowError(
      'FFMPEG_POSTPROCESS_FAILED',
      `thumb.png dimensions ${probe.width}x${probe.height} != ${THUMB_W}x${THUMB_H}`,
      false,
    );
  }

  albumsRepo.patch(album.id, { thumbnailPath: thumbPath });

  log(
    'step 05b',
    `done thumb=${THUMB_W}x${THUMB_H} useCover=${decision.useCover} overlay=${channel.thumbnailOverlayText ? 'yes' : 'no'}`,
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
  log('step 05b', `submitted taskId=${taskId} aspect=${aspect}`);

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
      log('step 05b', `poll error ${msg}`);
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
