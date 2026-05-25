import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import { __resetMockDistrokidState } from '@/lib/distrokid/client';
import { POST as verifyArtistRoute } from '@/app/api/channels/[id]/verify-distrokid-artist/route';

let db: Db;
let prevMode: string | undefined;

const baseChannel = {
  name: 'verify-test-ch',
  displayName: 'Verify Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Verify Artist',
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
  __resetMockDistrokidState();
  prevMode = process.env.DISTROKID_MODE;
  process.env.DISTROKID_MODE = 'mock';
});

afterEach(() => {
  __setDbForTests(null);
  __resetMockDistrokidState();
  if (prevMode === undefined) {
    delete process.env.DISTROKID_MODE;
  } else {
    process.env.DISTROKID_MODE = prevMode;
  }
  db.close();
});

function makeReq(channelId: string): Request {
  return new Request(`http://localhost/api/channels/${channelId}/verify-distrokid-artist`, {
    method: 'POST',
  });
}

describe('POST /api/channels/[id]/verify-distrokid-artist', () => {
  it('happy path: returns found:true and updates distrokidArtistVerifiedAt', async () => {
    const channel = channelsRepo.create(baseChannel);
    const before = channel.distrokidArtistVerifiedAt;
    expect(before).toBeNull();

    const res = await verifyArtistRoute(makeReq(channel.id), { params: { id: channel.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(true);
    expect(typeof body.verifiedAt).toBe('number');

    const after = channelsRepo.get(channel.id);
    expect(after?.distrokidArtistVerifiedAt).toBe(body.verifiedAt);
  });

  it('not found: returns found:false (200), does NOT update verified timestamp', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      name: 'verify-test-not-found',
      distrokidArtistName: 'Nonexistent Test Artist',
    });

    const res = await verifyArtistRoute(makeReq(channel.id), { params: { id: channel.id } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.found).toBe(false);

    const after = channelsRepo.get(channel.id);
    expect(after?.distrokidArtistVerifiedAt).toBeNull();
  });

  it('404 when channel does not exist', async () => {
    const res = await verifyArtistRoute(makeReq('nope'), { params: { id: 'nope' } });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('400 NO_ARTIST_CONFIGURED when distrokidArtistName is empty', async () => {
    const channel = channelsRepo.create({
      ...baseChannel,
      name: 'verify-test-empty-artist',
      distrokidArtistName: '',
    });
    const res = await verifyArtistRoute(makeReq(channel.id), { params: { id: channel.id } });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe('NO_ARTIST_CONFIGURED');
  });
});
