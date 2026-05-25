// AmbientForge Suno Runner — background service worker.
//
// Polls the Node bridge at http://localhost:7341/next-action. When an action
// arrives, dispatches to the suno.com tab via chrome.tabs.sendMessage, then
// posts the result back to /action-result/:id. This mirrors the YouForge Flow
// pull-model: the bridge owns the queue, this SW owns the executor.
//
// The actual Suno calls (submit/poll/download/credits) are stubs in this
// session. Wire them up in a follow-up by filling in the placeholder branches
// in handleAction below — they should call into content.js (which has access
// to suno.com's auth cookies and DOM) via chrome.tabs.sendMessage.

const BRIDGE_URL = 'http://localhost:7341';
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

async function findSunoTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['https://suno.com/*', 'https://*.suno.com/*'] }, (tabs) => {
      resolve(tabs[0] ?? null);
    });
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

async function handleAction(action) {
  const tab = await findSunoTab();
  if (!tab) {
    throw new Error('NO_SUNO_TAB — open suno.com in a tab first');
  }
  // STUB: real implementations should round-trip with content.js, which has
  // auth cookies + DOM access for suno.com. Replace these with real calls.
  switch (action.type) {
    case 'credits': {
      const result = await sendToContent(tab.id, { kind: 'getCredits' });
      if (result && result.error) {
        throw new Error(result.error);
      }
      return result;
    }
    case 'submit':
      //   return await sendToContent(tab.id, { kind: 'submit', payload: action.payload });
      return { taskId: 'stub-' + action.id, _stub: true };
    case 'poll':
      //   return await sendToContent(tab.id, { kind: 'poll', payload: action.payload });
      return { status: 'failed', _stub: true };
    case 'download':
      //   const { bytesBase64 } = await sendToContent(tab.id, { kind: 'download', payload: action.payload });
      //   return { bytesBase64 };
      throw new Error('DOWNLOAD_NOT_IMPLEMENTED — wire content.js download handler');
    default:
      throw new Error(`UNKNOWN_ACTION_TYPE: ${action.type}`);
  }
}

async function postActionResult(id, result, isBinary = false) {
  const headers = isBinary
    ? { 'content-type': 'application/octet-stream' }
    : { 'content-type': 'application/json' };
  const body = isBinary
    ? Uint8Array.from(atob(result.bytesBase64), (c) => c.charCodeAt(0))
    : JSON.stringify({ ok: true, result });
  await fetch(`${BRIDGE_URL}/action-result/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers,
    body,
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
        const isBinary = action.type === 'download';
        await postActionResult(action.id, result, isBinary);
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
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
  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  setBadge('OFF', '#71717a');
  pollLoop();
});
chrome.runtime.onStartup.addListener(() => {
  setBadge('OFF', '#71717a');
  pollLoop();
});

// Cold-load when the SW spins up for any other reason (e.g. operator clicks
// the action icon and chrome wakes the worker).
pollLoop();
