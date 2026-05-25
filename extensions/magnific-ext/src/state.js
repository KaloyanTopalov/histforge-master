// Magnific HITL - runtime-state module
// Caches the slice of chrome.storage.local that isn't user-chosen
// configuration: the enabled flag, last-poll timestamp, defensive-dedup
// ring of processed job ids, and the granted HistForge origin. Other
// modules read via getters and mutate via the named setters; loadState
// is invoked on chrome.runtime.onStartup and at cold bootstrap alongside
// loadSettings.

let isEnabled = false;
let lastPoll = null;
let processedJobIds = [];
let grantedOrigin = null;

// In-memory only — survive across task lifecycles within a single SW
// lifetime; an MV3 wake resets them, which is fine: a fresh start gets
// a clean health budget.
let consecutiveFailures = 0;
let pauseReason = null;

let stateLoadPromise = null;
function loadState() {
  if (stateLoadPromise) return stateLoadPromise;
  stateLoadPromise = (async () => {
    try {
      const state = await chrome.storage.local.get([
        'isEnabled', 'lastPoll', 'processedJobIds', 'grantedOrigin',
      ]);
      if (typeof state.isEnabled === 'boolean') isEnabled = state.isEnabled;
      if (state.lastPoll) lastPoll = state.lastPoll;
      if (Array.isArray(state.processedJobIds)) processedJobIds = state.processedJobIds;
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
// Returns the new ring length so callers can log progress.
async function addProcessedJobId(jobId) {
  processedJobIds.push(jobId);
  while (processedJobIds.length > PROCESSED_JOB_IDS_CAP) processedJobIds.shift();
  await chrome.storage.local.set({ processedJobIds });
  return processedJobIds.length;
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
