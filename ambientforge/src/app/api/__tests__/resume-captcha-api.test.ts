import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting, getRawSetting } from '@/lib/settings';
import { POST as resumeCaptchaRoute } from '@/app/api/albums/[id]/resume-captcha/route';

let db: Db;

const baseChannel = {
  name: 'resume-captcha-ch',
  displayName: 'Resume Captcha',
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

function makeReq(albumId: string): Request {
  return new Request(`http://localhost/api/albums/${albumId}/resume-captcha`, {
    method: 'POST',
  });
}

describe('POST /api/albums/[id]/resume-captcha', () => {
  it('happy path: awaiting_captcha → queued, clears flag', async () => {
    const channel = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { status: 'awaiting_captcha' });
    setSetting('distrokid_captcha_pending', JSON.stringify({ albumId: album.id }));

    const res = await resumeCaptchaRoute(makeReq(album.id), { params: { id: album.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.album.status).toBe('queued');

    const after = albumsRepo.get(album.id);
    expect(after?.status).toBe('queued');
    expect(getRawSetting('distrokid_captcha_pending')).toBe('');
  });

  it('409 NOT_AWAITING_CAPTCHA when album status is not awaiting_captcha', async () => {
    const channel = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: channel.id });
    // Default status from create() is 'queued'.

    const res = await resumeCaptchaRoute(makeReq(album.id), { params: { id: album.id } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('NOT_AWAITING_CAPTCHA');
  });

  it('404 when album does not exist', async () => {
    const res = await resumeCaptchaRoute(makeReq('nope'), { params: { id: 'nope' } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('ALBUM_NOT_FOUND');
  });
});
