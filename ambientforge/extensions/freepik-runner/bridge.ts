/**
 * freepik-runner bridge — Node HTTP server that mediates between the AmbientForge
 * worker (client face) and the AmbientForge Freepik Runner Chrome extension
 * (executor face).
 *
 * Pattern identical to flow-runner (port 7343); freepik runs on port 7344.
 *
 *   - Worker face:
 *       POST /submit              -> { taskId }   body: { prompt, model?, aspectRatio? }
 *       GET  /poll/:taskId        -> { status: 'pending'|'ready'|'failed', error? }
 *       GET  /download/:taskId    -> image/jpeg|png
 *
 *   - Extension face:
 *       POST /poll                -> next task or {} when queue empty
 *       POST /result              -> success { mediaFiles[] } | failure { error }
 *       POST /status              -> log-only (e.g. session_expired)
 *
 * Mock mode in the worker (FREEPIK_MODE=mock or apiKey='mock') bypasses this
 * server entirely. The bridge only runs when the operator has set up Freepik
 * via `npm run freepik:login` and the Chrome extension is loaded.
 *
 * Run: `npx tsx extensions/freepik-runner/bridge.ts` or `npm run freepik:bridge`.
 */

import http from 'node:http';
import { URL } from 'node:url';

const PORT = Number(process.env.FREEPIK_BRIDGE_PORT ?? 7344);
const ALLOWED_ORIGIN = process.env.FREEPIK_BRIDGE_ALLOWED_ORIGIN ?? 'http://localhost:3003';

type TaskAspect = '1:1' | '16:9' | '9:16';
type TaskStatus = 'pending' | 'dispatched' | 'ready' | 'failed';
type TaskMode = 'imagegen' | 'image-to-video' | 'imagegen-thumbnail';

type Task = {
  id: string;
  /** 'imagegen' = Seedream 5 Lite Fast, ONE operator-picked image.
   * 'image-to-video' = Seedance 2.0 Fast (mp4 bytes returned). The video
   * flow expects to chain off the most recent imagegen result still visible
   * in the Magnific tab.
   * 'imagegen-thumbnail' = Seedream with `referenceImagePath` uploaded via the
   * edit-reference button (no saved style), generates `count` candidates, ALL
   * returned (no operator pick). */
  mode: TaskMode;
  /** For imagegen: the image prompt fed to Magnific's main textarea.
   * For image-to-video: the motion prompt fed to the Seedance prompt
   * textbox. Empty string is tolerated for image-to-video (Seedance can
   * run from the image alone). */
  prompt: string;
  /** Freepik UI model picker value. Default 'seedream-5' for imagegen,
   * 'Seedance 2.0 Fast' for image-to-video. Operator can override via the
   * worker-side request. */
  model: string;
  aspectRatio: TaskAspect;
  /** Saved Magnific style to apply via the My Styles reference-card picker.
   * Only used in imagegen mode. The runner tolerates an optional `#`
   * prefix when matching by alt text. */
  styleName?: string;
  /** image-to-video only: absolute path (on the Chrome machine) to the start
   * image (source.jpg). The extension CDP-uploads it as the Seedance end
   * frame so the looped clip is seamless (end == start). */
  sourceImagePath?: string;
  /** imagegen-thumbnail only: absolute path (on the Chrome machine) to the
   * reference image CDP-uploaded via Magnific's edit-reference button. */
  referenceImagePath?: string;
  /** imagegen-thumbnail only: how many candidates to generate (all returned). */
  count?: number;
  status: TaskStatus;
  enqueuedAt: number;
  dispatchedAt?: number;
  /** Decoded media set by /result. One entry for imagegen/image-to-video;
   * `count` entries for imagegen-thumbnail. Single source of truth — the
   * indexed /download/:id/:index reads this; /download/:id (no index) returns
   * media[0] for backward compatibility. */
  media?: Array<{ bytes: Buffer; mimeType: string }>;
  /** Failure detail when status='failed'. */
  error?: string;
};

let taskCounter = 0;
const tasks = new Map<string, Task>();

// --- Operator cover-pick relay ----------------------------------------------
// The freepik content script offers the 4 generated cover candidates here
// (base64 preview thumbs). scripts/pick-popup.ps1 polls /pick-state, shows
// them in an always-on-top window, and POSTs the operator's choice back so
// the operator never has to babysit the Magnific tab. Single-slot: a new
// offer replaces any prior one (only ever one album in flight).
type PickOffer = { offerId: string; images: string[]; createdAt: number };
let pickOffer: PickOffer | null = null;
let pickChoice: { offerId: string; index: number } | null = null;
let pickOfferCounter = 0;
// A live offer is resolved or cleared within the content script's 10-min
// human-decision window. Anything older means a prior run was killed
// mid-pick without /pick-clear — expire it so the popup can't surface stale
// covers from an abandoned offer (belt-and-suspenders with the launcher's
// startup /pick-clear).
const PICK_OFFER_TTL_MS = 15 * 60_000;

function nextId(): string {
  taskCounter += 1;
  return `freepik-task-${Date.now().toString(36)}-${taskCounter}`;
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

function setCors(res: http.ServerResponse, req?: http.IncomingMessage): void {
  const origin = typeof req?.headers.origin === 'string' ? req.headers.origin : '';
  // Echo the caller's origin when it's a chrome-extension:// (the runner SW)
  // or a localhost worker. Otherwise fall back to the configured worker origin.
  const allow =
    origin.startsWith('chrome-extension://') || /^http:\/\/localhost(:\d+)?$/.test(origin)
      ? origin
      : ALLOWED_ORIGIN;
  res.setHeader('access-control-allow-origin', allow);
  res.setHeader('vary', 'origin');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function sendBytes(
  res: http.ServerResponse,
  status: number,
  bytes: Buffer,
  mimeType = 'image/jpeg',
): void {
  res.statusCode = status;
  res.setHeader('content-type', mimeType);
  res.end(bytes);
}

function sendEmpty(res: http.ServerResponse, status: number): void {
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
    setCors(res, req);
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const method = req.method ?? 'GET';

    if (method === 'OPTIONS') {
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

    // ============ Operator cover-pick relay ============

    // Extension face: content script offers the 4 candidate previews.
    if (method === 'POST' && url.pathname === '/pick-offer') {
      const body = (await readJsonBody(req)) as { images?: unknown };
      const images = Array.isArray(body.images)
        ? body.images.filter((s): s is string => typeof s === 'string').slice(0, 8)
        : [];
      if (images.length === 0) {
        sendJson(res, 400, { error: 'NO_IMAGES' });
        return;
      }
      pickOfferCounter += 1;
      const offerId = `pick-${Date.now().toString(36)}-${pickOfferCounter}`;
      pickOffer = { offerId, images, createdAt: Date.now() };
      pickChoice = null;
      sendJson(res, 200, { offerId });
      return;
    }

    // Popup face: current offer (id + base64 previews) or {} when idle.
    if (method === 'GET' && url.pathname === '/pick-state') {
      if (pickOffer && Date.now() - pickOffer.createdAt > PICK_OFFER_TTL_MS) {
        pickOffer = null;
        pickChoice = null;
      }
      sendJson(
        res,
        200,
        pickOffer ? { offerId: pickOffer.offerId, images: pickOffer.images } : {},
      );
      return;
    }

    // Popup face: operator picked candidate `index` for offer `offerId`.
    if (method === 'POST' && url.pathname === '/pick-choice') {
      const body = (await readJsonBody(req)) as { offerId?: unknown; index?: unknown };
      const offerId = typeof body.offerId === 'string' ? body.offerId : '';
      const index = typeof body.index === 'number' ? body.index : -1;
      if (!pickOffer || pickOffer.offerId !== offerId) {
        sendJson(res, 409, { ok: false, error: 'STALE_OFFER' });
        return;
      }
      if (index < 0 || index >= pickOffer.images.length) {
        sendJson(res, 400, { ok: false, error: 'BAD_INDEX' });
        return;
      }
      pickChoice = { offerId, index };
      sendJson(res, 200, { ok: true });
      return;
    }

    // Extension face: the operator's choice for the live offer, or {}.
    if (method === 'GET' && url.pathname === '/pick-choice') {
      sendJson(
        res,
        200,
        pickChoice && pickOffer && pickChoice.offerId === pickOffer.offerId
          ? { index: pickChoice.index }
          : {},
      );
      return;
    }

    // Either face: clear the relay (content script after it resolves the pick).
    if (method === 'POST' && url.pathname === '/pick-clear') {
      await readJsonBody(req);
      pickOffer = null;
      pickChoice = null;
      sendJson(res, 200, { ok: true });
      return;
    }

    // ============ Worker face ============

    if (method === 'POST' && url.pathname === '/submit') {
      const body = (await readJsonBody(req)) as {
        mode?: string;
        prompt?: string;
        model?: string;
        aspectRatio?: string;
        styleName?: string;
        sourceImagePath?: string;
        referenceImagePath?: string;
        count?: number;
      };
      const mode: TaskMode =
        body.mode === 'image-to-video'
          ? 'image-to-video'
          : body.mode === 'imagegen-thumbnail'
            ? 'imagegen-thumbnail'
            : 'imagegen';
      const prompt = (body.prompt ?? '').trim();
      // imagegen + imagegen-thumbnail require a prompt; image-to-video can run
      // without one (Seedance can generate motion from the image alone).
      if (mode !== 'image-to-video' && prompt.length === 0) {
        sendJson(res, 400, { error: 'MISSING_PROMPT' });
        return;
      }
      const defaultModel = mode === 'image-to-video' ? 'Seedance 2.0 Fast' : 'seedream-5';
      const model =
        typeof body.model === 'string' && body.model.trim().length > 0
          ? body.model.trim()
          : defaultModel;
      const styleName =
        typeof body.styleName === 'string' && body.styleName.trim().length > 0
          ? body.styleName.trim()
          : undefined;
      const sourceImagePath =
        typeof body.sourceImagePath === 'string' && body.sourceImagePath.trim().length > 0
          ? body.sourceImagePath.trim()
          : undefined;
      const referenceImagePath =
        typeof body.referenceImagePath === 'string' && body.referenceImagePath.trim().length > 0
          ? body.referenceImagePath.trim()
          : undefined;
      // Clamp candidate count to a sane 1-8; default 4 for thumbnail mode.
      const count =
        mode === 'imagegen-thumbnail'
          ? Math.min(8, Math.max(1, Math.floor(Number(body.count) || 4)))
          : undefined;
      const id = nextId();
      const task: Task = {
        id,
        mode,
        prompt,
        model,
        aspectRatio: parseAspect(body.aspectRatio),
        styleName,
        sourceImagePath,
        referenceImagePath,
        count,
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
        // `count` lets the thumbnail flow know how many candidates to pull via
        // /download/:id/:index. Harmless for single-result modes (always 1);
        // the legacy client's poll() ignores the extra field.
        sendJson(res, 200, { status: 'ready', count: task.media?.length ?? 0 });
        return;
      }
      sendJson(res, 200, { status: 'pending' });
      return;
    }

    if (method === 'GET' && url.pathname.startsWith('/download/')) {
      // `/download/:taskId` (back-compat → index 0) or `/download/:taskId/:index`.
      // taskIds never contain '/', so split the remainder safely.
      const rest = url.pathname.slice('/download/'.length);
      const slash = rest.indexOf('/');
      const taskId = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
      const index = slash === -1 ? 0 : Number(decodeURIComponent(rest.slice(slash + 1)));
      const task = tasks.get(taskId);
      if (!task) {
        sendJson(res, 404, { error: 'UNKNOWN_TASK', taskId });
        return;
      }
      if (task.status !== 'ready' || !task.media || task.media.length === 0) {
        sendJson(res, 409, { error: 'NOT_READY', status: task.status });
        return;
      }
      if (!Number.isInteger(index) || index < 0 || index >= task.media.length) {
        sendJson(res, 404, { error: 'BAD_INDEX', index, count: task.media.length });
        return;
      }
      const m = task.media[index];
      sendBytes(res, 200, m.bytes, m.mimeType ?? 'image/jpeg');
      return;
    }

    // ============ Extension face ============

    if (method === 'POST' && url.pathname === '/poll') {
      await readJsonBody(req); // drain body; permissive on localhost
      const task = nextPendingTask();
      if (!task) {
        sendJson(res, 200, {});
        return;
      }
      task.status = 'dispatched';
      task.dispatchedAt = Date.now();
      sendJson(res, 200, {
        id: task.id,
        mode: task.mode,
        // `imagePrompt` for the prompt-box-filling content paths (imagegen +
        // imagegen-thumbnail). Video-mode reads `task.prompt`.
        imagePrompt:
          task.mode === 'imagegen' || task.mode === 'imagegen-thumbnail'
            ? task.prompt
            : undefined,
        prompt: task.prompt,
        model: task.model,
        aspectRatio: task.aspectRatio,
        styleName: task.styleName,
        sourceImagePath: task.sourceImagePath,
        referenceImagePath: task.referenceImagePath,
        count: task.count,
      });
      return;
    }

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
      const files = (body.mediaFiles ?? []).filter(
        (f): f is { base64: string; mimeType?: string; size?: number } =>
          typeof f?.base64 === 'string' && f.base64.length > 0,
      );
      if (files.length === 0) {
        task.status = 'failed';
        task.error = 'NO_MEDIA';
        sendJson(res, 200, { success: true });
        return;
      }
      try {
        // Store ALL media (one for imagegen/image-to-video; `count` for
        // imagegen-thumbnail). Single source of truth for both /download forms.
        task.media = files.map((f) => ({
          bytes: Buffer.from(f.base64, 'base64'),
          mimeType: f.mimeType ?? 'image/jpeg',
        }));
        task.status = 'ready';
      } catch (err) {
        task.status = 'failed';
        task.error = `BASE64_DECODE_FAILED: ${(err as Error).message}`;
      }
      sendJson(res, 200, { success: true });
      return;
    }

    if (method === 'POST' && url.pathname === '/status') {
      const body = (await readJsonBody(req)) as { event?: string };
      console.log(`[freepik-bridge] status event: ${body.event ?? '(unknown)'}`);
      sendEmpty(res, 204);
      return;
    }

    sendJson(res, 404, { error: 'NOT_FOUND', method, path: url.pathname });
  } catch (err) {
    sendJson(res, 500, { error: 'BRIDGE_ERROR', detail: String(err) });
  }
});

server.listen(PORT, () => {
  console.log(`[freepik-bridge] listening on http://localhost:${PORT}`);
  console.log(`[freepik-bridge] CORS origin: ${ALLOWED_ORIGIN}`);
});

process.on('SIGINT', () => {
  console.log('[freepik-bridge] SIGINT — shutting down');
  server.close(() => process.exit(0));
});
