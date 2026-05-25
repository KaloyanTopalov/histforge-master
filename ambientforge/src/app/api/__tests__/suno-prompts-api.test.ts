import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import {
  GET as listPrompts,
  POST as createPromptRoute,
} from '@/app/api/channels/[id]/suno-prompts/route';
import {
  PATCH as patchPromptRoute,
  DELETE as deletePromptRoute,
} from '@/app/api/channels/[id]/suno-prompts/[promptId]/route';

let db: Db;

const baseChannel = {
  name: 'sp-api-test',
  displayName: 'SP API Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'SP Artist',
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
  db.close();
});

function jsonReq(url: string, method: string, body?: unknown): Request {
  return new Request(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe('GET /api/channels/:id/suno-prompts', () => {
  it('returns empty list for a fresh channel', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const res = await listPrompts(
      jsonReq(`http://localhost/api/channels/${channel.id}/suno-prompts`, 'GET'),
      { params: { id: channel.id } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.prompts).toEqual([]);
  });

  it('returns prompts ordered by createdAt asc with usage counts', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const a = sunoPromptsRepo.create({
      channelId: channel.id,
      label: 'a',
      content: 'A',
    });
    sunoPromptsRepo.create({
      channelId: channel.id,
      label: 'b',
      content: 'B',
    });
    // Reference 'a' from one album.
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, { sunoPromptId: a.id });

    const res = await listPrompts(
      jsonReq(`http://localhost/api/channels/${channel.id}/suno-prompts`, 'GET'),
      { params: { id: channel.id } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.prompts).toHaveLength(2);
    expect(json.prompts[0].label).toBe('a');
    expect(json.prompts[0].albumsUsing).toBe(1);
    expect(json.prompts[1].albumsUsing).toBe(0);
  });

  it('404s when channel does not exist', async () => {
    const res = await listPrompts(
      jsonReq('http://localhost/api/channels/01ZZZZ/suno-prompts', 'GET'),
      { params: { id: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' } },
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/channels/:id/suno-prompts', () => {
  it('creates a prompt with valid body', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const res = await createPromptRoute(
      jsonReq(`http://localhost/api/channels/${channel.id}/suno-prompts`, 'POST', {
        label: 'p1',
        content: 'foo bar',
      }),
      { params: { id: channel.id } },
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.prompt.label).toBe('p1');
    expect(json.prompt.content).toBe('foo bar');
    expect(json.prompt.weight).toBe(1.0);
    expect(json.prompt.active).toBe(true);
  });

  it('400s on invalid body (missing content)', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const res = await createPromptRoute(
      jsonReq(`http://localhost/api/channels/${channel.id}/suno-prompts`, 'POST', {
        label: 'p1',
      }),
      { params: { id: channel.id } },
    );
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/channels/:id/suno-prompts/:promptId', () => {
  it('updates label and active flag', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const p = sunoPromptsRepo.create({
      channelId: channel.id,
      label: 'orig',
      content: 'X',
    });
    const res = await patchPromptRoute(
      jsonReq(
        `http://localhost/api/channels/${channel.id}/suno-prompts/${p.id}`,
        'PATCH',
        { label: 'renamed', active: false },
      ),
      { params: { id: channel.id, promptId: p.id } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.prompt.label).toBe('renamed');
    expect(json.prompt.active).toBe(false);
  });

  it('404s when prompt belongs to a different channel', async () => {
    const c1 = channelsRepo.create({ ...baseChannel, active: true });
    const c2 = channelsRepo.create({
      ...baseChannel,
      name: 'sp-api-test-2',
      active: true,
    });
    const p = sunoPromptsRepo.create({
      channelId: c1.id,
      label: 'cross',
      content: 'X',
    });
    const res = await patchPromptRoute(
      jsonReq(
        `http://localhost/api/channels/${c2.id}/suno-prompts/${p.id}`,
        'PATCH',
        { label: 'attempt' },
      ),
      { params: { id: c2.id, promptId: p.id } },
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/channels/:id/suno-prompts/:promptId', () => {
  it('deletes a prompt and nulls FK on referencing albums but keeps resolved_text', async () => {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    const p = sunoPromptsRepo.create({
      channelId: channel.id,
      label: 'doomed',
      content: 'snap-val',
    });
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, {
      sunoPromptId: p.id,
      sunoPromptResolvedText: 'snap-val',
    });

    const res = await deletePromptRoute(
      jsonReq(
        `http://localhost/api/channels/${channel.id}/suno-prompts/${p.id}`,
        'DELETE',
      ),
      { params: { id: channel.id, promptId: p.id } },
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);

    const after = albumsRepo.get(album.id)!;
    expect(after.sunoPromptId).toBe(null);
    expect(after.sunoPromptResolvedText).toBe('snap-val');
  });
});
