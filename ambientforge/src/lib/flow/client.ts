import fs from 'node:fs';
import path from 'node:path';

export class FlowError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(code: string, message: string, retriable: boolean, status?: number, cause?: unknown) {
    super(message);
    this.name = 'FlowError';
    this.code = code;
    this.retriable = retriable;
    this.status = status;
    this.cause = cause;
  }
}

export type FlowAspect = '1:1' | '16:9' | '9:16';
export type FlowTaskStatus = 'pending' | 'ready' | 'failed';

export interface FlowClient {
  submitPrompt(prompt: string, aspectRatio?: FlowAspect): Promise<string>;
  poll(taskId: string): Promise<FlowTaskStatus>;
  download(taskId: string, destPath: string): Promise<void>;
}

const DEFAULT_BRIDGE_URL = 'http://localhost:7343';
const BRIDGE_TIMEOUT_MS = 30_000;

export type FlowClientOpts = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function makeFlowClient(opts: FlowClientOpts = {}): FlowClient {
  if (process.env.FLOW_MODE === 'mock') {
    return makeMockFlowClient();
  }
  return makeBridgeFlowClient(opts);
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

const FIXTURE_SQUARE = 'fixture-square.png';
const FIXTURE_WIDE = 'fixture-wide.png';

type MockTask = {
  prompt: string;
  aspectRatio: FlowAspect;
  fixture: string;
  status: FlowTaskStatus;
};

type MockState = {
  counter: number;
  tasks: Map<string, MockTask>;
  /**
   * Optional override: the fixture name to use for the next call to
   * submitPrompt. Lets tests force a specific fixture (e.g., wide PNG) for
   * an aspect-retry scenario without needing to pass options through every
   * layer.
   */
  nextFixtureOverride: string | null;
  /**
   * If true, every poll() call returns 'failed' instead of 'ready'. Used by
   * tests that need to drive the prompt-rejected retry path.
   */
  failNextPoll: boolean;
};

const mockState: MockState = {
  counter: 0,
  tasks: new Map(),
  nextFixtureOverride: null,
  failNextPoll: false,
};

/** Test-only: reset the mock counter / task map between runs. */
export function __resetMockFlowState(): void {
  mockState.counter = 0;
  mockState.tasks.clear();
  mockState.nextFixtureOverride = null;
  mockState.failNextPoll = false;
}

/**
 * Test-only: force the NEXT submitPrompt to use the named fixture file
 * (relative to tests/fixtures/flow/). Useful for the aspect-retry test that
 * needs Flow to "return" a wide image first, then a square one.
 */
export function __setMockNextFixture(name: string | null): void {
  mockState.nextFixtureOverride = name;
}

/** Test-only: cause the NEXT poll() call to return 'failed'. */
export function __setMockFailNextPoll(fail: boolean): void {
  mockState.failNextPoll = fail;
}

export function makeMockFlowClient(): FlowClient {
  return {
    async submitPrompt(prompt, aspectRatio = '16:9') {
      mockState.counter += 1;
      const taskId = `mock-flow-${String(mockState.counter).padStart(4, '0')}`;
      const fixture =
        mockState.nextFixtureOverride ??
        (aspectRatio === '1:1' ? FIXTURE_SQUARE : FIXTURE_WIDE);
      mockState.nextFixtureOverride = null;
      mockState.tasks.set(taskId, {
        prompt,
        aspectRatio,
        fixture,
        status: 'pending',
      });
      return taskId;
    },
    async poll(taskId) {
      const task = mockState.tasks.get(taskId);
      if (!task) return 'failed';
      if (mockState.failNextPoll) {
        mockState.failNextPoll = false;
        task.status = 'failed';
        return 'failed';
      }
      task.status = 'ready';
      return 'ready';
    },
    async download(taskId, destPath) {
      const task = mockState.tasks.get(taskId);
      if (!task) {
        throw new FlowError('FLOW_TASK_FAILED', `unknown mock taskId ${taskId}`, false);
      }
      const fixturePath = path.join(
        process.cwd(),
        'tests',
        'fixtures',
        'flow',
        task.fixture,
      );
      if (!fs.existsSync(fixturePath)) {
        throw new FlowError(
          'FLOW_DOWNLOAD_FAILED',
          `mock fixture missing: ${fixturePath} — run scripts/setup-fixtures or tests/fixtures/flow/setup.ts`,
          false,
        );
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(fixturePath, destPath);
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge HTTP client (real)
// ---------------------------------------------------------------------------

export function makeBridgeFlowClient(opts: FlowClientOpts = {}): FlowClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BRIDGE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    timeoutMs = BRIDGE_TIMEOUT_MS,
  ): Promise<T> {
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
        throw new FlowError('FLOW_BRIDGE_TIMEOUT', `${method} ${urlPath} timed out`, true, undefined, err);
      }
      const code = cause?.code ?? '';
      const msg = cause?.message ?? '';
      if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
        throw new FlowError('FLOW_BRIDGE_UNREACHABLE', `bridge unreachable at ${baseUrl}`, true, undefined, err);
      }
      throw new FlowError('FLOW_BRIDGE_UNREACHABLE', `bridge call failed: ${msg}`, true, undefined, err);
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401) {
      throw new FlowError('FLOW_AUTH', 'bridge rejected request', false, 401);
    }
    if (res.status === 409) {
      // /download/:id when task isn't ready yet — the worker shouldn't reach
      // here unless poll said ready, so treat as a transient bridge issue.
      throw new FlowError('FLOW_BRIDGE_ERROR', `bridge responded ${res.status}`, true, 409);
    }
    if (res.status === 429) {
      throw new FlowError('FLOW_RATE_LIMITED', `bridge responded ${res.status}`, true, 429);
    }
    if (res.status >= 500) {
      throw new FlowError('FLOW_BRIDGE_ERROR', `bridge responded ${res.status}`, true, res.status);
    }
    if (!res.ok) {
      let detail = '';
      try {
        detail = (await res.text()).slice(0, 200);
      } catch {
        /* ignore */
      }
      throw new FlowError(
        'FLOW_BRIDGE_ERROR',
        `bridge ${method} ${urlPath} -> ${res.status}: ${detail}`,
        false,
        res.status,
      );
    }

    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new FlowError('FLOW_BRIDGE_ERROR', 'bridge returned invalid JSON', true, res.status, err);
    }
  }

  return {
    async submitPrompt(prompt, aspectRatio = '16:9') {
      const data = await call<{ taskId: string }>('POST', '/submit', { prompt, aspectRatio });
      if (!data?.taskId) {
        throw new FlowError('FLOW_BRIDGE_ERROR', 'bridge /submit missing taskId', true);
      }
      return data.taskId;
    },
    async poll(taskId) {
      const data = await call<{ status: FlowTaskStatus; error?: string }>(
        'GET',
        `/poll/${encodeURIComponent(taskId)}`,
      );
      const status = data?.status ?? 'pending';
      if (status === 'failed' && data?.error) {
        // We surface the error message back through poll() callers via a
        // FlowError that the step can decide whether to retry on. Content-
        // policy rejections look like `error: "...content policy..."`.
        const lower = data.error.toLowerCase();
        const retriable = lower.includes('content') || lower.includes('policy');
        throw new FlowError(
          retriable ? 'FLOW_PROMPT_REJECTED' : 'FLOW_TASK_FAILED',
          `task ${taskId} failed: ${data.error.slice(0, 200)}`,
          retriable,
        );
      }
      return status;
    },
    async download(taskId, destPath) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      const url = `${baseUrl}/download/${encodeURIComponent(taskId)}`;
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), BRIDGE_TIMEOUT_MS * 4);
      let res: Response;
      try {
        res = await fetchImpl(url, { method: 'GET', signal: ac.signal });
      } catch (err) {
        clearTimeout(timeout);
        const cause = err as { name?: string; code?: string; message?: string };
        if (cause?.name === 'AbortError') {
          throw new FlowError('FLOW_BRIDGE_TIMEOUT', `download ${taskId} timed out`, true, undefined, err);
        }
        throw new FlowError('FLOW_BRIDGE_UNREACHABLE', `download failed: ${cause?.message ?? ''}`, true, undefined, err);
      }
      clearTimeout(timeout);
      if (!res.ok) {
        throw new FlowError(
          'FLOW_DOWNLOAD_FAILED',
          `bridge /download/${taskId} -> ${res.status}`,
          res.status >= 500,
          res.status,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(destPath, buf);
    },
  };
}
