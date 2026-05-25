import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { step01bSceneGenerator, step01bInternal } from '@/worker/steps/01b-scene-generator';
import { getWorkflow } from '@/worker/workflows';

let db: Db;
let prevCwd: string;
let tmpRoot: string;

const baseChannel = {
  name: 'amv-test',
  displayName: 'Ambient Video Test',
  description: 'medieval ambient',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'AmbientForge Knight',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: 'ambient,knight',
};

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amv-step01b-'));
  // Copy the real ambient-video-scene.md (with its mock-response directive)
  // into the sandbox so prompts.cwd resolution finds it.
  const realTemplate = fs.readFileSync(
    path.join(prevCwd, 'prompts', 'defaults', 'ambient-video-scene.md'),
    'utf8',
  );
  // Also need the album-brief default for the composed-step01 test.
  const realAlbumBrief = fs.readFileSync(
    path.join(prevCwd, 'prompts', 'defaults', 'album-brief.md'),
    'utf8',
  );
  fs.mkdirSync(path.join(tmpRoot, 'prompts', 'defaults'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpRoot, 'prompts', 'defaults', 'ambient-video-scene.md'),
    realTemplate,
  );
  fs.writeFileSync(path.join(tmpRoot, 'prompts', 'defaults', 'album-brief.md'), realAlbumBrief);
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
  vi.restoreAllMocks();
});

const noopLog = (_stage: string, _msg: string) => {};

describe('step01bSceneGenerator', () => {
  it('populates album.scene_* fields and writes scene.json from mock response', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      sceneThemes: JSON.stringify(['knight by campfire at night']),
    });
    const album = albumsRepo.create({ channelId: channel.id });

    await step01bSceneGenerator(albumsRepo.get(album.id)!, noopLog);

    const updated = albumsRepo.get(album.id)!;
    expect(updated.sceneImagePrompt).toMatch(/painterly|matte-painting|JRPG/i);
    expect(updated.sceneSeedancePrompt).toMatch(/Static locked camera/);
    expect(updated.sceneTitle).toMatch(/Medieval Fantasy Music for/);

    const scenePath = path.join(tmpRoot, 'projects', channel.id, album.id, 'scene.json');
    expect(fs.existsSync(scenePath)).toBe(true);
    const json = JSON.parse(fs.readFileSync(scenePath, 'utf8'));
    expect(json).toHaveProperty('scene');
    expect(json).toHaveProperty('imagePrompt');
    expect(json).toHaveProperty('seedancePrompt');
    expect(json).toHaveProperty('title');
    expect(json.title).toBe(updated.sceneTitle);
  });

  it('is a no-op when all three scene_* fields are already populated', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      sceneThemes: JSON.stringify(['knight at sunrise']),
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, {
      sceneImagePrompt: 'pre-existing image prompt',
      sceneSeedancePrompt: 'pre-existing seedance prompt',
      sceneTitle: 'Pre-existing Title',
    });

    await step01bSceneGenerator(albumsRepo.get(album.id)!, noopLog);

    const after = albumsRepo.get(album.id)!;
    expect(after.sceneImagePrompt).toBe('pre-existing image prompt');
    expect(after.sceneTitle).toBe('Pre-existing Title');
    // scene.json must NOT exist — the step short-circuited before writing.
    const scenePath = path.join(tmpRoot, 'projects', channel.id, album.id, 'scene.json');
    expect(fs.existsSync(scenePath)).toBe(false);
  });

  it('uses the fallback theme when channel.sceneThemes is null', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      sceneThemes: null,
    });
    const album = albumsRepo.create({ channelId: channel.id });

    // Inject deterministic random + capture which theme was picked.
    const themesSeen: string[] = [];
    const origRandom = Math.random;
    Math.random = () => 0;
    try {
      // Use the Internal entry point so we can pass a sandbox projectsDir and
      // assert the fallback path is hit via mock-response.
      await step01bInternal(albumsRepo.get(album.id)!, (_stage, msg) => themesSeen.push(msg), {
        projectsDir: path.join(tmpRoot, 'projects'),
        promptsRoot: path.join(tmpRoot, 'prompts'),
      });
    } finally {
      Math.random = origRandom;
    }
    const themeLog = themesSeen.find((m) => m.startsWith('theme picked='));
    expect(themeLog).toBeDefined();
    expect(themeLog).toContain('medieval knight in a peaceful fantasy environment');
  });

  it('picks deterministically when random=0 over a multi-theme list', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      sceneThemes: JSON.stringify(['theme-A', 'theme-B', 'theme-C']),
    });
    const album = albumsRepo.create({ channelId: channel.id });

    const seen: string[] = [];
    await step01bInternal(albumsRepo.get(album.id)!, (_s, m) => seen.push(m), {
      projectsDir: path.join(tmpRoot, 'projects'),
      promptsRoot: path.join(tmpRoot, 'prompts'),
      random: () => 0,
    });
    const themeLog = seen.find((m) => m.startsWith('theme picked='));
    expect(themeLog).toBe('theme picked="theme-A"');
  });

  it('throws CHANNEL_NOT_FOUND when channel row is gone', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      sceneThemes: null,
    });
    const album = albumsRepo.create({ channelId: channel.id });
    const snapshot = albumsRepo.get(album.id)!;
    // Simulate channel-removed-between-creation-and-step. We hand the step a
    // snapshot album (so its refetch falls back), then drop the album row +
    // the channel row so `channelsRepo.get` returns null.
    db.prepare('DELETE FROM albums WHERE id = ?').run(album.id);
    db.prepare('DELETE FROM channels WHERE id = ?').run(channel.id);
    await expect(step01bSceneGenerator(snapshot, noopLog)).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
  });
});

describe('ambient-video composed step01 (step 01 + 01b chain)', () => {
  it('runs step 01 first (album title) then step 01b (scene fields)', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
      sceneThemes: JSON.stringify(['knight by campfire at night']),
    });
    const album = albumsRepo.create({ channelId: channel.id });
    // Strip the artist so we can verify step 01 ran (it copies channel.distrokidArtistName).
    albumsRepo.patch(album.id, { artistName: '' });

    const composed = getWorkflow('ambient-video').step01;
    expect(typeof composed).toBe('function');

    await composed!(albumsRepo.get(album.id)!, noopLog);

    const after = albumsRepo.get(album.id)!;
    // Step 01 evidence
    expect(after.albumTitle.length).toBeGreaterThan(0);
    expect(after.primaryGenre.length).toBeGreaterThan(0);
    expect(after.artistName).toBe('AmbientForge Knight');
    // Step 01b evidence
    expect(after.sceneImagePrompt).toMatch(/painterly|matte-painting|JRPG/i);
    expect(after.sceneSeedancePrompt).toMatch(/Static locked camera/);
    expect(after.sceneTitle).toMatch(/Medieval Fantasy Music for/);

    // scene.json on disk
    const scenePath = path.join(tmpRoot, 'projects', channel.id, album.id, 'scene.json');
    expect(fs.existsSync(scenePath)).toBe(true);
  });
});
