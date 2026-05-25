// YouForge Flow — Popup Script
// Minimal single-form UI: three webhook URLs + account token + concurrency.

const SAVE_DEBOUNCE_MS = 400;
const STATUS_REFRESH_MS = 2000;

const els = {
  form: document.getElementById('config-form'),
  pollUrl: document.getElementById('poll-url'),
  resultUrl: document.getElementById('result-url'),
  statusUrl: document.getElementById('status-url'),
  accountToken: document.getElementById('account-token'),
  concurrency: document.getElementById('concurrency'),
  grantBtn: document.getElementById('grant-btn'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  statusLine: document.getElementById('status-line'),
};

let hostGranted = false;
let saveTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig();
  await refreshHostPermission();
  refreshEnabled();
  await refreshStatus();
  setInterval(refreshStatus, STATUS_REFRESH_MS);

  els.form.addEventListener('input', () => {
    queueSave();
    refreshEnabled();
  });

  els.grantBtn.addEventListener('click', requestHostPermission);
  els.startBtn.addEventListener('click', startPolling);
  els.stopBtn.addEventListener('click', stopPolling);

  if (chrome.permissions && chrome.permissions.onRemoved) {
    chrome.permissions.onRemoved.addListener(refreshHostPermission);
  }
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(refreshHostPermission);
  }
});

async function loadConfig() {
  const s = await chrome.storage.local.get([
    'pollUrl', 'resultUrl', 'statusUrl', 'accountToken', 'concurrency'
  ]);
  if (s.pollUrl) els.pollUrl.value = s.pollUrl;
  if (s.resultUrl) els.resultUrl.value = s.resultUrl;
  if (s.statusUrl) els.statusUrl.value = s.statusUrl;
  if (s.accountToken) els.accountToken.value = s.accountToken;
  els.concurrency.value = Number.isFinite(s.concurrency) ? s.concurrency : 5;
}

function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, SAVE_DEBOUNCE_MS);
}

async function saveConfig() {
  const pollUrl = els.pollUrl.value.trim();
  const resultUrl = els.resultUrl.value.trim();
  const statusUrl = els.statusUrl.value.trim();
  const accountToken = els.accountToken.value;
  const concurrency = Math.max(1, Math.min(10, parseInt(els.concurrency.value, 10) || 5));

  await chrome.storage.local.set({
    pollUrl, resultUrl, statusUrl, accountToken, concurrency
  });
  chrome.runtime.sendMessage({ action: 'updateWebhooks', pollUrl, resultUrl, statusUrl, accountToken });
  chrome.runtime.sendMessage({ action: 'updateConcurrency', concurrency });

  // If the HistForge host changed, the old permission may no longer cover it.
  await refreshHostPermission();
  refreshEnabled();
}

function histforgeOrigin() {
  const urls = [els.pollUrl.value, els.resultUrl.value, els.statusUrl.value]
    .map((u) => u.trim())
    .filter(Boolean);
  for (const u of urls) {
    try {
      return new URL(u).origin;
    } catch (e) { /* skip */ }
  }
  return null;
}

async function refreshHostPermission() {
  const origin = histforgeOrigin();
  const { grantedOrigin } = await chrome.storage.local.get('grantedOrigin');

  // If the user pointed the URLs at a different host (or cleared them),
  // the previously granted permission is no longer needed — revoke it.
  if (grantedOrigin && grantedOrigin !== origin) {
    try {
      await chrome.permissions.remove({ origins: [`${grantedOrigin}/*`] });
    } catch (e) { /* ignore — may already be gone */ }
    await chrome.runtime.sendMessage({ action: 'setGrantedOrigin', origin: null });
  }

  if (!origin) {
    hostGranted = false;
    els.grantBtn.hidden = true;
    refreshEnabled();
    return;
  }
  try {
    hostGranted = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  } catch (e) {
    hostGranted = false;
  }
  els.grantBtn.hidden = hostGranted;
  els.grantBtn.textContent = hostGranted ? 'Access granted' : `Grant access to ${origin}`;
  refreshEnabled();
}

async function requestHostPermission() {
  const origin = histforgeOrigin();
  if (!origin) return;
  try {
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    hostGranted = granted;
    await chrome.runtime.sendMessage({
      action: 'setGrantedOrigin',
      origin: granted ? origin : null,
    });
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
  await refreshHostPermission();
}

function refreshEnabled() {
  const fieldsFilled = [
    els.pollUrl.value.trim(),
    els.resultUrl.value.trim(),
    els.statusUrl.value.trim(),
    els.accountToken.value.trim()
  ].every(Boolean);
  els.startBtn.disabled = !(fieldsFilled && hostGranted);
}

async function startPolling() {
  await saveConfig();
  await chrome.runtime.sendMessage({ action: 'startPolling' });
  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
  await refreshStatus();
}

async function stopPolling() {
  await chrome.runtime.sendMessage({ action: 'stopPolling' });
  els.startBtn.hidden = false;
  els.stopBtn.hidden = true;
  await refreshStatus();
}

async function refreshStatus() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });
    if (!status) return;

    els.startBtn.hidden = !!status.isPolling;
    els.stopBtn.hidden = !status.isPolling;

    if (status.hostPermissionRevoked) {
      setStatus('Error: HistForge host permission revoked');
      return;
    }
    if (status.sessionExpired) {
      setStatus('Error: session expired — re-login needed');
      return;
    }
    if (!status.isPolling) {
      setStatus('Idle');
      return;
    }

    const parts = [];
    if (status.lastPoll) {
      const ago = Math.max(0, Math.floor((Date.now() - new Date(status.lastPoll).getTime()) / 1000));
      parts.push(`Last poll: ${ago}s ago`);
    } else {
      parts.push('Last poll: —');
    }
    setStatus(parts.join(' · '));
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
}

function setStatus(text) {
  els.statusLine.textContent = text;
}
