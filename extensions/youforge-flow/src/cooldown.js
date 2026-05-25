// YouForge Flow - rate-limit cool-off / soft-pause module
// Owns the cool-off subsystem extracted out of runner.js: the trigger
// fired from every Flow API throw site (via flow-error.js's
// throwFlowApiError helper), the soft-pause / resume primitives that
// gate the pollTasks alarm without tearing down credits visibility,
// the one-shot rateLimitCooldown alarm listener that flips the runner
// back on, and the configurable launch-stagger / poll-interval
// accessors that runner.js and the cool-off math both depend on.
//
// Public verbs consumed by other modules:
//   - triggerRateLimitCooldown(err) — arms the cool-off; idempotent
//     (no-op if already paused).
//   - pauseGenerationOnly(reason) / resumeGenerationOnly(expectedReason)
//     — soft-pause primitives, reason-guarded so a credits-recovered
//     resume can't accidentally unstick a still-active rate-limit
//     cool-off.
//   - _launchStaggerMs() / _taskPollIntervalMinutes() — config
//     accessors. runner.js callers reach them as service-worker globals.
//
// Lifecycle: runner.js's startPolling / stopPolling still own clearing
// the rateLimitCooldown alarm + pause-reason + cooldownUntil at the
// start/stop boundary. Only the *implementation* of cool-off lives
// here; teardown stays with the runner because that's where the
// hard-stop / restart entry points are.
//
// Runtime deps (resolved at call time): getStopFlag (src/stop-flag.js),
// getPauseReason / setPauseReason / clearPauseReason / setCooldownUntil
// (src/state.js), getRateLimitCooldownMinutes / getLaunchStaggerMs /
// getTaskPollIntervalSec (src/settings.js — schema-backed defaults),
// POLL_INTERVAL_MINUTES (src/constants.js), postStatusEvent
// (src/webhook.js), safeLog (src/logger.js).

// Configurable inter-launch delay (Task 3.4 in the original runner
// plan). Schema default is 500ms; 0 disables the stagger entirely. At
// maxConcurrent: 5 with simultaneous completion, the spacing keeps
// Google's per-second budget from spiking even when the per-minute
// quota is healthy. Mirrors flow2api's flow_image_launch_stagger_ms
// config key (dormant at default 0 there).
function _launchStaggerMs() {
  return getLaunchStaggerMs();
}

// Configurable task-poll interval (Task 4.1 in the original runner
// plan). Settings stores seconds; chrome.alarms takes minutes. Falls
// back to POLL_INTERVAL_MINUTES (~10s) when the cached value is
// non-positive.
function _taskPollIntervalMinutes() {
  const sec = getTaskPollIntervalSec();
  return Number.isFinite(sec) && sec > 0 ? sec / 60 : POLL_INTERVAL_MINUTES;
}

// Soft pause/resume primitives. Distinct from stopPolling, which is the
// user-initiated hard stop. Soft pause clears only the pollTasks alarm
// and leaves credits visibility on; reason-guarded resume keeps
// credits-recovered from accidentally unsticking a still-active
// rate-limit cool-off.
function pauseGenerationOnly(reason) {
  const current = getPauseReason();
  if (current !== null) {
    safeLog(`[runner] pauseGenerationOnly(${reason}) — already paused for "${current}", no-op`);
    return;
  }
  safeLog(`[runner] pauseGenerationOnly(${reason}) — clearing pollTasks alarm`);
  chrome.alarms.clear('pollTasks');
  setPauseReason(reason);
}

function resumeGenerationOnly(expectedReason) {
  if (getStopFlag()) {
    safeLog('[runner] resumeGenerationOnly — stop flag is set, hard stop wins');
    return;
  }
  const current = getPauseReason();
  if (current !== expectedReason) {
    safeLog(`[runner] resumeGenerationOnly(${expectedReason}) — current pauseReason="${current}", no-op`);
    return;
  }
  safeLog(`[runner] resumeGenerationOnly(${expectedReason}) — re-arming pollTasks alarm`);
  const _resumeIntervalMin = _taskPollIntervalMinutes();
  chrome.alarms.create('pollTasks', {
    delayInMinutes: _resumeIntervalMin,
    periodInMinutes: _resumeIntervalMin,
  });
  clearPauseReason();
  if (expectedReason === 'rate_limited') {
    setCooldownUntil(null);
  }
}

// Trigger a 429 cool-off. Reads err.retryAfterMs (populated by
// parseFlowApiError when the Retry-After header is present), defaults
// to the configured cooldown (or 10 minutes), pauses generation, sets
// the cooldownUntil checkpoint, schedules the one-shot
// rateLimitCooldown alarm, and emits a rate_limited StatusEvent.
// Idempotent — second call while paused is a no-op via
// pauseGenerationOnly's guard.
async function triggerRateLimitCooldown(err) {
  if (getPauseReason() !== null) {
    safeLog('[runner] triggerRateLimitCooldown — already paused, skipping');
    return;
  }
  const defaultMin = getRateLimitCooldownMinutes();
  const minMs = 30_000; // floor to keep tight 429 storms from busy-looping
  const headerMs = (err && typeof err.retryAfterMs === 'number') ? err.retryAfterMs : null;
  const cooldownMs = Math.max(minMs, headerMs || defaultMin * 60_000);
  const cooldownUntil = Date.now() + cooldownMs;
  setCooldownUntil(cooldownUntil);
  pauseGenerationOnly('rate_limited');
  chrome.alarms.create('rateLimitCooldown', {
    delayInMinutes: cooldownMs / 60_000,
  });
  try {
    await postStatusEvent({
      type: 'StatusEvent',
      event: 'rate_limited',
      retryAfterMs: headerMs,
      cooldownUntil,
    });
  } catch (_e) { /* advisory */ }
}

// Dedicated alarm listener for the rateLimitCooldown one-shot. Chrome
// supports multiple onAlarm listeners on the same event; runner.js
// keeps its own listener for the pollTasks periodic alarm. Listener
// returns early on every other alarm name so it never interferes with
// runner.js's branch.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'rateLimitCooldown') return;
  safeLog('[runner] rateLimitCooldown alarm fired - resuming generation');
  resumeGenerationOnly('rate_limited');
});
