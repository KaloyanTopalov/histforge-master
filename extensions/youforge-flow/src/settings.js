// YouForge Flow - settings module
// Owns all user-configurable state sourced from chrome.storage.local. The
// per-tunable shape (key, default, kind, normalize, popup binding) lives
// in src/settings-schema.js (SETTINGS_SCHEMA) — adding a tunable means
// appending one entry there. This module owns the in-memory cache, the
// loadSettings → coerce-from-storage round-trip, the schema-driven
// setSetting mutator, and the public getX/getSetting accessors.
//
// Two write paths reach the cache:
//   1. setSetting(key, value) — runs coerceSettingValue + normalize and
//      silently drops malformed input. Used by loadSettings, the
//      schema-coercible mutators (updateConcurrency, setMode,
//      setVerboseLogging, updateExecutorSettings), and any future
//      message-router setter.
//   2. updateWebhooks — bypasses coercion because clearing a webhook URL
//      (passing '') must clear the cache, which is precisely what
//      coerceSettingValue would reject for kind: 'string'.
//
// loadSettings is invoked on chrome.runtime.onStartup and at cold
// bootstrap (MV3 lifecycle); callers can `await loadSettings()` to
// guarantee the cache is populated before reading.

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
// caller leaves the cache entry untouched in that case so a malformed
// storage write does not clobber a previously-loaded good value (or the
// schema default).
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
  if (entry.kind === 'enum') {
    if (Array.isArray(entry.enumValues) && entry.enumValues.includes(raw)) return raw;
    return undefined;
  }
  return undefined;
}

// Schema-driven cache mutator. Coerces by kind, applies the optional
// normalize hook, and writes the cache. Returns true on success. Returns
// false (cache untouched) when the key is unknown or the raw value fails
// coercion — same semantics as the loadSettings storage loop.
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
// and late consumers (e.g. getStatus from the popup during MV3 wake) can
// `await loadSettings()` to guarantee the cache is populated before they
// read.
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
        'Settings loaded - Mode:', settingsCache.get('generationMode'),
        'Poll:', settingsCache.get('pollUrl'),
        'imageConcurrency:', settingsCache.get('imageConcurrency'),
        'videoConcurrency:', settingsCache.get('videoConcurrency'),
      );
    } catch (e) {
      safeLog('Failed to load settings:', e);
    }
  })();
  return loadPromise;
}

function updateWebhooks(message) {
  settingsCache.set('pollUrl', message.pollUrl || '');
  settingsCache.set('resultUrl', message.resultUrl || '');
  settingsCache.set('statusUrl', message.statusUrl || '');
  settingsCache.set('projectUrl', message.projectUrl || '');
  settingsCache.set('operationStartedUrl', message.operationStartedUrl || '');
  if (typeof message.accountToken === 'string') {
    settingsCache.set('accountToken', message.accountToken);
  }
  safeLog(
    'Webhook URLs updated - Poll:', settingsCache.get('pollUrl'),
    'Result:', settingsCache.get('resultUrl'),
    'Status:', settingsCache.get('statusUrl'),
    'Project:', settingsCache.get('projectUrl'),
    'OperationStarted:', settingsCache.get('operationStartedUrl'),
  );
}

// Bucket discriminant → schema key + per-bucket invalid-input default.
// The default is what `Number(value) || default` falls through to when
// the popup sends a blank/NaN value; the schema's normalize hook then
// clamps to [1, MAX_CONCURRENT_MAX].
const CONCURRENCY_BUCKETS = {
  image: { key: 'imageConcurrency', default: 5 },
  video: { key: 'videoConcurrency', default: 3 },
};

function updateConcurrency(bucket, value) {
  const entry = CONCURRENCY_BUCKETS[bucket];
  if (!entry) throw new Error(`updateConcurrency: unknown bucket "${bucket}"`);
  setSetting(entry.key, Number(value) || entry.default);
  safeLog(`${entry.key} updated:`, settingsCache.get(entry.key));
}

function setMode(mode) {
  setSetting('generationMode', mode);
  safeLog('Generation mode set to:', settingsCache.get('generationMode'));
}

// Refresh the executor-settings cache from a popup / message-router
// payload. Mirrors updateWebhooks / updateConcurrency / setMode — the
// router is not yet wired to call this today; the load-at-bootstrap
// path (loadSettings) is sufficient for the HistForge-driven write
// flow. Provided so future popup UI for these six keys has a cache
// refresh entry point.
function updateExecutorSettings(message) {
  for (const key of [
    'outputCount', 'aspectRatio', 'imageModel', 'videoModel', 'imgUpscale', 'vidUpscale',
  ]) {
    setSetting(key, message[key]);
  }
  safeLog('Executor settings updated - outputCount:', settingsCache.get('outputCount'),
    'aspect:', settingsCache.get('aspectRatio'),
    'image:', settingsCache.get('imageModel'),
    'video:', settingsCache.get('videoModel'),
    'imgUpscale:', settingsCache.get('imgUpscale'),
    'vidUpscale:', settingsCache.get('vidUpscale'));
}

// Schema-driven public accessor. Returns undefined for unknown keys; the
// cache always contains an entry for every schema key (initialized with
// the default) so a known key never returns undefined.
function getSetting(key) {
  return settingsCache.get(key);
}

function getPollUrl() { return getSetting('pollUrl'); }
function getResultUrl() { return getSetting('resultUrl'); }
function getStatusUrl() { return getSetting('statusUrl'); }
function getProjectUrl() { return getSetting('projectUrl'); }
function getOperationStartedUrl() { return getSetting('operationStartedUrl'); }
function getAccountToken() { return getSetting('accountToken'); }
function getMaxConcurrent(bucket) {
  const entry = CONCURRENCY_BUCKETS[bucket];
  if (!entry) throw new Error(`getMaxConcurrent: unknown bucket "${bucket}"`);
  return getSetting(entry.key);
}
function getCurrentMode() { return getSetting('generationMode'); }
function getOutputCount() { return getSetting('outputCount'); }
function getAspectRatio() { return getSetting('aspectRatio'); }
function getImageModel() { return getSetting('imageModel'); }
function getVideoModel() { return getSetting('videoModel'); }
function getImgUpscale() { return getSetting('imgUpscale'); }
function getVidUpscale() { return getSetting('vidUpscale'); }
function getVerboseLogging() { return getSetting('verboseLogging'); }
function getVideoPollBaseSec() { return getSetting('videoPollBaseSec'); }
function getVideoPollMaxSec() { return getSetting('videoPollMaxSec'); }
function getVideoPollMaxAttempts() { return getSetting('videoPollMaxAttempts'); }
function getVideoPollStepFactor() { return getSetting('videoPollStepFactor'); }
function getVideoPollJitterMs() { return getSetting('videoPollJitterMs'); }
function getLaunchStaggerMs() { return getSetting('launchStaggerMs'); }
function getCircuitBreakerThreshold() { return getSetting('circuitBreakerThreshold'); }
function getRateLimitCooldownMinutes() { return getSetting('rateLimitCooldownMinutes'); }
function getCreditsMinThreshold() { return getSetting('creditsMinThreshold'); }
function getTaskPollIntervalSec() { return getSetting('taskPollIntervalSec'); }
function getWebhookMaxRetries() { return getSetting('webhookMaxRetries'); }
function getUpscaleMaxAttempts() { return getSetting('upscaleMaxAttempts'); }
function getUploadMaxRetries() { return getSetting('uploadMaxRetries'); }
function getImageRequestTimeoutSec() { return getSetting('imageRequestTimeoutSec'); }
function getVideoRequestTimeoutSec() { return getSetting('videoRequestTimeoutSec'); }
function getUploadTimeoutSec() { return getSetting('uploadTimeoutSec'); }
function getMediaFetchTimeoutSec() { return getSetting('mediaFetchTimeoutSec'); }
function getSessionReFetchRetries() { return getSetting('sessionReFetchRetries'); }
function getProgressEventEveryN() { return getSetting('progressEventEveryN'); }
function getNotificationsEnabled() { return getSetting('notificationsEnabled'); }

// Toggles the verbose-logging flag. Called by the popup checkbox via
// the message router; the cache stays in sync without a re-read. The
// !!v cast normalizes truthy/falsy callers (the popup sends a real
// boolean today, but the cast keeps the contract robust).
function setVerboseLogging(v) {
  setSetting('verboseLogging', !!v);
}

// Drops the memoized loadPromise so the next loadSettings() call re-reads
// chrome.storage.local. Called by the message router after the popup
// writes an Advanced-fieldset value (Task 4.1) — those don't have
// per-field setters because adding one per knob is more boilerplate than
// the savings warrant. The next consumer that calls a getter triggers
// the re-read implicitly via loadSettings.
function reloadSettings() {
  loadPromise = null;
  return loadSettings();
}
