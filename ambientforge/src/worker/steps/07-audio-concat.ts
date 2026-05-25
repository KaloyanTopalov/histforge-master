import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import { concatTracks } from '@/lib/audio/concat';
import { ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';
import { getRawSetting } from '@/lib/settings';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

export type Step07Opts = {
  projectsDir?: string;
};

export const step07AudioConcat: PipelineStep = async (album, log) => step07Internal(album, log);

export async function step07Internal(album: Album, log: LogFn, opts: Step07Opts = {}): Promise<void> {
  log('step 07', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const albumDir = path.join(projectsDir, album.channelId, album.id);
  const buildDir = path.join(albumDir, 'build');
  const concatPath = path.join(buildDir, 'concat.wav');

  // Mark Branch B as in-flight at the very first opportunity. Branch B owns
  // video_status writes; Branch A is unaffected.
  albumsRepo.patch(album.id, { videoStatus: 'rendering', videoProgressPct: 0 });

  // Test-only synthetic failure for runtime Check C (branch B fails, branch A
  // completes). The settings flag is cleared by runtime cleanup.
  const forceFailFor = getRawSetting('force_branch_b_failure_for_album');
  if (forceFailFor && forceFailFor === album.id) {
    log('step 07', `force-fail flag matches album ${album.id} — throwing FORCE_BRANCH_B_FAILURE`);
    throw new FfmpegError(
      'FORCE_BRANCH_B_FAILURE',
      `test-only synthetic branch-B failure for album ${album.id}`,
    );
  }

  const tracks = tracksRepo.listByAlbum(album.id);
  if (tracks.length === 0) {
    throw new FfmpegError('STEP_07_NO_TRACKS', `album ${album.id} has zero tracks`);
  }
  const wavPaths: string[] = [];
  for (const t of tracks) {
    if (!t.audioPath) {
      throw new FfmpegError(
        'STEP_07_TRACK_AUDIO_MISSING',
        `track ${t.id} (#${t.trackNumber}) has no audio_path`,
      );
    }
    if (!fs.existsSync(t.audioPath)) {
      throw new FfmpegError(
        'STEP_07_TRACK_AUDIO_MISSING',
        `track ${t.id} (#${t.trackNumber}) audio file missing on disk: ${t.audioPath}`,
      );
    }
    wavPaths.push(t.audioPath);
  }

  await fs.promises.mkdir(buildDir, { recursive: true });
  await concatTracks(wavPaths, concatPath);

  const probe = await ffprobe(concatPath);
  log(
    'step 07',
    `done tracks=${tracks.length} duration=${(probe.duration ?? 0).toFixed(2)}s out=${path.basename(concatPath)}`,
  );
}
