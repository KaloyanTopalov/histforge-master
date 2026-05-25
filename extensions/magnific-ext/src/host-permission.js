// Magnific HITL - host-permission watchdog
// If the user revokes the HistForge host permission mid-run (via
// chrome://extensions), chrome fires chrome.permissions.onRemoved. We
// halt polling immediately and surface "Error: HistForge host
// permission revoked" to the popup via the status aggregator. Start
// stays disabled until the user re-grants.
//
// Runtime deps (resolved at call time): setStopFlag (stop-flag.js),
// stopPolling (runner.js — loads later in the importScripts chain),
// getGrantedOrigin / clearGrantedOrigin (state.js), safeLog.

let hostPermissionRevoked = false;

function pathStartsWithOrigin(origins, origin) {
  if (!origin) return false;
  const match = `${origin}/*`;
  return (origins || []).includes(match);
}

async function halt_onHostRemoved(removedOrigins) {
  if (!pathStartsWithOrigin(removedOrigins, getGrantedOrigin())) return;
  safeLog('HistForge host permission revoked; halting.');
  hostPermissionRevoked = true;
  setStopFlag();
  try { await stopPolling(); } catch (_e) { /* ignore */ }
  await clearGrantedOrigin();
}

async function noteHostAdded(origins) {
  if (pathStartsWithOrigin(origins, getGrantedOrigin())) {
    // User re-granted the previously stored origin — re-arm.
    hostPermissionRevoked = false;
  }
}

function isHostPermissionRevoked() {
  return hostPermissionRevoked;
}

chrome.permissions.onRemoved.addListener((p) => halt_onHostRemoved(p.origins || []));
chrome.permissions.onAdded.addListener((p) => noteHostAdded(p.origins || []));
