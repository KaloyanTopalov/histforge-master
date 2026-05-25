import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { ffprobe } from '@/lib/audio/ffmpeg';
import { step05bAmbientVideoThumbnailInternal } from '@/worker/steps/05b-ambient-video-thumbnail';
import { sourceJpgPath } from '@/worker/workflows/checks';
import type {
  FreepikClient,
  FreepikThumbnailSubmitInput,
} from '@/lib/freepik/client';

const baseChannel = {
  name: 'amv-05b',
  displayName: 'AMV Step05b',
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
let promptsRoot: string;
// Reusable source-image fixture (2048×2048 JPEG, well above 50 KB). Doubles as
// what the mock freepik client returns for each downloaded candidate so the
// real resize + grade + ffprobe chain runs on valid bytes.
let sourceJpgFixture: string;

const THUMB_W = 3840;
const THUMB_H = 2160;

beforeAll(() => {
  const sharedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'amv-05b-fixture-'));
  sourceJpgFixture = path.join(sharedTmp, 'source.jpg');
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step05b-amv-'));
  process.chdir(tmpRoot);
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  // Hermetic prompts root: a thumbnail-spec default whose mock-response
  // directive echoes the title, so the forwarded Magnific prompt proves the
  // template-load → render(sceneTitle) → mock-LLM → submitThumbnail chain.
  promptsRoot = path.join(tmpRoot, 'prompts');
  writeDefaultTemplate('<!-- mock-response: "MOCK_MAGNIFIC::{{TITLE}}" -->\nSpec body for {{TITLE}}.');
});

afterEach(() => {
  __setDbForTests(null);
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const noopLog = (_stage: string, _msg: string) => {};

function writeDefaultTemplate(content: string): void {
  const dir = path.join(promptsRoot, 'defaults');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thumbnail-spec.md'), content);
}

function writeChannelTemplate(channelId: string, content: string): void {
  const dir = path.join(promptsRoot, 'channel-templates', channelId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'thumbnail-spec.md'), content);
}

function makeMockClient(opts: {
  count?: number;
  capture?: { submit?: FreepikThumbnailSubmitInput };
  onSubmitThumbnail?: () => void;
  pollResult?: { status: 'pending' | 'ready' | 'failed'; count: number };
}): FreepikClient {
  let nextId = 1;
  const count = opts.count ?? 4;
  async function copyFixture(dest: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.copyFile(sourceJpgFixture, dest);
  }
  return {
    async submit() {
      return `mock-img-${nextId++}`;
    },
    async submitVideo() {
      return `mock-vid-${nextId++}`;
    },
    async submitThumbnail(input) {
      opts.onSubmitThumbnail?.();
      if (opts.capture) opts.capture.submit = input;
      return `mock-thumb-${nextId++}`;
    },
    async poll() {
      return 'ready';
    },
    async pollThumbnail() {
      return opts.pollResult ?? { status: 'ready', count };
    },
    async download(_taskId, dest) {
      await copyFixture(dest);
    },
    async downloadThumbnail(_taskId, _index, dest) {
      await copyFixture(dest);
    },
  };
}

function dropAlbumSource(channelId: string, albumId: string): string {
  const p = path.join(tmpRoot, 'projects', channelId, albumId, 'source.jpg');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.copyFileSync(sourceJpgFixture, p);
  return p;
}

describe('step05bAmbientVideoThumbnail — happy path', () => {
  it('produces 4 graded thumbs at 3840×2160 and forwards the LLM prompt + source.jpg reference', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: 'Quiet Fire' });
    const albumSource = dropAlbumSource(channel.id, album.id);

    const captured: { submit?: FreepikThumbnailSubmitInput } = {};
    const client = makeMockClient({ capture: captured });

    await step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
      promptsRoot,
      freepikClient: client,
      llmApiKey: 'mock',
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });

    // The mock LLM returns the directive verbatim after {{TITLE}} render.
    expect(captured.submit?.prompt).toBe('MOCK_MAGNIFIC::Quiet Fire');
    expect(captured.submit?.referenceImagePath).toBe(albumSource);
    expect(captured.submit?.count).toBe(4);

    const thumbsDir = path.join(tmpRoot, 'projects', channel.id, album.id, 'thumbs');
    for (let i = 1; i <= 4; i++) {
      const p = path.join(thumbsDir, `thumb-${i}.png`);
      expect(fs.existsSync(p)).toBe(true);
      const probe = await ffprobe(p);
      expect(probe.width).toBe(THUMB_W);
      expect(probe.height).toBe(THUMB_H);
    }

    // Selection is deferred — the step must NOT set album.thumbnailPath.
    const after = albumsRepo.get(album.id)!;
    expect(after.thumbnailPath ?? null).toBeNull();
  }, 120_000);
});

describe('step05bAmbientVideoThumbnail — idempotency', () => {
  it('is a noop on the second run: no submitThumbnail, files untouched', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: 'Quiet Fire' });
    dropAlbumSource(channel.id, album.id);

    let submitCount = 0;
    const client = makeMockClient({ onSubmitThumbnail: () => (submitCount += 1) });
    const runOpts = {
      projectsDir: path.join(tmpRoot, 'projects'),
      promptsRoot,
      freepikClient: client,
      llmApiKey: 'mock',
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    };

    await step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, runOpts);
    expect(submitCount).toBe(1);
    const thumb1 = path.join(tmpRoot, 'projects', channel.id, album.id, 'thumbs', 'thumb-1.png');
    const mtime1 = fs.statSync(thumb1).mtimeMs;

    await new Promise((r) => setTimeout(r, 50));
    await step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, runOpts);
    expect(submitCount).toBe(1); // not re-submitted
    expect(fs.statSync(thumb1).mtimeMs).toBe(mtime1); // not rewritten
  }, 120_000);
});

describe('step05bAmbientVideoThumbnail — source resolution', () => {
  it('throws THUMBNAIL_SOURCE_JPG_MISSING when no album/channel source.jpg exists', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: 'Quiet Fire' });
    // Deliberately drop NO source.jpg.

    await expect(
      step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
        promptsRoot,
        freepikClient: makeMockClient({}),
        llmApiKey: 'mock',
        pollIntervalMs: 0,
        pollTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'THUMBNAIL_SOURCE_JPG_MISSING' });
  });

  it('falls back to the channel-folder source.jpg when no album-folder one exists', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: 'Quiet Fire' });
    // Channel-level operator fallback, not the album folder.
    const channelSource = sourceJpgPath(channel.id);
    fs.mkdirSync(path.dirname(channelSource), { recursive: true });
    fs.copyFileSync(sourceJpgFixture, channelSource);

    const captured: { submit?: FreepikThumbnailSubmitInput } = {};
    await step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
      promptsRoot,
      freepikClient: makeMockClient({ capture: captured }),
      llmApiKey: 'mock',
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });

    expect(captured.submit?.referenceImagePath).toBe(channelSource);
    const thumb1 = path.join(tmpRoot, 'projects', channel.id, album.id, 'thumbs', 'thumb-1.png');
    expect(fs.existsSync(thumb1)).toBe(true);
  }, 120_000);
});

describe('step05bAmbientVideoThumbnail — template + title wiring', () => {
  it('uses a per-channel thumbnail-spec override and flows its prompt to submitThumbnail', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: 'Quiet Fire' });
    dropAlbumSource(channel.id, album.id);
    // Channel override wins over the default written in beforeEach.
    writeChannelTemplate(
      channel.id,
      '<!-- mock-response: "CH_OVERRIDE::{{TITLE}}" -->\nOverride body {{TITLE}}.',
    );

    const captured: { submit?: FreepikThumbnailSubmitInput } = {};
    await step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
      promptsRoot,
      freepikClient: makeMockClient({ capture: captured }),
      llmApiKey: 'mock',
      pollIntervalMs: 0,
      pollTimeoutMs: 5_000,
    });

    expect(captured.submit?.prompt).toBe('CH_OVERRIDE::Quiet Fire');
  }, 120_000);

  it('throws THUMBNAIL_SCENE_TITLE_MISSING when album.sceneTitle is null', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    // No sceneTitle patch — step 01b would normally set it.
    dropAlbumSource(channel.id, album.id);

    await expect(
      step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
        promptsRoot,
        freepikClient: makeMockClient({}),
        llmApiKey: 'mock',
        pollIntervalMs: 0,
        pollTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'THUMBNAIL_SCENE_TITLE_MISSING' });
  });
});

describe('step05bAmbientVideoThumbnail — poll failure translation', () => {
  function setup() {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: 'Quiet Fire' });
    dropAlbumSource(channel.id, album.id);
    return album;
  }

  it('translates a failed Magnific task to THUMBNAIL_GEN_FAILED', async () => {
    const album = setup();
    await expect(
      step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
        promptsRoot,
        freepikClient: makeMockClient({ pollResult: { status: 'failed', count: 0 } }),
        llmApiKey: 'mock',
        pollIntervalMs: 0,
        pollTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'THUMBNAIL_GEN_FAILED' });
  });

  it('translates a never-ready task (timeout) to THUMBNAIL_GEN_TIMEOUT', async () => {
    const album = setup();
    await expect(
      step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
        promptsRoot,
        freepikClient: makeMockClient({ pollResult: { status: 'pending', count: 0 } }),
        llmApiKey: 'mock',
        pollIntervalMs: 0,
        pollTimeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: 'THUMBNAIL_GEN_TIMEOUT' });
  });

  it('translates ready-but-zero-candidates to THUMBNAIL_RESULTS_INCOMPLETE', async () => {
    const album = setup();
    await expect(
      step05bAmbientVideoThumbnailInternal(albumsRepo.get(album.id)!, noopLog, {
        projectsDir: path.join(tmpRoot, 'projects'),
        promptsRoot,
        freepikClient: makeMockClient({ pollResult: { status: 'ready', count: 0 } }),
        llmApiKey: 'mock',
        pollIntervalMs: 0,
        pollTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'THUMBNAIL_RESULTS_INCOMPLETE' });
  });
});
