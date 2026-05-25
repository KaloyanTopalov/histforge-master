import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { step10Internal } from '@/worker/steps/10-youtube-metadata';

let db: Db;
let prevCwd: string;
let tmpRoot: string;

const baseChannel = {
  name: 'step10-test',
  displayName: 'Step10 Test',
  description: 'ambient sleep music',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step10 Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: 'ambient,sleep',
};

beforeEach(() => {
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'step10-'));
  // Copy the real yt-metadata.md (with its mock-response directive) into a
  // sandboxed prompts dir so the step's resolveChannelPrompt lookup hits it.
  fs.mkdirSync(path.join(tmpRoot, 'prompts', 'defaults'), { recursive: true });
  const realYtMetadata = fs.readFileSync(
    path.join(prevCwd, 'prompts', 'defaults', 'yt-metadata.md'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'prompts', 'defaults', 'yt-metadata.md'),
    realYtMetadata,
  );
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

function preWriteTracklist(channelId: string, albumId: string): string {
  // generateTracklist short-circuits to the existing file when present, so a
  // hand-rolled tracklist.txt lets the test skip the real ffprobe of audio
  // files for 30 tracks.
  const albumDir = path.join(tmpRoot, 'projects', channelId, albumId);
  fs.mkdirSync(albumDir, { recursive: true });
  const text = '0:00 - One\n3:00 - Two\n6:00 - Three';
  fs.writeFileSync(path.join(albumDir, 'tracklist.txt'), text);
  return text;
}

describe('step 10 — title resolution', () => {
  it('ambient workflow: ytTitle comes from the LLM mock', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true, workflow: 'ambient' });
    const album = albumsRepo.create({ channelId: channel.id });
    preWriteTracklist(channel.id, album.id);

    await step10Internal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });

    const after = albumsRepo.get(album.id)!;
    // The default yt-metadata.md mock-response is `"sleep tonight."`.
    expect(after.ytTitle).toBe('sleep tonight.');
  });

  it('ambient-video workflow: ytTitle is overridden by album.sceneTitle', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, {
      sceneTitle: "The Knight's Quiet Fire | Medieval Fantasy Music for Peaceful Focus",
    });
    preWriteTracklist(channel.id, album.id);

    await step10Internal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });

    const after = albumsRepo.get(album.id)!;
    expect(after.ytTitle).toBe(
      "The Knight's Quiet Fire | Medieval Fantasy Music for Peaceful Focus",
    );
    // Title file on disk reflects the override.
    const titleOnDisk = fs.readFileSync(
      path.join(tmpRoot, 'projects', channel.id, album.id, 'title.txt'),
      'utf8',
    );
    expect(titleOnDisk).toBe(
      "The Knight's Quiet Fire | Medieval Fantasy Music for Peaceful Focus",
    );
  });

  it('ambient-video workflow with empty sceneTitle: falls back to LLM title', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    // Leave sceneTitle null.
    preWriteTracklist(channel.id, album.id);

    await step10Internal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });

    const after = albumsRepo.get(album.id)!;
    expect(after.ytTitle).toBe('sleep tonight.');
  });

  it('ambient-video workflow with whitespace-only sceneTitle: falls back to LLM title', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      active: true,
      workflow: 'ambient-video',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sceneTitle: '   ' });
    preWriteTracklist(channel.id, album.id);

    await step10Internal(albumsRepo.get(album.id)!, noopLog, {
      projectsDir: path.join(tmpRoot, 'projects'),
    });

    const after = albumsRepo.get(album.id)!;
    expect(after.ytTitle).toBe('sleep tonight.');
  });
});
