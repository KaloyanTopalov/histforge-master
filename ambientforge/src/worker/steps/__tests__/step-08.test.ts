import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { concatTracks } from '@/lib/audio/concat';
import { step08Internal } from '@/worker/steps/08-loop-to-2h';
import { ffprobe } from '@/lib/audio/ffmpeg';

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../../../tests/fixtures/audio/concat-set',
);

let db: Db;
let workDir: string;

const baseChannel = {
  name: 'step08-test-ch',
  displayName: 'Step08',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step08 Artist',
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step08-work-'));
});

afterEach(() => {
  __setDbForTests(null);
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function setupAlbumWithConcat(): Promise<{ albumId: string; channelId: string }> {
  const ch = channelsRepo.create(baseChannel);
  const album = albumsRepo.create({ channelId: ch.id });
  const buildDir = path.join(workDir, 'projects', ch.id, album.id, 'build');
  fs.mkdirSync(buildDir, { recursive: true });
  const concatPath = path.join(buildDir, 'concat.wav');
  await concatTracks(
    ['01.wav', '02.wav', '03.wav', '04.wav', '05.wav'].map((f) =>
      path.join(FIXTURE_ROOT, f),
    ),
    concatPath,
  );
  return { albumId: album.id, channelId: ch.id };
}

describe('step08LoopTo2h', () => {
  it('loops concat.wav to target_video_seconds (set to 75 for test speed)', async () => {
    const { albumId, channelId } = await setupAlbumWithConcat();
    setSetting('target_video_seconds', '75');
    const album = albumsRepo.get(albumId)!;
    await step08Internal(album, noopLog, { projectsDir: path.join(workDir, 'projects') });
    const loopPath = path.join(workDir, 'projects', channelId, albumId, 'build', 'loop.wav');
    expect(fs.existsSync(loopPath)).toBe(true);
    const probe = await ffprobe(loopPath);
    expect(probe.duration!).toBeGreaterThan(74.5);
    expect(probe.duration!).toBeLessThan(75.5);
  }, 60_000);

  it('targetSecondsOverride wins over the setting', async () => {
    const { albumId, channelId } = await setupAlbumWithConcat();
    setSetting('target_video_seconds', '999'); // would be wrong if used
    const album = albumsRepo.get(albumId)!;
    await step08Internal(album, noopLog, {
      projectsDir: path.join(workDir, 'projects'),
      targetSecondsOverride: 60,
    });
    const probe = await ffprobe(
      path.join(workDir, 'projects', channelId, albumId, 'build', 'loop.wav'),
    );
    expect(probe.duration!).toBeGreaterThan(59.5);
    expect(probe.duration!).toBeLessThan(60.5);
  }, 60_000);
});
