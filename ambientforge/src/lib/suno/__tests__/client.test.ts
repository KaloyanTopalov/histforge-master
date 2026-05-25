import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import { setSetting } from '@/lib/settings';
import {
  SunoError,
  __resetMockSunoState,
  makeBridgeSunoClient,
  makeMockSunoClient,
  type SunoClient,
} from '@/lib/suno/client';

const submit = (c: SunoClient, stylePrompt: string, lyrics: string) =>
  c.submit({ stylePrompt, lyrics, model: 'chirp-fenix', mode: 'custom', instrumental: false });

let db: Db;
let tmpDir: string;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetMockSunoState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suno-client-test-'));
});

afterEach(() => {
  __setDbForTests(null);
  __resetMockSunoState();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('mock SunoClient', () => {
  it('getCredits reads suno_mock_credits setting (defaults to 100)', async () => {
    const c = makeMockSunoClient();
    expect(await c.getCredits()).toBe(100); // default from DEFAULT_SETTINGS
    setSetting('suno_mock_credits', '42', db);
    expect(await c.getCredits()).toBe(42);
    setSetting('suno_mock_credits', '0', db);
    expect(await c.getCredits()).toBe(0);
  });

  it('submit returns deterministic zero-padded IDs in submission order', async () => {
    const c = makeMockSunoClient();
    const id1 = await submit(c,'style', 'lyrics-1');
    const id2 = await submit(c,'style', 'lyrics-2');
    const id3 = await submit(c,'style', 'lyrics-3');
    expect(id1).toBe('mock-task-0001');
    expect(id2).toBe('mock-task-0002');
    expect(id3).toBe('mock-task-0003');
  });

  it('poll returns ready for a submitted task and failed for unknown', async () => {
    const c = makeMockSunoClient();
    const id = await submit(c,'s', 'l');
    expect(await c.poll(id)).toBe('ready');
    expect(await c.poll('mock-task-9999')).toBe('failed');
  });

  it('download copies a fixture .wav to destPath, round-robin across 3 fixtures', async () => {
    const c = makeMockSunoClient();
    const ids = await Promise.all([
      submit(c,'s', '1'),
      submit(c,'s', '2'),
      submit(c,'s', '3'),
      submit(c,'s', '4'),
    ]);
    const dests = ids.map((_, i) => path.join(tmpDir, `track-${i}.wav`));
    for (let i = 0; i < ids.length; i++) {
      await c.download(ids[i], dests[i]);
      expect(fs.existsSync(dests[i])).toBe(true);
      expect(fs.statSync(dests[i]).size).toBeGreaterThan(1024);
    }
    // 1st and 4th map to fixture-01 (round-robin), so they should be byte-identical.
    const a = fs.readFileSync(dests[0]);
    const d = fs.readFileSync(dests[3]);
    expect(Buffer.compare(a, d)).toBe(0);
  });
});

describe('bridge SunoClient (HTTP, fetchImpl injected)', () => {
  function jsonResp(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('submit POSTs and returns taskId from JSON envelope', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(200, { taskId: 'real-123' }));
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const id = await submit(c,'style-prompt', 'lyrics');
    expect(id).toBe('real-123');
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://x/submit',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'content-type': 'application/json' }),
      }),
    );
  });

  it('maps 402 to INSUFFICIENT_SUNO_CREDITS (non-retriable)', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(402, { error: 'low' }));
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(c.getCredits()).rejects.toMatchObject({
      code: 'INSUFFICIENT_SUNO_CREDITS',
      retriable: false,
    });
  });

  it('maps 409 to SUNO_CAPTCHA (non-retriable)', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(409, { error: 'captcha' }));
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(submit(c,'s', 'l')).rejects.toMatchObject({
      code: 'SUNO_CAPTCHA',
      retriable: false,
    });
  });

  it('maps 429 to SUNO_RATE_LIMITED (retriable)', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(429, { error: 'slow down' }));
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(submit(c,'s', 'l')).rejects.toMatchObject({
      code: 'SUNO_RATE_LIMITED',
      retriable: true,
    });
  });

  it('maps 500 to SUNO_BRIDGE_ERROR (retriable)', async () => {
    const fetchImpl = vi.fn(async () => jsonResp(500, { error: 'oops' }));
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(submit(c,'s', 'l')).rejects.toMatchObject({
      code: 'SUNO_BRIDGE_ERROR',
      retriable: true,
    });
  });

  it('maps fetch ECONNREFUSED to SUNO_BRIDGE_UNREACHABLE (retriable)', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7341'), {
      code: 'ECONNREFUSED',
    });
    const fetchImpl = vi.fn(async () => {
      throw err;
    });
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    try {
      await c.getCredits();
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(SunoError);
      expect((e as SunoError).code).toBe('SUNO_BRIDGE_UNREACHABLE');
      expect((e as SunoError).retriable).toBe(true);
    }
  });

  it('poll uses GET /poll/:taskId and returns status from JSON', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://x/poll/abc-123');
      return jsonResp(200, { status: 'ready' });
    });
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await c.poll('abc-123')).toBe('ready');
  });

  it('download POSTs and writes the response body to disk', async () => {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'suno', 'fixture-01.wav');
    const expectedBytes = fs.readFileSync(fixturePath);
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toBe('http://x/download/task-9');
      return new Response(expectedBytes, { status: 200 });
    });
    const c = makeBridgeSunoClient({ baseUrl: 'http://x', fetchImpl: fetchImpl as unknown as typeof fetch });
    const dest = path.join(tmpDir, 'out.wav');
    await c.download('task-9', dest);
    const written = fs.readFileSync(dest);
    expect(Buffer.compare(written, expectedBytes)).toBe(0);
  });
});
