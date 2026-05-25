/**
 * flow-runner bridge — Node HTTP server that mediates between the AmbientForge
 * worker (client face) and the AmbientForge Flow Runner Chrome extension
 * (executor face).
 *
 * Unlike the suno-runner bridge (which fits a single pull-poll model), the
 * Flow extension was originally built to talk to HistForge HTTPS webhooks at
 * three named URLs (poll / result / status). This bridge speaks BOTH
 * dialects:
 *
 *   - Worker face  (mirrors suno-runner client contract):
 *       POST /submit              -> { taskId }
 *       GET  /poll/:taskId        -> { status, error? }
 *       GET  /download/:taskId    -> image/png
 *
 *   - Extension face (the YouForge webhook contract the extension expects):
 *       POST /poll                -> next task or {} when queue empty
 *       POST /result              -> success { mediaFiles[] } | failure { error }
 *       POST /status              -> log-only; { event: 'session_expired' | ... }
 *
 * Mock mode in the worker (FLOW_MODE=mock) bypasses the bridge entirely;
 * this server only runs when the operator has set up a real Flow session
 * via `npm run flow:login` and started the extension.
 *
 * Run: `npx tsx extensions/flow-runner/bridge.ts` or `npm run flow:bridge`.
 */

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.FLOW_BRIDGE_PORT ?? 7343);
const ALLOWED_ORIGIN = process.env.FLOW_BRIDGE_ALLOWED_ORIGIN ?? 'http://localhost:3003';

type TaskAspect = '1:1' | '16:9' | '9:16';
type TaskStatus = 'pending' | 'dispatched' | 'ready' | 'failed';

type Task = {
  id: string;
  prompt: string;
  aspectRatio: TaskAspect;
  status: TaskStatus;
  enqueuedAt: number;
  dispatchedAt?: number;
  /** Decoded image bytes, set by /result. */
  bytes?: Buffer;
  /** Mime type from the extension's mediaFiles[0]. */
  mimeType?: string;
  /** Failure detail when status='failed'. */
  error?: string;
};

let taskCounter = 0;
const tasks = new Map<string, Task>();

function nextId(): string {
  taskCounter += 1;
  return `flow-task-${Date.now().toString(36)}-${taskCounter}`;
}

function nextPendingTask(): Task | null {
  for (const t of tasks.values()) {
    if (t.status === 'pending') return t;
  }
  return null;
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

function sendBytes(
  res: http.ServerResponse,
  status: number,
  bytes: Buffer,
  mimeType = 'image/png',
): void {
  setCors(res);
  res.statusCode = status;
  res.setHeader('content-type', mimeType);
  res.end(bytes);
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
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function parseAspect(raw: unknown): TaskAspect {
  const s = typeof raw === 'string' ? raw.toLowerCase() : '';
  if (s === '1:1' || s === 'square') return '1:1';
  if (s === '9:16' || s === 'portrait') return '9:16';
  return '16:9';
}

// -------------------------------------------------------------------------
// Route handlers
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

    // -------- health --------
    if (method === 'GET' && url.pathname === '/health') {
      let pending = 0;
      let dispatched = 0;
      let ready = 0;
      let failed = 0;
      for (const t of tasks.values()) {
        if (t.status === 'pending') pending++;
        else if (t.status === 'dispatched') dispatched++;
        else if (t.status === 'ready') ready++;
        else if (t.status === 'failed') failed++;
      }
      sendJson(res, 200, { status: 'ok', pending, dispatched, ready, failed });
      return;
    }

    // ============ Worker face ============

    if (method === 'POST' && url.pathname === '/submit') {
      const body = (await readJsonBody(req)) as { prompt?: string; aspectRatio?: string };
      const prompt = (body.prompt ?? '').trim();
      if (prompt.length === 0) {
        sendJson(res, 400, { error: 'MISSING_PROMPT' });
        return;
      }
      const id = nextId();
      const task: Task = {
        id,
        prompt,
        aspectRatio: parseAspect(body.aspectRatio),
        status: 'pending',
        enqueuedAt: Date.now(),
      };
      tasks.set(id, task);
      sendJson(res, 200, { taskId: id });
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/poll/')) {
      const taskId = decodeURIComponent(url.pathname.slice('/poll/'.length));
      const task = tasks.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: 'UNKNOWN_TASK', taskId });
        return;
      }
      if (task.status === 'failed') {
        sendJson(res, 200, { status: 'failed', error: task.error ?? 'unknown' });
        return;
      }
      if (task.status === 'ready') {
        sendJson(res, 200, { status: 'ready' });
        return;
      }
      sendJson(res, 200, { status: 'pending' });
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/download/')) {
      const taskId = decodeURIComponent(url.pathname.slice('/download/'.length));
      const task = tasks.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: 'UNKNOWN_TASK', taskId });
        return;
      }
      if (task.status !== 'ready' || !task.bytes) {
        sendJson(res, 409, { error: 'NOT_READY', status: task.status });
        return;
      }
      sendBytes(res, 200, task.bytes, task.mimeType ?? 'image/png');
      return;
    }

    // ============ Extension face ============

    // The extension polls with `POST /poll` body
    //   { type: 'TaskRequest', accountToken, mode }
    // and expects either a task body or `{}` (no task).
    if (method === 'POST' && url.pathname === '/poll') {
      // Account token validation deliberately permissive in dev; the bridge
      // sits on localhost only. Tighten if exposed beyond loopback.
      await readJsonBody(req); // drain body; we don't care about the contents in v1
      const task = nextPendingTask();
      if (!task) {
        sendJson(res, 200, {});
        return;
      }
      task.status = 'dispatched';
      task.dispatchedAt = Date.now();
      sendJson(res, 200, {
        id: task.id,
        mode: 'imagegen',
        imagePrompt: task.prompt,
        aspectRatio: task.aspectRatio,
      });
      return;
    }

    // The extension POSTs `/result` with success or failure shape:
    //   success: { type:'ResultSubmission', taskId, resultUrl, mode, mediaFiles, timestamp }
    //   failure: { type:'ResultSubmission', taskId, mode, error, timestamp }
    if (method === 'POST' && url.pathname === '/result') {
      const body = (await readJsonBody(req)) as {
        taskId?: string;
        error?: string;
        mediaFiles?: Array<{ base64?: string; mimeType?: string; size?: number }>;
      };
      const taskId = body.taskId ?? '';
      const task = tasks.get(taskId);
      if (!task) {
        sendJson(res, 404, { success: false, error: 'UNKNOWN_TASK', taskId });
        return;
      }
      if (typeof body.error === 'string' && body.error.length > 0) {
        task.status = 'failed';
        task.error = body.error;
        sendJson(res, 200, { success: true });
        return;
      }
      const first = (body.mediaFiles ?? [])[0];
      if (!first?.base64) {
        task.status = 'failed';
        task.error = 'NO_MEDIA';
        sendJson(res, 200, { success: true });
        return;
      }
      try {
        task.bytes = Buffer.from(first.base64, 'base64');
        task.mimeType = first.mimeType ?? 'image/png';
        task.status = 'ready';
      } catch (err) {
        task.status = 'failed';
        task.error = `BASE64_DECODE_FAILED: ${(err as Error).message}`;
      }
      sendJson(res, 200, { success: true });
      return;
    }

    // The extension POSTs `/status` with `{ type:'StatusEvent', event, accountToken, at }`.
    if (method === 'POST' && url.pathname === '/status') {
      const body = (await readJsonBody(req)) as { event?: string };
      console.log(`[flow-bridge] status event: ${body.event ?? '(unknown)'}`);
      sendEmpty(res, 204);
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND', method, path: url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: 'BRIDGE_ERROR', detail: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[flow-bridge] listening on http://localhost:${PORT}`);
  console.log(`[flow-bridge] CORS origin: ${ALLOWED_ORIGIN}`);
});

process.on('SIGINT', () => {
  console.log('[flow-bridge] SIGINT — shutting down');
  server.close(() => process.exit(0));
});
