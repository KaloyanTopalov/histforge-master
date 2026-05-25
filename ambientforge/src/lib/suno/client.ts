import fs from 'node:fs';
import path from 'node:path';
import { getRawSetting } from '@/lib/settings';
import type { SunoMode } from '@/lib/repos/channels';

export class SunoError extends Error {
  readonly code: string;
  readonly retriable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  constructor(code: string, message: string, retriable: boolean, status?: number, cause?: unknown) {
    super(message);
    this.name = 'SunoError';
    this.code = code;
    this.retriable = retriable;
    this.status = status;
    this.cause = cause;
  }
}

export type SunoTaskStatus = 'pending' | 'ready' | 'failed';

export type SubmitOpts = {
  stylePrompt: string;
  lyrics: string;
  model: string;
  mode: SunoMode;
  instrumental: boolean;
  personaId?: string | null;
  title?: string;
};

export interface SunoClient {
  submit(opts: SubmitOpts): Promise<string>;
  /** Suno-dual-variant: submit ONE generation and return BOTH of Suno's
   * clip ids (Suno always produces 2 per generation). Optional — only the
   * bridge + mock clients implement it; legacy callers use submit(). */
  submitClips?(opts: SubmitOpts): Promise<{ taskId: string; clipIds: string[] }>;
  poll(taskId: string): Promise<SunoTaskStatus>;
  /** clipIndex absent/0 = legacy single-clip download (byte-identical to
   * pre-dual-variant). Pass 1 to fetch the second clip of the same task. */
  download(taskId: string, destPath: string, clipIndex?: number): Promise<void>;
  getCredits(): Promise<number>;
}

const DEFAULT_BRIDGE_URL = 'http://localhost:7341';
const BRIDGE_TIMEOUT_MS = 30_000;
// /submit may sit through suno_bot.py's BrowserCaptchaSolver (120s ceiling).
// The bridge gives /submit 180s; we wait slightly longer here so the bridge's
// timeout fires first and the worker gets a clean error code instead of an
// AbortError mid-response.
const BRIDGE_SUBMIT_TIMEOUT_MS = 200_000;

export type SunoClientOpts = {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
};

export function makeSunoClient(opts: SunoClientOpts = {}): SunoClient {
  if (process.env.SUNO_MODE === 'mock') {
    return makeMockSunoClient();
  }
  return makeBridgeSunoClient(opts);
}

// ---------------------------------------------------------------------------
// Mock client
// ---------------------------------------------------------------------------

const FIXTURES = ['fixture-01.wav', 'fixture-02.wav', 'fixture-03.wav'];

type MockTask = {
  stylePrompt: string;
  lyrics: string;
  fixtureIdx: number;
  model: string;
  mode: SunoMode;
  instrumental: boolean;
  personaId: string | null;
  title: string;
};

type MockState = {
  counter: number;
  tasks: Map<string, MockTask>;
};

const mockState: MockState = {
  counter: 0,
  tasks: new Map(),
};

/** Test-only: reset the mock counter / task map between runs. */
export function __resetMockSunoState(): void {
  mockState.counter = 0;
  mockState.tasks.clear();
}

export function makeMockSunoClient(): SunoClient {
  function doSubmit(opts: SubmitOpts): string {
    if (opts.mode === 'persona') {
      throw new SunoError(
        'PERSONA_PAYLOAD_NOT_CAPTURED',
        'persona mode plumbing in place; payload field name needs network capture',
        false,
      );
    }
    mockState.counter += 1;
    const taskId = `mock-task-${String(mockState.counter).padStart(4, '0')}`;
    mockState.tasks.set(taskId, {
      stylePrompt: opts.stylePrompt,
      lyrics: opts.lyrics,
      fixtureIdx: (mockState.counter - 1) % FIXTURES.length,
      model: opts.model,
      mode: opts.mode,
      instrumental: opts.instrumental,
      personaId: opts.personaId ?? null,
      title: opts.title ?? '',
    });
    return taskId;
  }
  return {
    async submit(opts) {
      return doSubmit(opts);
    },
    async submitClips(opts) {
      // One mock generation → two synthetic clip ids (mirrors Suno's pair).
      // The mock keys downloads by taskId + clipIndex, so the ids are
      // informational; step 04 still passes the per-track clip index.
      const taskId = doSubmit(opts);
      return { taskId, clipIds: [`${taskId}#0`, `${taskId}#1`] };
    },
    async poll(taskId) {
      if (!mockState.tasks.has(taskId)) return 'failed';
      return 'ready';
    },
    async download(taskId, destPath, clipIndex = 0) {
      const task = mockState.tasks.get(taskId);
      if (!task) {
        throw new SunoError('SUNO_TASK_FAILED', `unknown mock taskId ${taskId}`, false);
      }
      // clipIndex 0 → FIXTURES[task.fixtureIdx] (byte-identical to the
      // pre-dual-variant mock). clipIndex 1 → the next fixture, so a paired
      // dual-variant album yields two distinct mock songs.
      const fixturePath = path.join(
        process.cwd(),
        'tests',
        'fixtures',
        'suno',
        FIXTURES[(task.fixtureIdx + clipIndex) % FIXTURES.length],
      );
      if (!fs.existsSync(fixturePath)) {
        throw new SunoError(
          'SUNO_DOWNLOAD_FAILED',
          `mock fixture missing: ${fixturePath} — run scripts/setup-fixtures or tests/fixtures/suno/setup.ts`,
          false,
        );
      }
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(fixturePath, destPath);
    },
    async getCredits() {
      const raw = getRawSetting('suno_mock_credits');
      const n = raw === undefined || raw === '' ? 100 : Number(raw);
      return Number.isFinite(n) ? n : 100;
    },
  };
}

// ---------------------------------------------------------------------------
// Bridge HTTP client (real)
// ---------------------------------------------------------------------------

async function readBridgeError(
  res: Response,
  fallbackCode: string,
): Promise<{ code: string; detail: string }> {
  try {
    const text = await res.text();
    if (!text) return { code: fallbackCode, detail: '' };
    try {
      const parsed = JSON.parse(text) as { code?: string; detail?: string };
      const code = typeof parsed?.code === 'string' && parsed.code.length > 0 ? parsed.code : fallbackCode;
      const detail = typeof parsed?.detail === 'string' ? parsed.detail.slice(0, 400) : '';
      return { code, detail };
    } catch {
      return { code: fallbackCode, detail: text.slice(0, 400) };
    }
  } catch {
    return { code: fallbackCode, detail: '' };
  }
}

export function makeBridgeSunoClient(opts: SunoClientOpts = {}): SunoClient {
  const baseUrl = opts.baseUrl ?? DEFAULT_BRIDGE_URL;
  const fetchImpl = opts.fetchImpl ?? fetch;

  async function call<T>(
    method: string,
    urlPath: string,
    body?: unknown,
    timeoutMs: number = BRIDGE_TIMEOUT_MS,
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
        throw new SunoError('SUNO_BRIDGE_TIMEOUT', `${method} ${urlPath} timed out`, true, undefined, err);
      }
      const code = cause?.code ?? '';
      const msg = cause?.message ?? '';
      if (code === 'ECONNREFUSED' || msg.includes('ECONNREFUSED')) {
        throw new SunoError('SUNO_BRIDGE_UNREACHABLE', `bridge unreachable at ${baseUrl}`, true, undefined, err);
      }
      throw new SunoError('SUNO_BRIDGE_UNREACHABLE', `bridge call failed: ${msg}`, true, undefined, err);
    } finally {
      clearTimeout(timeout);
    }

    if (res.status === 401) {
      // Bridge body may include a more specific code (e.g. SUNO_COOKIE_ROTATED).
      // Default to SUNO_AUTH for backward compatibility.
      let code = 'SUNO_AUTH';
      let detail = 'bridge rejected request';
      try {
        const bodyText = await res.text();
        if (bodyText) {
          const parsed = JSON.parse(bodyText) as { code?: string; detail?: string };
          if (typeof parsed?.code === 'string' && parsed.code.length > 0) {
            code = parsed.code;
          }
          if (typeof parsed?.detail === 'string') {
            detail = parsed.detail;
          }
        }
      } catch {
        /* fall back to defaults */
      }
      throw new SunoError(code, detail, false, 401);
    }
    if (res.status === 409) {
      throw new SunoError('SUNO_CAPTCHA', 'bridge reports captcha required', false, 409);
    }
    if (res.status === 402) {
      throw new SunoError('INSUFFICIENT_SUNO_CREDITS', 'bridge reports insufficient credits', false, 402);
    }
    if (res.status === 429) {
      const { code, detail } = await readBridgeError(res, 'SUNO_RATE_LIMITED');
      throw new SunoError(code, detail || `bridge responded 429`, true, 429);
    }
    if (res.status >= 500) {
      // 5xx: bridge body should carry the masked sidecar code+message via bridgeError (bridge.ts:243).
      // Surface them so step 03 logs the real cause instead of just "bridge responded 502".
      const { code, detail } = await readBridgeError(res, 'SUNO_BRIDGE_ERROR');
      throw new SunoError(
        code,
        `bridge responded ${res.status}: ${detail || '(no body)'}`,
        true,
        res.status,
      );
    }
    if (!res.ok) {
      const { code, detail } = await readBridgeError(res, 'SUNO_BRIDGE_ERROR');
      throw new SunoError(
        code,
        `bridge ${method} ${urlPath} -> ${res.status}: ${detail || '(no body)'}`,
        false,
        res.status,
      );
    }

    if (res.status === 204) return undefined as T;
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new SunoError('SUNO_BRIDGE_ERROR', 'bridge returned invalid JSON', true, res.status, err);
    }
  }

  return {
    async submit(opts) {
      const data = await call<{ taskId: string }>(
        'POST',
        '/submit',
        {
          stylePrompt: opts.stylePrompt,
          lyrics: opts.lyrics,
          model: opts.model,
          mode: opts.mode,
          instrumental: opts.instrumental,
          personaId: opts.personaId ?? null,
          title: opts.title ?? '',
        },
        BRIDGE_SUBMIT_TIMEOUT_MS,
      );
      if (!data?.taskId) {
        throw new SunoError('SUNO_BRIDGE_ERROR', 'bridge /submit missing taskId', true);
      }
      return data.taskId;
    },
    async submitClips(opts) {
      const data = await call<{ taskId: string; clipIds: string[] }>(
        'POST',
        '/submit',
        {
          stylePrompt: opts.stylePrompt,
          lyrics: opts.lyrics,
          model: opts.model,
          mode: opts.mode,
          instrumental: opts.instrumental,
          personaId: opts.personaId ?? null,
          title: opts.title ?? '',
        },
        BRIDGE_SUBMIT_TIMEOUT_MS,
      );
      if (!data?.taskId) {
        throw new SunoError('SUNO_BRIDGE_ERROR', 'bridge /submit missing taskId', true);
      }
      const clipIds = Array.isArray(data.clipIds) ? data.clipIds : [];
      if (clipIds.length === 0) {
        throw new SunoError(
          'SUNO_BRIDGE_ERROR',
          'bridge /submit returned no clipIds (dual-variant requires both)',
          true,
        );
      }
      return { taskId: data.taskId, clipIds };
    },
    async poll(taskId) {
      const data = await call<{ status: SunoTaskStatus }>('GET', `/poll/${encodeURIComponent(taskId)}`);
      return data?.status ?? 'pending';
    },
    async download(taskId, destPath, clipIndex) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      // The bridge delivers the file body itself via this POST. The client decides
      // the filesystem destination — we don't trust the bridge to write to disk.
      // clipIndex omitted → no ?clip → bridge/sidecar default to clip 0
      // (byte-identical to the pre-dual-variant download path).
      const q =
        clipIndex == null ? '' : `?clip=${encodeURIComponent(String(clipIndex))}`;
      const url = `${baseUrl}/download/${encodeURIComponent(taskId)}${q}`;
      const ac = new AbortController();
      const timeout = setTimeout(() => ac.abort(), BRIDGE_TIMEOUT_MS * 4);
      let res: Response;
      try {
        res = await fetchImpl(url, { method: 'POST', signal: ac.signal });
      } catch (err) {
        clearTimeout(timeout);
        const cause = err as { name?: string; code?: string; message?: string };
        if (cause?.name === 'AbortError') {
          throw new SunoError('SUNO_BRIDGE_TIMEOUT', `download ${taskId} timed out`, true, undefined, err);
        }
        throw new SunoError('SUNO_BRIDGE_UNREACHABLE', `download failed: ${cause?.message ?? ''}`, true, undefined, err);
      }
      clearTimeout(timeout);
      if (!res.ok) {
        throw new SunoError(
          'SUNO_DOWNLOAD_FAILED',
          `bridge /download/${taskId} -> ${res.status}`,
          res.status >= 500,
          res.status,
        );
      }
      const buf = Buffer.from(await res.arrayBuffer());
      await fs.promises.writeFile(destPath, buf);
    },
    async getCredits() {
      const data = await call<{ credits: number }>('GET', '/credits');
      const n = Number(data?.credits);
      if (!Number.isFinite(n)) {
        throw new SunoError('SUNO_BRIDGE_ERROR', 'bridge /credits missing credits', true);
      }
      return n;
    },
  };
}
