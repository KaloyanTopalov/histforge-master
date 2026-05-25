import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveChannelPrompt } from '@/lib/prompts';
import type { Channel } from '@/lib/repos/channels';

const CHANNEL_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-resolve-prompt-'));
  fs.mkdirSync(path.join(tmpRoot, 'defaults'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'channel-templates', CHANNEL_ID), {
    recursive: true,
  });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function fakeChannel(overrides: Partial<Channel> = {}): Channel {
  return {
    id: CHANNEL_ID,
    name: 'fake',
    displayName: 'Fake',
    description: '',
    active: true,
    scheduleCron: '0 9 * * 1',
    albumBriefTemplate: null,
    trackBriefsTemplate: null,
    coverPromptTemplate: null,
    thumbnailPromptTemplate: null,
    ytMetadataTemplate: null,
    distrokidArtistName: 'X',
    distrokidPrimaryGenre: 'Ambient',
    distrokidLabelName: null,
    youtubeChannelId: null,
    youtubeChannelHandle: null,
    thumbnailOverlayText: null,
    spotifyPlaylistUrl: null,
    hashtags: '',
    distrokidArtistVerifiedAt: null,
    sunoModel: 'chirp-fenix',
    sunoMode: 'custom',
    sunoInstrumental: false,
    sunoPersonaId: null,
    sunoDualVariant: false,
    workflow: 'ambient',
    tracksPerAlbum: null,
    targetVideoSeconds: null,
    brollFolderPath: null,
    sunoStylePrompt: null,
    promptAlbumBrief: null,
    promptTrackBriefs: null,
    promptCoverImage: null,
    promptThumbnail: null,
    promptYtMetadata: null,
    youtubeImageAspect: null,
    distrokidSongwriterName: null,
    distrokidPerformerName: null,
    distrokidPerformerRole: null,
    distrokidProducerName: null,
    distrokidProducerRole: null,
    rapClipStrategy: null,
    sceneThemes: null,
    seedanceMotionPrompt: null,
    imageStyleName: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('resolveChannelPrompt', () => {
  it('uses channel-db content when promptAlbumBrief is set', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'DEFAULT');
    const ch = fakeChannel({ promptAlbumBrief: 'CHANNEL DB CONTENT' });
    const r = resolveChannelPrompt(ch, 'album-brief', tmpRoot);
    expect(r.source).toBe('channel-db');
    expect(r.content).toBe('CHANNEL DB CONTENT');
    expect(r.kind).toBe('album-brief');
  });

  it('falls through to channel-file when DB column is null but file exists', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'DEFAULT');
    fs.writeFileSync(
      path.join(tmpRoot, 'channel-templates', CHANNEL_ID, 'album-brief.md'),
      'FILE OVERRIDE',
    );
    const ch = fakeChannel();
    const r = resolveChannelPrompt(ch, 'album-brief', tmpRoot);
    expect(r.source).toBe('channel-file');
    expect(r.content).toBe('FILE OVERRIDE');
  });

  it('falls through to workflow-default when both DB and file are missing', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'AMBIENT DEFAULT');
    const ch = fakeChannel();
    const r = resolveChannelPrompt(ch, 'album-brief', tmpRoot);
    expect(r.source).toBe('workflow-default');
    expect(r.content).toBe('AMBIENT DEFAULT');
  });

  it('rap-compilation kind=cover-image resolves to cover-image-rap.md default', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'cover-prompt.md'), 'AMBIENT COVER');
    fs.writeFileSync(
      path.join(tmpRoot, 'defaults', 'cover-image-rap.md'),
      'RAP COVER',
    );
    const ch = fakeChannel({ workflow: 'rap-compilation' });
    const r = resolveChannelPrompt(ch, 'cover-image', tmpRoot);
    expect(r.source).toBe('workflow-default');
    expect(r.content).toBe('RAP COVER');
  });

  it('ambient kind=cover-image resolves to legacy cover-prompt.md (not cover-image.md)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'cover-prompt.md'), 'AMBIENT COVER');
    const ch = fakeChannel();
    const r = resolveChannelPrompt(ch, 'cover-image', tmpRoot);
    expect(r.source).toBe('workflow-default');
    expect(r.content).toBe('AMBIENT COVER');
  });

  it('empty channel-db string is treated as null (falls through)', () => {
    fs.writeFileSync(path.join(tmpRoot, 'defaults', 'album-brief.md'), 'DEFAULT');
    const ch = fakeChannel({ promptAlbumBrief: '   ' });
    const r = resolveChannelPrompt(ch, 'album-brief', tmpRoot);
    expect(r.source).toBe('workflow-default');
  });
});
