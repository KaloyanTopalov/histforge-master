// YouForge Flow - session-guard wrapper
// Single point at which executor errors are inspected: STOP_REQUESTED
// passes through silently, session-expired errors trigger the one-shot
// webhook notification (which also halts polling), and everything else
// rethrows so runner.js's catch can handle it.
//
// HistForge owns retry semantics via requeueTask + google_flow_max_retries,
// so this wrapper does NOT retry — any non-stop, non-session error
// propagates straight back to the runner which reports it via submit-result
// and lets HistForge decide whether to requeue.
//
// Plan deviation (docs/plans/2026-04-21-youforge-flow-audit-modularize.md
// §3.14): the plan expected executeTaskWithSessionGuard to stay inline in
// the bootstrapper. Extracted here to keep runner.js free of session-
// expiry semantics and executors/index.js free of webhook knowledge —
// this is the only place that bridges the two.
//
// Runtime deps (resolved at call time): executeTaskViaAPI
// (src/executors/index.js), notifySessionExpired (src/webhook.js),
// assertNotStopped (src/stop-flag.js).

async function executeTaskWithSessionGuard(task, tabId) {
  assertNotStopped();
  try {
    return await executeTaskViaAPI(task, tabId);
  } catch (error) {
    if (error.message === 'STOP_REQUESTED') throw error;
    if (error.isSessionExpired) {
      await notifySessionExpired(error.message);
    }
    throw error;
  }
}
