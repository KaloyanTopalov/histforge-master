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

async function bumpStat(key) {
  const { stats } = await chrome.storage.local.get('stats');
  const current = stats || {};
  await chrome.storage.local.set({
    stats: {
      ...current,
      [key]: (current[key] || 0) + 1,
    },
  });
}

async function getStats() {
  const { stats } = await chrome.storage.local.get('stats');
  return stats || {};
}
