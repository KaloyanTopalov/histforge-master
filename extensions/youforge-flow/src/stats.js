// YouForge Flow - stats counters
// Owns the `stats` object in chrome.storage.local: a bag of per-counter
// integers (processed / failed / retries, with room for future counters
// like sessionExpiries / contentPolicyRejections). bumpStat(key) does a
// read-modify-write cycle; getStats() returns the full object for the
// popup-status payload.
//
// Why this is separate from state.js: counters are append-only /
// write-heavy while state.js is read-heavy, and future counter keys
// (session expiries, content-policy rejections) will be added here
// without touching state.js's cache shape.
//
// Direct read/write per call instead of a cache — stats are a low-write
// path (one bump per completed / failed / retried task) and popup reads
// are infrequent, so the consistency cost of cache-sync isn't worth the
// latency savings.
//
// Runtime deps: safeLog (src/logger.js).

// Today-only counters that get reset at the next-day rollover. Mirrors
// flow2api's TokenStats today_* columns at extensions/flow2api/src/core/
// models.py:63-79. The rollover compares the stored todayDate (ISO
// YYYY-MM-DD) against the current local date — if they differ, every
// today* key is zeroed out before the named key is bumped.
const TODAY_KEYS = [
  'todayProcessed',
  'todayFailed',
  'todayRateLimited',
  'todayContentPolicy',
];

// Lifetime keys whose bump should mirror into a today* counter. Other
// today* keys (todayRateLimited / todayContentPolicy) are bumped
// directly by handleTaskFailedFIFO based on err.category.
const STAT_TO_TODAY = {
  processed: 'todayProcessed',
  failed: 'todayFailed',
};

function _todayDateISO() {
  return new Date().toISOString().slice(0, 10);
}

async function bumpStat(key) {
  const { stats } = await chrome.storage.local.get('stats');
  const current = stats || {};
  const today = _todayDateISO();
  const next = { ...current };

  // Date rollover — zero every today* counter before the bump.
  if (current.todayDate !== today) {
    for (const k of TODAY_KEYS) next[k] = 0;
    next.todayDate = today;
  }

  next[key] = (next[key] || 0) + 1;

  // Mirror processed/failed bumps into the today* counterpart so callers
  // don't have to bump twice.
  const mirror = STAT_TO_TODAY[key];
  if (mirror) {
    next[mirror] = (next[mirror] || 0) + 1;
  }

  await chrome.storage.local.set({ stats: next });
}

// Reads stats and applies the date rollover if the worker has been idle
// past midnight without a bump. Without this, getStatus shows yesterday's
// today* counters until the first bump after midnight fires.
async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  const current = stats || {};
  const today = _todayDateISO();
  if (current.todayDate && current.todayDate !== today) {
    const rolled = { ...current };
    for (const k of TODAY_KEYS) rolled[k] = 0;
    rolled.todayDate = today;
    await chrome.storage.local.set({ stats: rolled });
    return rolled;
  }
  return current;
}
