import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import { POST as createChannel } from '@/app/api/channels/route';
import { PATCH as patchChannelRoute } from '@/app/api/channels/[id]/route';
import * as channelsRepo from '@/lib/repos/channels';

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

const baseValidBody = {
  name: 'amv-api-test',
  displayName: 'AMV API Test',
  description: 'medieval ambient',
  scheduleCron: '0 9 * * 1',
  distrokidArtistName: 'AMV API',
  distrokidPrimaryGenre: 'Ambient',
  workflow: 'ambient-video' as const,
  sunoStylePrompt: 'gentle medieval ambient with strings',
};

/** Repo-direct fixture used by the PATCH tests — channelsRepo.create requires
 *  the full ChannelInput shape (Zod defaults aren't applied). */
const baseRepoBody = {
  ...baseValidBody,
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchReq(body: unknown): Request {
  return new Request('http://localhost/api/channels/x', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/channels — ambient-video sceneThemes validation', () => {
  it('accepts a null sceneThemes (channel uses default fallback theme)', async () => {
    const res = await createChannel(postReq({ ...baseValidBody, sceneThemes: null }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channel: { sceneThemes: string | null } };
    expect(json.channel.sceneThemes).toBeNull();
  });

  it('accepts a valid JSON array of theme strings', async () => {
    const themes = JSON.stringify([
      'knight by campfire at night',
      'knight resting by river at dusk',
    ]);
    const res = await createChannel(postReq({ ...baseValidBody, sceneThemes: themes }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channel: { sceneThemes: string | null } };
    expect(json.channel.sceneThemes).toBe(themes);
  });

  it('rejects malformed JSON with SCENE_THEMES_INVALID', async () => {
    const res = await createChannel(postReq({ ...baseValidBody, sceneThemes: 'not json' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('SCENE_THEMES_INVALID');
  });

  it('rejects non-array JSON with SCENE_THEMES_INVALID', async () => {
    const res = await createChannel(
      postReq({ ...baseValidBody, sceneThemes: JSON.stringify({ foo: 'bar' }) }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_THEMES_INVALID',
    );
  });

  it('rejects empty array with SCENE_THEMES_INVALID', async () => {
    const res = await createChannel(postReq({ ...baseValidBody, sceneThemes: '[]' }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_THEMES_INVALID',
    );
  });

  it('rejects array with empty-string entry with SCENE_THEMES_INVALID', async () => {
    const res = await createChannel(
      postReq({
        ...baseValidBody,
        sceneThemes: JSON.stringify(['ok', '  ', 'still ok']),
      }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_THEMES_INVALID',
    );
  });

  it('skips sceneThemes validation when workflow is NOT ambient-video', async () => {
    // Even malformed JSON is accepted when the workflow is ambient — the
    // column is a free-text passthrough for non-ambient-video workflows.
    const res = await createChannel(
      postReq({ ...baseValidBody, workflow: 'ambient', sceneThemes: 'not json at all' }),
    );
    expect(res.status).toBe(200);
  });

  it('persists seedanceMotionPrompt', async () => {
    const res = await createChannel(
      postReq({
        ...baseValidBody,
        seedanceMotionPrompt: 'gentle flickering flames, drifting embers',
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { channel: { seedanceMotionPrompt: string | null } };
    expect(json.channel.seedanceMotionPrompt).toBe('gentle flickering flames, drifting embers');
  });
});

describe('PATCH /api/channels/[id] — sceneThemes cross-field validation', () => {
  it('rejects a PATCH that adds malformed sceneThemes when workflow stays ambient-video', async () => {
    const channel = channelsRepo.create({
      ...baseRepoBody,
      active: true,
    });
    const res = await patchChannelRoute(patchReq({ sceneThemes: 'not json' }), {
      params: { id: channel.id },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_THEMES_INVALID',
    );
  });

  it('rejects a PATCH that flips workflow to ambient-video while existing sceneThemes is invalid', async () => {
    // Create as ambient with junk in sceneThemes (passes because workflow != ambient-video).
    const channel = channelsRepo.create({
      ...baseRepoBody,
      workflow: 'ambient',
      active: true,
      sceneThemes: 'not json',
    });
    // Now flip workflow to ambient-video — the cross-field check should see
    // the existing (invalid) sceneThemes and reject.
    const res = await patchChannelRoute(patchReq({ workflow: 'ambient-video' }), {
      params: { id: channel.id },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'SCENE_THEMES_INVALID',
    );
  });

  it('accepts PATCH that clears sceneThemes back to null', async () => {
    const channel = channelsRepo.create({
      ...baseRepoBody,
      active: true,
      sceneThemes: JSON.stringify(['initial theme']),
    });
    const res = await patchChannelRoute(patchReq({ sceneThemes: null }), {
      params: { id: channel.id },
    });
    expect(res.status).toBe(200);
    const after = channelsRepo.get(channel.id)!;
    expect(after.sceneThemes).toBeNull();
  });
});
