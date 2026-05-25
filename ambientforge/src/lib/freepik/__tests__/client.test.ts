import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeFreepikClient,
  makeBridgeFreepikClient,
  FreepikError,
} from '@/lib/freepik/client';

let tmpRoot: string;

beforeEach(() => {
  vi.restoreAllMocks();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'freepik-test-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.FREEPIK_MODE;
});

describe('Freepik mock client', () => {
  it('apiKey="mock" returns a mock client that produces deterministic task ids', async () => {
    const fixturePath = path.join(tmpRoot, 'fixture.jpg');
    fs.writeFileSync(fixturePath, Buffer.from('FAKE_JPG_BYTES'));
    const client = makeFreepikClient({ apiKey: 'mock', fixturePath });
    const t1 = await client.submit({ prompt: 'a' });
    const t2 = await client.submit({ prompt: 'b' });
    expect(t1).toBe('mock-freepik-1');
    expect(t2).toBe('mock-freepik-2');
    expect(await client.poll(t1)).toBe('ready');
  });

  it('FREEPIK_MODE=mock env activates mock client even without apiKey', async () => {
    process.env.FREEPIK_MODE = 'mock';
    const fixturePath = path.join(tmpRoot, 'fixture.jpg');
    fs.writeFileSync(fixturePath, Buffer.from('FAKE'));
    const client = makeFreepikClient({ fixturePath });
    const id = await client.submit({ prompt: 'x' });
    expect(id).toBe('mock-freepik-1');
  });

  it('download copies the fixture to the destination path', async () => {
    const fixturePath = path.join(tmpRoot, 'fixture.jpg');
    fs.writeFileSync(fixturePath, Buffer.from('THE_FIXTURE_BYTES'));
    const client = makeFreepikClient({ apiKey: 'mock', fixturePath });
    const id = await client.submit({ prompt: 'x' });
    const dest = path.join(tmpRoot, 'out', 'source.jpg');
    await client.download(id, dest);
    expect(fs.readFileSync(dest).toString()).toBe('THE_FIXTURE_BYTES');
  });

  it('download throws FREEPIK_MOCK_FIXTURE_MISSING when fixture absent', async () => {
    const client = makeFreepikClient({
      apiKey: 'mock',
      fixturePath: '/no/such/path.jpg',
    });
    const id = await client.submit({ prompt: 'x' });
    await expect(client.download(id, path.join(tmpRoot, 'x.jpg'))).rejects.toMatchObject({
      code: 'FREEPIK_MOCK_FIXTURE_MISSING',
    });
  });

  it('poll throws FREEPIK_UNKNOWN_TASK on an id the mock has not seen', async () => {
    const client = makeFreepikClient({ apiKey: 'mock' });
    await expect(client.poll('never-submitted')).rejects.toMatchObject({
      code: 'FREEPIK_UNKNOWN_TASK',
    });
  });

  it('thumbnail flow: submitThumbnail + pollThumbnail(ready,4) + downloadThumbnail copies fixture per index', async () => {
    const fixturePath = path.join(tmpRoot, 'fixture.jpg');
    fs.writeFileSync(fixturePath, Buffer.from('THUMB_FIXTURE'));
    const client = makeFreepikClient({ apiKey: 'mock', fixturePath });

    const id = await client.submitThumbnail({
      prompt: 'spec',
      referenceImagePath: '/x/source.jpg',
    });
    expect(id).toBe('mock-freepik-1');
    expect(await client.pollThumbnail(id)).toEqual({ status: 'ready', count: 4 });

    const out0 = path.join(tmpRoot, 'thumbs', 'thumb-1.png');
    const out3 = path.join(tmpRoot, 'thumbs', 'thumb-4.png');
    await client.downloadThumbnail(id, 0, out0);
    await client.downloadThumbnail(id, 3, out3);
    expect(fs.readFileSync(out0).toString()).toBe('THUMB_FIXTURE');
    expect(fs.readFileSync(out3).toString()).toBe('THUMB_FIXTURE');
  });
});

describe('Freepik bridge client (HTTP shape)', () => {
  function makeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    });
  }

  it('submit posts { prompt, model, aspectRatio } to /submit and returns the bridge taskId', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { taskId: 'freepik-task-xyz' }),
    );
    const client = makeBridgeFreepikClient({
      baseUrl: 'http://localhost:7344',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const id = await client.submit({
      prompt: 'knight by fire',
      model: 'Seedream 5 Lite Fast',
      aspectRatio: '16:9',
    });
    expect(id).toBe('freepik-task-xyz');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:7344/submit');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, string>;
    expect(body.prompt).toBe('knight by fire');
    expect(body.model).toBe('Seedream 5 Lite Fast');
    expect(body.aspectRatio).toBe('16:9');
  });

  it('submit defaults model to seedream-5 when not provided', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { taskId: 't1' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.submit({ prompt: 'x' });
    const body = JSON.parse((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}') as Record<
      string,
      string
    >;
    expect(body.model).toBe('seedream-5');
    expect(body.aspectRatio).toBe('16:9');
  });

  it('poll returns the bridge status', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { status: 'pending' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(await client.poll('t1')).toBe('pending');
  });

  it('poll classifies content-policy failures as retriable, others as terminal', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { status: 'failed', error: 'image violates content policy' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.poll('t1')).rejects.toMatchObject({
      code: 'FREEPIK_PROMPT_REJECTED',
      retriable: true,
    });
  });

  it('poll surfaces non-policy failures with FREEPIK_TASK_FAILED', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { status: 'failed', error: 'bridge selector mismatch' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.poll('t1')).rejects.toMatchObject({
      code: 'FREEPIK_TASK_FAILED',
      retriable: false,
    });
  });

  it('download writes image bytes to disk', async () => {
    const fakeBytes = Buffer.from('JPEG_BYTES_HERE');
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(fakeBytes, {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const dest = path.join(tmpRoot, 'out.jpg');
    await client.download('t1', dest);
    expect(fs.readFileSync(dest).equals(fakeBytes)).toBe(true);
  });

  it('maps ECONNREFUSED to FREEPIK_BRIDGE_UNREACHABLE (retriable)', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => {
      const err = new Error('connect ECONNREFUSED');
      (err as { code?: string }).code = 'ECONNREFUSED';
      throw err;
      // Unreachable but keeps TS happy about the return type:
      // eslint-disable-next-line no-unreachable
      return new Response('', { status: 0 });
    });
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.submit({ prompt: 'x' })).rejects.toMatchObject({
      code: 'FREEPIK_BRIDGE_UNREACHABLE',
      retriable: true,
    });
  });

  it('maps 429 to FREEPIK_RATE_LIMIT (retriable)', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(429, { error: 'slow down' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.submit({ prompt: 'x' })).rejects.toMatchObject({
      code: 'FREEPIK_RATE_LIMIT',
      retriable: true,
    });
  });
});

describe('Freepik thumbnail flow (bridge HTTP shape)', () => {
  function makeResponse(status: number, body: unknown, contentType = 'application/json'): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': contentType },
    });
  }

  it('submitThumbnail posts mode=imagegen-thumbnail + referenceImagePath + count and returns taskId', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { taskId: 'fp-thumb-1' }),
    );
    const client = makeBridgeFreepikClient({
      baseUrl: 'http://localhost:7344',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const id = await client.submitThumbnail({
      prompt: 'TITLE_BLOCK\nLine 1: The Knight',
      referenceImagePath: 'C:/proj/source.jpg',
      model: 'Seedream 5 Lite',
      aspectRatio: '16:9',
      count: 4,
    });
    expect(id).toBe('fp-thumb-1');
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('http://localhost:7344/submit');
    expect(init?.method).toBe('POST');
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.mode).toBe('imagegen-thumbnail');
    expect(body.prompt).toBe('TITLE_BLOCK\nLine 1: The Knight');
    expect(body.referenceImagePath).toBe('C:/proj/source.jpg');
    expect(body.model).toBe('Seedream 5 Lite');
    expect(body.aspectRatio).toBe('16:9');
    expect(body.count).toBe(4);
  });

  it('submitThumbnail defaults model→seedream-5, aspectRatio→16:9, count→4 when omitted', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { taskId: 't' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await client.submitThumbnail({ prompt: 'spec', referenceImagePath: '/a/b.jpg' });
    const body = JSON.parse((fetchSpy.mock.calls[0][1]?.body as string) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body.model).toBe('seedream-5');
    expect(body.aspectRatio).toBe('16:9');
    expect(body.count).toBe(4);
    expect(body.referenceImagePath).toBe('/a/b.jpg');
  });

  it('pollThumbnail returns { status, count } parsed from the bridge /poll response', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { status: 'ready', count: 4 }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const out = await client.pollThumbnail('fp-thumb-1');
    expect(out).toEqual({ status: 'ready', count: 4 });
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:7344/poll/fp-thumb-1');
  });

  it('pollThumbnail reports count 0 while still pending', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { status: 'pending' }),
    );
    const client = makeBridgeFreepikClient({
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(await client.pollThumbnail('t')).toEqual({ status: 'pending', count: 0 });
  });

  it('downloadThumbnail GETs /download/<id>/<index> and writes the bytes to disk', async () => {
    const fakeBytes = Buffer.from('THUMB_3_BYTES');
    const fetchSpy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(fakeBytes, {
          status: 200,
          headers: { 'content-type': 'image/png' },
        }),
    );
    const client = makeBridgeFreepikClient({
      baseUrl: 'http://localhost:7344',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const dest = path.join(tmpRoot, 'thumbs', 'thumb-3.png');
    await client.downloadThumbnail('fp-thumb-1', 2, dest);
    expect(fetchSpy.mock.calls[0][0]).toBe('http://localhost:7344/download/fp-thumb-1/2');
    expect(fs.readFileSync(dest).equals(fakeBytes)).toBe(true);
  });
});

describe('FreepikError', () => {
  it('exposes code, retriable, status', () => {
    const e = new FreepikError('X', 'msg', true, 429);
    expect(e.code).toBe('X');
    expect(e.retriable).toBe(true);
    expect(e.status).toBe(429);
  });
});
