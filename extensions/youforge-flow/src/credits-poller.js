// YouForge Flow - credits poller
// Periodically asks the Flow credits endpoint for the signed-in account's
// balance and tier, and forwards a `credits` StatusEvent to HistForge so
// the dashboard can show remaining capacity. Runs every
// CREDITS_POLL_MINUTES while polling is active; kicked off by
// runner.startPolling and torn down by runner.stopPolling.
//
// Uses chrome.alarms rather than setInterval because MV3 service workers
// suspend after ~30s of idle and kill any in-flight setInterval timers —
// the alarm wakes the worker every CREDITS_POLL_MINUTES regardless of
// suspend state. Multiple chrome.alarms.onAlarm listeners coexist (runner
// also has one for 'pollTasks'); each filters by alarm.name.
//
// Runtime deps (resolved at call time): CREDITS_POLL_MINUTES
// (src/constants.js), getSessionTokenFromPage (src/auth.js), getCredits
// (flow-api.js), postStatusEvent (src/webhook.js), safeLog (src/logger.js),
// getPauseReason (src/state.js), pauseGenerationOnly /
// resumeGenerationOnly (src/cooldown.js — moved out of runner.js in
// the Phase 2 SOLID audit refactor), getCreditsMinThreshold
// (src/settings.js, default 0; surfaced by Task 4.1).

function startCreditsPolling() {
  chrome.alarms.create('credits', { periodInMinutes: CREDITS_POLL_MINUTES });
  // Fire once immediately so the dashboard doesn't wait a full interval
  // for the first reading. chrome.alarms.create with an existing name
  // replaces the prior alarm, so re-entry is safe without a guard.
  pollCreditsOnce();
}

function stopCreditsPolling() {
  chrome.alarms.clear('credits');
}

async function pollCreditsOnce() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    if (tabs.length === 0) {
      safeLog('[credits] no Flow tab — skipping');
      return;
    }
    const authToken = await getSessionTokenFromPage(tabs[0].id);
    if (!authToken) {
      safeLog('[credits] no session token — skipping');
      return;
    }
    const result = await getCredits(authToken);
    if (!result) {
      safeLog('[credits] Google non-2xx (getCredits returned null)');
      return;
    }
    // Credits-threshold pause/resume (Task 3.3). Pause when credits drop
    // to/below threshold and the runner isn't already paused for some
    // other reason (rate-limit cool-off wins). Resume when credits
    // recover AND we own the current pause — guards against stomping a
    // still-active rate_limited cool-off.
    const threshold = getCreditsMinThreshold();
    const currentPause = getPauseReason();
    let pausedNow = false;
    let resumedNow = false;
    if (typeof result.credits === 'number') {
      if (result.credits <= threshold && currentPause === null) {
        pauseGenerationOnly('credits_exhausted');
        pausedNow = true;
      } else if (result.credits > threshold && currentPause === 'credits_exhausted') {
        resumeGenerationOnly('credits_exhausted');
        resumedNow = true;
      }
    }
    const payload = {
      type: 'StatusEvent',
      event: 'credits',
      credits: result.credits,
      tier: result.tier,
      serviceTier: result.serviceTier,
      sku: result.sku,
    };
    if (pausedNow) {
      payload.paused = true;
      payload.reason = 'credits_exhausted';
    } else if (resumedNow) {
      payload.resumed = true;
      payload.reason = 'credits_recovered';
    }
    await postStatusEvent(payload);
    safeLog('[credits] ok —', result.credits, 'credits');
  } catch (e) {
    safeLog('[credits] poll failed:', e && e.message ? e.message : e);
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'credits') pollCreditsOnce();
});
