/**
 * ambient-video variant of step 05b. Generates the YouTube thumbnail via the
 * Magnific reference-image flow (NOT Flow — ambient-video has no Flow path).
 *
 * Pipeline:
 *   1. resolve channel + source.jpg (album folder > channel folder; required —
 *      step 05a already produced it, this step never regenerates it)
 *   2. load + render the thumbnail-spec template with album.sceneTitle
 *   3. downscale source.jpg to a bounded JPEG for the vision LLM call
 *   4. chatCompletionText (vision) → the Magnific title-overlay prompt
 *   5. freepik submitThumbnail (reference image = source.jpg, count 4)
 *   6. poll → download ALL candidates
 *   7. each candidate: crop-to-fill 3840×2160 (no bars) → vibrance/saturation
 *      grade → projects/<ch>/<alb>/thumbs/thumb-N.png
 *
 * Selection of one winner is deferred — this step does NOT set
 * album.thumbnailPath. Idempotent: a noop when 4 valid graded files exist.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { getSettings } from '@/lib/settings';
import { chatCompletionText } from '@/lib/llm/openrouter';
import {
  ffprobe,
  gradeImage,
  resizeWithMode,
  scaleToMaxEdgeJpeg,
} from '@/lib/audio/ffmpeg';
import {
  makeFreepikClient,
  FreepikError,
  type FreepikClient,
} from '@/lib/freepik/client';
import {
  loadThumbnailSpecTemplate,
  renderThumbnailSpec,
} from './thumbnail-spec-template';
import { sourceJpgPath } from '../workflows/checks';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

const THUMB_W = 3840;
const THUMB_H = 2160;
const THUMB_COUNT = 4;
const SOURCE_JPG_MIN_BYTES = 50 * 1024;
/** Longest edge for the vision-call reference image. ~1568px keeps tokens /
 * latency sane vs. a multi-MB 4K source. */
const VISION_MAX_EDGE = 1568;
const FREEPIK_POLL_INTERVAL_MS = 5_000;
// 15 min: same upper bound as step 05a/08 — Magnific gen + the result wait.
const FREEPIK_POLL_TIMEOUT_MS = 15 * 60_000;
const GRADE_VIBRANCE = 30;
const GRADE_SATURATION = 10;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Step-level error with a distinct `.code` (mirrors ThumbnailSpecTemplateError
 * / SeedanceError) so blind iteration + dashboard banners are unambiguous. */
export class AmbientVideoThumbnailError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AmbientVideoThumbnailError';
    this.code = code;
  }
}

export type Step05bAmbientVideoThumbnailOpts = {
  projectsDir?: string;
  /** Template root. Defaults to `<cwd>/prompts`. */
  promptsRoot?: string;
  /** Inject a freepik client for tests. Defaults to the bridge HTTP client. */
  freepikClient?: FreepikClient;
  /** OpenRouter key override (tests pass 'mock'). Defaults to settings/env. */
  llmApiKey?: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

export const step05bAmbientVideoThumbnail: PipelineStep = async (album, log) =>
  step05bAmbientVideoThumbnailInternal(album, log);

export async function step05bAmbientVideoThumbnailInternal(
  album: Album,
  log: LogFn,
  opts: Step05bAmbientVideoThumbnailOpts = {},
): Promise<void> {
  log('step 05b-amv', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const promptsRoot = opts.promptsRoot ?? path.join(process.cwd(), 'prompts');
  const pollIntervalMs = opts.pollIntervalMs ?? FREEPIK_POLL_INTERVAL_MS;
  const pollTimeoutMs = opts.pollTimeoutMs ?? FREEPIK_POLL_TIMEOUT_MS;

  const fresh = albumsRepo.get(album.id) ?? album;
  const channel = channelsRepo.get(fresh.channelId);
  if (!channel) {
    throw new AmbientVideoThumbnailError(
      'CHANNEL_NOT_FOUND',
      `channel ${fresh.channelId} not found for album ${album.id}`,
    );
  }

  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  const buildDir = path.join(albumDir, 'build');
  const thumbsDir = path.join(albumDir, 'thumbs');

  // ---- Idempotency: noop when all 4 graded thumbs exist at target dims. ----
  if (await thumbsLookReady(thumbsDir, THUMB_COUNT)) {
    log('step 05b-amv', `noop (${THUMB_COUNT} valid thumbs already at ${thumbsDir})`);
    return;
  }

  await fs.promises.mkdir(buildDir, { recursive: true });
  await fs.promises.mkdir(thumbsDir, { recursive: true });

  // ---- 1. Resolve source.jpg: album folder > channel folder (required). ----
  const albumSourcePath = path.join(albumDir, 'source.jpg');
  const channelSourcePath = sourceJpgPath(fresh.channelId);
  const sourcePath = await firstSourceAtLeast(
    [albumSourcePath, channelSourcePath],
    SOURCE_JPG_MIN_BYTES,
  );
  if (!sourcePath) {
    throw new AmbientVideoThumbnailError(
      'THUMBNAIL_SOURCE_JPG_MISSING',
      `no source.jpg (> ${SOURCE_JPG_MIN_BYTES} bytes) for album ${album.id}. ` +
        `Tried album ${albumSourcePath} and channel ${channelSourcePath}. ` +
        `Step 05a should have produced it.`,
    );
  }
  log('step 05b-amv', `source=${path.relative(process.cwd(), sourcePath)}`);

  // ---- 2. Scene title (set by step 01b; guard rather than vision-call null). ----
  const sceneTitle = (fresh.sceneTitle ?? '').trim();
  if (sceneTitle.length === 0) {
    throw new AmbientVideoThumbnailError(
      'THUMBNAIL_SCENE_TITLE_MISSING',
      `album ${album.id} has no sceneTitle — step 01b must run before 05b`,
    );
  }

  // ---- 3. Load + render the thumbnail-spec template. ----
  const tpl = loadThumbnailSpecTemplate(fresh.channelId, promptsRoot);
  const renderedSpec = renderThumbnailSpec(tpl.content, sceneTitle);
  log('step 05b-amv', `template=${tpl.source} (${tpl.origin})`);

  // ---- 4. Downscale source for the vision call, then ask the LLM. ----
  const visionJpg = path.join(buildDir, '_thumb-vision.jpg');
  await scaleToMaxEdgeJpeg(sourcePath, visionJpg, VISION_MAX_EDGE);
  const base64 = (await fs.promises.readFile(visionJpg)).toString('base64');
  const magnificPrompt = (
    await chatCompletionText({
      rendered: renderedSpec,
      image: { base64, mimeType: 'image/jpeg' },
      apiKey: opts.llmApiKey,
    })
  ).trim();
  if (magnificPrompt.length === 0) {
    throw new AmbientVideoThumbnailError(
      'THUMBNAIL_LLM_EMPTY',
      'vision LLM returned an empty Magnific prompt',
    );
  }
  log('step 05b-amv', `llm prompt chars=${magnificPrompt.length}`);

  // ---- 5. Submit to Magnific (reference image = source.jpg, no saved style). ----
  const settings = getSettings();
  const client: FreepikClient = opts.freepikClient ?? makeFreepikClient();
  const taskId = await client.submitThumbnail({
    prompt: magnificPrompt,
    model: settings.freepik_model_name,
    aspectRatio: '16:9',
    referenceImagePath: sourcePath,
    count: THUMB_COUNT,
  });
  log('step 05b-amv', `submitted taskId=${taskId} count=${THUMB_COUNT}`);

  // ---- 6. Poll until ready (or fail/timeout). ----
  const startedAt = Date.now();
  let readyCount = 0;
  let done = false;
  while (Date.now() - startedAt < pollTimeoutMs) {
    let status: 'pending' | 'ready' | 'failed';
    let count = 0;
    try {
      const r = await client.pollThumbnail(taskId);
      status = r.status;
      count = r.count;
    } catch (err) {
      if (err instanceof FreepikError && !err.retriable) {
        throw new AmbientVideoThumbnailError(
          'THUMBNAIL_GEN_FAILED',
          `freepik bridge failed: ${err.code} ${err.message}`,
        );
      }
      await sleep(pollIntervalMs);
      continue;
    }
    if (status === 'ready') {
      readyCount = count;
      done = true;
      break;
    }
    if (status === 'failed') {
      throw new AmbientVideoThumbnailError(
        'THUMBNAIL_GEN_FAILED',
        `freepik thumbnail task ${taskId} failed`,
      );
    }
    await sleep(pollIntervalMs);
  }
  if (!done) {
    throw new AmbientVideoThumbnailError(
      'THUMBNAIL_GEN_TIMEOUT',
      `freepik thumbnail task ${taskId} not ready after ${Date.now() - startedAt}ms`,
    );
  }
  if (readyCount < 1) {
    throw new AmbientVideoThumbnailError(
      'THUMBNAIL_RESULTS_INCOMPLETE',
      `freepik reported ready but 0 candidates for task ${taskId}`,
    );
  }

  // ---- 7. Download each candidate → crop-to-fill 4K → grade. ----
  for (let i = 0; i < readyCount; i++) {
    const n = i + 1;
    const raw = path.join(buildDir, `_thumb-raw-${n}`);
    const resized = path.join(buildDir, `_thumb-resized-${n}.png`);
    const out = path.join(thumbsDir, `thumb-${n}.png`);
    await client.downloadThumbnail(taskId, i, raw);
    await resizeWithMode(raw, resized, THUMB_W, THUMB_H, 'crop');
    await gradeImage(resized, out, {
      vibrance: GRADE_VIBRANCE,
      saturation: GRADE_SATURATION,
    });
    const probe = await ffprobe(out);
    if (probe.width !== THUMB_W || probe.height !== THUMB_H) {
      throw new AmbientVideoThumbnailError(
        'THUMBNAIL_POSTPROCESS_FAILED',
        `thumb-${n}.png dims ${probe.width}x${probe.height} != ${THUMB_W}x${THUMB_H}`,
      );
    }
    await fs.promises.unlink(raw).catch(() => {});
    await fs.promises.unlink(resized).catch(() => {});
  }
  await fs.promises.unlink(visionJpg).catch(() => {});

  log(
    'step 05b-amv',
    `done ${readyCount} thumbs @ ${THUMB_W}x${THUMB_H} vibrance=+${GRADE_VIBRANCE} sat=+${GRADE_SATURATION}`,
  );
}

async function thumbsLookReady(thumbsDir: string, count: number): Promise<boolean> {
  for (let n = 1; n <= count; n++) {
    const p = path.join(thumbsDir, `thumb-${n}.png`);
    if (!fs.existsSync(p)) return false;
    try {
      const probe = await ffprobe(p);
      if (probe.width !== THUMB_W || probe.height !== THUMB_H) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function firstSourceAtLeast(
  candidates: string[],
  minBytes: number,
): Promise<string | null> {
  for (const c of candidates) {
    try {
      const st = await fs.promises.stat(c);
      if (st.size > minBytes) return c;
    } catch {
      /* missing — try next */
    }
  }
  return null;
}
