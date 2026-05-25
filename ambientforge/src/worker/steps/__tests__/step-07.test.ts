import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import { setSetting } from '@/lib/settings';
import { step07Internal } from '@/worker/steps/07-audio-concat';
import { ffprobe } from '@/lib/audio/ffmpeg';

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../../../tests/fixtures/audio/concat-set',
);

let db: Db;
let workDir: string;

const baseChannel = {
  name: 'step07-test-ch',
  displayName: 'Step07',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step07 Artist',
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
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step07-work-'));
});

afterEach(() => {
  __setDbForTests(null);
  fs.rmSync(workDir, { recursive: true, force: true });
});

function setupAlbumWithTracks(): { albumId: string; channelId: string } {
  const ch = channelsRepo.create(baseChannel);
  const album = albumsRepo.create({ channelId: ch.id });
  // Insert 5 tracks pointing at the fixture wavs.
  const inputs = ['01.wav', '02.wav', '03.wav', '04.wav', '05.wav'];
  tracksRepo.insertMany(
    inputs.map((f, i) => ({
      albumId: album.id,
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      fileName: f,
    })),
  );
  for (const t of tracksRepo.listByAlbum(album.id)) {
    tracksRepo.patch(t.id, {
      audioPath: path.join(FIXTURE_ROOT, t.fileName),
      status: 'done',
    });
  }
  return { albumId: album.id, channelId: ch.id };
}

describe('step07AudioConcat', () => {
  it('happy path: concat.wav written to build/, video_status=rendering set', async () => {
    const { albumId, channelId } = setupAlbumWithTracks();
    const album = albumsRepo.get(albumId)!;
    await step07Internal(album, noopLog, { projectsDir: path.join(workDir, 'projects') });
    const concatPath = path.join(workDir, 'projects', channelId, albumId, 'build', 'concat.wav');
    expect(fs.existsSync(concatPath)).toBe(true);
    const probe = await ffprobe(concatPath);
    expect(probe.duration!).toBeGreaterThan(29.5);
    expect(probe.duration!).toBeLessThan(30.5);
    const after = albumsRepo.get(albumId)!;
    expect(after.videoStatus).toBe('rendering');
    expect(after.videoProgressPct).toBe(0);
  }, 30_000);

  it('force_branch_b_failure_for_album setting throws FORCE_BRANCH_B_FAILURE', async () => {
    const { albumId } = setupAlbumWithTracks();
    setSetting('force_branch_b_failure_for_album', albumId);
    const album = albumsRepo.get(albumId)!;
    await expect(
      step07Internal(album, noopLog, { projectsDir: path.join(workDir, 'projects') }),
    ).rejects.toMatchObject({ code: 'FORCE_BRANCH_B_FAILURE' });
    // video_status was still flipped to 'rendering' BEFORE the synthetic throw —
    // matches real behavior; the orchestrator's catch wrapper then patches to 'failed'.
    expect(albumsRepo.get(albumId)!.videoStatus).toBe('rendering');
  });

  it('throws STEP_07_NO_TRACKS when album has no tracks', async () => {
    const ch = channelsRepo.create({ ...baseChannel, name: 'step07-empty-ch' });
    const album = albumsRepo.create({ channelId: ch.id });
    await expect(
      step07Internal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(workDir, 'projects'),
      }),
    ).rejects.toMatchObject({ code: 'STEP_07_NO_TRACKS' });
  });

  it('throws STEP_07_TRACK_AUDIO_MISSING when a track has no audio_path', async () => {
    const ch = channelsRepo.create({ ...baseChannel, name: 'step07-noaudio-ch' });
    const album = albumsRepo.create({ channelId: ch.id });
    tracksRepo.insertMany([
      { albumId: album.id, trackNumber: 1, title: 'T1', fileName: 'x.wav' },
    ]);
    await expect(
      step07Internal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(workDir, 'projects'),
      }),
    ).rejects.toMatchObject({ code: 'STEP_07_TRACK_AUDIO_MISSING' });
  });
});
