// YouForge Flow - status aggregator
// Reports the combined state of the popup's "everything going on" view:
// storage-backed counters, live runner state, and the two override flags
// that take precedence over derived status (session expired, host
// permission revoked).
//
// Plan deviation (docs/plans/2026-04-21-youforge-flow-audit-modularize.md
// §1.3 / §3.16): the plan trimmed getStatus in place without naming its
// final home. Hosted here because the fields it aggregates span four
// modules (runner, settings, webhook, host-permission) — keeping it in
// any one of them would couple that module to the other three, and
// messages.js is supposed to be switch-only.
//
// Runtime deps (resolved at call time): getActiveCount (src/runner.js),
// loadSettings / getCurrentMode (src/settings.js), loadState / getIsEnabled
// / getLastPoll / getProcessedJobIds / getPauseReason / getCooldownUntil
// (src/state.js), getStats (src/stats.js),
// isSessionExpiredReported (src/webhook.js), isHostPermissionRevoked
// (src/host-permission.js).

// Default shape returned when no stats record exists yet. Includes the
// today* counters added in task 1.7 so popup / HistForge consumers can
// rely on them being present even on a fresh install.
const _STATS_DEFAULTS = {
  processed: 0,
  failed: 0,
  todayProcessed: 0,
  todayFailed: 0,
  todayRateLimited: 0,
  todayContentPolicy: 0,
};

async function getStatus() {
  // Guard against the cold-boot window: MV3 can wake the worker and fire a
  // getStatus message before the bootstrap loadSettings/loadState complete.
  // Both are memoized, so this is a no-op on warm calls.
  await Promise.all([loadSettings(), loadState()]);
  const stats = await getStats();
  const merged = { ..._STATS_DEFAULTS, ...stats };
  return {
    isPolling: getIsEnabled(),
    isProcessing: getActiveCount('image') + getActiveCount('video') > 0,
    lastPoll: getLastPoll(),
    stats: merged,
    processedCount: getProcessedJobIds().length,
    mode: getCurrentMode(),
    // Error/session overrides — take precedence over derived status in popup.
    sessionExpired: isSessionExpiredReported(),
    hostPermissionRevoked: isHostPermissionRevoked(),
    // Phase 3 fix #4: surface soft-pause state so the popup can render the
    // remaining cool-off window and HistForge knows the runner is alive
    // but intentionally idle.
    pauseReason: getPauseReason(),
    cooldownUntil: getCooldownUntil(),
  };
}
