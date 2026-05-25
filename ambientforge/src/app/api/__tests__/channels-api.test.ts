import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { GET as listChannels, POST as createChannel } from '@/app/api/channels/route';
import {
  GET as getChannelDetail,
  PATCH as patchChannelRoute,
} from '@/app/api/channels/[id]/route';

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

const validBody = {
  name: 'sad-ambient',
  displayName: "i'm crying",
  description: 'Niche test',
  scheduleCron: '0 9 * * 1',
  distrokidArtistName: 'Songs For Cry',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelHandle: '@songsforcry',
  spotifyPlaylistUrl: null,
  hashtags: 'ambient,sleep',
  thumbnailOverlayText: null,
};

// Repo-level inputs need every nullable template field explicit; the API schema
// fills them in via Zod defaults, but channelsRepo.create takes the full shape.
const repoInput = {
  ...validBody,
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  youtubeChannelId: null,
};

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('POST /api/channels', () => {
  it('creates a channel with valid input', async () => {
    const res = await createChannel(jsonReq('http://localhost/api/channels', 'POST', validBody));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.channel.name).toBe('sad-ambient');
    expect(json.channel.id).toHaveLength(26);
    expect(json.channel.youtubeChannelId).toBeNull();
  });

  it('rejects invalid cron with INVALID_CRON', async () => {
    const res = await createChannel(
      jsonReq('http://localhost/api/channels', 'POST', {
        ...validBody,
        scheduleCron: 'not-a-cron',
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_CRON');
  });

  it('rejects duplicate name with CHANNEL_NAME_TAKEN', async () => {
    const ok = await createChannel(jsonReq('http://localhost/api/channels', 'POST', validBody));
    expect(ok.status).toBe(200);
    const dup = await createChannel(jsonReq('http://localhost/api/channels', 'POST', validBody));
    expect(dup.status).toBe(409);
    const json = await dup.json();
    expect(json.error.code).toBe('CHANNEL_NAME_TAKEN');
  });

  it('rejects bad body with INVALID_BODY', async () => {
    const res = await createChannel(
      jsonReq('http://localhost/api/channels', 'POST', { name: 'x' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_BODY');
  });
});

describe('GET /api/channels', () => {
  it('returns counts and the channel list', async () => {
    channelsRepo.create(repoInput, db);
    const res = await listChannels();
    const json = await res.json();
    expect(json.counts.active).toBe(1);
    expect(json.counts.inactive).toBe(0);
    expect(json.channels).toHaveLength(1);
  });
});

describe('GET /api/channels/[id]', () => {
  it('returns 404 when missing', async () => {
    const res = await getChannelDetail(new Request('http://localhost'), {
      params: { id: 'Z'.repeat(26) },
    });
    expect(res.status).toBe(404);
  });

  it('returns channel + albums when present', async () => {
    const ch = channelsRepo.create(repoInput, db);
    albumsRepo.create({ channelId: ch.id }, db);
    const res = await getChannelDetail(new Request('http://localhost'), {
      params: { id: ch.id },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.channel.id).toBe(ch.id);
    expect(json.albums).toHaveLength(1);
    expect(json.nextScheduledAt).toBeNull();
  });
});

describe('PATCH /api/channels/[id]', () => {
  it('updates fields', async () => {
    const ch = channelsRepo.create(repoInput, db);
    const res = await patchChannelRoute(
      jsonReq(`http://localhost/api/channels/${ch.id}`, 'PATCH', { displayName: 'sobbing' }),
      { params: { id: ch.id } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.channel.displayName).toBe('sobbing');
  });

  it('returns 409 CHANNEL_LOCKED_DURING_RUN while an album is in_progress', async () => {
    const ch = channelsRepo.create(repoInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(a.id, { status: 'in_progress' }, db);
    const res = await patchChannelRoute(
      jsonReq(`http://localhost/api/channels/${ch.id}`, 'PATCH', { displayName: 'x' }),
      { params: { id: ch.id } },
    );
    expect(res.status).toBe(409);
    const json = await res.json();
    expect(json.error.code).toBe('CHANNEL_LOCKED_DURING_RUN');
  });

  it('returns 400 INVALID_CRON for bad scheduleCron', async () => {
    const ch = channelsRepo.create(repoInput, db);
    const res = await patchChannelRoute(
      jsonReq(`http://localhost/api/channels/${ch.id}`, 'PATCH', { scheduleCron: 'nope' }),
      { params: { id: ch.id } },
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_CRON');
  });

  it('returns 404 for unknown channel', async () => {
    const res = await patchChannelRoute(
      jsonReq(`http://localhost/api/channels/missing`, 'PATCH', { displayName: 'x' }),
      { params: { id: 'Z'.repeat(26) } },
    );
    expect(res.status).toBe(404);
  });
});
