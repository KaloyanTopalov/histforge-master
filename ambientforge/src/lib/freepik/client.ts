/**
 * Freepik image-generation client. Pattern mirrors `src/lib/flow/client.ts`:
 * a Node bridge runs at localhost:7344, a Chrome extension polls the bridge
 * and drives www.freepik.com/ai/image-generator. This client is the
 * worker-side face of that bridge.
 *
 * Mock mode (apiKey === 'mock' or FREEPIK_MODE === 'mock') skips the bridge
 * entirely and returns a fixture image.
 */

import fs from 'node:fs';
import path from 'node:path';

export class FreepikError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(
    code: string,
    message: string,
    retriable: boolean,
    status?: number,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'FreepikError';
    this.code = code;
    this.retriable = retriable;
    this.status = status;
    this.cause = cause;
  }
}

export type FreepikAspect = '16:9' | '1:1' | '9:16';
export type FreepikTaskStatus = 'pending' | 'ready' | 'failed';

export type FreepikSubmitInput = {
  prompt: string;
  /** Freepik UI model picker option. Default `seedream-5`. */
  model?: string;
  aspectRatio?: FreepikAspect;
  /** Optional Magnific saved-style name. When set, the content script clicks
   * the Style reference-card slot and selects this style before generating. */
  styleName?: string;
};

export type FreepikVideoSubmitInput = {
  /** Motion prompt fed into Magnific's Seedance prompt textbox. Empty
   * tolerated (Seedance generates from the just-picked image alone). */
  prompt?: string;
  /** Magnific video-model picker text. Default `Seedance 2.0 Fast`. */
  model?: string;
  aspectRatio?: FreepikAspect;
  /** Absolute path on the Chrome machine to the picked start image
   * (source.jpg). The runner CDP-uploads this as the Seedance END frame so
   * the looped clip is seamless (end == start). Omitted → the content script
   * falls back to the operator-manual end-frame gate. */
  sourceImagePath?: string;
};

export type FreepikThumbnailSubmitInput = {
  /** Magnific image prompt (the rendered thumbnail-spec). */
  prompt: string;
  /** Freepik UI model picker option. Default `seedream-5`. */
  model?: string;
  aspectRatio?: FreepikAspect;
  /** Absolute path on the Chrome machine to the reference image uploaded via
   * Magnific's edit-reference button (the album's max-res source.jpg). The
   * content script CDP-uploads it instead of applying a saved style. */
  referenceImagePath: string;
  /** How many candidates Magnific should generate (all downloaded). Default 4. */
  count?: number;
};

/** poll result for the thumbnail flow — also carries how many candidate
 * images are available for download once `status === 'ready'`. */
export type FreepikThumbnailPoll = { status: FreepikTaskStatus; count: number };

export interface FreepikClient {
  submit(input: FreepikSubmitInput): Promise<string>;
  /** Submits a Magnific image-to-video task. Assumes the operator has just
   * picked an image in the current Magnific session (extension clicks
   * "Create video" on the visible result). Returns the bridge taskId. */
  submitVideo(input: FreepikVideoSubmitInput): Promise<string>;
  /** Submits a Magnific thumbnail task: uploads `referenceImagePath` via the
   * edit-reference button (no saved style), generates `count` candidates, and
   * returns ALL of them (no operator pick). Returns the bridge taskId. */
  submitThumbnail(input: FreepikThumbnailSubmitInput): Promise<string>;
  poll(taskId: string): Promise<FreepikTaskStatus>;
  /** Poll for a thumbnail task: status + how many candidates are ready. */
  pollThumbnail(taskId: string): Promise<FreepikThumbnailPoll>;
  download(taskId: string, destPath: string): Promise<void>;
  /** Download the candidate at `index` (0-based) for a thumbnail task. */
  downloadThumbnail(taskId: string, index: number, destPath: string): Promise<void>;
}

const DEFAULT_BRIDGE_URL = 'http://localhost:7344';
const BRIDGE_TIMEOUT_MS = 30_000;

/** Fixture path used by the mock client. Operator drops a placeholder JPG/PNG
 * here for tests; not committed. */
export const FREEPIK_FIXTURE_PATH = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'freepik',
  'source-fixture.jpg',
);

export type FreepikClientOpts = {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  /** Override mock fixture path. Tests use this. */
  fixturePath?: string;
};

/** Factory. Honors `apiKey === 'mock'` or `process.env.FREEPIK_MODE === 'mock'`. */
export function makeFreepikClient(opts: FreepikClientOpts = {}): FreepikClient {
  if (opts.apiKey === 'mock' || process.env.FREEPIK_MODE === 'mock') {
    return makeMockFreepikClient(opts);
  }
  return makeBridgeFreepikClient(opts);
}

// ---------------------------------------------------------------------------
// Mock client — copies a fixture instead of driving Freepik. Used in tests
// + integration runs when the operator hasn't loaded the extension.
// ---------------------------------------------------------------------------

type MockState = { counter: number; tasks: Map<string, { status: FreepikTaskStatus }> };

function makeMockFreepikClient(opts: FreepikClientOpts): FreepikClient {
  const state: MockState = { counter: 0, tasks: new Map() };
  const fixturePath = opts.fixturePath ?? FREEPIK_FIXTURE_PATH;
  async function submitMock(): Promise<string> {
    state.counter += 1;
    const id = `mock-freepik-${state.counter}`;
    state.tasks.set(id, { status: 'ready' });
    return id;
  }
  async function copyFixture(destPath: string): Promise<void> {
    if (!fs.existsSync(fixturePath)) {
      throw new FreepikError(
        'FREEPIK_MOCK_FIXTURE_MISSING',
        `freepik mock fixture not found at ${fixturePath}`,
        false,
      );
    }
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
    await fs.promises.copyFile(fixturePath, destPath);
  }
  return {
    submit: submitMock,
    submitVideo: submitMock,
    submitThumbnail: submitMock,
    async poll(taskId) {
      const t = state.tasks.get(taskId);
      if (!t) throw new FreepikError('FREEPIK_UNKNOWN_TASK', `mock: no task ${taskId}`, false);
      return t.status;
    },
    async pollThumbnail(taskId) {
      const t = state.tasks.get(taskId);
      if (!t) throw new FreepikError('FREEPIK_UNKNOWN_TASK', `mock: no task ${taskId}`, false);
      return { status: t.status, count: 4 };
    },
    async download(_taskId, destPath) {
      await copyFixture(destPath);
    },
    async downloadThumbnail(_taskId, _index, destPath) {
      await copyFixture(destPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge HTTP client — talks to the freepik-runner bridge on localhost:7344.
// ---------------------------------------------------------------------------

export function makeBridgeFreepikClient(opts: FreepikClientOpts = {}): FreepikClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BRIDGE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    timeoutMs = BRIDGE_TIMEOUT_MS,
  ): Promise<T | Buffer> {
    const url = `${baseUrl}${urlPath}`;
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ac.signal,
      });
    } catch (err) {
      const cause = err as { code?: string; name?: string; message?: string };
      if (cause?.name === 'AbortError') {
        throw new FreepikError(
          'FREEPIK_BRIDGE_TIMEOUT',
          `${method} ${urlPath} timed out`,
          true,
          undefined,
          err,
        );
      }
      const code = cause?.code ?? '';
      const msg = cause?.message ?? '';
      if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
        throw new FreepikError(
          'FREEPIK_BRIDGE_UNREACHABLE',
          `bridge unreachable at ${baseUrl} — is \`npm run freepik:bridge\` running?`,
          true,
          undefined,
          err,
        );
      }
      throw new FreepikError(
        'FREEPIK_BRIDGE_UNREACHABLE',
        `bridge call failed: ${msg}`,
        true,
        undefined,
        err,
      );
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401) {
      throw new FreepikError('FREEPIK_AUTH', 'bridge rejected request', false, 401);
    }
    if (res.status === 409) {
      // /download/:id when task isn't ready yet — caller should NOT reach
      // here unless poll said ready; treat as a transient bridge issue.
      throw new FreepikError(
        'FREEPIK_BRIDGE_ERROR',
        `bridge responded ${res.status}`,
        true,
        409,
      );
    }
    if (res.status === 429 || res.status >= 500) {
      throw new FreepikError(
        'FREEPIK_RATE_LIMIT',
        `bridge responded ${res.status}`,
        true,
        res.status,
      );
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new FreepikError(
        'FREEPIK_BRIDGE_ERROR',
        `bridge ${method} ${urlPath} -> ${res.status}: ${detail}`,
        false,
        res.status,
      );
    }

    const contentType = res.headers.get('content-type') ?? '';
    if (
      contentType.startsWith('image/') ||
      contentType.startsWith('video/') ||
      contentType === 'application/octet-stream'
    ) {
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    }
    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new FreepikError(
        'FREEPIK_BRIDGE_ERROR',
        'bridge returned invalid JSON',
        true,
        res.status,
        err,
      );
    }
  }

  return {
    async submit(input) {
      const body: Record<string, unknown> = {
        mode: 'imagegen',
        prompt: input.prompt,
        model: input.model ?? 'seedream-5',
        aspectRatio: input.aspectRatio ?? '16:9',
      };
      if (input.styleName && input.styleName.trim().length > 0) {
        body.styleName = input.styleName.trim();
      }
      const data = (await call<{ taskId: string }>('POST', '/submit', body)) as {
        taskId: string;
      };
      if (!data?.taskId) {
        throw new FreepikError('FREEPIK_BRIDGE_ERROR', 'bridge /submit missing taskId', true);
      }
      return data.taskId;
    },
    async submitVideo(input) {
      const body: Record<string, unknown> = {
        mode: 'image-to-video',
        prompt: (input.prompt ?? '').trim(),
        model: input.model ?? 'Seedance 2.0 Fast',
        aspectRatio: input.aspectRatio ?? '16:9',
      };
      if (input.sourceImagePath && input.sourceImagePath.trim().length > 0) {
        body.sourceImagePath = input.sourceImagePath.trim();
      }
      const data = (await call<{ taskId: string }>('POST', '/submit', body)) as {
        taskId: string;
      };
      if (!data?.taskId) {
        throw new FreepikError(
          'FREEPIK_BRIDGE_ERROR',
          'bridge /submit (video) missing taskId',
          true,
        );
      }
      return data.taskId;
    },
    async submitThumbnail(input) {
      const body: Record<string, unknown> = {
        mode: 'imagegen-thumbnail',
        prompt: input.prompt,
        model: input.model ?? 'seedream-5',
        aspectRatio: input.aspectRatio ?? '16:9',
        referenceImagePath: input.referenceImagePath,
        count: input.count ?? 4,
      };
      const data = (await call<{ taskId: string }>('POST', '/submit', body)) as {
        taskId: string;
      };
      if (!data?.taskId) {
        throw new FreepikError(
          'FREEPIK_BRIDGE_ERROR',
          'bridge /submit (thumbnail) missing taskId',
          true,
        );
      }
      return data.taskId;
    },
    async pollThumbnail(taskId) {
      const data = (await call<{ status?: FreepikTaskStatus; count?: number }>(
        'GET',
        `/poll/${encodeURIComponent(taskId)}`,
      )) as { status?: FreepikTaskStatus; count?: number };
      return {
        status: data?.status ?? 'pending',
        count: typeof data?.count === 'number' ? data.count : 0,
      };
    },
    async downloadThumbnail(taskId, index, destPath) {
      const bytes = (await call<Buffer>(
        'GET',
        `/download/${encodeURIComponent(taskId)}/${encodeURIComponent(String(index))}`,
      )) as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new FreepikError(
          'FREEPIK_BRIDGE_ERROR',
          'bridge /download (thumbnail) returned empty body',
          true,
        );
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, bytes);
    },
    async poll(taskId) {
      const data = (await call<{ status: FreepikTaskStatus; error?: string }>(
        'GET',
        `/poll/${encodeURIComponent(taskId)}`,
      )) as { status: FreepikTaskStatus; error?: string };
      const status = data?.status ?? 'pending';
      if (status === 'failed' && data?.error) {
        const lower = data.error.toLowerCase();
        // Content-policy rejections are retriable with a different prompt;
        // other failures (FREEPIK_SELECTORS_NOT_RECORDED, captcha, etc.) are
        // terminal so the album surfaces them to the operator.
        const retriable = lower.includes('content') || lower.includes('policy');
        throw new FreepikError(
          retriable ? 'FREEPIK_PROMPT_REJECTED' : 'FREEPIK_TASK_FAILED',
          data.error,
          retriable,
        );
      }
      return status;
    },
    async download(taskId, destPath) {
      const bytes = (await call<Buffer>(
        'GET',
        `/download/${encodeURIComponent(taskId)}`,
      )) as Buffer;
      if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
        throw new FreepikError(
          'FREEPIK_BRIDGE_ERROR',
          'bridge /download returned empty body',
          true,
        );
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.writeFile(destPath, bytes);
    },
  };
}
