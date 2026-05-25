import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { POST as createAlbum } from '@/app/api/albums/route';
import { PATCH as patchAlbumRoute } from '@/app/api/albums/[id]/route';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
});

const channelInput = {
  name: 'album-api-ch',
  displayName: 'Album API',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Album API Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/albums', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/albums', () => {
  it('creates a queued album with artistName copied from channel', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const res = await createAlbum(jsonReq({ channelId: ch.id }));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.album.status).toBe('queued');
    expect(json.album.channelId).toBe(ch.id);
    expect(json.album.artistName).toBe('Album API Artist');
    expect(json.album.themePrompt).toBeNull();
  });

  it('passes themePrompt through when provided', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const res = await createAlbum(
      jsonReq({ channelId: ch.id, themePrompt: 'rainy night' }),
    );
    const json = await res.json();
    expect(json.album.themePrompt).toBe('rainy night');
  });

  it('returns 404 for missing channel', async () => {
    const res = await createAlbum(jsonReq({ channelId: 'Z'.repeat(26) }));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('returns 409 CHANNEL_INACTIVE for inactive channels', async () => {
    const ch = channelsRepo.create(channelInput, db);
    channelsRepo.softDelete(ch.id, db);
    const res = await createAlbum(jsonReq({ channelId: ch.id }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('CHANNEL_INACTIVE');
  });

  it('returns 409 ALREADY_QUEUED_OR_RUNNING when an open album exists', async () => {
    const ch = channelsRepo.create(channelInput, db);
    albumsRepo.create({ channelId: ch.id }, db);
    const res = await createAlbum(jsonReq({ channelId: ch.id }));
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('ALREADY_QUEUED_OR_RUNNING');
  });

  it('returns 400 INVALID_BODY when channelId is missing', async () => {
    const res = await createAlbum(jsonReq({}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_BODY');
  });
});

describe('PATCH /api/albums/[id] — Content-ID hold gate (C3)', () => {
  function patchReq(id: string, body: unknown): Request {
    return new Request(`http://localhost/api/albums/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('returns 409 UPLOAD_HOLD_ACTIVE when hold is still in the future', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    const futureMs = Date.now() + 86_400_000;
    albumsRepo.patch(album.id, { safeToUploadAfter: futureMs }, db);
    const res = await patchAlbumRoute(
      patchReq(album.id, {
        youtubeVideoId: 'dQw4w9WgXcQ',
        uploadedAt: Date.now(),
      }),
      { params: { id: album.id } },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('UPLOAD_HOLD_ACTIVE');
    expect(json.error.details?.safeAfter).toBe(futureMs);
    // Album row must NOT have been mutated.
    expect(albumsRepo.get(album.id, db)?.youtubeVideoId).toBeNull();
  });

  it('returns 200 when hold has just expired', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(album.id, { safeToUploadAfter: Date.now() - 1 }, db);
    const res = await patchAlbumRoute(
      patchReq(album.id, {
        youtubeVideoId: 'dQw4w9WgXcQ',
        uploadedAt: Date.now(),
      }),
      { params: { id: album.id } },
    );
    expect(res.status).toBe(200);
    expect(albumsRepo.get(album.id, db)?.youtubeVideoId).toBe('dQw4w9WgXcQ');
  });

  it('returns 200 when safeToUploadAfter is null (test mode / hold disabled)', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    expect(albumsRepo.get(album.id, db)?.safeToUploadAfter).toBeNull();
    const res = await patchAlbumRoute(
      patchReq(album.id, {
        youtubeVideoId: 'dQw4w9WgXcQ',
        uploadedAt: Date.now(),
      }),
      { params: { id: album.id } },
    );
    expect(res.status).toBe(200);
  });
});
