// Magnific HITL — Popup Script
// One-form config UI: HistForge domain + Magnific token, plus a poll
// cadence knob and verbose-logging toggle.
//
// The four Magnific webhook URLs (next-task, submit-result, status,
// queue-summary) all share `${domain}/api/magnific/...` prefixes. The
// popup hides that and sends the derived URLs to the service worker via
// the updateWebhooks message; the SW writes them to chrome.storage.local
// under the same keys settings.js reads via the
// getNextTaskUrl / getSubmitResultUrl / getStatusUrl /
// getQueueSummaryUrl getters, so the service worker doesn't re-derive.
// queue-summary is videoId-keyed (not token-keyed); the popup sends the
// base prefix so a future consumer can append /<videoId>.
//
// Write path: the popup never calls chrome.storage.local.set for
// settings keys — every mutation goes through a message action handled
// by src/messages.js → src/settings.js, which updates the cache and
// storage atomically. Reads on popup open still use
// chrome.storage.local.get directly (the SW is the sole writer, so
// storage is the source of truth).

const SAVE_DEBOUNCE_MS = 400;
const STATUS_REFRESH_MS = 2000;
const DEFAULT_HISTFORGE_DOMAIN = 'http://localhost:3000';

const els = {
  form: document.getElementById('config-form'),
  histforgeDomain: document.getElementById('histforge-domain'),
  magnificToken: document.getElementById('magnific-token'),
  pollInterval: document.getElementById('poll-interval'),
  verboseLogging: document.getElementById('verbose-logging'),
  derivedHint: document.getElementById('derived-urls-hint'),
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
    'histforgeDomain', 'magnificToken',
    'pollIntervalSec', 'verboseLogging',
  ]);

  const domain = typeof s.histforgeDomain === 'string' && s.histforgeDomain
    ? s.histforgeDomain
    : DEFAULT_HISTFORGE_DOMAIN;
  els.histforgeDomain.value = domain;

  if (s.magnificToken) els.magnificToken.value = s.magnificToken;
  els.pollInterval.value = Number.isFinite(s.pollIntervalSec)
    ? s.pollIntervalSec
    : DEFAULT_POLL_INTERVAL_SEC;
  if (els.verboseLogging) els.verboseLogging.checked = !!s.verboseLogging;
  updateDerivedHint();
}

function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveConfig, SAVE_DEBOUNCE_MS);
}

function normalizeDomain(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  try { return new URL(trimmed).origin; } catch (_e) { /* try with http:// prefix */ }
  try { return new URL('http://' + trimmed).origin; } catch (_e) { return ''; }
}

function deriveWebhookUrls(domain, token) {
  if (!domain || !token) {
    return {
      nextTaskUrl: '',
      submitResultUrl: '',
      statusUrl: '',
      queueSummaryUrl: '',
    };
  }
  return {
    nextTaskUrl: `${domain}/api/magnific/next-task/${token}`,
    submitResultUrl: `${domain}/api/magnific/submit-result/${token}`,
    statusUrl: `${domain}/api/magnific/status/${token}`,
    // queue-summary is videoId-keyed, not token-keyed; store the base
    // prefix and let consumers append /<videoId>. The extension does
    // not call it today — the HistForge dashboard does.
    queueSummaryUrl: `${domain}/api/magnific/queue-summary`,
  };
}

async function saveConfig() {
  const domain = normalizeDomain(els.histforgeDomain.value);
  const magnificToken = els.magnificToken.value.trim();
  const { nextTaskUrl, submitResultUrl, statusUrl, queueSummaryUrl } =
    deriveWebhookUrls(domain, magnificToken);
  const pollRaw = parseInt(els.pollInterval.value, 10);
  const pollIntervalSec = Number.isFinite(pollRaw)
    ? Math.max(5, pollRaw)
    : DEFAULT_POLL_INTERVAL_SEC;
  const verboseLogging = !!(els.verboseLogging && els.verboseLogging.checked);

  await chrome.runtime.sendMessage({
    action: 'updateWebhooks',
    nextTaskUrl, submitResultUrl, statusUrl, queueSummaryUrl,
    magnificToken,
    histforgeDomain: domain,
  });
  await chrome.runtime.sendMessage({ action: 'setVerboseLogging', value: verboseLogging });
  await chrome.runtime.sendMessage({ action: 'setPollIntervalSec', value: pollIntervalSec });

  await refreshHostPermission();
  refreshEnabled();
  updateDerivedHint();
}

function updateDerivedHint() {
  if (!els.derivedHint) return;
  const domain = normalizeDomain(els.histforgeDomain.value);
  const token = els.magnificToken.value.trim();
  els.derivedHint.hidden = !(domain && token);
}

function histforgeOrigin() {
  return normalizeDomain(els.histforgeDomain.value) || null;
}

async function refreshHostPermission() {
  const origin = histforgeOrigin();
  const { grantedOrigin } = await chrome.storage.local.get('grantedOrigin');

  // If the user pointed the URL at a different host (or cleared it),
  // the previously granted permission is no longer needed — revoke it.
  if (grantedOrigin && grantedOrigin !== origin) {
    try {
      await chrome.permissions.remove({ origins: [`${grantedOrigin}/*`] });
    } catch (_e) { /* may already be gone */ }
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
  } catch (_e) {
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
  const domain = normalizeDomain(els.histforgeDomain.value);
  const token = els.magnificToken.value.trim();
  const ready = !!(domain && token && hostGranted);
  els.startBtn.disabled = !ready;
}

async function startPolling() {
  await saveConfig();
  await chrome.runtime.sendMessage({ action: 'startPolling' });
  els.startBtn.hidden = true;
  els.stopBtn.hidden = false;
  await refreshStatus();
}

async function stopPolling() {
  // Send `stopAllProcessing` (not `stopPolling`) so the global stop flag
  // is flipped in addition to clearing the alarm. Phase 2.2 polls don't
  // dispatch yet, but Phase 2.3/2.4 executors will read getStopFlag()
  // to abort mid-task — using the broader action now keeps Stop
  // behavior consistent across phases.
  await chrome.runtime.sendMessage({ action: 'stopAllProcessing' });
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
    if (status.pauseReason) {
      setStatus(`Paused: ${status.pauseReason}`);
      return;
    }
    if (!status.isPolling) {
      setStatus('Idle');
      return;
    }

    if (status.lastPoll) {
      const ago = Math.max(0, Math.floor((Date.now() - new Date(status.lastPoll).getTime()) / 1000));
      setStatus(`Last poll: ${ago}s ago`);
    } else {
      setStatus('Last poll: —');
    }
  } catch (e) {
    setStatus(`Error: ${e.message}`);
  }
}

function setStatus(text) {
  els.statusLine.textContent = text;
}
