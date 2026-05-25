/**
 * suno-runner bridge — Node HTTP server that mediates between the AmbientForge
 * worker (HTTP face on :7341) and the Python sidecar (JSON-RPC over stdio).
 *
 * Replaces the prior extension-driven design (Session 4 era). Per
 * `docs/suno-sidecar-plan.md`, the Chrome extension is retired; this bridge
 * spawns `python sidecars/suno/sidecar.py` and proxies AmbientForge's
 * /submit /poll/:id /download/:id /credits routes to it.
 *
 *   worker ──HTTP──▶ bridge ──JSON-RPC stdio──▶ python sidecar ──HTTPS──▶ Suno
 *
 * Crash handling: on stdio close, pending RPCs are rejected with
 * SUNO_SIDECAR_CRASHED (retriable) and the child is respawned with
 * exponential backoff (1s, 2s, 4s, … 30s cap).
 *
 * Run: `npx tsx extensions/suno-runner/bridge.ts` or `npm run suno:bridge`.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { URL } from 'node:url';
import { ensureChromeRunning, startChromeWatchdog } from './chrome-manager';

const PORT = Number(process.env.SUNO_BRIDGE_PORT ?? 7341);
const ALLOWED_ORIGIN = process.env.SUNO_BRIDGE_ALLOWED_ORIGIN ?? 'http://localhost:3003';
const PYTHON_BIN = process.env.SUNO_PYTHON ?? 'python';
const SIDECAR_SCRIPT = path.resolve(process.cwd(), 'sidecars', 'suno', 'sidecar.py');
const RPC_TIMEOUT_MS = 60_000;
// /submit may fall back to BrowserCaptchaSolver in suno_bot.py which has its
// own 120s deadline (see suno_bot.py:305 — captcha solve + Suno's own queue).
// 180s gives 50% headroom; we never want the bridge to bail before the solver
// would have surfaced its own success or failure.
const RPC_SUBMIT_TIMEOUT_MS = 180_000;
const RPC_DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const RESPAWN_BACKOFFS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

// ---------------------------------------------------------------------------
// Sidecar manager
// ---------------------------------------------------------------------------

type Pending = {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

class SunoSidecar {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private respawnAttempts = 0;
  private stdoutBuf = '';
  private alive = false;

  start(): void {
    if (this.child) return;
    if (!fs.existsSync(SIDECAR_SCRIPT)) {
      console.error(`[suno-bridge] FATAL: sidecar script not found at ${SIDECAR_SCRIPT}`);
      process.exit(2);
    }
    console.error(`[suno-bridge] spawning ${PYTHON_BIN} ${SIDECAR_SCRIPT}`);
    const child = spawn(PYTHON_BIN, [SIDECAR_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.child = child;
    this.alive = true;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => process.stderr.write(`[sidecar] ${chunk}`));

    child.on('exit', (code, signal) => {
      console.error(`[suno-bridge] sidecar exited code=${code} signal=${signal}`);
      this.alive = false;
      this.failAllPending(
        `SUNO_SIDECAR_CRASHED: sidecar exited code=${code} signal=${signal}`,
      );
      this.child = null;
      this.scheduleRespawn();
    });
    child.on('error', (err) => {
      console.error(`[suno-bridge] sidecar spawn error: ${err.message}`);
      this.alive = false;
    });
  }

  private scheduleRespawn(): void {
    const idx = Math.min(this.respawnAttempts, RESPAWN_BACKOFFS_MS.length - 1);
    const delay = RESPAWN_BACKOFFS_MS[idx];
    this.respawnAttempts += 1;
    console.error(
      `[suno-bridge] respawn attempt ${this.respawnAttempts} in ${delay}ms`,
    );
    setTimeout(() => this.start(), delay);
  }

  private onStdout(chunk: string): void {
    this.stdoutBuf += chunk;
    let nl: number;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg: { id?: number; result?: unknown; error?: { code: string; message: string }; event?: string };
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.error(`[suno-bridge] non-JSON line from sidecar: ${line.slice(0, 200)}`);
        continue;
      }
      if (msg.event === 'ready') {
        this.respawnAttempts = 0;
        console.error('[suno-bridge] sidecar ready');
        continue;
      }
      const id = msg.id;
      if (typeof id !== 'number') continue;
      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);
      if (msg.error) {
        const err = new Error(msg.error.message) as Error & { code?: string };
        err.code = msg.error.code;
        pending.reject(err);
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private failAllPending(message: string): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      const err = new Error(message) as Error & { code?: string };
      err.code = 'SUNO_SIDECAR_CRASHED';
      p.reject(err);
    }
    this.pending.clear();
  }

  call<T = unknown>(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    if (!this.child || !this.alive) {
      return Promise.reject(
        Object.assign(new Error('sidecar not running'), { code: 'SUNO_SIDECAR_CRASHED' }),
      );
    }
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const err = Object.assign(new Error(`sidecar ${method} timed out after ${timeoutMs}ms`), {
          code: 'SUNO_BRIDGE_TIMEOUT',
        });
        reject(err);
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject, timer });
      const payload = JSON.stringify({ id, method, params }) + '\n';
      this.child!.stdin.write(payload, 'utf-8');
    });
  }

  isAlive(): boolean {
    return this.alive;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Force a clean restart: kill the current sidecar (if any), then immediately
   * spawn a new one. Pending RPCs are rejected with SUNO_SIDECAR_CRASHED so
   * callers retry against the fresh sidecar. Used by the Chrome watchdog
   * after a Chrome respawn so the sidecar re-reads SUNO_COOKIE from .env
   * with whatever value Clerk has rotated to.
   */
  restart(): void {
    if (this.child) {
      console.error(`[suno-bridge] restart: killing sidecar pid=${this.child.pid}`);
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* if it's already gone, the exit handler will respawn */
      }
      // The 'exit' handler will null out this.child and schedule a respawn
      // via scheduleRespawn(). Force an immediate spawn instead by clearing
      // the respawn counter so the operator-driven restart isn't subjected
      // to backoff.
      this.respawnAttempts = 0;
    } else {
      // Already dead — just (re)start.
      this.start();
    }
  }
}

const sidecar = new SunoSidecar();

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function setCors(res: http.ServerResponse): void {
  res.setHeader('access-control-allow-origin', ALLOWED_ORIGIN);
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  setCors(res);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendEmpty(res: http.ServerResponse, status: number): void {
  setCors(res);
  res.statusCode = status;
  res.end();
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function mapSidecarErrorToStatus(code: string | undefined): number {
  switch (code) {
    case 'SUNO_AUTH':
    case 'SUNO_COOKIE_ROTATED':
      return 401;
    case 'SUNO_CAPTCHA':
    case 'CAPTCHA_BROWSER_UNREACHABLE':
    case 'CAPTCHA_SOLVE_FAILED':
      return 409;
    case 'INSUFFICIENT_SUNO_CREDITS':
      return 402;
    case 'SUNO_RATE_LIMITED':
      return 429;
    case 'PERSONA_PAYLOAD_NOT_CAPTURED':
    case 'INVALID_MODE':
    case 'BAD_REQUEST':
    case 'UNKNOWN_TASK':
      return 400;
    case 'SUNO_BRIDGE_TIMEOUT':
    case 'SUNO_SIDECAR_CRASHED':
      return 503;
    default:
      return 502;
  }
}

function bridgeError(res: http.ServerResponse, err: unknown): void {
  const e = err as { code?: string; message?: string };
  const code = e.code ?? 'SUNO_BRIDGE_ERROR';
  const status = mapSidecarErrorToStatus(code);
  // Include `code` in the body so the worker can disambiguate codes that
  // share an HTTP status (e.g. SUNO_AUTH vs SUNO_COOKIE_ROTATED on 401).
  sendJson(res, status, { code, error: code, detail: e.message ?? String(err) });
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
      setCors(res);
      res.statusCode = 204;
      res.end();
      return;
    }

    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        sidecarAlive: sidecar.isAlive(),
        sidecarPid: sidecar.pid(),
        pending: sidecar.pendingCount(),
      });
      return;
    }

    if (method === 'POST' && url.pathname === '/submit') {
      const body = (await readJsonBody(req)) as {
        stylePrompt?: string;
        lyrics?: string;
        model?: string;
        mode?: string;
        instrumental?: boolean;
        personaId?: string | null;
        title?: string;
      };
      try {
        const data = await sidecar.call<{ taskId: string; clipIds: string[] }>(
          'submit',
          {
            stylePrompt: body.stylePrompt ?? '',
            lyrics: body.lyrics ?? '',
            model: body.model ?? 'chirp-fenix',
            mode: body.mode ?? 'custom',
            instrumental: !!body.instrumental,
            personaId: body.personaId ?? null,
            title: body.title ?? '',
          },
          RPC_SUBMIT_TIMEOUT_MS,
        );
        // clipIds is additive — legacy callers read only taskId and are
        // unaffected. Suno-dual-variant step 03 uses both ids of the pair.
        sendJson(res, 200, { taskId: data.taskId, clipIds: data.clipIds });
      } catch (err) {
        bridgeError(res, err);
      }
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/poll/')) {
      const taskId = decodeURIComponent(url.pathname.slice('/poll/'.length));
      try {
        const data = await sidecar.call<{ status: 'pending' | 'ready' | 'failed' }>('poll', {
          taskId,
        });
        sendJson(res, 200, { status: data.status });
      } catch (err) {
        bridgeError(res, err);
      }
      return;
    }

    if (method === 'POST' && url.pathname.startsWith('/download/')) {
      const taskId = decodeURIComponent(url.pathname.slice('/download/'.length));
      // ?clip=N (Suno-dual-variant): which of the generation's clips to fetch.
      // Absent → sidecar defaults to clip 0 = byte-identical legacy behavior.
      const clipParam = url.searchParams.get('clip');
      const clipIndex =
        clipParam == null || clipParam === '' ? undefined : Number(clipParam);
      try {
        const data = await sidecar.call<{ path: string; bytes: number }>(
          'download_wav',
          { taskId, clipIndex },
          RPC_DOWNLOAD_TIMEOUT_MS,
        );
        const buf = await fs.promises.readFile(data.path);
        setCors(res);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/octet-stream');
        res.setHeader('content-length', String(buf.length));
        res.end(buf);
        // Best-effort cleanup; sidecar-owned tmp file.
        fs.promises.unlink(data.path).catch(() => undefined);
      } catch (err) {
        bridgeError(res, err);
      }
      return;
    }

    if (method === 'GET' && url.pathname === '/credits') {
      try {
        const data = await sidecar.call<{ credits: number }>('credits', {});
        sendJson(res, 200, { credits: data.credits });
      } catch (err) {
        bridgeError(res, err);
      }
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND', method, path: url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: 'BRIDGE_ERROR', detail: String(err) });
  }
});

server.listen(PORT, async () => {
  console.error(`[suno-bridge] listening on http://localhost:${PORT}`);
  console.error(`[suno-bridge] CORS origin: ${ALLOWED_ORIGIN}`);
  // Spin up Chrome (no-op if it's already alive on the CDP port). The
  // first-time login flow (`npm run suno:login`) is unchanged — but after
  // the operator has logged in once, `npm run dev` will keep Chrome alive
  // automatically across crashes / closed windows. Profile persists cookies
  // so re-spawned Chrome remains logged into Suno.
  const chromeReady = await ensureChromeRunning();
  if (!chromeReady) {
    console.error(
      "[suno-bridge] WARNING: Chrome not available. Suno submissions will fail with SIDECAR_INTERNAL until Chrome is reachable. Run `npm run suno:login` to capture cookies if this is the first time.",
    );
  }
  sidecar.start();
  // Watchdog: pings CDP every 30s. On Chrome death (closed window, crash),
  // respawns Chrome with the saved profile, refreshes the cookie via CDP,
  // and asks the sidecar to restart so it picks up the new cookie. Albums
  // paused with status='awaiting_suno_relogin' will be auto-resumed by the
  // worker (Phase 3) once the bridge ping returns healthy again.
  startChromeWatchdog({
    onChromeRecovered: () => {
      console.error(
        '[suno-bridge] Chrome recovered, restarting sidecar to pick up refreshed cookie',
      );
      sidecar.restart();
    },
  });
});

process.on('SIGINT', () => {
  console.error('[suno-bridge] SIGINT — shutting down');
  server.close(() => process.exit(0));
});
