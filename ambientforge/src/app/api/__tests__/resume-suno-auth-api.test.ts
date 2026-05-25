import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting, getRawSetting } from '@/lib/settings';
import { POST as resumeSunoAuth } from '@/app/api/albums/[id]/resume-suno-auth/route';

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
  name: 'resume-suno-ch',
  displayName: 'Resume Suno',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Resume Suno Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function postReq(id: string): Request {
  return new Request(`http://localhost/api/albums/${id}/resume-suno-auth`, {
    method: 'POST',
  });
}

describe('POST /api/albums/[id]/resume-suno-auth', () => {
  it('returns 200 and patches awaiting_suno_relogin → queued, clearing flag', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(album.id, { status: 'awaiting_suno_relogin' }, db);
    setSetting(
      'suno_cookie_rotated',
      JSON.stringify({ albumId: album.id, channelId: ch.id, at: Date.now() }),
      db,
    );
    const res = await resumeSunoAuth(postReq(album.id), { params: { id: album.id } });
    expect(res.status).toBe(200);
    expect(albumsRepo.get(album.id, db)?.status).toBe('queued');
    expect(getRawSetting('suno_cookie_rotated', db)).toBe('');
  });

  it('returns 409 NOT_AWAITING_SUNO_RELOGIN when album is in another state', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    // Album is queued, not awaiting_suno_relogin.
    const res = await resumeSunoAuth(postReq(album.id), { params: { id: album.id } });
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('NOT_AWAITING_SUNO_RELOGIN');
  });

  it('returns 404 ALBUM_NOT_FOUND for unknown id', async () => {
    const res = await resumeSunoAuth(postReq('Z'.repeat(26)), {
      params: { id: 'Z'.repeat(26) },
    });
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('ALBUM_NOT_FOUND');
  });

  it('clears both suno_cookie_rotated AND suno_bridge_disrupted on resume', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(album.id, { status: 'awaiting_suno_relogin' }, db);
    setSetting(
      'suno_bridge_disrupted',
      JSON.stringify({
        albumId: album.id,
        channelId: ch.id,
        code: 'SIDECAR_INTERNAL',
        detail: 'port 9333 unreachable',
        at: Date.now(),
      }),
      db,
    );
    const res = await resumeSunoAuth(postReq(album.id), { params: { id: album.id } });
    expect(res.status).toBe(200);
    expect(albumsRepo.get(album.id, db)?.status).toBe('queued');
    expect(getRawSetting('suno_bridge_disrupted', db)).toBe('');
    expect(getRawSetting('suno_cookie_rotated', db)).toBe('');
  });
});
