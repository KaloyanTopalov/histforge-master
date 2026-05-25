// YouForge Flow - host-permission watchdog
// If the user revokes the HistForge host permission mid-run (via
// chrome://extensions), chrome fires chrome.permissions.onRemoved. We
// halt polling immediately and surface "Error: HistForge host permission
// revoked" to the popup. Start stays disabled until the user re-grants.
//
// Runtime deps (resolved at call time): setStopFlag (src/stop-flag.js),
// stopPolling (src/runner.js — loads later in the importScripts chain),
// getGrantedOrigin / clearGrantedOrigin (src/state.js).

let hostPermissionRevoked = false;

function pathsStartsWithOrigin(origins, origin) {
  if (!origin) return false;
  const match = `${origin}/*`;
  return (origins || []).includes(match);
}

async function halt_onHostRemoved(removedOrigins) {
  if (!pathsStartsWithOrigin(removedOrigins, getGrantedOrigin())) return;
  safeLog('HistForge host permission revoked; halting.');
  hostPermissionRevoked = true;
  setStopFlag();
  try { await stopPolling(); } catch (e) { /* ignore */ }
  await clearGrantedOrigin();
}

async function noteHostAdded(origins) {
  if (pathsStartsWithOrigin(origins, getGrantedOrigin())) {
    // User re-granted the previously stored origin — re-arm.
    hostPermissionRevoked = false;
  }
}

function isHostPermissionRevoked() {
  return hostPermissionRevoked;
}

chrome.permissions.onRemoved.addListener((p) => halt_onHostRemoved(p.origins || []));
chrome.permissions.onAdded.addListener((p) => noteHostAdded(p.origins || []));
