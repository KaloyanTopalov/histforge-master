import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import * as promptsModule from '@/lib/prompts';
import * as openrouterModule from '@/lib/llm/openrouter';
import { setSetting } from '@/lib/settings';
import { step02TrackBriefs } from '@/worker/steps/02-track-briefs';

let db: Db;

const baseChannel = {
  name: 'step02-test-ambient',
  displayName: 'Step02 Ambient',
  description: 'ambient',
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
  hashtags: '',
};

function tracksFixture(count: number) {
  return {
    tracks: Array.from({ length: count }, (_, i) => ({
      trackNumber: i + 1,
      title: `Drift ${i + 1}`,
      lyrics: '',
    })),
  };
}

const FIXTURE_TEMPLATE = `<!-- mock-response: ${JSON.stringify(tracksFixture(30))} -->\n\nFake track-briefs body for {{album.albumTitle}}.`;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  setSetting('openrouter_api_key', 'mock', db);
  vi.restoreAllMocks();
  // Step 02 calls resolveChannelPrompt which prefers channel.promptTrackBriefs
  // (DB content) when set. setupChannelAndAlbum below sets it to FIXTURE_TEMPLATE
  // so the test's specific 30-track-with-"Drift N"-titles fixture wins over the
  // real prompts/defaults/track-briefs.md (which uses "Drift One/Two/..." titles).
  void promptsModule;
});

afterEach(() => {
  __setDbForTests(null);
  vi.restoreAllMocks();
});

const noopLog = (_stage: string, _msg: string) => {};

function setupChannelAndAlbum() {
  const channel = channelsRepo.create({
    ...baseChannel,
    active: true,
    // Inject test fixture via the channel-db prompt path so step 02's
    // resolveChannelPrompt picks it up first.
    promptTrackBriefs: FIXTURE_TEMPLATE,
  });
  const album = albumsRepo.create({ channelId: channel.id });
  // step02 reads album.albumTitle for the rendered template — make it non-empty so step02 doesn't fail in render.
  albumsRepo.patch(album.id, {
    albumTitle: 'Test Album',
    sunoStylePrompt: 'test style',
    primaryGenre: 'Ambient',
  });
  return { channel, album: albumsRepo.get(album.id)! };
}

describe('step02TrackBriefs', () => {
  it('inserts 30 tracks with NN - Title.wav filenames', async () => {
    const { album } = setupChannelAndAlbum();
    await step02TrackBriefs(album, noopLog);
    const tracks = tracksRepo.listByAlbum(album.id);
    expect(tracks).toHaveLength(30);
    expect(tracks[0].trackNumber).toBe(1);
    expect(tracks[0].fileName).toBe('01 - Drift 1.wav');
    expect(tracks[29].trackNumber).toBe(30);
    expect(tracks[29].fileName).toBe('30 - Drift 30.wav');
  });

  it('is a no-op when 30 tracks already exist', async () => {
    const { album } = setupChannelAndAlbum();
    await step02TrackBriefs(album, noopLog);
    // After the first run inserts 30 tracks, the second run should noop
    // before the prompt loader runs at all. Spy on resolveChannelPrompt to
    // verify.
    const resolveSpy = vi.spyOn(promptsModule, 'resolveChannelPrompt');
    await step02TrackBriefs(album, noopLog);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(tracksRepo.listByAlbum(album.id)).toHaveLength(30);
  });

  it('clears partial state when existing track count is between 1 and 29', async () => {
    const { album } = setupChannelAndAlbum();
    // simulate a crashed previous run that left 12 tracks behind
    tracksRepo.insertMany(
      Array.from({ length: 12 }, (_, i) => ({
        albumId: album.id,
        trackNumber: i + 1,
        title: `Old ${i + 1}`,
        fileName: `${String(i + 1).padStart(2, '0')} - Old ${i + 1}.wav`,
        sunoLyrics: null,
      })),
    );
    expect(tracksRepo.listByAlbum(album.id)).toHaveLength(12);

    await step02TrackBriefs(album, noopLog);

    const after = tracksRepo.listByAlbum(album.id);
    expect(after).toHaveLength(30);
    // confirm new tracks (titles different from "Old N")
    expect(after[0].title).toBe('Drift 1');
  });

  it('retries once on count-mismatch and succeeds on retry (28 -> 30)', async () => {
    const { album } = setupChannelAndAlbum();
    const spy = vi
      .spyOn(openrouterModule, 'chatCompletionJSON')
      .mockRejectedValueOnce(
        new openrouterModule.OpenRouterError(
          'OPENROUTER_MALFORMED_JSON',
          'simulated 28-entry response',
          false,
        ),
      )
      .mockResolvedValueOnce(tracksFixture(30) as unknown as never);

    await step02TrackBriefs(album, noopLog);

    expect(spy).toHaveBeenCalledTimes(2);
    expect(tracksRepo.listByAlbum(album.id)).toHaveLength(30);
  });

  it('throws INVALID_TRACK_COUNT after both attempts return wrong count', async () => {
    const { album } = setupChannelAndAlbum();
    vi.spyOn(openrouterModule, 'chatCompletionJSON').mockRejectedValue(
      new openrouterModule.OpenRouterError(
        'OPENROUTER_MALFORMED_JSON',
        'simulated 28-entry response',
        false,
      ),
    );

    await expect(step02TrackBriefs(album, noopLog)).rejects.toMatchObject({
      code: 'INVALID_TRACK_COUNT',
    });
    expect(tracksRepo.listByAlbum(album.id)).toHaveLength(0);
  });
});
