/**
 * Seedance video-generation client. Unlike Suno/Flow/DistroKid (browser-bridge
 * driven), Seedance is a stateless REST call against OpenRouter's
 * `/api/v1/videos` endpoint — same API key as the LLM calls.
 *
 * IMPORTANT — OpenRouter video field names are NOT fully locked in. Live
 * verification on the first end-to-end run is part of Phase 9. Treat the
 * submit-body shape below as a best-effort starting point; on the first 4xx
 * response the implementer should log the raw error body and adjust.
 */

import fs from 'node:fs';
import path from 'node:path';
import { getOpenRouterApiKey } from '@/lib/settings';

export class SeedanceError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(code: string, message: string, retriable: boolean, status?: number, cause?: unknown) {
    super(message);
    this.name = 'SeedanceError';
    this.code = code;
    this.retriable = retriable;
    this.status = status;
    this.cause = cause;
  }
}

export type SeedanceAspect = '16:9' | '9:16' | '1:1';
export type SeedanceJobStatus = 'pending' | 'ready' | 'failed';

export type SeedanceSubmitInput = {
  prompt: string;
  /** Path to the image used as BOTH first and last frame (seamless loop). */
  sourceImagePath: string;
  /** Clip duration in seconds. Seedance 2.0 default = 10. */
  duration: number;
  aspectRatio: SeedanceAspect;
};

export interface SeedanceClient {
  submit(input: SeedanceSubmitInput): Promise<string>;
  poll(jobId: string): Promise<SeedanceJobStatus>;
  download(jobId: string, destPath: string): Promise<void>;
}

const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/v1/videos';
const DEFAULT_MODEL = 'bytedance/seedance-2.0';
/** Fixture path used by the mock client. Operator drops a small placeholder
 * MP4 here for tests; not committed. */
export const SEEDANCE_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'seedance',
  'clip-fixture.mp4',
);

export type SeedanceClientOpts = {
  apiKey?: string;
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Path to mock fixture (overrides SEEDANCE_FIXTURE_PATH). Tests use this. */
  fixturePath?: string;
};

/** Factory. Honors the `apiKey === 'mock'` sentinel so tests can short-circuit
 * the real REST round-trip the same way Suno/OpenRouter tests do. */
export function makeSeedanceClient(opts: SeedanceClientOpts = {}): SeedanceClient {
  const apiKey = opts.apiKey ?? safeReadApiKey();
  if (apiKey === 'mock') return makeMockSeedanceClient(opts);
  return makeRestSeedanceClient({ ...opts, apiKey });
}

function safeReadApiKey(): string {
  try {
    return getOpenRouterApiKey() ?? '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Mock client — copies a local fixture instead of calling the API. Used in
// tests + `apiKey === 'mock'` integration runs.
// ---------------------------------------------------------------------------

type MockState = { counter: number; jobs: Map<string, { status: SeedanceJobStatus }> };

function makeMockSeedanceClient(opts: SeedanceClientOpts): SeedanceClient {
  const state: MockState = { counter: 0, jobs: new Map() };
  const fixturePath = opts.fixturePath ?? SEEDANCE_FIXTURE_PATH;
  return {
    async submit() {
      state.counter += 1;
      const id = `mock-seedance-${state.counter}`;
      state.jobs.set(id, { status: 'ready' });
      return id;
    },
    async poll(jobId) {
      const j = state.jobs.get(jobId);
      if (!j) throw new SeedanceError('SEEDANCE_UNKNOWN_JOB', `mock: no job ${jobId}`, false);
      return j.status;
    },
    async download(_jobId, destPath) {
      if (!fs.existsSync(fixturePath)) {
        throw new SeedanceError(
          'SEEDANCE_MOCK_FIXTURE_MISSING',
          `seedance mock fixture not found at ${fixturePath}`,
          false,
        );
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(fixturePath, destPath);
    },
  };
}

// ---------------------------------------------------------------------------
// REST client — talks to OpenRouter `/api/v1/videos`.
// ---------------------------------------------------------------------------

type RestOpts = SeedanceClientOpts & { apiKey: string };

function makeRestSeedanceClient(opts: RestOpts): SeedanceClient {
  const apiKey = opts.apiKey;
  if (!apiKey || apiKey.length === 0) {
    // Defer the throw to first call so factory invocation in modules that
    // never actually run Seedance (e.g. test setup) doesn't blow up.
    return throwingClient(
      new SeedanceError('SEEDANCE_AUTH', 'OPENROUTER_API_KEY is not set', false),
    );
  }
  const endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
  const model = opts.model ?? DEFAULT_MODEL;
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;

  return {
    async submit(input) {
      // Seedance uses the source image as BOTH first and last frame for a
      // seamless loop. Inline it as a data URL — the multipart alternative
      // would require knowing OpenRouter's videos-specific upload semantics.
      const dataUrl = await imageDataUrl(input.sourceImagePath);
      const body = {
        model,
        input: {
          prompt: input.prompt,
          first_frame: dataUrl,
          last_frame: dataUrl,
          duration: input.duration,
          aspect_ratio: input.aspectRatio,
          generate_audio: false,
        },
      };
      const res = await safeFetch(fetchImpl, endpoint, {
        method: 'POST',
        headers: jsonAuthHeaders(apiKey),
        body: JSON.stringify(body),
      });
      handleAuthOrRateLimit(res);
      const json = (await res.json().catch((err) => {
        throw new SeedanceError(
          'SEEDANCE_NETWORK',
          'submit response was not valid JSON',
          true,
          res.status,
          err,
        );
      })) as { id?: string; job_id?: string; data?: { id?: string } };
      const id = json.id ?? json.job_id ?? json.data?.id;
      if (!id) {
        throw new SeedanceError(
          'SEEDANCE_TASK_FAILED',
          `submit response had no id field: ${JSON.stringify(json).slice(0, 200)}`,
          false,
          res.status,
        );
      }
      return id;
    },

    async poll(jobId) {
      const url = `${endpoint}/${encodeURIComponent(jobId)}`;
      const res = await safeFetch(fetchImpl, url, {
        method: 'GET',
        headers: jsonAuthHeaders(apiKey),
      });
      handleAuthOrRateLimit(res);
      if (!res.ok) {
        throw new SeedanceError(
          'SEEDANCE_NETWORK',
          `poll responded ${res.status}`,
          true,
          res.status,
        );
      }
      const json = (await res.json()) as {
        status?: string;
        state?: string;
        error?: { message?: string };
      };
      const raw = (json.status ?? json.state ?? '').toLowerCase();
      if (raw === 'succeeded' || raw === 'completed' || raw === 'ready' || raw === 'done') {
        return 'ready';
      }
      if (raw === 'failed' || raw === 'error') {
        throw new SeedanceError(
          'SEEDANCE_TASK_FAILED',
          json.error?.message ?? `seedance job ${jobId} failed`,
          false,
        );
      }
      return 'pending';
    },

    async download(jobId, destPath) {
      const url = `${endpoint}/${encodeURIComponent(jobId)}`;
      const res = await safeFetch(fetchImpl, url, {
        method: 'GET',
        headers: jsonAuthHeaders(apiKey),
      });
      handleAuthOrRateLimit(res);
      if (!res.ok) {
        throw new SeedanceError(
          'SEEDANCE_NETWORK',
          `download metadata responded ${res.status}`,
          true,
          res.status,
        );
      }
      const meta = (await res.json()) as {
        output?: { url?: string };
        url?: string;
        data?: { url?: string };
      };
      const fileUrl = meta.output?.url ?? meta.url ?? meta.data?.url;
      if (!fileUrl) {
        throw new SeedanceError(
          'SEEDANCE_TASK_FAILED',
          `download metadata had no url field: ${JSON.stringify(meta).slice(0, 200)}`,
          false,
        );
      }
      const fileRes = await safeFetch(fetchImpl, fileUrl, { method: 'GET' });
      if (!fileRes.ok) {
        throw new SeedanceError(
          'SEEDANCE_NETWORK',
          `clip download responded ${fileRes.status}`,
          true,
          fileRes.status,
        );
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      const buf = Buffer.from(await fileRes.arrayBuffer());
      await fs.promises.writeFile(destPath, buf);
    },
  };
}

function jsonAuthHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

async function safeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    throw new SeedanceError('SEEDANCE_NETWORK', `fetch failed: ${url}`, true, undefined, err);
  }
}

function handleAuthOrRateLimit(res: Response): void {
  if (res.status === 401) {
    throw new SeedanceError('SEEDANCE_AUTH', 'OpenRouter rejected the API key', false, 401);
  }
  if (res.status === 429 || res.status >= 500) {
    throw new SeedanceError(
      'SEEDANCE_RATE_LIMIT',
      `OpenRouter responded ${res.status}`,
      true,
      res.status,
    );
  }
}

async function imageDataUrl(p: string): Promise<string> {
  const buf = await fs.promises.readFile(p);
  const ext = path.extname(p).toLowerCase();
  const mime =
    ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function throwingClient(err: SeedanceError): SeedanceClient {
  return {
    async submit() {
      throw err;
    },
    async poll() {
      throw err;
    },
    async download() {
      throw err;
    },
  };
}
