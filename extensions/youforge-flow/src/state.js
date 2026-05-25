// YouForge Flow - runtime-state module
// Caches the slice of chrome.storage.local that isn't user-chosen
// configuration: the enabled flag, last-poll timestamp, defensive-dedup
// ring of processed job ids, the cached account-tier, and the granted
// HistForge origin. Other modules read via getters and mutate via the
// named setters; loadState is invoked on chrome.runtime.onStartup and
// at cold bootstrap (MV3 lifecycle) alongside loadSettings.
//
// Why this is separate from settings.js: settings.js holds values the
// user configures (webhooks, concurrency, mode). state.js holds values
// that change during the worker's lifetime in response to runtime
// events (polling toggled, tier detected, permission granted). Both
// mirror the same cache-in-memory / persist-through-setter pattern.
//
// Runtime deps: safeLog (src/logger.js).

// Bounded-ring cap for the processedJobIds dedup buffer. A long-lived
// install shouldn't grow storage without limit; HistForge's
// dispatch-qualified IDs make collisions beyond this horizon
// vanishingly unlikely.
const PROCESSED_JOB_IDS_CAP = 500;

let isEnabled = false;
let lastPoll = null;
let processedJobIds = [];
let cachedAccountTier = null;
let grantedOrigin = null;

// Circuit-breaker counter (Task 3.1). In-memory only — survives across
// task lifecycles within a single SW lifetime; an MV3 wake resets it,
// which is fine: a fresh start gets a clean health budget.
let consecutiveFailures = 0;

// Soft-pause primitive (Task 3.2 / 3.3). null = generation polling is
// running; 'rate_limited' or 'credits_exhausted' = paused for that
// reason. The first pauser wins — concurrent triggers do not overwrite
// the reason. cooldownUntil is the wall-clock ms at which a
// rate-limited pause is scheduled to auto-resume; surfaces in popup /
// status payload so users see the remaining cool-off window.
let pauseReason = null;
let cooldownUntil = null;

// Memoize the load so concurrent callers share one storage round-trip and
// late consumers (e.g. getStatus from the popup during MV3 wake) can
// `await loadState()` to guarantee the cache is populated before they read.
let stateLoadPromise = null;
function loadState() {
  if (stateLoadPromise) return stateLoadPromise;
  stateLoadPromise = (async () => {
    try {
      const state = await chrome.storage.local.get([
        'isEnabled', 'lastPoll', 'processedJobIds', 'accountTier', 'grantedOrigin',
      ]);
      if (typeof state.isEnabled === 'boolean') isEnabled = state.isEnabled;
      if (state.lastPoll) lastPoll = state.lastPoll;
      if (Array.isArray(state.processedJobIds)) processedJobIds = state.processedJobIds;
      if (state.accountTier) cachedAccountTier = state.accountTier;
      if (state.grantedOrigin) grantedOrigin = state.grantedOrigin;
    } catch (e) {
      safeLog('Failed to load state:', e);
    }
  })();
  return stateLoadPromise;
}

function getIsEnabled() { return isEnabled; }
function getLastPoll() { return lastPoll; }
function getProcessedJobIds() { return processedJobIds; }
function getCachedAccountTier() { return cachedAccountTier; }
function getGrantedOrigin() { return grantedOrigin; }

async function setIsEnabled(v) {
  isEnabled = !!v;
  await chrome.storage.local.set({ isEnabled });
}

async function setLastPoll(v) {
  lastPoll = v;
  await chrome.storage.local.set({ lastPoll });
}

// Appends jobId to the processedJobIds ring with bounded-cap trimming.
// Returns the new ring length so callers can log progress with their
// own module prefix.
async function addProcessedJobId(jobId) {
  processedJobIds.push(jobId);
  while (processedJobIds.length > PROCESSED_JOB_IDS_CAP) processedJobIds.shift();
  await chrome.storage.local.set({ processedJobIds });
  return processedJobIds.length;
}

async function setCachedAccountTier(v) {
  cachedAccountTier = v;
  await chrome.storage.local.set({ accountTier: cachedAccountTier });
}

async function clearCachedAccountTier() {
  cachedAccountTier = null;
  await chrome.storage.local.set({ accountTier: null });
}

async function setGrantedOrigin(origin) {
  grantedOrigin = origin;
  await chrome.storage.local.set({ grantedOrigin });
}

async function clearGrantedOrigin() {
  grantedOrigin = null;
  await chrome.storage.local.set({ grantedOrigin: null });
}

function getConsecutiveFailures() { return consecutiveFailures; }
function bumpConsecutiveFailures() { consecutiveFailures += 1; return consecutiveFailures; }
function resetConsecutiveFailures() { consecutiveFailures = 0; }

function getPauseReason() { return pauseReason; }
function setPauseReason(reason) { pauseReason = reason; }
function clearPauseReason() { pauseReason = null; }

function getCooldownUntil() { return cooldownUntil; }
function setCooldownUntil(ms) { cooldownUntil = ms; }
