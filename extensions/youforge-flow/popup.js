// YouForge Flow — Popup Script
// One-form config UI: HistForge domain + account token, plus general
// knobs and a schema-driven Advanced fieldset.
//
// The five HistForge webhook URLs (next-task / submit-result / status /
// project / operation-started) all share `${domain}/api/flow/{route}/
// ${token}` — same domain, same token. The popup hides that and stores
// the derived pollUrl / resultUrl / statusUrl / projectUrl /
// operationStartedUrl into chrome.storage.local (same keys the SW
// already reads via settings.js getters), so the service-worker side
// stays unchanged.

const SAVE_DEBOUNCE_MS = 400;
const STATUS_REFRESH_MS = 2000;
const DEFAULT_HISTFORGE_DOMAIN = 'http://localhost:3000';
const CHARACTER_LOCK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const els = {
  form: document.getElementById('config-form'),
  histforgeDomain: document.getElementById('histforge-domain'),
  accountToken: document.getElementById('account-token'),
  imageConcurrency: document.getElementById('image-concurrency'),
  videoConcurrency: document.getElementById('video-concurrency'),
  verboseLogging: document.getElementById('verbose-logging'),
  notificationsEnabled: document.getElementById('notifications-enabled'),
  characterLockReference: document.getElementById('character-lock-reference'),
  characterLockError: document.getElementById('character-lock-error'),
  detectedList: document.getElementById('detected-list'),
  detectedEmpty: document.getElementById('detected-empty'),
  derivedHint: document.getElementById('derived-urls-hint'),
  advancedRoot: document.getElementById('advanced-root'),
  grantBtn: document.getElementById('grant-btn'),
  startBtn: document.getElementById('start-btn'),
  stopBtn: document.getElementById('stop-btn'),
  testBtn: document.getElementById('test-btn'),
  statusLine: document.getElementById('status-line'),
  selfTestResults: document.getElementById('self-test-results'),
};

// Numeric Advanced fieldset, derived from SETTINGS_SCHEMA (loaded as a
// classic script from src/settings-schema.js before this file). Adding
// a new numeric tunable means appending one schema entry with
// kind: 'number' and a popup binding — popup-side touches nothing
// else. The kind === 'number' filter is load-bearing: loadConfig /
// saveConfig below assume Number.isFinite / Number(raw) coercion, so a
// future popup-bound non-numeric entry must not slip in here. If/when
// the popup grows non-numeric advanced fields, this derivation needs a
// kind dispatch.
const ADVANCED_NUMERIC_FIELDS = SETTINGS_SCHEMA
  .filter((entry) => entry.popup && entry.kind === 'number')
  .map((entry) => ({
    key: entry.key,
    id: entry.popup.id,
    label: entry.popup.label,
    group: entry.popup.group || 'Other',
    min: typeof entry.popup.min === 'number' ? entry.popup.min : 1,
    step: typeof entry.popup.step === 'number' ? entry.popup.step : 1,
    def: entry.default,
  }));

let hostGranted = false;
let saveTimer = null;

document.addEventListener('DOMContentLoaded', async () => {
  renderAdvanced();
  await loadConfig();
  await refreshHostPermission();
  refreshEnabled();
  await refreshStatus();
  setInterval(refreshStatus, STATUS_REFRESH_MS);
  await refreshDetectedCharacters();

  els.form.addEventListener('input', () => {
    queueSave();
    refreshEnabled();
  });
  // The lock input changes (via direct typing OR via a "Use as lock"
  // click) should re-render the detected panel so the active row
  // highlight tracks the new lock value.
  if (els.characterLockReference) {
    els.characterLockReference.addEventListener('input', () => {
      renderDetectedCharacters(lastDetectedSnapshot);
    });
  }

  els.grantBtn.addEventListener('click', requestHostPermission);
  els.startBtn.addEventListener('click', startPolling);
  els.stopBtn.addEventListener('click', stopPolling);
  if (els.testBtn) els.testBtn.addEventListener('click', runSelfTest);

  if (chrome.permissions && chrome.permissions.onRemoved) {
    chrome.permissions.onRemoved.addListener(refreshHostPermission);
  }
  if (chrome.permissions && chrome.permissions.onAdded) {
    chrome.permissions.onAdded.addListener(refreshHostPermission);
  }
  // Live-refresh the detected panel when the SW writes a new entry.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.detectedCharacters) return;
      void refreshDetectedCharacters();
    });
  }
});

let lastDetectedSnapshot = [];

async function refreshDetectedCharacters() {
  const { detectedCharacters } = await chrome.storage.local.get('detectedCharacters');
  const list = Array.isArray(detectedCharacters) ? detectedCharacters : [];
  lastDetectedSnapshot = list;
  renderDetectedCharacters(list);
}

function renderDetectedCharacters(list) {
  if (!els.detectedList || !els.detectedEmpty) return;
  const items = Array.isArray(list) ? list : [];
  els.detectedList.textContent = '';
  if (items.length === 0) {
    els.detectedEmpty.hidden = false;
    els.detectedList.hidden = true;
    return;
  }
  els.detectedEmpty.hidden = true;
  els.detectedList.hidden = false;
  const currentLock = (els.characterLockReference && els.characterLockReference.value || '').trim();
  for (const entry of items) {
    if (!entry || typeof entry.entityId !== 'string') continue;
    const li = document.createElement('li');
    li.className = 'detected-item';
    const isActive = entry.entityId === currentLock;
    if (isActive) li.classList.add('is-active');

    const meta = document.createElement('div');
    meta.className = 'detected-item-meta';
    const labelEl = document.createElement('span');
    labelEl.className = 'detected-item-label';
    labelEl.textContent = entry.label || '(no prompt)';
    const idEl = document.createElement('span');
    idEl.className = 'detected-item-id';
    idEl.textContent = entry.entityId;
    meta.appendChild(labelEl);
    meta.appendChild(idEl);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'detected-item-action';
    btn.textContent = isActive ? 'Active' : 'Use as lock';
    btn.disabled = isActive;
    if (!isActive) {
      btn.addEventListener('click', () => useAsLock(entry.entityId));
    }

    li.appendChild(meta);
    li.appendChild(btn);
    els.detectedList.appendChild(li);
  }
}

function useAsLock(entityId) {
  if (!els.characterLockReference) return;
  els.characterLockReference.value = entityId;
  if (els.characterLockError) {
    els.characterLockError.textContent = '';
    els.characterLockError.hidden = true;
  }
  // Drive through the existing save path — debounced save fires + the
  // dedicated setCharacterLockReference message pushes into the SW
  // cache. Synthesise an `input` event so the form-wide input handler
  // queues the save just like a user keystroke would.
  els.characterLockReference.dispatchEvent(new Event('input', { bubbles: true }));
  renderDetectedCharacters(lastDetectedSnapshot);
}

function renderAdvanced() {
  if (!els.advancedRoot) return;
  els.advancedRoot.innerHTML = '';

  // Group by popup.group, preserving schema order both within each
  // group and across groups (first-seen group wins its slot).
  const groups = new Map();
  for (const f of ADVANCED_NUMERIC_FIELDS) {
    if (!groups.has(f.group)) groups.set(f.group, []);
    groups.get(f.group).push(f);
  }

  for (const [groupName, fields] of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'advanced-group';

    const titleEl = document.createElement('h3');
    titleEl.className = 'advanced-group-title';
    titleEl.textContent = groupName;
    groupEl.appendChild(titleEl);

    const gridEl = document.createElement('div');
    gridEl.className = 'grid-2';

    for (const f of fields) {
      const fieldEl = document.createElement('div');
      fieldEl.className = 'field';

      const labelEl = document.createElement('label');
      labelEl.htmlFor = f.id;
      labelEl.textContent = f.label;

      const inputEl = document.createElement('input');
      inputEl.type = 'number';
      inputEl.id = f.id;
      inputEl.name = f.key;
      inputEl.min = String(f.min);
      inputEl.step = String(f.step);

      fieldEl.appendChild(labelEl);
      fieldEl.appendChild(inputEl);
      gridEl.appendChild(fieldEl);
    }

    groupEl.appendChild(gridEl);
    els.advancedRoot.appendChild(groupEl);
  }
}

async function loadConfig() {
  const baseKeys = [
    'histforgeDomain', 'pollUrl', 'accountToken',
    'imageConcurrency', 'videoConcurrency',
    'verboseLogging', 'notificationsEnabled',
    'characterLockReference',
  ];
  const advancedKeys = ADVANCED_NUMERIC_FIELDS.map((f) => f.key);
  const s = await chrome.storage.local.get([...baseKeys, ...advancedKeys]);

  // Domain comes from histforgeDomain (popup-owned key). For installs
  // upgraded from the four-URL era, derive the domain from the stored
  // pollUrl's origin so the user doesn't lose their prior config.
  let domain = typeof s.histforgeDomain === 'string' && s.histforgeDomain ? s.histforgeDomain : '';
  if (!domain && typeof s.pollUrl === 'string' && s.pollUrl) {
    try { domain = new URL(s.pollUrl).origin; } catch (_e) { /* leave blank */ }
  }
  if (!domain) domain = DEFAULT_HISTFORGE_DOMAIN;
  els.histforgeDomain.value = domain;

  if (s.accountToken) els.accountToken.value = s.accountToken;
  els.imageConcurrency.value = Number.isFinite(s.imageConcurrency) ? s.imageConcurrency : 5;
  els.videoConcurrency.value = Number.isFinite(s.videoConcurrency) ? s.videoConcurrency : 3;
  if (els.verboseLogging) els.verboseLogging.checked = !!s.verboseLogging;
  if (els.notificationsEnabled) {
    // notificationsEnabled defaults to true; only flip when explicitly stored false.
    els.notificationsEnabled.checked = s.notificationsEnabled !== false;
  }
  if (els.characterLockReference) {
    els.characterLockReference.value = typeof s.characterLockReference === 'string' ? s.characterLockReference : '';
  }
  for (const f of ADVANCED_NUMERIC_FIELDS) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    el.value = Number.isFinite(s[f.key]) ? s[f.key] : f.def;
  }
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
      pollUrl: '',
      resultUrl: '',
      statusUrl: '',
      projectUrl: '',
      operationStartedUrl: '',
    };
  }
  return {
    pollUrl: `${domain}/api/flow/next-task/${token}`,
    resultUrl: `${domain}/api/flow/submit-result/${token}`,
    statusUrl: `${domain}/api/flow/status/${token}`,
    projectUrl: `${domain}/api/flow/project/${token}`,
    operationStartedUrl: `${domain}/api/flow/operation-started/${token}`,
  };
}

async function saveConfig() {
  // Character lock validation runs first — a malformed value aborts the
  // entire save (we don't want a known-bad lock persisted alongside an
  // otherwise valid config, and the executor would throw on it anyway).
  const characterLockReference = els.characterLockReference
    ? els.characterLockReference.value.trim()
    : '';
  if (characterLockReference && !CHARACTER_LOCK_UUID_RE.test(characterLockReference)) {
    showCharacterLockError('Expected a Google Flow media ID (UUID, 8-4-4-4-12 lowercase hex).');
    return;
  }
  hideCharacterLockError();

  const domain = normalizeDomain(els.histforgeDomain.value);
  const accountToken = els.accountToken.value.trim();
  const { pollUrl, resultUrl, statusUrl, projectUrl, operationStartedUrl } =
    deriveWebhookUrls(domain, accountToken);
  const imageConcurrency = Math.max(1, Math.min(10, parseInt(els.imageConcurrency.value, 10) || 5));
  const videoConcurrency = Math.max(1, Math.min(10, parseInt(els.videoConcurrency.value, 10) || 3));
  const verboseLogging = !!(els.verboseLogging && els.verboseLogging.checked);
  const notificationsEnabled = !!(els.notificationsEnabled && els.notificationsEnabled.checked);

  const advanced = {};
  for (const f of ADVANCED_NUMERIC_FIELDS) {
    const el = document.getElementById(f.id);
    if (!el) continue;
    const raw = el.value.trim();
    const n = raw === '' ? f.def : Number(raw);
    advanced[f.key] = Number.isFinite(n) ? n : f.def;
  }

  await chrome.storage.local.set({
    histforgeDomain: domain,
    pollUrl, resultUrl, statusUrl, projectUrl, operationStartedUrl,
    accountToken,
    imageConcurrency, videoConcurrency,
    verboseLogging, notificationsEnabled,
    characterLockReference,
    ...advanced,
  });
  chrome.runtime.sendMessage({
    action: 'updateWebhooks',
    pollUrl, resultUrl, statusUrl, projectUrl, operationStartedUrl,
    accountToken,
  });
  // One message, both buckets — the router fans out to two settings
  // writes (see messages.js).
  chrome.runtime.sendMessage({
    action: 'updateConcurrency',
    imageConcurrency, videoConcurrency,
  });
  chrome.runtime.sendMessage({ action: 'setVerboseLogging', value: verboseLogging });
  // Dedicated setter — reloadSettings can't clear the lock cache because
  // coerceSettingValue rejects '' for kind:'string'. See messages.js.
  chrome.runtime.sendMessage({
    action: 'setCharacterLockReference',
    value: characterLockReference,
  });
  // Advanced fieldset + notificationsEnabled have no per-field setter on
  // the SW side; ask it to drop its memoized loadPromise so the next
  // getter call re-reads chrome.storage.local.
  chrome.runtime.sendMessage({ action: 'reloadSettings' });

  // If the HistForge host changed, the old permission may no longer cover it.
  await refreshHostPermission();
  refreshEnabled();
  updateDerivedHint();
}

function showCharacterLockError(message) {
  if (!els.characterLockError) return;
  els.characterLockError.textContent = message;
  els.characterLockError.hidden = false;
}

function hideCharacterLockError() {
  if (!els.characterLockError) return;
  els.characterLockError.textContent = '';
  els.characterLockError.hidden = true;
}

function updateDerivedHint() {
  if (!els.derivedHint) return;
  const domain = normalizeDomain(els.histforgeDomain.value);
  const token = els.accountToken.value.trim();
  els.derivedHint.hidden = !(domain && token);
}

function histforgeOrigin() {
  return normalizeDomain(els.histforgeDomain.value) || null;
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
  const domain = normalizeDomain(els.histforgeDomain.value);
  const token = els.accountToken.value.trim();
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
  // Send `stopAllProcessing`, not `stopPolling`. The latter only clears
  // the pollTasks alarm (no NEW tasks fetched) but doesn't set the global
  // stop flag, so any in-flight pollVideoUntilDone loops keep running for
  // their full attempts budget — visible to the user as the SW continuing
  // to POST to aisandbox-pa.googleapis.com long after they pressed Stop.
  // `stopAllProcessing` flips the stop flag (assertNotStopped throws on
  // the next 500ms tick), tears down the alarm, clears in-flight project
  // tracking, and force-stops content-script work in any labs.google tab.
  // startPolling clears the flag again (runner.js: clearStopFlag).
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

async function runSelfTest() {
  if (!els.selfTestResults) return;
  els.testBtn.disabled = true;
  els.selfTestResults.hidden = false;
  els.selfTestResults.textContent = 'Testing…';
  try {
    // Push the latest popup values to the SW before probing — the test
    // pings the URLs the SW currently has cached, and a debounced save
    // may not have fired yet.
    await saveConfig();
    const result = await chrome.runtime.sendMessage({ action: 'runSelfTest' });
    renderSelfTest(result);
  } catch (e) {
    els.selfTestResults.textContent = `Self-test error: ${e.message}`;
  } finally {
    els.testBtn.disabled = false;
  }
}

function renderSelfTest(result) {
  els.selfTestResults.textContent = '';
  if (!result || !Array.isArray(result.checks)) {
    els.selfTestResults.textContent = 'No result';
    return;
  }
  for (const c of result.checks) {
    const li = document.createElement('li');
    li.className = `self-test-item self-test-${c.status}`;
    const dot = document.createElement('span');
    dot.className = 'self-test-dot';
    dot.textContent = c.status === 'pass' ? '●' : c.status === 'fail' ? '●' : '○';
    li.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = ` ${c.name}${c.detail ? ` — ${c.detail}` : ''}`;
    li.appendChild(label);
    els.selfTestResults.appendChild(li);
  }
}
