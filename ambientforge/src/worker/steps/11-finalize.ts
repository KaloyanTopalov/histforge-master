import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import type { Album } from '@/lib/repos/albums';
import type { PipelineStep } from '../pipeline';

export type Step11Opts = {
  projectsDir?: string;
};

export const step11Finalize: PipelineStep = async (album, log) =>
  step11Internal(album, log, {});

export async function step11Internal(
  album: Album,
  log: (stage: string, msg: string) => void,
  opts: Step11Opts = {},
): Promise<void> {
  log('step 11', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');

  const fresh = albumsRepo.get(album.id) ?? album;
  const status = computeFinalStatus(fresh);
  const albumDir = path.join(projectsDir, fresh.channelId, fresh.id);
  const sizeBytes = computeAlbumDiskSize(albumDir);
  const sizeMb = sizeBytes / (1024 * 1024);

  if (status === 'failed' && !fresh.lastError) {
    const reason = summarizeFailureReason(fresh);
    albumsRepo.patch(fresh.id, { status, lastError: reason });
  } else {
    albumsRepo.patch(fresh.id, { status });
  }

  log(
    'step 11',
    `album ${fresh.id} finalized status=${status} size=${sizeMb.toFixed(2)}MB`,
  );
}

function summarizeFailureReason(album: Pick<Album, 'distrokidStatus' | 'videoStatus'>): string {
  const parts: string[] = [];
  if (album.distrokidStatus === 'failed') parts.push('branchA(distrokid)=failed');
  else if (album.distrokidStatus === 'pending') parts.push('branchA(distrokid)=pending');
  if (album.videoStatus === 'failed') parts.push('branchB(video)=failed');
  else if (album.videoStatus === 'pending') parts.push('branchB(video)=pending');
  return parts.length > 0
    ? `step11_terminal_fail: ${parts.join(', ')}`
    : 'step11_terminal_fail: unknown';
}

export function computeFinalStatus(
  album: Pick<Album, 'distrokidStatus' | 'videoStatus'>,
): 'done' | 'failed' {
  const distrokidOk = album.distrokidStatus === 'submitted' || album.distrokidStatus === 'dryrun';
  const videoOk = album.videoStatus === 'rendered';
  return distrokidOk && videoOk ? 'done' : 'failed';
}

/**
 * Sum size on disk of every artifact this album owns. Missing files contribute
 * zero (we do NOT throw — step 11 must always run, even on failure paths where
 * not all artifacts exist).
 */
export function computeAlbumDiskSize(albumDir: string): number {
  const files = [
    'cover.png',
    'thumb.png',
    'ytImage.png',
    'final.mp4',
    path.join('build', 'concat.wav'),
    path.join('build', 'loop.wav'),
  ];
  let total = 0;
  for (const rel of files) {
    total += safeSize(path.join(albumDir, rel));
  }
  const songsDir = path.join(albumDir, 'songs');
  try {
    const entries = fs.readdirSync(songsDir);
    for (const f of entries) {
      if (f.toLowerCase().endsWith('.wav')) {
        total += safeSize(path.join(songsDir, f));
      }
    }
  } catch {
    // songs/ may not exist on some failure paths — ignore.
  }
  return total;
}

function safeSize(p: string): number {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? st.size : 0;
  } catch {
    return 0;
  }
}
