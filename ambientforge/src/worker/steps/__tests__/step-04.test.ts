import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import {
  __resetMockSunoState,
  makeMockSunoClient,
  SunoError,
  type SunoClient,
} from '@/lib/suno/client';
import { step04Internal } from '@/worker/steps/04-suno-download';
import { getRawSetting } from '@/lib/settings';

let db: Db;
let workDir: string;

const FIXTURE_DIR = path.join(process.cwd(), 'tests', 'fixtures', 'suno');
const GOOD_FIXTURE = path.join(FIXTURE_DIR, 'fixture-01.wav');
const BAD_FIXTURE = path.join(FIXTURE_DIR, 'bad-fixture.wav');

const baseChannel = {
  name: 'step04-test-ch',
  displayName: 'Step04 Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step04 Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function seed30TracksWithTaskIds(albumId: string) {
  const inputs = Array.from({ length: 30 }, (_, i) => ({
    albumId,
    trackNumber: i + 1,
    title: `Track ${i + 1}`,
    fileName: `${String(i + 1).padStart(2, '0')} - Track ${i + 1}.wav`,
    sunoLyrics: `lyrics ${i + 1}`,
  }));
  const tracks = tracksRepo.insertMany(inputs);
  // Pre-populate sunoTaskIds so step 04 has something to download.
  for (let i = 0; i < tracks.length; i++) {
    tracksRepo.patch(tracks[i].id, {
      sunoTaskId: `mock-task-${String(i + 1).padStart(4, '0')}`,
      status: 'submitted',
    });
  }
  return tracksRepo.listByAlbum(albumId);
}

function setupAlbum(): { albumId: string; channelId: string } {
  const channel = channelsRepo.create({ ...baseChannel, active: true });
  const album = albumsRepo.create({ channelId: channel.id });
  albumsRepo.patch(album.id, {
    albumTitle: 'Test Album',
    artistName: 'Step04 Artist',
    sunoStylePrompt: 'ambient drift',
    primaryGenre: 'Ambient',
  });
  return { albumId: album.id, channelId: channel.id };
}

const noopLog = (_stage: string, _msg: string) => {};
function fastOpts(): { pollIntervalMs: number; pollTimeoutMs: number; projectsDir: string } {
  return { pollIntervalMs: 0, pollTimeoutMs: 5_000, projectsDir: path.join(workDir, 'projects') };
}

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetMockSunoState();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step04-work-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  __setDbForTests(null);
  __resetMockSunoState();
});

// Build a mock client that knows how to "download" by copying any source path
// to dest. Since we changed cwd above, we need a helper that resolves against
// the fixture dir from the test file's perspective (originalCwd).
function makeFixtureClient(sourceFile = GOOD_FIXTURE): SunoClient {
  return {
    async submit() {
      throw new Error('not used');
    },
    async poll() {
      return 'ready';
    },
    async download(_taskId, destPath) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(sourceFile, destPath);
    },
    async getCredits() {
      return 100;
    },
  };
}

describe('step04SunoDownload', () => {
  it('happy path: 30 tracks downloaded, ffprobe-validated, status=done', async () => {
    const { albumId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    const client = makeFixtureClient(GOOD_FIXTURE);

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    const after = tracksRepo.listByAlbum(albumId);
    expect(after).toHaveLength(30);
    for (const t of after) {
      expect(t.status).toBe('done');
      expect(t.audioPath).toMatch(/songs[\\/].*\.wav$/);
      expect(t.duration).toBeGreaterThanOrEqual(34.9);
      expect(fs.existsSync(t.audioPath!)).toBe(true);
    }
  });

  it('validation failure: bad-fixture.wav triggers one retry, then track failed', async () => {
    const { albumId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    const inner = makeFixtureClient(GOOD_FIXTURE);
    let track5DownloadCalls = 0;
    const client: SunoClient = {
      ...inner,
      download: async (taskId, dest) => {
        const isTrack5 = taskId === 'mock-task-0005';
        if (isTrack5) {
          track5DownloadCalls++;
          // Always serve bad fixture for track 5: triggers initial validation
          // failure + one retry that also fails -> track marked failed.
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(BAD_FIXTURE, dest);
          return;
        }
        await inner.download(taskId, dest);
      },
    };

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    expect(track5DownloadCalls).toBe(2); // initial + 1 retry
    const after = tracksRepo.listByAlbum(albumId);
    const t5 = after.find((t) => t.trackNumber === 5)!;
    expect(t5.status).toBe('failed');
    expect(t5.audioPath).toBeNull();
    // Other tracks still done.
    for (const t of after) {
      if (t.trackNumber === 5) continue;
      expect(t.status).toBe('done');
    }
  });

  it('validation failure recovers if retry serves a good file', async () => {
    const { albumId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    const inner = makeFixtureClient(GOOD_FIXTURE);
    const callCounts = new Map<string, number>();
    const client: SunoClient = {
      ...inner,
      download: async (taskId, dest) => {
        const n = (callCounts.get(taskId) ?? 0) + 1;
        callCounts.set(taskId, n);
        if (taskId === 'mock-task-0009' && n === 1) {
          // First attempt = bad fixture, retry = good.
          await fs.promises.mkdir(path.dirname(dest), { recursive: true });
          await fs.promises.copyFile(BAD_FIXTURE, dest);
          return;
        }
        await inner.download(taskId, dest);
      },
    };

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    expect(callCounts.get('mock-task-0009')).toBe(2);
    const after = tracksRepo.listByAlbum(albumId);
    const t9 = after.find((t) => t.trackNumber === 9)!;
    expect(t9.status).toBe('done');
    expect(t9.audioPath).not.toBeNull();
  });

  it('resume: skips tracks with existing valid audioPath', async () => {
    const { albumId, channelId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    // Pre-populate 10 tracks with audioPath pointing at a real (valid) fixture.
    const tracks = tracksRepo.listByAlbum(albumId);
    const songsDir = path.join(workDir, 'projects', channelId, albumId, 'songs');
    fs.mkdirSync(songsDir, { recursive: true });
    for (let i = 0; i < 10; i++) {
      const dest = path.join(songsDir, tracks[i].fileName);
      fs.copyFileSync(GOOD_FIXTURE, dest);
      tracksRepo.patch(tracks[i].id, { audioPath: dest, status: 'done', duration: 35 });
    }
    let downloadCalls = 0;
    const inner = makeFixtureClient(GOOD_FIXTURE);
    const client: SunoClient = {
      ...inner,
      download: async (taskId, dest) => {
        downloadCalls++;
        await inner.download(taskId, dest);
      },
    };

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    expect(downloadCalls).toBe(20); // 30 - 10 pre-done
    const after = tracksRepo.listByAlbum(albumId);
    expect(after.filter((t) => t.status === 'done')).toHaveLength(30);
  });

  it('skips tracks without sunoTaskId entirely', async () => {
    const { albumId } = setupAlbum();
    const tracks = seed30TracksWithTaskIds(albumId);
    // Strip sunoTaskId on track 1 (simulating step03 having failed for that track).
    tracksRepo.patch(tracks[0].id, { sunoTaskId: null, status: 'failed' });
    const client = makeFixtureClient(GOOD_FIXTURE);

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    const after = tracksRepo.listByAlbum(albumId);
    expect(after[0].status).toBe('failed');
    expect(after[0].audioPath).toBeNull();
    for (const t of after.slice(1)) {
      expect(t.status).toBe('done');
    }
  });

  it('poll returns failed -> mark track failed, no download attempted', async () => {
    const { albumId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    const inner = makeFixtureClient(GOOD_FIXTURE);
    let downloadCalls = 0;
    const client: SunoClient = {
      ...inner,
      poll: async (taskId) => (taskId === 'mock-task-0012' ? 'failed' : 'ready'),
      download: async (taskId, dest) => {
        downloadCalls++;
        await inner.download(taskId, dest);
      },
    };

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    expect(downloadCalls).toBe(29);
    const after = tracksRepo.listByAlbum(albumId);
    const t12 = after.find((t) => t.trackNumber === 12)!;
    expect(t12.status).toBe('failed');
    expect(t12.audioPath).toBeNull();
  });

  it('integrates with the real mock client when sunoTaskIds came from its own submit calls', async () => {
    const { albumId } = setupAlbum();
    // Insert tracks with NO sunoTaskIds, then have the real mock client
    // assign them via submit(); this mirrors what step 03 does.
    const inputs = Array.from({ length: 30 }, (_, i) => ({
      albumId,
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      fileName: `${String(i + 1).padStart(2, '0')} - Track ${i + 1}.wav`,
      sunoLyrics: `lyrics ${i + 1}`,
    }));
    tracksRepo.insertMany(inputs);
    const client = makeMockSunoClient();
    for (const t of tracksRepo.listByAlbum(albumId)) {
      const taskId = await client.submit({
        stylePrompt: 'style',
        lyrics: t.sunoLyrics ?? '',
        model: 'chirp-fenix',
        mode: 'custom',
        instrumental: false,
      });
      tracksRepo.patch(t.id, { sunoTaskId: taskId, status: 'submitted' });
    }

    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    const after = tracksRepo.listByAlbum(albumId);
    for (const t of after) {
      expect(t.status).toBe('done');
      expect(t.audioPath).not.toBeNull();
      expect(fs.statSync(t.audioPath!).size).toBeGreaterThan(1024);
    }
  });

  it('throws SunoError class assignment correctness for failures', async () => {
    // Sanity smoke test: bad-fixture causes ffprobe/validate to throw a SunoError.
    const { albumId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    const client = makeFixtureClient(BAD_FIXTURE);
    await step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());
    const after = tracksRepo.listByAlbum(albumId);
    expect(after.every((t) => t.status === 'failed')).toBe(true);
    // Suppress unused import warning.
    expect(SunoError).toBeDefined();
  });

  it('halts album to awaiting_suno_relogin when poll throws SUNO_COOKIE_ROTATED (C4)', async () => {
    const { albumId, channelId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    const inner = makeFixtureClient(GOOD_FIXTURE);
    let pollCalls = 0;
    let downloadCalls = 0;
    const client: SunoClient = {
      ...inner,
      poll: async (taskId) => {
        pollCalls++;
        if (taskId === 'mock-task-0001') {
          throw new SunoError(
            'SUNO_COOKIE_ROTATED',
            'cookie rotated mid-poll',
            false,
            401,
          );
        }
        return 'ready';
      },
      download: async (taskId, dest) => {
        downloadCalls++;
        await inner.download(taskId, dest);
      },
    };

    await expect(
      step04Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts()),
    ).rejects.toThrow('cookie rotated mid-poll');

    // Album halted at awaiting_suno_relogin.
    const after = albumsRepo.get(albumId);
    expect(after?.status).toBe('awaiting_suno_relogin');
    // Settings flag set with right shape.
    const flagRaw = getRawSetting('suno_cookie_rotated');
    expect(flagRaw).toBeDefined();
    const flag = JSON.parse(flagRaw!);
    expect(flag.albumId).toBe(albumId);
    expect(flag.channelId).toBe(channelId);
    expect(typeof flag.at).toBe('number');
    // No tracks beyond the failing one were polled.
    expect(pollCalls).toBe(1);
    // No downloads attempted.
    expect(downloadCalls).toBe(0);
  });

  it('preserves audioPath on halt + resume; only the failing track re-polls (C4)', async () => {
    const { albumId, channelId } = setupAlbum();
    seed30TracksWithTaskIds(albumId);
    // Pre-populate tracks 1-5 with valid audioPath (simulating prior progress).
    const tracks = tracksRepo.listByAlbum(albumId);
    const songsDir = path.join(workDir, 'projects', channelId, albumId, 'songs');
    fs.mkdirSync(songsDir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const dest = path.join(songsDir, tracks[i].fileName);
      fs.copyFileSync(GOOD_FIXTURE, dest);
      tracksRepo.patch(tracks[i].id, { audioPath: dest, status: 'done', duration: 35 });
    }
    // Phase 1: track 6 throws SUNO_COOKIE_ROTATED → album halts.
    let pollPhase1 = 0;
    const inner = makeFixtureClient(GOOD_FIXTURE);
    const phase1Client: SunoClient = {
      ...inner,
      poll: async (taskId) => {
        pollPhase1++;
        if (taskId === 'mock-task-0006') {
          throw new SunoError('SUNO_COOKIE_ROTATED', 'rotated', false, 401);
        }
        return 'ready';
      },
    };
    await expect(
      step04Internal(albumsRepo.get(albumId)!, noopLog, phase1Client, fastOpts()),
    ).rejects.toThrow();
    expect(albumsRepo.get(albumId)?.status).toBe('awaiting_suno_relogin');
    // First 5 tracks still done (skipped via audioPath idempotency); track 6+ untouched.
    expect(tracksRepo.listByAlbum(albumId).filter((t) => t.status === 'done')).toHaveLength(5);

    // Phase 2: operator runs suno-login, resume endpoint patches album back to queued,
    // worker re-runs step 04. Now poll returns ready for everything.
    albumsRepo.patch(albumId, { status: 'queued' });
    const phase2Client = makeFixtureClient(GOOD_FIXTURE);
    let pollPhase2 = 0;
    const wrappedPhase2: SunoClient = {
      ...phase2Client,
      poll: async (taskId) => {
        pollPhase2++;
        return phase2Client.poll(taskId);
      },
    };
    await step04Internal(albumsRepo.get(albumId)!, noopLog, wrappedPhase2, fastOpts());

    // Phase 2 polls only the eligible (non-done) tracks: 25 tracks (6..30).
    expect(pollPhase2).toBe(25);
    // First 5 tracks still hold their original audioPath (no re-fetch).
    const finalState = tracksRepo.listByAlbum(albumId);
    for (let i = 0; i < 5; i++) {
      expect(finalState[i].status).toBe('done');
      expect(finalState[i].audioPath).toContain(tracks[i].fileName);
    }
    // All tracks now done.
    expect(finalState.filter((t) => t.status === 'done')).toHaveLength(30);
    // Phase-1 tally: only track 6 was polled before the throw.
    expect(pollPhase1).toBe(1);
  });
});
