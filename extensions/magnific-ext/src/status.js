// Magnific HITL - status aggregator
// Reports the combined state of the popup's "everything going on" view:
// storage-backed counters, live runner state, and the host-permission
// override flag. Loaded after settings.js / state.js / host-permission.js
// so the symbols it reads are in scope.

async function getStatus() {
  // Guard against the cold-boot window: MV3 can wake the worker and
  // fire a getStatus message before the bootstrap loadSettings /
  // loadState complete. Both are memoized; warm calls are no-ops.
  await Promise.all([loadSettings(), loadState()]);
  return {
    isPolling: getIsEnabled(),
    lastPoll: getLastPoll(),
    processedCount: getProcessedJobIds().length,
    domain: getHistforgeDomain(),
    // Override flags — popup uses these to render an error banner before
    // the derived "Idle / Polling" status.
    hostPermissionRevoked: isHostPermissionRevoked(),
    pauseReason: getPauseReason(),
  };
}
