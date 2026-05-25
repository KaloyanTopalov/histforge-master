import path from 'node:path';
import { loopToTarget } from '@/lib/audio/loop';
import { ffprobe } from '@/lib/audio/ffmpeg';
import { getSettings } from '@/lib/settings';
import * as channelsRepo from '@/lib/repos/channels';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

export type Step08Opts = {
  projectsDir?: string;
  targetSecondsOverride?: number;
};

export const step08LoopTo2h: PipelineStep = async (album, log) => step08Internal(album, log);

export async function step08Internal(album: Album, log: LogFn, opts: Step08Opts = {}): Promise<void> {
  log('step 08', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const buildDir = path.join(projectsDir, album.channelId, album.id, 'build');
  const concatPath = path.join(buildDir, 'concat.wav');
  const loopPath = path.join(buildDir, 'loop.wav');

  // Per-channel target_video_seconds overrides the global setting when set.
  const channel = channelsRepo.get(album.channelId);
  const target =
    opts.targetSecondsOverride ??
    channel?.targetVideoSeconds ??
    getSettings().target_video_seconds;
  await loopToTarget(concatPath, loopPath, target);

  const probe = await ffprobe(loopPath);
  log(
    'step 08',
    `done target=${target}s actual=${(probe.duration ?? 0).toFixed(3)}s out=${path.basename(loopPath)}`,
  );
}
