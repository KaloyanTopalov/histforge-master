import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { GET as getAlbumRoute } from '@/app/api/albums/[id]/route';

let db: Db;

const baseChannel = {
  name: 'get-album-ch',
  displayName: 'Get Album',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
  active: true,
};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
});

describe('GET /api/albums/[id]', () => {
  it('happy path returns album with all fields', async () => {
    const ch = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: ch.id });
    const req = new Request(`http://localhost/api/albums/${album.id}`);
    const res = await getAlbumRoute(req, { params: { id: album.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.album.id).toBe(album.id);
    expect(body.album.videoStatus).toBe('pending');
    expect(body.album.videoProgressPct).toBe(0);
    expect(body.album.retryBranchOnly).toBeNull();
    // Phase 7: scene fields are present on the API response (default null).
    expect(body.album.sceneImagePrompt).toBeNull();
    expect(body.album.sceneSeedancePrompt).toBeNull();
    expect(body.album.sceneTitle).toBeNull();
  });

  it('surfaces populated scene fields for ambient-video albums', async () => {
    const ch = channelsRepo.create({ ...baseChannel, workflow: 'ambient-video' });
    const album = albumsRepo.create({ channelId: ch.id });
    albumsRepo.patch(album.id, {
      sceneImagePrompt: 'knight in forest, --niji 6 --ar 16:9',
      sceneSeedancePrompt: 'static camera, leaves sway, fireflies drift',
      sceneTitle: "The Knight's Quiet Forest | Medieval Fantasy Music for Peaceful Focus",
    });
    const req = new Request(`http://localhost/api/albums/${album.id}`);
    const res = await getAlbumRoute(req, { params: { id: album.id } });
    const body = await res.json();
    expect(body.album.sceneImagePrompt).toBe('knight in forest, --niji 6 --ar 16:9');
    expect(body.album.sceneSeedancePrompt).toBe('static camera, leaves sway, fireflies drift');
    expect(body.album.sceneTitle).toBe(
      "The Knight's Quiet Forest | Medieval Fantasy Music for Peaceful Focus",
    );
  });

  it('404 when album does not exist', async () => {
    const req = new Request('http://localhost/api/albums/missing');
    const res = await getAlbumRoute(req, { params: { id: 'missing' } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ALBUM_NOT_FOUND');
  });
});
