/**
 * distrokid-runner bridge — Node HTTP server that mediates between the
 * AmbientForge worker (client face) and the distrokid-runner Chrome extension
 * (executor face). Same pull-poll contract as the suno-runner bridge.
 *
 *   worker ──POST /verify_artist──▶ bridge ──pending q──▶ extension (GET /next-action)
 *                                                                   │
 *   worker ◀────{found, ...}──── bridge ◀──/action-result───────────┘
 *
 * Mock mode in the worker (DISTROKID_MODE=mock) bypasses the bridge entirely.
 * This server only matters when the operator has set up a real DistroKid
 * session via `npm run distrokid:login` and started the extension.
 *
 * Run: `npx tsx extensions/distrokid-runner/bridge.ts` or `npm run distrokid:bridge`.
 */

import { promises as fsp } from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.DISTROKID_BRIDGE_PORT ?? 7342);
const ALLOWED_ORIGIN = process.env.DISTROKID_BRIDGE_ALLOWED_ORIGIN ?? 'http://localhost:3003';
const LONG_POLL_TIMEOUT_MS = 25_000;

type ActionType =
  | 'verify_artist'
  | 'start_release'
  | 'set_metadata'
  | 'upload_cover'
  | 'upload_track'
  | 'verify_track_count'
  | 'submit_or_screenshot'
  | 'focus_window';

type PendingAction = {
  id: string;
  type: ActionType;
  payload: unknown;
  enqueuedAt: number;
  resolve: (data: unknown) => void;
  reject: (err: unknown) => void;
};

let actionCounter = 0;
const queue: PendingAction[] = [];
const inFlight = new Map<string, PendingAction>();
const longPollers: Array<(action: PendingAction | null) => void> = [];

function nextId(): string {
  actionCounter += 1;
  return `dk-${Date.now().toString(36)}-${actionCounter}`;
}

function enqueue<T = unknown>(type: ActionType, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const action: PendingAction = {
      id: nextId(),
      type,
      payload,
      enqueuedAt: Date.now(),
      resolve: resolve as (d: unknown) => void,
      reject,
    };
    queue.push(action);
    drainLongPollers();
  });
}

function drainLongPollers(): void {
  while (longPollers.length > 0 && queue.length > 0) {
    const waiter = longPollers.shift()!;
    const action = queue.shift()!;
    inFlight.set(action.id, action);
    waiter(action);
  }
}

function takeNext(timeoutMs: number): Promise<PendingAction | null> {
  if (queue.length > 0) {
    const action = queue.shift()!;
    inFlight.set(action.id, action);
    return Promise.resolve(action);
  }
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = longPollers.indexOf(waiter);
      if (idx >= 0) longPollers.splice(idx, 1);
      resolve(null);
    }, timeoutMs);
    const waiter = (action: PendingAction | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(action);
    };
    longPollers.push(waiter);
  });
}

// -------------------------------------------------------------------------
// HTTP helpers
// -------------------------------------------------------------------------

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

async function readRawBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

// -------------------------------------------------------------------------
// Route table
// -------------------------------------------------------------------------

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

    // ---------------- health ----------------
    if (method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        status: 'ok',
        queueDepth: queue.length,
        inFlight: inFlight.size,
        waiters: longPollers.length,
      });
      return;
    }

    // ---------------- client face (worker -> bridge) ----------------
    if (method === 'POST' && url.pathname === '/verify_artist') {
      const body = (await readJsonBody(req)) as { artistName?: string };
      const data = await enqueue('verify_artist', { artistName: body.artistName ?? '' });
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/start_release') {
      const data = await enqueue('start_release', {});
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/set_metadata') {
      const body = await readJsonBody(req);
      const data = await enqueue('set_metadata', body);
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/upload_cover') {
      const body = await readJsonBody(req);
      const data = await enqueue('upload_cover', body);
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/upload_track') {
      const body = await readJsonBody(req);
      const data = await enqueue('upload_track', body);
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/verify_track_count') {
      const body = await readJsonBody(req);
      const data = await enqueue('verify_track_count', body);
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/submit_or_screenshot') {
      const body = await readJsonBody(req);
      const data = await enqueue('submit_or_screenshot', body);
      sendJson(res, 200, data);
      return;
    }

    if (method === 'POST' && url.pathname === '/focus_window') {
      const data = await enqueue('focus_window', {});
      sendJson(res, 200, data);
      return;
    }

    // ---------------- extension face ----------------
    if (method === 'GET' && url.pathname === '/next-action') {
      const action = await takeNext(LONG_POLL_TIMEOUT_MS);
      if (!action) {
        sendEmpty(res, 204);
        return;
      }
      sendJson(res, 200, {
        id: action.id,
        type: action.type,
        payload: action.payload,
        enqueuedAt: action.enqueuedAt,
      });
      return;
    }

    // Screenshot upload route. The extension's background SW captures the
    // visible tab via chrome.tabs.captureVisibleTab and POSTs the raw PNG
    // bytes here. We look up the in-flight action by id, read its
    // screenshotPath from the original payload, and write the bytes to disk.
    // Action stays in-flight (the extension's content script awaits this
    // confirmation before resolving submit_or_screenshot).
    if (method === 'POST' && url.pathname.startsWith('/upload-screenshot/')) {
      const id = decodeURIComponent(url.pathname.slice('/upload-screenshot/'.length));
      const action = inFlight.get(id);
      if (!action) {
        sendJson(res, 404, { error: 'UNKNOWN_ACTION' });
        return;
      }
      const payload = (action.payload ?? {}) as { screenshotPath?: string };
      if (!payload.screenshotPath) {
        sendJson(res, 400, { error: 'NO_SCREENSHOT_PATH_IN_ACTION_PAYLOAD' });
        return;
      }
      const bytes = await readRawBody(req);
      try {
        await fsp.writeFile(payload.screenshotPath, bytes);
      } catch (err) {
        sendJson(res, 500, { error: 'WRITE_FAILED', detail: String(err) });
        return;
      }
      sendJson(res, 200, { ok: true, bytes: bytes.length, path: payload.screenshotPath });
      return;
    }

    if (method === 'POST' && url.pathname.startsWith('/action-result/')) {
      const id = decodeURIComponent(url.pathname.slice('/action-result/'.length));
      const action = inFlight.get(id);
      if (!action) {
        sendJson(res, 404, { error: 'UNKNOWN_ACTION' });
        return;
      }
      inFlight.delete(id);
      const body = (await readJsonBody(req)) as { ok?: boolean; result?: unknown; error?: string };
      if (body.ok === false) {
        action.reject(new Error(body.error ?? 'extension reported failure'));
      } else {
        action.resolve(body.result ?? {});
      }
      sendEmpty(res, 204);
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND', method, path: url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: 'BRIDGE_ERROR', detail: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[distrokid-bridge] listening on http://localhost:${PORT}`);
  console.log(`[distrokid-bridge] CORS origin: ${ALLOWED_ORIGIN}`);
});

process.on('SIGINT', () => {
  console.log('[distrokid-bridge] SIGINT — shutting down');
  server.close(() => process.exit(0));
});
