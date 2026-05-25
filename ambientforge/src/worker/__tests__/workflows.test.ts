import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import {
  getWorkflow,
  listWorkflows,
  UnknownWorkflowError,
} from '@/worker/workflows';
import { step05bNoop } from '@/worker/pipeline';
import { step05bAmbientVideoThumbnail } from '@/worker/steps/05b-ambient-video-thumbnail';
import {
  requireSceneThemesValidOrNull,
  requireSourceJpg,
  requireSunoStylePromptSource,
  sourceJpgPath,
} from '@/worker/workflows/checks';

let db: Db;

const baseChannel = {
  name: 'wf-test',
  displayName: 'WF Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'WF Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
});

describe('workflow registry', () => {
  it('getWorkflow("ambient") returns ambient definition with suno-prompt preflight', () => {
    const w = getWorkflow('ambient');
    expect(w.name).toBe('ambient');
    expect(w.defaultTracksPerAlbum).toBe(30);
    // Session 12: ambient now has the suno-prompt-source preflight.
    expect(w.preflightChecks).toHaveLength(1);
    expect(typeof w.branchB).toBe('function');
  });

  it('getWorkflow("rap-compilation") returns rap definition with suno-prompt + broll preflights', () => {
    const w = getWorkflow('rap-compilation');
    expect(w.name).toBe('rap-compilation');
    expect(w.defaultTracksPerAlbum).toBe(10);
    // Session 12: rap has [requireSunoStylePromptSource, requireBrollFolder].
    expect(w.preflightChecks).toHaveLength(2);
    expect(w.requiredChannelFields).toContain('brollFolderPath');
    expect(typeof w.branchB).toBe('function');
  });

  it('getWorkflow throws UnknownWorkflowError for unknown names', () => {
    expect(() => getWorkflow('podcast-compilation')).toThrow(UnknownWorkflowError);
  });

  it('listWorkflows returns all registered workflows', () => {
    const list = listWorkflows();
    expect(list).toHaveLength(3);
    expect(list.map((w) => w.name).sort()).toEqual([
      'ambient',
      'ambient-video',
      'rap-compilation',
    ]);
  });

  it('getWorkflow("ambient-video") returns ambient-video definition with 3 preflights', () => {
    const w = getWorkflow('ambient-video');
    expect(w.name).toBe('ambient-video');
    expect(w.defaultTracksPerAlbum).toBe(30);
    // Phase 3: [requireSunoStylePromptSource, requireSourceJpg, requireSceneThemesValidOrNull]
    expect(w.preflightChecks).toHaveLength(3);
    expect(typeof w.branchB).toBe('function');
    // Phase 2: composed step01 (album-brief → 01b) + custom step05a slot.
    expect(typeof w.step01).toBe('function');
    expect(typeof w.step05a).toBe('function');
    // The pre-fork step05b slot MUST be a noop for ambient-video. The Magnific
    // reference-thumbnail step generates images in the same Magnific tab that
    // step 08 (Seedance) reads its start frame from; running it pre-fork (the
    // original Task 11 placement) made step 08 animate a title-text thumbnail
    // instead of the clean cover. The thumbnail now runs at the END of branch B
    // (after step 08/09). Regression guard for that bug:
    expect(w.step05b).toBe(step05bNoop);
    expect(w.step05b).not.toBe(step05bAmbientVideoThumbnail);
  });

  it('ambient and rap-compilation do NOT define step05b (keep the Flow thumbnail via runner fallback)', () => {
    // Task 10: step05b is an optional slot. Only a workflow with a custom
    // thumbnail step sets it; ambient + rap must stay undefined so the
    // runner's `workflow.step05b ?? step05bThumbnail` keeps them on Flow.
    expect(getWorkflow('ambient').step05b).toBeUndefined();
    expect(getWorkflow('rap-compilation').step05b).toBeUndefined();
  });

  it('rap preflight (broll) rejects channels without brollFolderPath', async () => {
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: 'legacy', workflow: 'rap-compilation' },
      db,
    );
    const w = getWorkflow('rap-compilation');
    // requireBrollFolder is index [1] now; index [0] is requireSunoStylePromptSource.
    const brollCheck = w.preflightChecks[1];
    const result = await brollCheck({
      album: { id: 'fake' } as never,
      channel: { ...channel, brollFolderPath: null } as never,
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BROLL_FOLDER_MISSING');
    }
  });
});

describe('requireSunoStylePromptSource preflight', () => {
  it('passes when channel has ≥1 active prompt in the collection', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'a', content: 'A', active: true },
      db,
    );
    const result = await requireSunoStylePromptSource({
      album: { id: 'fake' } as never,
      channel,
      settings: {} as never,
    });
    expect(result.ok).toBe(true);
  });

  it('passes when channel has only legacy sunoStylePrompt (no collection rows)', async () => {
    const channel = channelsRepo.create(
      { ...baseChannel, active: true, sunoStylePrompt: 'legacy seed' },
      db,
    );
    // Strip any backfill that initSchema might have added.
    for (const p of sunoPromptsRepo.listByChannel(channel.id, {}, db)) {
      sunoPromptsRepo.remove(p.id, db);
    }
    const result = await requireSunoStylePromptSource({
      album: { id: 'fake' } as never,
      channel,
      settings: {} as never,
    });
    expect(result.ok).toBe(true);
  });

  it('fails with SUNO_STYLE_PROMPT_REQUIRED when no source exists', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    const result = await requireSunoStylePromptSource({
      album: { id: 'fake' } as never,
      channel,
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SUNO_STYLE_PROMPT_REQUIRED');
    }
  });

  it('fails when only inactive prompts exist and legacy is empty', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true }, db);
    sunoPromptsRepo.create(
      { channelId: channel.id, label: 'off', content: 'X', active: false },
      db,
    );
    const result = await requireSunoStylePromptSource({
      album: { id: 'fake' } as never,
      channel,
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SUNO_STYLE_PROMPT_REQUIRED');
    }
  });
});

describe('requireSourceJpg preflight', () => {
  // requireSourceJpg derives the path from process.cwd(); sandbox cwd per test
  // so we never touch the real projects/ folder.
  let prevCwd: string;
  let tmpRoot: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'amv-source-jpg-'));
    process.chdir(tmpRoot);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function channelWithId(id: string): channelsRepo.Channel {
    return {
      ...baseChannel,
      id,
      active: true,
      scheduleCron: '0 9 * * 1',
      tracksPerAlbum: null,
      targetVideoSeconds: null,
      brollFolderPath: null,
      rapClipStrategy: null,
      sunoStylePrompt: null,
      sunoModel: 'chirp-fenix',
      sunoMode: 'custom',
      sunoInstrumental: false,
      sunoPersonaId: null,
      workflow: 'ambient-video',
      promptAlbumBrief: null,
      promptTrackBriefs: null,
      promptCoverImage: null,
      promptThumbnail: null,
      promptYtMetadata: null,
      youtubeImageAspect: null,
      distrokidArtistVerifiedAt: null,
      distrokidSongwriterName: null,
      distrokidPerformerName: null,
      distrokidPerformerRole: null,
      distrokidProducerName: null,
      distrokidProducerRole: null,
      sceneThemes: null,
      seedanceMotionPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    } as channelsRepo.Channel;
  }

  it('passes when source.jpg exists and is > 50 KB', async () => {
    const ch = channelWithId('ch_ok');
    const p = sourceJpgPath(ch.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(60 * 1024, 0xab));
    const result = await requireSourceJpg({
      album: { id: 'fake' } as never,
      channel: ch,
      settings: {} as never,
    });
    expect(result.ok).toBe(true);
  });

  it('fails with SOURCE_JPG_MISSING when the file does not exist', async () => {
    const ch = channelWithId('ch_missing');
    const result = await requireSourceJpg({
      album: { id: 'fake' } as never,
      channel: ch,
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_JPG_MISSING');
      expect(result.message).toContain(sourceJpgPath(ch.id));
    }
  });

  it('fails with SOURCE_JPG_MISSING when the file is too small', async () => {
    const ch = channelWithId('ch_small');
    const p = sourceJpgPath(ch.id);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(1024, 0xab));
    const result = await requireSourceJpg({
      album: { id: 'fake' } as never,
      channel: ch,
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SOURCE_JPG_MISSING');
      expect(result.message).toContain('too small');
    }
  });

  it('fails with CHANNEL_NOT_FOUND when channel is null', async () => {
    const result = await requireSourceJpg({
      album: { id: 'fake' } as never,
      channel: null,
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('CHANNEL_NOT_FOUND');
    }
  });
});

describe('requireSceneThemesValidOrNull preflight', () => {
  function channelWith(sceneThemes: string | null): channelsRepo.Channel {
    return {
      ...baseChannel,
      id: 'ch_themes',
      active: true,
      scheduleCron: '0 9 * * 1',
      tracksPerAlbum: null,
      targetVideoSeconds: null,
      brollFolderPath: null,
      rapClipStrategy: null,
      sunoStylePrompt: null,
      sunoModel: 'chirp-fenix',
      sunoMode: 'custom',
      sunoInstrumental: false,
      sunoPersonaId: null,
      workflow: 'ambient-video',
      promptAlbumBrief: null,
      promptTrackBriefs: null,
      promptCoverImage: null,
      promptThumbnail: null,
      promptYtMetadata: null,
      youtubeImageAspect: null,
      distrokidArtistVerifiedAt: null,
      distrokidSongwriterName: null,
      distrokidPerformerName: null,
      distrokidPerformerRole: null,
      distrokidProducerName: null,
      distrokidProducerRole: null,
      sceneThemes,
      seedanceMotionPrompt: null,
      createdAt: 0,
      updatedAt: 0,
    } as channelsRepo.Channel;
  }

  it('passes when sceneThemes is null', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith(null),
      settings: {} as never,
    });
    expect(result.ok).toBe(true);
  });

  it('passes for a valid non-empty string array', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith(JSON.stringify(['knight at campfire', 'rain in forest'])),
      settings: {} as never,
    });
    expect(result.ok).toBe(true);
  });

  it('fails with SCENE_THEMES_INVALID on malformed JSON', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith('not json'),
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SCENE_THEMES_INVALID');
  });

  it('fails with SCENE_THEMES_INVALID when value is not an array', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith(JSON.stringify({ foo: 'bar' })),
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SCENE_THEMES_INVALID');
      expect(result.message).toContain('must be a JSON array');
    }
  });

  it('fails with SCENE_THEMES_INVALID on empty array', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith('[]'),
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SCENE_THEMES_INVALID');
      expect(result.message).toContain('empty array');
    }
  });

  it('fails with SCENE_THEMES_INVALID when array contains a non-string', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith(JSON.stringify(['ok', 123, 'still ok'])),
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SCENE_THEMES_INVALID');
      expect(result.message).toContain('[1]');
    }
  });

  it('fails with SCENE_THEMES_INVALID when array contains an empty string', async () => {
    const result = await requireSceneThemesValidOrNull({
      album: { id: 'fake' } as never,
      channel: channelWith(JSON.stringify(['ok', '   '])),
      settings: {} as never,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('SCENE_THEMES_INVALID');
      expect(result.message).toContain('[1]');
    }
  });
});
