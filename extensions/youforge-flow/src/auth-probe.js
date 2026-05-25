// YouForge Flow - Auth probe
// After notifySessionExpired halts polling, a periodic Chrome alarm asks
// the labs.google content bridge for a session token. When the user
// re-logs, the next probe sees the fresh token, calls startPolling(), and
// clears itself. The minute cadence is a tradeoff: short enough that
// "I just re-logged, why isn't it running?" stays under the user's
// patience horizon, long enough that a tab without a logged-in session
// doesn't generate per-second console spam.
//
// Lives in its own module (not webhook.js) because the probe owns three
// concerns webhook.js shouldn't: (a) auth state read-back, (b) Chrome
// alarm lifecycle, and (c) re-arming the runner. webhook.js only calls
// `scheduleAuthProbe()` from inside `notifySessionExpired`, mirroring how
// it already calls `clearAuthCache()` (an auth.js symbol).
//
// Loaded after src/runner.js so the `startPolling` forward-ref resolves
// at call time. The runner clears the probe on start/stop (idempotent).
//
// Runtime deps (resolved at call time): clearSessionExpiredReport /
// isSessionExpiredReported (src/webhook.js), startPolling (src/runner.js
// — forward-ref), safeLog (src/logger.js).

const AUTH_PROBE_ALARM = 'authProbe';
const AUTH_PROBE_INTERVAL_MIN = 1;

function scheduleAuthProbe() {
  // Defensive clear before re-arm: if a prior expiry already armed the
  // alarm and was never cleared (e.g. SW restart between expiries), we
  // want a single live alarm, not two stacked.
  chrome.alarms.clear(AUTH_PROBE_ALARM, () => {
    chrome.alarms.create(AUTH_PROBE_ALARM, {
      delayInMinutes: AUTH_PROBE_INTERVAL_MIN,
      periodInMinutes: AUTH_PROBE_INTERVAL_MIN,
    });
    safeLog('[auth-probe] Armed (every ' + AUTH_PROBE_INTERVAL_MIN + ' min)');
  });
}

function clearAuthProbe() {
  chrome.alarms.clear(AUTH_PROBE_ALARM);
}

async function probeAuth() {
  // The session-expired flag can flip back to false if the user manually
  // started polling between alarm firings (startPolling clears the alarm,
  // but a tick already in flight isn't cancelled). Guard against probing
  // a healthy session — nothing to fix.
  if (!isSessionExpiredReported()) {
    clearAuthProbe();
    return;
  }
  let tabs;
  try {
    tabs = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
  } catch (e) {
    safeLog('[auth-probe] tabs.query failed:', e?.message || String(e));
    return;
  }
  if (!tabs || tabs.length === 0) {
    safeLog('[auth-probe] No labs.google/fx tab open, will retry');
    return;
  }
  let response;
  try {
    // Direct sendMessage rather than getSessionTokenFromPage: that helper
    // re-fires notifySessionExpired on failure, which would re-arm us in a
    // self-tail. The probe is a passive check — log and wait.
    response = await chrome.tabs.sendMessage(tabs[0].id, { action: 'getSessionToken' });
  } catch (e) {
    safeLog('[auth-probe] Bridge unreachable:', e?.message || String(e));
    return;
  }
  const token = response?.session?.accessToken || response?.token;
  if (!token) {
    safeLog('[auth-probe] Still no token (re-login pending)');
    return;
  }
  safeLog('[auth-probe] Session restored, resuming polling');
  clearSessionExpiredReport();
  clearAuthProbe();
  // Forward-ref: startPolling lives in src/runner.js, loaded before this
  // module per background.js's importScripts order. Swallow any throw so
  // a misbehaving runner doesn't surface back through the alarm runtime.
  try {
    await startPolling();
  } catch (e) {
    safeLog('[auth-probe] startPolling threw:', e?.message || String(e));
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AUTH_PROBE_ALARM) return;
  probeAuth();
});
