import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { ffprobe } from '@/lib/audio/ffmpeg';
import { step05aAmbientVideoInternal } from '@/worker/steps/05a-ambient-video-cover';
import { sourceJpgPath } from '@/worker/workflows/checks';

const baseChannel = {
  name: 'amv-05a',
  displayName: 'AMV Step05a',
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
// Reusable Midjourney-shaped source JPEG (1024×1024, well above 50KB threshold).
let sourceJpgFixture: string;

beforeAll(() => {
  const sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amv-05a-fixture-'));
  sourceJpgFixture = path.join(sharedTmp, 'source.jpg');
  // Generate a 2048×2048 JPEG well above the 50KB threshold. rgbtestsrc
  // (random-ish RGB pattern) compresses worse than flat colors, q:v 1 keeps
  // quality high enough to avoid sub-50KB outputs.
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'rgbtestsrc=size=2048x2048:duration=1:rate=1',
    '-frames:v',
    '1',
    '-q:v',
    '1',
    sourceJpgFixture,
  ]);
  const size = fs.statSync(sourceJpgFixture).size;
  // Defensive: if the lavfi generator produced too small a file, throw so the
  // test failure points at the fixture rather than the SUT.
  if (size <= 50 * 1024) {
    throw new Error(`source.jpg fixture only ${size} bytes; rgbtestsrc compressed too well`);
  }
});

afterAll(() => {
  if (sourceJpgFixture) {
    fs.rmSync(path.dirname(sourceJpgFixture), { recursive: true, force: true });
  }
});

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step05a-amv-'));
  process.chdir(tmpRoot);
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const noopLog = (_stage: string, _msg: string) => {};

describe('step05aAmbientVideoCover — preconditions', () => {
  it('throws SOURCE_JPG_MISSING when no source.jpg is present', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    await expect(
      step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_JPG_MISSING' });
  });

  it('throws SOURCE_JPG_MISSING when source.jpg is too small', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    const p = sourceJpgPath(channel.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(1024, 0xab));
    await expect(
      step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
      }),
    ).rejects.toMatchObject({ code: 'SOURCE_JPG_MISSING' });
  });
});

describe('step05aAmbientVideoCover — happy path', () => {
  it('produces cover.png 3000x3000 + ytImage.png 1920x1080 from source.jpg', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    const p = sourceJpgPath(channel.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(sourceJpgFixture, p);

    await step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });

    const after = albumsRepo.get(album.id)!;
    expect(after.coverImagePath).toBeTruthy();
    expect(after.ytImagePath).toBeTruthy();
    expect(fs.existsSync(after.coverImagePath!)).toBe(true);
    expect(fs.existsSync(after.ytImagePath!)).toBe(true);
    const coverProbe = await ffprobe(after.coverImagePath!);
    expect(coverProbe.width).toBe(3000);
    expect(coverProbe.height).toBe(3000);
    const ytProbe = await ffprobe(after.ytImagePath!);
    expect(ytProbe.width).toBe(1920);
    expect(ytProbe.height).toBe(1080);
    // Raw is cleaned up post-process.
    const rawPath = path.join(tmpRoot, 'projects', channel.id, album.id, '_raw-cover.png');
    expect(fs.existsSync(rawPath)).toBe(false);
  }, 120_000);
});

describe('step05aAmbientVideoCover — freepik resolution path', () => {
  it('calls the freepik client when album.scene_image_prompt is set and no album/channel source.jpg exists', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneImagePrompt: 'a knight beside a campfire' });

    // Track that the freepik client was actually invoked.
    const callLog: string[] = [];
    const fakeClient = {
      async submit(input: { prompt: string; model?: string; aspectRatio?: string }) {
        callLog.push(`submit:${input.prompt}:${input.model}:${input.aspectRatio}`);
        return 'fake-task-1';
      },
      async poll() {
        callLog.push('poll');
        return 'ready' as const;
      },
      async download(_taskId: string, destPath: string) {
        callLog.push(`download:${destPath}`);
        // Copy the existing source fixture (well over 50 KB) to the destination
        // so the post-process happy path runs.
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(sourceJpgFixture, destPath);
      },
    };

    await step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
      freepikClient: fakeClient,
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });

    expect(callLog).toContain('submit:a knight beside a campfire:Seedream 5 Lite Fast:16:9');
    expect(callLog).toContain('poll');
    expect(callLog.some((entry) => entry.startsWith('download:'))).toBe(true);

    const after = albumsRepo.get(album.id)!;
    expect(after.coverImagePath).toBeTruthy();
    expect(after.ytImagePath).toBeTruthy();
    expect(fs.existsSync(after.coverImagePath!)).toBe(true);
    expect(fs.existsSync(after.ytImagePath!)).toBe(true);
    // The freepik client downloads to projects/<ch>/<alb>/source.jpg.
    const albumSource = path.join(tmpRoot, 'projects', channel.id, album.id, 'source.jpg');
    expect(fs.existsSync(albumSource)).toBe(true);
  }, 120_000);

  it('prefers an album-folder source.jpg over invoking freepik', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneImagePrompt: 'should not be used' });

    // Pre-drop an album-folder source.jpg (operator override).
    const albumSource = path.join(tmpRoot, 'projects', channel.id, album.id, 'source.jpg');
    fs.mkdirSync(path.dirname(albumSource), { recursive: true });
    fs.copyFileSync(sourceJpgFixture, albumSource);

    let submitCalls = 0;
    const fakeClient = {
      async submit() {
        submitCalls += 1;
        return 'should-not-happen';
      },
      async poll() {
        return 'ready' as const;
      },
      async download() {
        /* unused */
      },
    };

    await step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
      freepikClient: fakeClient,
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });
    expect(submitCalls).toBe(0);
  }, 120_000);

  it('falls back to channel-folder source.jpg when freepik client fails', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneImagePrompt: 'a knight beside a campfire' });

    // Drop a channel-folder fallback.
    const channelSource = sourceJpgPath(channel.id);
    fs.mkdirSync(path.dirname(channelSource), { recursive: true });
    fs.copyFileSync(sourceJpgFixture, channelSource);

    // Freepik client that always fails.
    const { FreepikError } = await import('@/lib/freepik/client');
    const fakeClient = {
      async submit() {
        throw new FreepikError('FREEPIK_BRIDGE_UNREACHABLE', 'no bridge', true);
      },
      async poll() {
        return 'failed' as const;
      },
      async download() {
        /* unused */
      },
    };

    await step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
      freepikClient: fakeClient,
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });
    // Step succeeded via channel-folder fallback.
    const after = albumsRepo.get(album.id)!;
    expect(after.coverImagePath).toBeTruthy();
    expect(fs.existsSync(after.coverImagePath!)).toBe(true);
  }, 120_000);
});

describe('step05aAmbientVideoCover — idempotency', () => {
  it('is a noop when cover and ytImage already exist at correct dimensions', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    const p = sourceJpgPath(channel.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.copyFileSync(sourceJpgFixture, p);

    // First run produces the artifacts.
    await step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });
    const after1 = albumsRepo.get(album.id)!;
    const mtime1 = fs.statSync(after1.coverImagePath!).mtimeMs;

    await new Promise((r) => setTimeout(r, 50));
    // Second run should be a noop.
    await step05aAmbientVideoInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });
    const mtime2 = fs.statSync(after1.coverImagePath!).mtimeMs;
    expect(mtime2).toBe(mtime1);
  }, 120_000);
});
