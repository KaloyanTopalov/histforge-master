// AmbientForge Freepik Runner — service worker.
// Skeleton: polls the bridge for tasks and dispatches them to the content
// script on www.freepik.com. The actual page automation (model picker,
// prompt textarea, generate button, result download) is recorded in Pass 2
// and lives in content.js / src/executors/*.

const BRIDGE_URL = 'http://localhost:7344';
const POLL_INTERVAL_MS = 5000;

// Dedicated automation runner: polling is ALWAYS ON. We deliberately do NOT
// gate on a stored `isEnabled` flag and do NOT depend on a sub-minute
// chrome.alarms period (Chrome clamps MV3 alarms to a ~1-min minimum, so the
// old 5s alarm was unreliable — when the MV3 service worker hibernated nothing
// respawned it and polling silently stopped: "the extension is not enabled").
//
// Mechanism: a 1-min alarm is the guaranteed SW-respawn heartbeat; every spawn
// (install / startup / alarm / any event) starts a 5s in-SW poll loop that
// does the real work. The popup toggle is now informational only.

let pollLoopId = null;

function startPollLoop() {
  // pollLoopId lives per service-worker instance; a fresh spawn → fresh loop.
  if (pollLoopId !== null) return;
  const tick = () =>
    pollOnce().catch((err) => console.warn('[freepik-runner] poll error', err));
  tick(); // poll immediately on (re)spawn — don't wait the first interval
  pollLoopId = setInterval(tick, POLL_INTERVAL_MS);
}

function ensureAlarm() {
  // 1 min is the smallest period Chrome reliably honors for MV3 alarms; it's
  // only the respawn heartbeat — the 5s loop above is the real cadence.
  chrome.alarms.create('poll-bridge', { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[freepik-runner] installed');
  await chrome.storage.local.set({
    isEnabled: true,
    lastPoll: null,
    stats: { processed: 0, failed: 0, retries: 0 },
  });
  ensureAlarm();
  startPollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  startPollLoop();
});

// Runs on every service-worker spin-up.
chrome.storage.local.set({ isEnabled: true }).catch(() => {});
ensureAlarm();
startPollLoop();

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'poll-bridge') return;
  startPollLoop(); // respawn heartbeat — no isEnabled gate
});

async function pollOnce() {
  const res = await fetch(`${BRIDGE_URL}/poll`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'TaskRequest', mode: 'imagegen' }),
  });
  if (!res.ok) {
    console.warn('[freepik-runner] /poll returned', res.status);
    return;
  }
  const task = await res.json();
  if (!task || !task.id) return; // queue empty
  await dispatchToFreepikTab(task);
}

async function dispatchToFreepikTab(task) {
  // Freepik AI tools redirect to magnific.com (the same product, post-rename),
  // so match both. content_scripts runs on either.
  const tabs = await chrome.tabs.query({
    url: [
      'https://www.freepik.com/*',
      'https://www.magnific.com/*',
      'https://magnific.ai/*',
      'https://*.magnific.ai/*',
    ],
  });
  if (tabs.length === 0) {
    await postResult(task.id, {
      error: 'FREEPIK_TAB_MISSING — open https://magnific.ai/ and sign in',
    });
    return;
  }
  const tabId = tabs[0].id;
  if (!tabId) {
    await postResult(task.id, { error: 'FREEPIK_TAB_NO_ID' });
    return;
  }
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: 'freepik:execute', task });
    await postResult(task.id, result);
  } catch (err) {
    await postResult(task.id, { error: `EXECUTOR_ERROR: ${String(err)}` });
  }
}

async function postResult(taskId, payload) {
  try {
    await fetch(`${BRIDGE_URL}/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'ResultSubmission',
        taskId,
        timestamp: Date.now(),
        mode: 'imagegen',
        ...payload,
      }),
    });
  } catch (err) {
    console.warn('[freepik-runner] /result post failed', err);
  }
}

// Popup ↔ background messaging — toggle enabled flag.
// Content script ↔ background messaging — fetch CDN images on its behalf
// (content scripts don't get the extension's host_permissions CORS bypass).
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'freepik:set-enabled') {
    chrome.storage.local.set({ isEnabled: !!msg.enabled }).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg?.type === 'freepik:get-state') {
    chrome.storage.local.get(['isEnabled', 'lastPoll', 'stats']).then((s) => sendResponse(s));
    return true;
  }
  if (msg?.type === 'freepik:cdn-fetch') {
    fetchAsBase64(msg.url).then(sendResponse);
    return true;
  }
  // Downscaled JPEG thumbnail for the cover-pick popup. Built in the SW
  // (OffscreenCanvas) so the offer is ~100KB total instead of 20-40MB of 4K
  // base64 — the latter is what made the popup offer fail to relay.
  if (msg?.type === 'freepik:pick-thumb') {
    fetchAsThumb(msg.url, typeof msg.maxEdge === 'number' ? msg.maxEdge : 420).then(sendResponse);
    return true;
  }
  // Operator cover-pick relay. Content scripts can't reach localhost (no
  // host_permissions), so the SW proxies the offer/poll/clear to the bridge,
  // exactly like freepik:cdn-fetch.
  if (msg?.type === 'freepik:pick-offer') {
    bridgeJson('POST', '/pick-offer', { images: msg.images || [] }).then((r) => {
      if (!r || !r.offerId) {
        console.warn('[freepik-runner][pick] /pick-offer relay failed:', JSON.stringify(r));
      }
      sendResponse(r);
    });
    return true;
  }
  if (msg?.type === 'freepik:pick-poll') {
    bridgeJson('GET', '/pick-choice').then(sendResponse);
    return true;
  }
  if (msg?.type === 'freepik:pick-clear') {
    bridgeJson('POST', '/pick-clear', {}).then(sendResponse);
    return true;
  }
  // Drive a <input type="file"> via CDP DOM.setFileInputFiles. A content
  // script cannot set a file input (browser security blocks it); this is the
  // same chrome.debugger mechanism the distrokid-runner uses for cover/track
  // uploads. Used by the End-frame automation to upload source.jpg.
  if (msg?.type === 'freepik:set-file-input-files') {
    (async () => {
      const tab = (_sender && _sender.tab) || (await findFreepikTab());
      if (!tab || !tab.id) return { ok: false, error: 'FREEPIK_TAB_MISSING' };
      try {
        await setFileInputFiles(tab.id, msg.selector, msg.files || []);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    })()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  // Trusted click via CDP Input.dispatchMouseEvent. Magnific's Radix triggers
  // (reference cards) and some controls gate on event.isTrusted, so a content
  // script's synthetic click/pointer sequence is ignored — same constraint as
  // distrokid. This is the only JS path to a real click.
  if (msg?.type === 'freepik:trusted-click') {
    (async () => {
      const tab = (_sender && _sender.tab) || (await findFreepikTab());
      if (!tab || !tab.id) return { ok: false, error: 'FREEPIK_TAB_MISSING' };
      try {
        await dispatchTrustedClick(tab.id, msg.selector);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    })()
      .then((r) => sendResponse(r))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  if (msg?.type === 'freepik:detach-debugger') {
    detachDebuggerIfAttached()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String((err && err.message) || err) }));
    return true;
  }
  // Page-side heartbeat (content.js) — receiving this message just woke the
  // SW. Make sure the loop + alarm are armed and poll the bridge immediately.
  if (msg?.type === 'freepik:poll-tick') {
    startPollLoop();
    ensureAlarm();
    pollOnce().catch((err) => console.warn('[freepik-runner] poll error', err));
    sendResponse({ ok: true });
    return false;
  }
  return undefined;
});

async function bridgeJson(method, path, body) {
  try {
    const res = await fetch(`${BRIDGE_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return await res.json();
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

async function fetchAsBase64(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const buf = await res.arrayBuffer();
    const mimeType = res.headers.get('content-type') || 'image/jpeg';
    return {
      mediaFiles: [{ base64: arrayBufferToBase64(buf), mimeType, size: buf.byteLength }],
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

// MV3 service workers have no FileReader; arrayBuffer + chunked btoa is the
// supported blob→base64 path (also used by the original fetchAsBase64).
function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Downscale a CDN image to a small JPEG thumbnail entirely inside the SW.
// OffscreenCanvas + createImageBitmap exist in MV3 workers; a DOM <canvas>
// does not, and a content-script canvas would taint on cross-origin
// cdnpk.net (toDataURL throws SecurityError). Returns
// { dataUrl, bytes, downscaled, dims } or { error } — the caller logs it and
// falls back to a placeholder tile (popup stays pickable by position).
async function fetchAsThumb(url, maxEdge) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const srcBlob = await res.blob();
    let bmp;
    try {
      bmp = await createImageBitmap(srcBlob);
    } catch (e) {
      return {
        error: `DECODE_FAILED ${String(e?.message ?? e)} (src ${srcBlob.size}B ${srcBlob.type})`,
      };
    }
    const longEdge = Math.max(bmp.width, bmp.height) || 1;
    const scale = Math.min(1, maxEdge / longEdge);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      if (bmp.close) bmp.close();
      return { error: 'NO_2D_CONTEXT' };
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 });
    const outBuf = await outBlob.arrayBuffer();
    return {
      dataUrl: `data:image/jpeg;base64,${arrayBufferToBase64(outBuf)}`,
      bytes: outBuf.byteLength,
      downscaled: scale < 1,
      dims: `${w}x${h}`,
    };
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

// ---------------------------------------------------------------------------
// chrome.debugger file-upload — ported verbatim from distrokid-runner. Browser
// security blocks a content script from setting a <input type="file">; CDP's
// DOM.setFileInputFiles is the only JS path. It fires a trusted change event
// so Magnific's React onChange enables the picker's "Add" button. Cost: a
// yellow "Extension is debugging this tab" banner while attached; we detach
// after the upload via the freepik:detach-debugger message.
// ---------------------------------------------------------------------------

const DEBUGGER_PROTOCOL = '1.3';
let debuggerAttachedTabId = null;

async function findFreepikTab() {
  const tabs = await chrome.tabs.query({
    url: [
      'https://www.freepik.com/*',
      'https://www.magnific.com/*',
      'https://magnific.ai/*',
      'https://*.magnific.ai/*',
    ],
  });
  return tabs[0] ?? null;
}

function debuggerSendCommand(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (result) => {
      if (chrome.runtime.lastError) {
        reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
        return;
      }
      resolve(result);
    });
  });
}

async function ensureDebuggerAttached(tabId) {
  if (debuggerAttachedTabId === tabId) return;
  if (debuggerAttachedTabId !== null && debuggerAttachedTabId !== tabId) {
    await new Promise((resolve) => {
      chrome.debugger.detach({ tabId: debuggerAttachedTabId }, () => {
        void chrome.runtime.lastError;
        resolve();
      });
    });
    debuggerAttachedTabId = null;
  }
  await new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, DEBUGGER_PROTOCOL, () => {
      if (chrome.runtime.lastError) {
        reject(new Error('debugger attach failed: ' + chrome.runtime.lastError.message));
        return;
      }
      resolve();
    });
  });
  debuggerAttachedTabId = tabId;
}

async function detachDebuggerIfAttached() {
  if (debuggerAttachedTabId === null) return;
  const tabId = debuggerAttachedTabId;
  debuggerAttachedTabId = null;
  await new Promise((resolve) => {
    chrome.debugger.detach({ tabId }, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

async function setFileInputFiles(tabId, selector, files) {
  await ensureDebuggerAttached(tabId);
  const evalRes = await debuggerSendCommand(tabId, 'Runtime.evaluate', {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
  });
  const objectId = evalRes && evalRes.result && evalRes.result.objectId;
  if (!objectId) {
    throw new Error(`selector not found: ${selector}`);
  }
  try {
    await debuggerSendCommand(tabId, 'DOM.setFileInputFiles', { files, objectId });
  } finally {
    try {
      await debuggerSendCommand(tabId, 'Runtime.releaseObject', { objectId });
    } catch (_e) {
      // ignore — object may have GC'd
    }
  }
}

// Trusted click: scroll the element into view, read its viewport-center
// coords, then CDP-dispatch a real move→press→release at that point.
async function dispatchTrustedClick(tabId, selector) {
  await ensureDebuggerAttached(tabId);
  const evalRes = await debuggerSendCommand(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 });
    })()`,
    returnByValue: true,
  });
  const raw = evalRes && evalRes.result && evalRes.result.value;
  if (!raw) throw new Error(`selector not found: ${selector}`);
  const { x, y } = JSON.parse(raw);
  const base = { x, y, button: 'left', buttons: 1, clickCount: 1 };
  await debuggerSendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
  });
  await debuggerSendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    ...base,
  });
  await debuggerSendCommand(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    ...base,
  });
}

// Clear our state if the debugger detaches for any reason (operator clicks
// "Cancel" on the banner, tab closes, extension reloads).
chrome.debugger.onDetach.addListener((source, _reason) => {
  if (source && source.tabId === debuggerAttachedTabId) {
    debuggerAttachedTabId = null;
  }
});
