import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  makeSeedanceClient,
  SeedanceError,
} from '@/lib/seedance/client';

let tmpRoot: string;
let prevCwd: string;

beforeEach(() => {
  vi.restoreAllMocks();
  prevCwd = process.cwd();
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'seedance-test-'));
  process.chdir(tmpRoot);
});

afterEach(() => {
  process.chdir(prevCwd);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('Seedance mock client (apiKey === "mock")', () => {
  it('submit assigns a deterministic mock id and download copies the fixture', async () => {
    const fixturePath = path.join(tmpRoot, 'fixture.mp4');
    fs.writeFileSync(fixturePath, Buffer.from('FAKE_MP4_BYTES'));
    const sourcePath = path.join(tmpRoot, 'src.jpg');
    fs.writeFileSync(sourcePath, Buffer.alloc(64 * 1024, 0xab));

    const client = makeSeedanceClient({ apiKey: 'mock', fixturePath });
    const jobId = await client.submit({
      prompt: 'flames flickering',
      sourceImagePath: sourcePath,
      duration: 10,
      aspectRatio: '16:9',
    });
    expect(jobId).toBe('mock-seedance-1');
    expect(await client.poll(jobId)).toBe('ready');

    const dest = path.join(tmpRoot, 'out', 'clip.mp4');
    await client.download(jobId, dest);
    expect(fs.readFileSync(dest).toString()).toBe('FAKE_MP4_BYTES');
  });

  it('throws SEEDANCE_MOCK_FIXTURE_MISSING when no fixture present', async () => {
    const client = makeSeedanceClient({ apiKey: 'mock', fixturePath: '/no/such/file.mp4' });
    const jobId = await client.submit({
      prompt: 'x',
      sourceImagePath: 'irrelevant',
      duration: 10,
      aspectRatio: '16:9',
    });
    await expect(client.download(jobId, path.join(tmpRoot, 'out.mp4'))).rejects.toMatchObject({
      code: 'SEEDANCE_MOCK_FIXTURE_MISSING',
    });
  });

  it('poll throws SEEDANCE_UNKNOWN_JOB for jobs the mock has not seen', async () => {
    const client = makeSeedanceClient({ apiKey: 'mock' });
    await expect(client.poll('never-submitted')).rejects.toMatchObject({
      code: 'SEEDANCE_UNKNOWN_JOB',
    });
  });
});

describe('Seedance REST client', () => {
  function makeResponse(status: number, body: unknown): Response {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('submit sends model + first_frame + last_frame data URL + 16:9 + duration', async () => {
    const sourcePath = path.join(tmpRoot, 'src.jpg');
    // Tiny real JPEG-ish payload — only the data-url base64 shape matters.
    fs.writeFileSync(sourcePath, Buffer.from('SOMEJPEGBYTES'));
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) =>
      makeResponse(200, { id: 'job-123' }),
    );
    const client = makeSeedanceClient({
      apiKey: 'sk-real',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const id = await client.submit({
      prompt: 'flames',
      sourceImagePath: sourcePath,
      duration: 10,
      aspectRatio: '16:9',
    });
    expect(id).toBe('job-123');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain('/api/v1/videos');
    const body = JSON.parse(init?.body as string) as {
      model: string;
      input: {
        prompt: string;
        first_frame: string;
        last_frame: string;
        duration: number;
        aspect_ratio: string;
        generate_audio: boolean;
      };
    };
    expect(body.model).toBe('bytedance/seedance-2.0');
    expect(body.input.prompt).toBe('flames');
    expect(body.input.duration).toBe(10);
    expect(body.input.aspect_ratio).toBe('16:9');
    expect(body.input.generate_audio).toBe(false);
    expect(body.input.first_frame).toMatch(/^data:image\/jpe?g;base64,/);
    expect(body.input.first_frame).toBe(body.input.last_frame);
  });

  it('submit maps 401 to SEEDANCE_AUTH (no retry)', async () => {
    const sourcePath = path.join(tmpRoot, 'src.jpg');
    fs.writeFileSync(sourcePath, Buffer.from('x'));
    const fetchSpy = vi.fn(async () => makeResponse(401, { error: 'unauth' }));
    const client = makeSeedanceClient({
      apiKey: 'sk-real',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(
      client.submit({
        prompt: 'x',
        sourceImagePath: sourcePath,
        duration: 10,
        aspectRatio: '16:9',
      }),
    ).rejects.toMatchObject({ code: 'SEEDANCE_AUTH' });
  });

  it('submit maps 429 to SEEDANCE_RATE_LIMIT (retriable=true)', async () => {
    const sourcePath = path.join(tmpRoot, 'src.jpg');
    fs.writeFileSync(sourcePath, Buffer.from('x'));
    const fetchSpy = vi.fn(async () => makeResponse(429, { error: 'slow down' }));
    const client = makeSeedanceClient({
      apiKey: 'sk-real',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(
      client.submit({
        prompt: 'x',
        sourceImagePath: sourcePath,
        duration: 10,
        aspectRatio: '16:9',
      }),
    ).rejects.toMatchObject({ code: 'SEEDANCE_RATE_LIMIT', retriable: true });
  });

  it('poll returns "pending" for unknown/in-progress states, "ready" when succeeded', async () => {
    const responses: Response[] = [
      makeResponse(200, { status: 'queued' }),
      makeResponse(200, { state: 'processing' }),
      makeResponse(200, { status: 'succeeded' }),
    ];
    const fetchSpy = vi.fn(async () => responses.shift() ?? makeResponse(200, {}));
    const client = makeSeedanceClient({
      apiKey: 'sk-real',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(await client.poll('j1')).toBe('pending');
    expect(await client.poll('j1')).toBe('pending');
    expect(await client.poll('j1')).toBe('ready');
  });

  it('poll throws SEEDANCE_TASK_FAILED on terminal failure', async () => {
    const fetchSpy = vi.fn(async () =>
      makeResponse(200, { status: 'failed', error: { message: 'unsafe content' } }),
    );
    const client = makeSeedanceClient({
      apiKey: 'sk-real',
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    await expect(client.poll('j1')).rejects.toMatchObject({
      code: 'SEEDANCE_TASK_FAILED',
    });
  });
});

describe('SeedanceError', () => {
  it('exposes code, retriable, status', () => {
    const e = new SeedanceError('X', 'msg', true, 429);
    expect(e.code).toBe('X');
    expect(e.retriable).toBe(true);
    expect(e.status).toBe(429);
  });
});
