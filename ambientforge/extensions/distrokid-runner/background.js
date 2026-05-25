// AmbientForge DistroKid Runner — background service worker.
//
// Polls the Node bridge at http://localhost:7342/next-action. When an action
// arrives, dispatches to the distrokid.com tab via chrome.tabs.sendMessage,
// then posts the result back to /action-result/:id. Same pull-poll model as
// suno-runner; the bridge owns the queue, this SW owns the executor.
//
// Action handlers in content.js are wired to the proven helpers ported from
// the upstream "AI Music Ext" extension (D:\ai-music-ext-main): React-aware
// setInputValue, label-traversal fallback selectors, isVisible heuristic.
// See docs/distrokid-dryrun-checklist.md for visual verification of dry runs.

const BRIDGE_URL = 'http://localhost:7342';
const POLL_BACKOFF_MS = 2_000;
const ERROR_BACKOFF_MS = 5_000;

let connected = false;
let pollLoopRunning = false;

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {
    // ignore — badge is best-effort
  }
}

async function findDistrokidTab() {
  return new Promise((resolve) => {
    chrome.tabs.query(
      { url: ['https://distrokid.com/*', 'https://*.distrokid.com/*'] },
      (tabs) => {
        resolve(tabs[0] ?? null);
      },
    );
  });
}

async function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

async function focusDistrokidWindow() {
  const tab = await findDistrokidTab();
  if (!tab) {
    return { ok: false, error: 'NO_DISTROKID_TAB' };
  }
  try {
    await new Promise((resolve, reject) => {
      chrome.windows.update(tab.windowId, { focused: true }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
    await new Promise((resolve, reject) => {
      chrome.tabs.update(tab.id, { active: true }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        resolve();
      });
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message ?? err) };
  }
}

async function handleAction(action) {
  if (action.type === 'focus_window') {
    return focusDistrokidWindow();
  }
  const tab = await findDistrokidTab();
  if (!tab) {
    throw new Error('NO_DISTROKID_TAB — open distrokid.com in a tab first');
  }
  // Each action delegates to the content script which has DOM + auth-cookie
  // access. Real form-driving lives in content.js; this SW only routes.
  switch (action.type) {
    case 'verify_artist':
      return await sendToContent(tab.id, { kind: 'verify_artist', payload: action.payload });
    case 'start_release':
      return await sendToContent(tab.id, { kind: 'start_release', payload: action.payload });
    case 'set_metadata':
      return await sendToContent(tab.id, { kind: 'set_metadata', payload: action.payload });
    case 'upload_cover':
      return await sendToContent(tab.id, { kind: 'upload_cover', payload: action.payload });
    case 'upload_track':
      return await sendToContent(tab.id, { kind: 'upload_track', payload: action.payload });
    case 'verify_track_count':
      return await sendToContent(tab.id, { kind: 'verify_track_count', payload: action.payload });
    case 'submit_or_screenshot':
      // submit_or_screenshot needs the actionId so it can correlate the
      // chrome.tabs.captureVisibleTab → POST /upload-screenshot/<actionId>
      // round-trip back to the bridge's inFlight entry (which has the file
      // path it should write to).
      return await sendToContent(tab.id, {
        kind: 'submit_or_screenshot',
        payload: action.payload,
        actionId: action.id,
      });
    default:
      throw new Error(`UNKNOWN_ACTION_TYPE: ${action.type}`);
  }
}

async function postActionResult(id, result) {
  await fetch(`${BRIDGE_URL}/action-result/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: true, result }),
  });
}

async function postActionError(id, err) {
  await fetch(`${BRIDGE_URL}/action-result/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ok: false, error: String(err.message ?? err) }),
  });
}

async function pollLoop() {
  if (pollLoopRunning) return;
  pollLoopRunning = true;
  while (pollLoopRunning) {
    try {
      const res = await fetch(`${BRIDGE_URL}/next-action`);
      if (res.status === 204) {
        connected = true;
        setBadge('ON', '#16a34a');
        continue;
      }
      if (!res.ok) {
        connected = false;
        setBadge('!', '#dc2626');
        await sleep(ERROR_BACKOFF_MS);
        continue;
      }
      connected = true;
      setBadge('ON', '#16a34a');
      const action = await res.json();
      try {
        const result = await handleAction(action);
        await postActionResult(action.id, result);
      } catch (err) {
        await postActionError(action.id, err);
      }
    } catch (err) {
      connected = false;
      setBadge('OFF', '#71717a');
      await sleep(POLL_BACKOFF_MS);
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.kind === 'getStatus') {
    sendResponse({ connected });
    return true;
  }
  if (msg && msg.kind === 'startPolling') {
    pollLoop();
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.kind === 'stopPolling') {
    pollLoopRunning = false;
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.kind === 'capture_screenshot') {
    handleCaptureScreenshot(msg, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // keep channel open for async sendResponse
  }
  return false;
});

// Capture the visible tab as PNG and POST raw bytes to the bridge so it can
// write them to the action's screenshotPath. Content scripts don't have
// permission for chrome.tabs.captureVisibleTab — the broker hop is required.
async function handleCaptureScreenshot(msg, sender) {
  const actionId = msg && msg.actionId;
  if (!actionId) return { ok: false, error: 'NO_ACTION_ID' };
  const tab = (sender && sender.tab) || (await findDistrokidTab());
  if (!tab) return { ok: false, error: 'NO_DISTROKID_TAB' };
  const dataUrl = await new Promise((resolve, reject) => {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' }, (url) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(url);
    });
  });
  if (!dataUrl || typeof dataUrl !== 'string') {
    return { ok: false, error: 'CAPTURE_RETURNED_EMPTY' };
  }
  // Strip "data:image/png;base64," prefix and decode.
  const commaIdx = dataUrl.indexOf(',');
  const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl;
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) bytes[i] = binStr.charCodeAt(i);
  const res = await fetch(`${BRIDGE_URL}/upload-screenshot/${encodeURIComponent(actionId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, error: `bridge ${res.status} ${text.slice(0, 120)}` };
  }
  const data = await res.json().catch(() => ({}));
  return { ok: true, bytes: (data && data.bytes) || bytes.length };
}

chrome.runtime.onInstalled.addListener(() => {
  setBadge('OFF', '#71717a');
  pollLoop();
});
chrome.runtime.onStartup.addListener(() => {
  setBadge('OFF', '#71717a');
  pollLoop();
});

// Cold-load when the SW spins up for any other reason.
pollLoop();
