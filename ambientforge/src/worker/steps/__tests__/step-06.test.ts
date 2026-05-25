import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import { setSetting, getRawSetting } from '@/lib/settings';
import {
  __resetMockDistrokidState,
  makeMockDistrokidClient,
  DistrokidError,
  type DistrokidClient,
} from '@/lib/distrokid/client';
import { step06Internal } from '@/worker/steps/06-distrokid-submit';

let db: Db;
let tmpDir: string;

const baseChannel = {
  name: 'step06-test-ch',
  displayName: 'Step06 Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step06 Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: 'Step06 Label',
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function makeFakeAudio(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // Tiny non-empty placeholder — step 06 only checks fs.existsSync.
  fs.writeFileSync(filePath, Buffer.from('RIFF\0\0\0\0WAVEfmt '));
}

function makeFakePng(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  // 1x1 PNG (8-byte sig + IHDR + IDAT + IEND, minimal valid)
  const png = Buffer.from(
    '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63000100000005000100' +
      '0d0a2db40000000049454e44ae426082',
    'hex',
  );
  fs.writeFileSync(filePath, png);
}

type SetupOpts = {
  channelName?: string;
  artistName?: string;
  withCover?: boolean;
  trackCount?: number;
};

function setupAlbum(opts: SetupOpts = {}): {
  albumId: string;
  channelId: string;
  projectsDir: string;
  coverPath: string;
} {
  const channel = channelsRepo.create({
    ...baseChannel,
    name: opts.channelName ?? baseChannel.name,
    distrokidArtistName: opts.artistName ?? baseChannel.distrokidArtistName,
    active: true,
  });
  const album = albumsRepo.create({ channelId: channel.id });
  albumsRepo.patch(album.id, {
    albumTitle: 'Test Album',
    artistName: opts.artistName ?? baseChannel.distrokidArtistName,
    sunoStylePrompt: 'ambient drift',
    primaryGenre: 'Ambient',
  });
  const projectsDir = path.join(tmpDir, 'projects');
  const albumDir = path.join(projectsDir, channel.id, album.id);
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, 'cover.png');
  if (opts.withCover !== false) {
    makeFakePng(coverPath);
    albumsRepo.patch(album.id, { coverImagePath: coverPath });
  }
  const trackCount = opts.trackCount ?? 30;
  const trackInputs = Array.from({ length: trackCount }, (_, i) => ({
    albumId: album.id,
    trackNumber: i + 1,
    title: `Track ${i + 1}`,
    fileName: `${String(i + 1).padStart(2, '0')} - Track ${i + 1}.wav`,
    sunoLyrics: `lyrics ${i + 1}`,
  }));
  tracksRepo.insertMany(trackInputs);
  // Populate audioPath for each track on disk.
  const tracks = tracksRepo.listByAlbum(album.id);
  for (const t of tracks) {
    const audioPath = path.join(albumDir, 'songs', t.fileName);
    makeFakeAudio(audioPath);
    tracksRepo.patch(t.id, { audioPath });
  }
  return { albumId: album.id, channelId: channel.id, projectsDir, coverPath };
}

const noopLog = (_stage: string, _msg: string) => {};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetMockDistrokidState();
  setSetting('distrokid_dry_run', 'true', db);
  setSetting('content_id_hold_days', '14', db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambientforge-step06-'));
});

afterEach(() => {
  __setDbForTests(null);
  __resetMockDistrokidState();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('step06DistrokidSubmit', () => {
  it('hard live-mode gate: throws DISTROKID_LIVE_MODE_DISABLED, no client calls, sets blocked-at flag', async () => {
    const { albumId, projectsDir } = setupAlbum();
    setSetting('distrokid_dry_run', 'false', db);
    const client: DistrokidClient = {
      verifyArtist: vi.fn(),
      startRelease: vi.fn(),
      setMetadata: vi.fn(),
      uploadCover: vi.fn(),
      uploadTrack: vi.fn(),
      verifyTrackCount: vi.fn(),
      submitOrScreenshot: vi.fn(),
      focusWindow: vi.fn(),
    };

    await expect(
      step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir }),
    ).rejects.toMatchObject({ code: 'DISTROKID_LIVE_MODE_DISABLED' });

    expect(client.verifyArtist).not.toHaveBeenCalled();
    expect(client.startRelease).not.toHaveBeenCalled();
    const flag = getRawSetting('distrokid_live_mode_blocked_at', db) ?? '';
    expect(flag.length).toBeGreaterThan(0);
  });

  it('happy path: writes screenshot + payload, sets dryrun status + Content ID hold timestamps', async () => {
    const { albumId, channelId, projectsDir } = setupAlbum();
    const client = makeMockDistrokidClient();
    // Generate the fixture screenshot in a tmp location so the mock can copy it.
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'distrokid', 'dryrun-fixture.png');
    if (!fs.existsSync(fixturePath)) {
      // Generate a placeholder if fixtures:setup hasn't been run yet — keeps the test self-contained.
      makeFakePng(fixturePath);
    }

    const fixedNow = 1_700_000_000_000;
    await step06Internal(albumsRepo.get(albumId)!, noopLog, client, {
      projectsDir,
      now: () => fixedNow,
    });

    const after = albumsRepo.get(albumId)!;
    expect(after.distrokidStatus).toBe('dryrun');
    expect(after.distrokidSubmittedAt).toBe(fixedNow);
    expect(after.safeToUploadAfter).toBe(fixedNow + 14 * 86_400_000);
    expect(after.distrokidDryRunArtifact).toContain('distrokid-dryrun.png');

    const screenshotPath = path.join(projectsDir, channelId, albumId, 'distrokid-dryrun.png');
    expect(fs.existsSync(screenshotPath)).toBe(true);
    expect(fs.statSync(screenshotPath).size).toBeGreaterThan(0);

    const payloadPath = path.join(projectsDir, channelId, albumId, 'distrokid-payload.json');
    expect(fs.existsSync(payloadPath)).toBe(true);
    const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));
    expect(payload.metadata.albumTitle).toBe('Test Album');
    expect(payload.metadata.artistName).toBe('Step06 Artist');
    expect(payload.metadata.genre).toBe('Ambient');
    expect(payload.metadata.language).toBe('English');
    expect(payload.metadata.explicit).toBe(false);
    expect(payload.metadata.label).toBe('Step06 Label');
    expect(payload.tracks).toHaveLength(30);
    for (let i = 0; i < 30; i++) {
      expect(payload.tracks[i].trackNumber).toBe(i + 1);
      expect(payload.tracks[i].title).toBe(`Track ${i + 1}`);
    }
  });

  it('idempotency: noop when dry-run artifact already exists', async () => {
    const { albumId, projectsDir } = setupAlbum();
    const client = makeMockDistrokidClient();
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'distrokid', 'dryrun-fixture.png');
    if (!fs.existsSync(fixturePath)) makeFakePng(fixturePath);

    await step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir });

    // Wrap client to track calls on second run.
    const trackedClient: DistrokidClient = {
      verifyArtist: vi.fn(client.verifyArtist),
      startRelease: vi.fn(client.startRelease),
      setMetadata: vi.fn(client.setMetadata),
      uploadCover: vi.fn(client.uploadCover),
      uploadTrack: vi.fn(client.uploadTrack),
      verifyTrackCount: vi.fn(client.verifyTrackCount),
      submitOrScreenshot: vi.fn(client.submitOrScreenshot),
      focusWindow: vi.fn(client.focusWindow),
    };

    await step06Internal(albumsRepo.get(albumId)!, noopLog, trackedClient, { projectsDir });

    expect(trackedClient.verifyArtist).not.toHaveBeenCalled();
    expect(trackedClient.startRelease).not.toHaveBeenCalled();
    expect(trackedClient.uploadTrack).not.toHaveBeenCalled();
  });

  it('artist not found: throws DISTROKID_ARTIST_NOT_FOUND, sets distrokid_artist_missing flag', async () => {
    const { albumId, channelId, projectsDir } = setupAlbum({
      artistName: 'Nonexistent Test Artist',
    });
    const client = makeMockDistrokidClient();

    await expect(
      step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir }),
    ).rejects.toMatchObject({ code: 'DISTROKID_ARTIST_NOT_FOUND' });

    const flag = JSON.parse(getRawSetting('distrokid_artist_missing', db) || '{}');
    expect(flag.albumId).toBe(albumId);
    expect(flag.channelId).toBe(channelId);
    expect(flag.artistName).toBe('Nonexistent Test Artist');
  });

  it('captcha: returns cleanly, sets album.status=awaiting_captcha + distrokid_captcha_pending flag', async () => {
    const { albumId, channelId, projectsDir } = setupAlbum({ channelName: 'captcha-test-ch' });
    const client = makeMockDistrokidClient();

    await step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir });

    const after = albumsRepo.get(albumId)!;
    expect(after.status).toBe('awaiting_captcha');
    expect(after.distrokidStatus).toBe('pending'); // unchanged
    const flag = JSON.parse(getRawSetting('distrokid_captcha_pending', db) || '{}');
    expect(flag.albumId).toBe(albumId);
    expect(flag.channelId).toBe(channelId);
  });

  it('track count mismatch: throws DISTROKID_TRACK_UPLOAD_MISMATCH', async () => {
    const { albumId, projectsDir } = setupAlbum();
    const inner = makeMockDistrokidClient();
    const client: DistrokidClient = {
      ...inner,
      verifyTrackCount: async () => ({ count: 14, matches: false }),
    };

    await expect(
      step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir }),
    ).rejects.toMatchObject({ code: 'DISTROKID_TRACK_UPLOAD_MISMATCH' });
  });

  it('cover missing: throws DISTROKID_COVER_MISSING', async () => {
    const { albumId, projectsDir } = setupAlbum({ withCover: false });
    const client = makeMockDistrokidClient();

    await expect(
      step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir }),
    ).rejects.toMatchObject({ code: 'DISTROKID_COVER_MISSING' });
  });

  it('rethrows verify_artist DistrokidError when client throws ARTIST_NOT_FOUND', async () => {
    const { albumId, projectsDir } = setupAlbum({ artistName: 'Definitely Not A Real Artist' });
    const client = makeMockDistrokidClient();

    await expect(
      step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir }),
    ).rejects.toBeInstanceOf(DistrokidError);
    const flag = JSON.parse(getRawSetting('distrokid_artist_missing', db) || '{}');
    expect(flag.artistName).toBe('Definitely Not A Real Artist');
  });

  it('cover.jpg preference: picks fresh jpg sibling when its mtime >= cover.png mtime', async () => {
    const { albumId, channelId, projectsDir, coverPath } = setupAlbum({
      channelName: 'jpg-fresh-ch',
    });
    const albumDir = path.join(projectsDir, channelId, albumId);
    const coverJpgPath = path.join(albumDir, 'cover.jpg');
    // Write the JPG AFTER the PNG so its mtime is naturally newer.
    fs.writeFileSync(coverJpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    expect(fs.statSync(coverJpgPath).mtimeMs).toBeGreaterThanOrEqual(
      fs.statSync(coverPath).mtimeMs,
    );

    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'distrokid', 'dryrun-fixture.png');
    if (!fs.existsSync(fixturePath)) makeFakePng(fixturePath);

    const inner = makeMockDistrokidClient();
    const uploadCover = vi.fn(inner.uploadCover);
    const client: DistrokidClient = { ...inner, uploadCover };

    await step06Internal(albumsRepo.get(albumId)!, noopLog, client, { projectsDir });

    expect(uploadCover).toHaveBeenCalledTimes(1);
    expect(uploadCover.mock.calls[0][1]).toBe(coverJpgPath);
  });

  it('cover.jpg preference: ignores stale jpg (older mtime) and uses cover.png', async () => {
    const { albumId, channelId, projectsDir, coverPath } = setupAlbum({
      channelName: 'jpg-stale-ch',
    });
    const albumDir = path.join(projectsDir, channelId, albumId);
    const coverJpgPath = path.join(albumDir, 'cover.jpg');
    fs.writeFileSync(coverJpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    // Force the jpg mtime backward so it's older than the png.
    const pngMtimeMs = fs.statSync(coverPath).mtimeMs;
    const staleSec = (pngMtimeMs - 60_000) / 1000;
    fs.utimesSync(coverJpgPath, staleSec, staleSec);
    expect(fs.statSync(coverJpgPath).mtimeMs).toBeLessThan(pngMtimeMs);

    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'distrokid', 'dryrun-fixture.png');
    if (!fs.existsSync(fixturePath)) makeFakePng(fixturePath);

    const inner = makeMockDistrokidClient();
    const uploadCover = vi.fn(inner.uploadCover);
    const logs: Array<[string, string]> = [];
    const captureLog = (stage: string, msg: string) => {
      logs.push([stage, msg]);
    };
    const client: DistrokidClient = { ...inner, uploadCover };

    await step06Internal(albumsRepo.get(albumId)!, captureLog, client, { projectsDir });

    expect(uploadCover).toHaveBeenCalledTimes(1);
    expect(uploadCover.mock.calls[0][1]).toBe(coverPath);
    expect(
      logs.some(
        ([stage, msg]) => stage === 'step 06' && msg.includes('stale cover.jpg ignored'),
      ),
    ).toBe(true);
  });
});
