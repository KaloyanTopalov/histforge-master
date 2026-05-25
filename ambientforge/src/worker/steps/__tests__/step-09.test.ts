import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { concatTracks } from '@/lib/audio/concat';
import { loopToTarget } from '@/lib/audio/loop';
import { step09Internal } from '@/worker/steps/09-mux-video';
import { ffprobe } from '@/lib/audio/ffmpeg';

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../../../tests/fixtures/audio/concat-set',
);

let db: Db;
let workDir: string;

const baseChannel = {
  name: 'step09-test-ch',
  displayName: 'Step09',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step09 Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

const noopLog = (_stage: string, _msg: string) => {};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step09-work-'));
  setSetting('nvenc_enabled', 'off'); // deterministic libx264 in CI
});

afterEach(() => {
  __setDbForTests(null);
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function setupAlbumWithLoopAndImage(targetSeconds = 30): Promise<{
  albumId: string;
  channelId: string;
  finalPath: string;
}> {
  const ch = channelsRepo.create(baseChannel);
  const album = albumsRepo.create({ channelId: ch.id });
  const albumDir = path.join(workDir, 'projects', ch.id, album.id);
  const buildDir = path.join(albumDir, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const concatPath = path.join(buildDir, 'concat.wav');
  await concatTracks(
    ['01.wav', '02.wav', '03.wav', '04.wav', '05.wav'].map((f) =>
      path.join(FIXTURE_ROOT, f),
    ),
    concatPath,
  );
  const loopPath = path.join(buildDir, 'loop.wav');
  await loopToTarget(concatPath, loopPath, targetSeconds);

  const ytImagePath = path.join(albumDir, 'ytImage.png');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=color=teal:size=1920x1080:duration=1:rate=1',
    '-frames:v',
    '1',
    ytImagePath,
  ]);
  albumsRepo.patch(album.id, { ytImagePath });

  return {
    albumId: album.id,
    channelId: ch.id,
    finalPath: path.join(albumDir, 'final.mp4'),
  };
}

describe('step09MuxVideo', () => {
  it('produces final.mp4 (h264/aac/1920x1080) and patches video_status=rendered', async () => {
    const { albumId, finalPath } = await setupAlbumWithLoopAndImage(30);
    const album = albumsRepo.get(albumId)!;
    await step09Internal(album, noopLog, { projectsDir: path.join(workDir, 'projects') });

    expect(fs.existsSync(finalPath)).toBe(true);
    const probe = await ffprobe(finalPath);
    expect(probe.codec).toBe('h264');
    expect(probe.audioCodec).toBe('aac');
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
    // libx264+`-shortest` adds a small tail (last-GOP / PTS alignment); allow ±3s.
    expect(probe.duration!).toBeGreaterThan(29.5);
    expect(probe.duration!).toBeLessThan(33);

    const after = albumsRepo.get(albumId)!;
    expect(after.videoStatus).toBe('rendered');
    expect(after.finalVideoPath).toBe(finalPath);
    expect(after.videoProgressPct).toBe(100);
  }, 180_000);

  it('throws STEP_09_YT_IMAGE_MISSING when album has no ytImagePath', async () => {
    const ch = channelsRepo.create({ ...baseChannel, name: 'step09-noimg-ch' });
    const album = albumsRepo.create({ channelId: ch.id });
    await expect(
      step09Internal(album, noopLog, { projectsDir: path.join(workDir, 'projects') }),
    ).rejects.toMatchObject({ code: 'STEP_09_YT_IMAGE_MISSING' });
  });
});
