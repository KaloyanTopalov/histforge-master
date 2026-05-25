/**
 * ambient-video branch B, step 09: final mux of the looped Seedance clip +
 * looped audio → 1920×1080 H.264/AAC MP4 of `target_video_seconds` exactly.
 *
 * Compared to ambient's static-image mux (step 09): the visual bed is a 10s
 * clip looped via `-stream_loop -1`, not a single frame held via `-loop 1`.
 * Compared to rap's branch B: the audio is looped (concat → loopToTarget)
 * instead of stream-copy concat of per-track variable-length songs.
 */

import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';
import { loopToTarget } from '@/lib/audio/loop';
import { muxVideoBedAndAudio, type NvencMode } from '@/lib/render/mux';
import { getSettings } from '@/lib/settings';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

export type Step09AmbientVideoOpts = {
  projectsDir?: string;
  nvencModeOverride?: NvencMode;
  targetSecondsOverride?: number;
};

export const step09AmbientVideoMux: PipelineStep = async (album, log) =>
  step09AmbientVideoInternal(album, log);

export async function step09AmbientVideoInternal(
  album: Album,
  log: LogFn,
  opts: Step09AmbientVideoOpts = {},
): Promise<void> {
  log('step 09-amv', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const albumDir = path.join(projectsDir, album.channelId, album.id);
  const buildDir = path.join(albumDir, 'build');
  const concatPath = path.join(buildDir, 'concat.wav');
  const clipPath = path.join(buildDir, 'clip.mp4');
  const loopPath = path.join(buildDir, 'loop.wav');
  const finalPath = path.join(albumDir, 'final.mp4');

  if (!fs.existsSync(concatPath)) {
    throw new FfmpegError(
      'STEP_09_AMV_CONCAT_MISSING',
      `concat.wav not found at ${concatPath} (run step 07 first)`,
    );
  }
  if (!fs.existsSync(clipPath)) {
    throw new FfmpegError(
      'STEP_09_AMV_CLIP_MISSING',
      `clip.mp4 not found at ${clipPath} (run step 08 first)`,
    );
  }

  // Resolve target seconds: per-channel override → global setting → opt override.
  const channel = channelsRepo.get(album.channelId);
  const settings = getSettings();
  const targetSeconds =
    opts.targetSecondsOverride ?? channel?.targetVideoSeconds ?? settings.target_video_seconds;
  if (targetSeconds <= 0) {
    throw new FfmpegError(
      'STEP_09_AMV_INVALID_TARGET',
      `target_video_seconds must be > 0; got ${targetSeconds}`,
    );
  }

  // ---- 1. Extend audio to the target via stream-copy loop + trim. ----
  // loopToTarget is idempotent on its own (mtime-aware).
  await loopToTarget(concatPath, loopPath, targetSeconds);
  const loopProbe = await ffprobe(loopPath);
  log(
    'step 09-amv',
    `loop.wav duration=${(loopProbe.duration ?? 0).toFixed(2)}s target=${targetSeconds}s`,
  );

  // ---- 2. Final mux. Idempotency is handled inside muxVideoBedAndAudio. ----
  const nvencMode = opts.nvencModeOverride ?? (settings.nvenc_enabled as NvencMode);
  let lastLoggedPct = -10;
  await muxVideoBedAndAudio(clipPath, loopPath, finalPath, targetSeconds, {
    nvencMode,
    onProgress: (pct) => {
      albumsRepo.patch(album.id, { videoProgressPct: pct });
      if (pct >= lastLoggedPct + 10 || pct === 100) {
        lastLoggedPct = pct;
        log('step 09-amv', `progress ${pct}%`);
      }
    },
  });

  const probe = await ffprobe(finalPath);
  const stat = await fs.promises.stat(finalPath);
  albumsRepo.patch(album.id, {
    videoStatus: 'rendered',
    finalVideoPath: finalPath,
    videoProgressPct: 100,
  });
  log(
    'step 09-amv',
    `done codec=${probe.codec} audio=${probe.audioCodec} duration=${(probe.duration ?? 0).toFixed(3)}s ` +
      `dims=${probe.width}x${probe.height} size=${(stat.size / 1024 / 1024).toFixed(2)}MB`,
  );
}
