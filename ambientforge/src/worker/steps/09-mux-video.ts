import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import { ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';
import { muxVideo, type NvencMode } from '@/lib/render/mux';
import { getSettings } from '@/lib/settings';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

export type Step09Opts = {
  projectsDir?: string;
  nvencModeOverride?: NvencMode;
};

export const step09MuxVideo: PipelineStep = async (album, log) => step09Internal(album, log);

export async function step09Internal(album: Album, log: LogFn, opts: Step09Opts = {}): Promise<void> {
  log('step 09', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const albumDir = path.join(projectsDir, album.channelId, album.id);
  const loopPath = path.join(albumDir, 'build', 'loop.wav');
  const finalPath = path.join(albumDir, 'final.mp4');

  const fresh = albumsRepo.get(album.id) ?? album;
  if (!fresh.ytImagePath) {
    throw new FfmpegError(
      'STEP_09_YT_IMAGE_MISSING',
      `album ${album.id} has no yt_image_path (run step 05a first)`,
    );
  }
  if (!fs.existsSync(fresh.ytImagePath)) {
    throw new FfmpegError(
      'STEP_09_YT_IMAGE_MISSING',
      `ytImage file missing on disk: ${fresh.ytImagePath}`,
    );
  }

  const nvencMode = opts.nvencModeOverride ?? (getSettings().nvenc_enabled as NvencMode);
  let lastLoggedPct = -10;
  await muxVideo(fresh.ytImagePath, loopPath, finalPath, {
    nvencMode,
    onProgress: (pct) => {
      albumsRepo.patch(album.id, { videoProgressPct: pct });
      // Throttle log spam — only emit every 10%.
      if (pct >= lastLoggedPct + 10 || pct === 100) {
        lastLoggedPct = pct;
        log('step 09', `progress ${pct}%`);
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
    'step 09',
    `done codec=${probe.codec} audio=${probe.audioCodec} duration=${(probe.duration ?? 0).toFixed(3)}s ` +
      `dims=${probe.width}x${probe.height} size=${(stat.size / 1024 / 1024).toFixed(2)}MB`,
  );
}
