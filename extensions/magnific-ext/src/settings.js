// Magnific HITL - settings module
// Owns all user-configurable state sourced from chrome.storage.local.
// The per-tunable shape (key, default, kind, normalize) lives in
// src/settings-schema.js — adding a tunable means appending one entry
// there. This module owns the in-memory cache, the loadSettings
// round-trip, the schema-driven setSetting mutator, the storage-writing
// mutators (updateWebhooks / setVerboseLogging / setPollIntervalSec),
// and the public getX/getSetting accessors.
//
// The service worker is the sole writer to chrome.storage.local for
// settings keys — the popup goes through these mutators via the message
// router instead of calling chrome.storage.local.set directly, so the
// in-memory cache and storage stay in sync without a cache-bust hook.
//
// Two write paths reach the cache:
//   1. setSetting(key, value) — runs coerceSettingValue + normalize and
//      silently drops malformed input. Used by loadSettings and the
//      schema-coercible mutators.
//   2. updateWebhooks — bypasses coercion because clearing a webhook URL
//      (passing '') must clear the cache, which is precisely what
//      coerceSettingValue rejects for kind: 'string'.

// In-memory cache, keyed by SETTINGS_SCHEMA key. Initialized with each
// schema entry's default so getters return the documented default before
// loadSettings has a chance to run.
const settingsCache = new Map();
const schemaByKey = new Map();
for (const entry of SETTINGS_SCHEMA) {
  settingsCache.set(entry.key, entry.default);
  schemaByKey.set(entry.key, entry);
}

// Coerce a raw chrome.storage.local value into the schema's declared
// kind. Returns undefined when the value fails the type contract — the
// caller leaves the cache entry untouched so a malformed storage write
// does not clobber a previously-loaded good value (or the default).
function coerceSettingValue(entry, raw) {
  if (raw === undefined) return undefined;
  if (entry.kind === 'string') {
    return typeof raw === 'string' && raw !== '' ? raw : undefined;
  }
  if (entry.kind === 'number') {
    return Number.isFinite(raw) ? raw : undefined;
  }
  if (entry.kind === 'boolean') {
    return typeof raw === 'boolean' ? raw : undefined;
  }
  return undefined;
}

function setSetting(key, raw) {
  const entry = schemaByKey.get(key);
  if (!entry) return false;
  const coerced = coerceSettingValue(entry, raw);
  if (coerced === undefined) return false;
  const v = typeof entry.normalize === 'function' ? entry.normalize(coerced) : coerced;
  settingsCache.set(key, v);
  return true;
}

// Memoize the load so concurrent callers share one storage round-trip
// and late consumers can `await loadSettings()` to guarantee the cache
// is populated before they read.
let loadPromise = null;
function loadSettings() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const stored = await chrome.storage.local.get(
        SETTINGS_SCHEMA.map((entry) => entry.key),
      );
      for (const entry of SETTINGS_SCHEMA) {
        setSetting(entry.key, stored[entry.key]);
      }
      safeLog(
        'Settings loaded - domain:', settingsCache.get('histforgeDomain'),
        'pollIntervalSec:', settingsCache.get('pollIntervalSec'),
      );
    } catch (e) {
      safeLog('Failed to load settings:', e);
    }
  })();
  return loadPromise;
}

// Direct assignment for the four URL keys + token. Bypasses coercion so
// '' clears (the popup uses this when domain/token go blank). Mirrors
// youforge-flow's updateWebhooks shape so the message router can use
// the same action name. Writes the same keys to chrome.storage.local so
// the cache and on-disk state stay in lockstep — the popup never writes
// these keys directly.
async function updateWebhooks(message) {
  const updates = {};
  if (typeof message.nextTaskUrl === 'string') {
    settingsCache.set('nextTaskUrl', message.nextTaskUrl);
    updates.nextTaskUrl = message.nextTaskUrl;
  }
  if (typeof message.submitResultUrl === 'string') {
    settingsCache.set('submitResultUrl', message.submitResultUrl);
    updates.submitResultUrl = message.submitResultUrl;
  }
  if (typeof message.statusUrl === 'string') {
    settingsCache.set('statusUrl', message.statusUrl);
    updates.statusUrl = message.statusUrl;
  }
  if (typeof message.queueSummaryUrl === 'string') {
    settingsCache.set('queueSummaryUrl', message.queueSummaryUrl);
    updates.queueSummaryUrl = message.queueSummaryUrl;
  }
  if (typeof message.magnificToken === 'string') {
    settingsCache.set('magnificToken', message.magnificToken);
    updates.magnificToken = message.magnificToken;
  }
  if (typeof message.histforgeDomain === 'string') {
    settingsCache.set('histforgeDomain', message.histforgeDomain);
    updates.histforgeDomain = message.histforgeDomain;
  }
  await chrome.storage.local.set(updates);
  safeLog(
    'Webhook URLs updated - NextTask:', settingsCache.get('nextTaskUrl'),
    'SubmitResult:', settingsCache.get('submitResultUrl'),
  );
}

function getSetting(key) {
  return settingsCache.get(key);
}

function getHistforgeDomain() { return getSetting('histforgeDomain'); }
function getMagnificToken() { return getSetting('magnificToken'); }
function getNextTaskUrl() { return getSetting('nextTaskUrl'); }
function getSubmitResultUrl() { return getSetting('submitResultUrl'); }
function getStatusUrl() { return getSetting('statusUrl'); }
function getQueueSummaryUrl() { return getSetting('queueSummaryUrl'); }
function getPollIntervalSec() { return getSetting('pollIntervalSec'); }
function getVerboseLogging() { return getSetting('verboseLogging'); }

async function setVerboseLogging(v) {
  const bool = !!v;
  setSetting('verboseLogging', bool);
  await chrome.storage.local.set({ verboseLogging: bool });
}

// Updates the poll-cadence knob. setSetting runs the schema's normalize
// hook (Math.max(5, floor)) so the storage write and cache agree on the
// clamped value, not whatever raw number the popup sent.
async function setPollIntervalSec(v) {
  if (!setSetting('pollIntervalSec', v)) return;
  await chrome.storage.local.set({
    pollIntervalSec: settingsCache.get('pollIntervalSec'),
  });
}
