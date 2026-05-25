import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { step08SeedanceInternal } from '@/worker/steps/08-seedance-clip';
import { sourceJpgPath } from '@/worker/workflows/checks';
import type { SeedanceClient } from '@/lib/seedance/client';

const baseChannel = {
  name: 'amv-08',
  displayName: 'AMV Step08',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'AMV',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

let db: Db;
let prevCwd: string;
let tmpRoot: string;
// Reusable 10s clip fixture generated once via ffmpeg.
let clipFixturePath: string;

beforeAll(() => {
  // Generate a 10s 1920x1080 h264 clip once for all tests. Audio-less, as
  // Seedance produces (we pass generate_audio: false). ultrafast keeps the
  // ffmpeg cost low.
  const sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-fixture-shared-'));
  clipFixturePath = path.join(sharedTmp, 'clip-fixture.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'color=color=darkblue:size=1920x1080:duration=10:rate=30',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    clipFixturePath,
  ]);
});

afterAll(() => {
  if (clipFixturePath) {
    fs.rmSync(path.dirname(clipFixturePath), { recursive: true, force: true });
  }
});

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step08-'));
  process.chdir(tmpRoot);
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  setSetting('openrouter_api_key', 'mock', db);
  vi.restoreAllMocks();
});

afterEach(() => {
  __setDbForTests(null);
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const noopLog = (_stage: string, _msg: string) => {};

function makeMockClient(opts: { fixturePath: string; capture?: { prompt?: string } }): SeedanceClient {
  let nextId = 1;
  return {
    async submit(input) {
      if (opts.capture) opts.capture.prompt = input.prompt;
      return `mock-${nextId++}`;
    },
    async poll() {
      return 'ready';
    },
    async download(_jobId, destPath) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(opts.fixturePath, destPath);
    },
  };
}

function dropSourceJpg(channelId: string): void {
  const p = sourceJpgPath(channelId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(80 * 1024, 0xab));
}

describe('step08SeedanceClip — prompt resolution', () => {
  it('prefers album.sceneSeedancePrompt over channel.seedanceMotionPrompt', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      seedanceMotionPrompt: 'CHANNEL FALLBACK',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneSeedancePrompt: 'ALBUM SPECIFIC' });
    dropSourceJpg(channel.id);

    const captured: { prompt?: string } = {};
    const client = makeMockClient({ fixturePath: clipFixturePath, capture: captured });

    await step08SeedanceInternal(albumsRepo.get(album.id)!, noopLog, {
      client,
      projectsDir: path.join(tmpRoot, 'projects'),
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });

    expect(captured.prompt).toBe('ALBUM SPECIFIC');
    // clip.mp4 should now exist and pass validation.
    const clipPath = path.join(tmpRoot, 'projects', channel.id, album.id, 'build', 'clip.mp4');
    expect(fs.existsSync(clipPath)).toBe(true);
  });

  it('falls back to channel.seedanceMotionPrompt when album field is empty', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      seedanceMotionPrompt: 'CHANNEL FALLBACK',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    // Leave sceneSeedancePrompt null.
    dropSourceJpg(channel.id);

    const captured: { prompt?: string } = {};
    const client = makeMockClient({ fixturePath: clipFixturePath, capture: captured });

    await step08SeedanceInternal(albumsRepo.get(album.id)!, noopLog, {
      client,
      projectsDir: path.join(tmpRoot, 'projects'),
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });

    expect(captured.prompt).toBe('CHANNEL FALLBACK');
  });

  it('throws SEEDANCE_PROMPT_MISSING when both album and channel prompts are empty', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    dropSourceJpg(channel.id);

    const client = makeMockClient({ fixturePath: clipFixturePath });
    await expect(
      step08SeedanceInternal(albumsRepo.get(album.id)!, noopLog, {
        client,
        projectsDir: path.join(tmpRoot, 'projects'),
        pollIntervalMs: 0,
        pollTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'SEEDANCE_PROMPT_MISSING' });
  });
});

describe('step08SeedanceClip — preconditions', () => {
  it('throws SOURCE_JPG_MISSING when source.jpg is absent', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      seedanceMotionPrompt: 'flames',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    // Deliberately do NOT drop source.jpg.

    const client = makeMockClient({ fixturePath: clipFixturePath });
    await expect(
      step08SeedanceInternal(albumsRepo.get(album.id)!, noopLog, {
        client,
        projectsDir: path.join(tmpRoot, 'projects'),
        pollIntervalMs: 0,
        pollTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_JPG_MISSING' });
  });
});

describe('step08SeedanceClip — idempotency', () => {
  it('skips submit+download when a valid clip.mp4 already exists', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      seedanceMotionPrompt: 'flames',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    dropSourceJpg(channel.id);

    // Pre-place a valid clip.mp4 from the fixture.
    const albumDir = path.join(tmpRoot, 'projects', channel.id, album.id, 'build');
    fs.mkdirSync(albumDir, { recursive: true });
    const clipPath = path.join(albumDir, 'clip.mp4');
    fs.copyFileSync(clipFixturePath, clipPath);
    const mtimeBefore = fs.statSync(clipPath).mtimeMs;

    let submitCalled = 0;
    const client: SeedanceClient = {
      async submit() {
        submitCalled += 1;
        return 'should-not-happen';
      },
      async poll() {
        return 'ready';
      },
      async download() {
        // Should NOT be called.
        submitCalled += 100;
      },
    };
    await step08SeedanceInternal(albumsRepo.get(album.id)!, noopLog, {
      client,
      projectsDir: path.join(tmpRoot, 'projects'),
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });
    expect(submitCalled).toBe(0);
    // File untouched.
    expect(fs.statSync(clipPath).mtimeMs).toBe(mtimeBefore);
  });
});
