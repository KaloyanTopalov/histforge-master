import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import { setSetting } from '@/lib/settings';
import { POST as previewPrompt } from '@/app/api/channels/preview-prompt/route';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  setSetting('openrouter_api_key', 'mock', db);
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
});

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/channels/preview-prompt', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const ALBUM_BRIEF_PROMPT = `<!-- mock-response: {"albumTitle":"Preview","sunoStylePrompt":"slow ambient drift","primaryGenre":"Ambient"} -->\n\nWrite an album brief for {{channel.displayName}}.`;

describe('POST /api/channels/preview-prompt', () => {
  it('returns mock response for album-brief in mock mode', async () => {
    const res = await previewPrompt(
      jsonReq({
        kind: 'album-brief',
        prompt: ALBUM_BRIEF_PROMPT,
        channelDraft: { displayName: 'Test Channel' },
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe('mock');
    expect(json.parsedOk).toBe(true);
    expect(json.mockResponse).toMatchObject({
      albumTitle: 'Preview',
      primaryGenre: 'Ambient',
    });
    expect(json.renderedPrompt).toContain('Test Channel');
    expect(json.renderedPrompt).not.toContain('mock-response'); // stripped
  });

  it('returns parsedOk=false when mock-response is missing', async () => {
    const res = await previewPrompt(
      jsonReq({
        kind: 'album-brief',
        prompt: 'Write an album brief for {{channel.displayName}}.',
      }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe('mock');
    expect(json.parsedOk).toBe(false);
    expect(json.validationErrors[0]).toContain('mock-response');
  });

  it('returns parsedOk=false when mock-response does not match schema', async () => {
    const badPrompt = `<!-- mock-response: {"wrongField":"x"} -->\n\nbody`;
    const res = await previewPrompt(
      jsonReq({ kind: 'album-brief', prompt: badPrompt }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.parsedOk).toBe(false);
    expect(json.validationErrors.length).toBeGreaterThan(0);
  });

  it('rejects unknown prompt kind', async () => {
    const res = await previewPrompt(
      jsonReq({ kind: 'not-a-real-kind', prompt: 'x' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('INVALID_BODY');
  });
});
