import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as promptsModule from '@/lib/prompts';
import { setSetting } from '@/lib/settings';
import { step01AlbumBrief } from '@/worker/steps/01-album-brief';

let db: Db;

const baseChannel = {
  name: 'step01-test-ambient',
  displayName: 'Step01 Ambient',
  description: 'ambient sleep music for tests',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'AmbientForge Test',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: 'ambient,test',
};

// Session 12: step 01 no longer generates sunoStylePrompt (step 03 owns it
// via selectSunoPromptForAlbum). The mock-response only carries albumTitle +
// primaryGenre now. Zod ignores extra keys by default.
const FAKE_TEMPLATE = `<!-- mock-response: {"albumTitle":"Mock Drift","primaryGenre":"Ambient"} -->\n\nFake template body referencing {{channel.displayName}}.`;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  setSetting('openrouter_api_key', 'mock', db);
  vi.restoreAllMocks();
  vi.spyOn(promptsModule, 'loadTemplate').mockReturnValue({
    content: FAKE_TEMPLATE,
    path: 'prompts/defaults/album-brief.md',
    source: 'default',
  });
});

afterEach(() => {
  __setDbForTests(null);
  vi.restoreAllMocks();
});

const noopLog = (_stage: string, _msg: string) => {};

describe('step01AlbumBrief', () => {
  it('patches the album with parsed JSON and copies channel.distrokidArtistName -> album.artistName', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const album = albumsRepo.create({ channelId: channel.id });
    // wipe the artist_name so we can prove step01 set it (album.create already copies it from channel)
    albumsRepo.patch(album.id, { artistName: '' });

    await step01AlbumBrief(albumsRepo.get(album.id)!, noopLog);

    const updated = albumsRepo.get(album.id)!;
    expect(updated.albumTitle.length).toBeGreaterThan(0);
    expect(updated.primaryGenre.length).toBeGreaterThan(0);
    expect(updated.artistName).toBe('AmbientForge Test');
    // Session 12: step 01 no longer writes sunoStylePrompt — step 03 owns it
    // via selectSunoPromptForAlbum. The album row's column stays at its
    // creation default (empty string) until step 03 runs.
    expect(updated.sunoStylePrompt).toBe('');
  });

  it('is a no-op when album is already fully populated', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, {
      albumTitle: 'Pre-existing',
      artistName: 'AmbientForge Test',
      primaryGenre: 'Ambient',
    });
    const loadSpy = promptsModule.loadTemplate as unknown as ReturnType<typeof vi.fn>;
    loadSpy.mockClear();

    await step01AlbumBrief(albumsRepo.get(album.id)!, noopLog);

    expect(loadSpy).not.toHaveBeenCalled();
    const after = albumsRepo.get(album.id)!;
    expect(after.albumTitle).toBe('Pre-existing'); // unchanged
  });

  it('throws when channel is missing', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const album = albumsRepo.create({ channelId: channel.id });
    // simulate channel disappearing (FK is enforced for inserts but get can return null if id swapped)
    const ghost = { ...album, channelId: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' };
    await expect(step01AlbumBrief(ghost, noopLog)).rejects.toMatchObject({
      code: 'CHANNEL_NOT_FOUND',
    });
  });
});
