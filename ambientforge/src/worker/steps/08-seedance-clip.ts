/**
 * ambient-video branch B, step 08: generate a 5-second seamless-loop motion
 * clip via Magnific Seedance 2.0 Fast (routed through the freepik-runner
 * extension, mode='image-to-video'). The just-picked image from step 05a is
 * the implicit input — the extension clicks Magnific's "Create video" button
 * on the visible result. source.jpg is the operator's only override path;
 * Seedance/Magnific manages first/last frame internally.
 *
 * Legacy: src/lib/seedance/client.ts (OpenRouter REST) is retained for
 * mock-only tests but no longer used in the prod path.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { ffprobe } from '@/lib/audio/ffmpeg';
import {
  makeFreepikClient,
  FreepikError,
  type FreepikClient,
} from '@/lib/freepik/client';
import { SeedanceError } from '@/lib/seedance/client';
import { sourceJpgPath } from '../workflows/checks';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const POLL_INTERVAL_MS = 5_000;
// 15 min covers Magnific Seedance Fast (~1-5 min) + safety. Same upper bound
// as step 05a since both gate on Magnific tab activity.
const POLL_TIMEOUT_MS = 15 * 60 * 1000;
const CLIP_DURATION_S = 5;
const CLIP_MIN_DURATION_S = 4; // tolerance for "ready clip" idempotency

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type Step08SeedanceOpts = {
  projectsDir?: string;
  /** Inject a freepik client for tests. Defaults to the bridge HTTP client. */
  client?: FreepikClient;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export const step08SeedanceClip: PipelineStep = async (album, log) =>
  step08SeedanceInternal(album, log);

export async function step08SeedanceInternal(
  album: Album,
  log: LogFn,
  opts: Step08SeedanceOpts = {},
): Promise<void> {
  log('step 08-seedance', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;

  // Branch B owns video_status writes. Mark in-flight on first entry so the
  // dashboard can show "rendering" before Seedance returns.
  albumsRepo.patch(album.id, { videoStatus: 'rendering' });

  const fresh = albumsRepo.get(album.id) ?? album;
  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new SeedanceError(
      'CHANNEL_NOT_FOUND',
      `channel ${fresh.channelId} not found for album ${album.id}`,
      false,
    );
  }

  // ---- 1. Resolve motion prompt: album wins over channel fallback. ----
  const albumPrompt = (fresh.sceneSeedancePrompt ?? '').trim();
  const channelPrompt = (channel.seedanceMotionPrompt ?? '').trim();
  let prompt: string;
  if (albumPrompt.length > 0) {
    prompt = albumPrompt;
    log('step 08-seedance', 'Using album-generated motion prompt');
  } else if (channelPrompt.length > 0) {
    prompt = channelPrompt;
    log('step 08-seedance', 'Using channel fallback motion prompt');
  } else {
    throw new SeedanceError(
      'SEEDANCE_PROMPT_MISSING',
      `no album.sceneSeedancePrompt and no channel.seedanceMotionPrompt for album ${album.id}`,
      false,
    );
  }

  // ---- 2. Idempotency: skip if clip.mp4 already looks ready. ----
  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  const buildDir = path.join(albumDir, 'build');
  const clipPath = path.join(buildDir, 'clip.mp4');
  await fs.promises.mkdir(buildDir, { recursive: true });
  if (await clipLooksReady(clipPath)) {
    log('step 08-seedance', `noop (clip.mp4 already valid at ${clipPath})`);
    return;
  }

  // ---- 3. Note source.jpg availability (informational only — Magnific's
  // Seedance pulls the frame from the just-picked image visible in the tab,
  // not from a path we hand it). The album-folder source.jpg is what step
  // 05a wrote there, and it must exist if step 05a ran successfully. ----
  const albumSourcePath = path.join(albumDir, 'source.jpg');
  const channelSourcePath = sourceJpgPath(fresh.channelId);
  const endFrameSourcePath = fs.existsSync(albumSourcePath)
    ? albumSourcePath
    : fs.existsSync(channelSourcePath)
      ? channelSourcePath
      : undefined;
  log(
    'step 08-seedance',
    endFrameSourcePath
      ? `source.jpg at ${path.relative(process.cwd(), endFrameSourcePath)} — CDP-uploaded as the Seedance end frame (end==start → seamless loop)`
      : `no source.jpg on disk — end frame falls back to the operator-manual gate (loop may seam)`,
  );

  // ---- 4. Submit + poll + download via the freepik bridge. ----
  const client: FreepikClient = opts.client ?? makeFreepikClient();
  const jobId = await client.submitVideo({
    prompt,
    model: 'Seedance 2.0 Fast',
    aspectRatio: '16:9',
    sourceImagePath: endFrameSourcePath,
  });
  log(
    'step 08-seedance',
    `submitted bridge-jobId=${jobId} expected-duration=${CLIP_DURATION_S}s aspect=16:9 mode=image-to-video`,
  );

  const startedAt = Date.now();
  let status: 'pending' | 'ready' | 'failed' = 'pending';
  while (Date.now() - startedAt < pollTimeoutMs) {
    try {
      status = await client.poll(jobId);
    } catch (err) {
      // Bridge-level FREEPIK_TASK_FAILED is terminal; transient errors keep
      // polling until timeout. FreepikError.retriable flags the difference.
      if (err instanceof FreepikError && !err.retriable) {
        throw new SeedanceError(
          'SEEDANCE_TASK_FAILED',
          `freepik bridge failed: ${err.code} ${err.message}`,
          false,
          err.status,
          err,
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      log('step 08-seedance', `poll error ${msg}`);
      status = 'pending';
    }
    if (status !== 'pending') break;
    await sleep(pollIntervalMs);
  }
  if (status !== 'ready') {
    throw new SeedanceError(
      'SEEDANCE_TASK_FAILED',
      `freepik video job ${jobId} ended with status=${status} after ${Date.now() - startedAt}ms`,
      true,
    );
  }

  await client.download(jobId, clipPath);
  log('step 08-seedance', `downloaded -> ${path.relative(process.cwd(), clipPath)}`);

  // ---- 5. Validate the produced clip. ----
  const probe = await ffprobe(clipPath);
  if (probe.codec !== 'h264') {
    throw new SeedanceError(
      'SEEDANCE_INVALID_CLIP',
      `clip.mp4 has codec=${probe.codec ?? 'unknown'}, expected h264`,
      false,
    );
  }
  if (probe.duration === undefined || probe.duration < CLIP_MIN_DURATION_S) {
    throw new SeedanceError(
      'SEEDANCE_INVALID_CLIP',
      `clip.mp4 duration=${probe.duration?.toFixed(2) ?? '?'}s, expected ≥${CLIP_MIN_DURATION_S}s`,
      false,
    );
  }
  if (!is16x9Aspect(probe.width, probe.height)) {
    throw new SeedanceError(
      'SEEDANCE_INVALID_CLIP',
      `clip.mp4 dims=${probe.width}x${probe.height} not 16:9`,
      false,
    );
  }
  log(
    'step 08-seedance',
    `done codec=${probe.codec} dur=${probe.duration.toFixed(2)}s dims=${probe.width}x${probe.height}`,
  );
}

async function clipLooksReady(p: string): Promise<boolean> {
  if (!fs.existsSync(p)) return false;
  try {
    const probe = await ffprobe(p);
    if (probe.codec !== 'h264') return false;
    if (probe.duration === undefined) return false;
    return probe.duration >= CLIP_MIN_DURATION_S;
  } catch {
    return false;
  }
}

function is16x9Aspect(w: number | undefined, h: number | undefined): boolean {
  if (!w || !h) return false;
  const ratio = w / h;
  // Seedance reports nominal 16:9 = 1.7777... — allow ±2% for rounding.
  return Math.abs(ratio - 16 / 9) <= 0.04;
}
