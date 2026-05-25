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
// Runtime deps (resolved at call time): getActiveTaskCount (src/runner.js),
// loadSettings / getCurrentMode (src/settings.js), loadState / getIsEnabled
// / getLastPoll / getProcessedJobIds (src/state.js), getStats (src/stats.js),
// isSessionExpiredReported (src/webhook.js), isHostPermissionRevoked
// (src/host-permission.js).

async function getStatus() {
  // Guard against the cold-boot window: MV3 can wake the worker and fire a
  // getStatus message before the bootstrap loadSettings/loadState complete.
  // Both are memoized, so this is a no-op on warm calls.
  await Promise.all([loadSettings(), loadState()]);
  const stats = await getStats();
  return {
    isPolling: getIsEnabled(),
    isProcessing: getActiveTaskCount() > 0,
    lastPoll: getLastPoll(),
    stats: Object.keys(stats).length > 0 ? stats : { processed: 0, failed: 0 },
    processedCount: getProcessedJobIds().length,
    mode: getCurrentMode(),
    // Error/session overrides — take precedence over derived status in popup.
    sessionExpired: isSessionExpiredReported(),
    hostPermissionRevoked: isHostPermissionRevoked(),
  };
}
