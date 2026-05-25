// Magnific HITL - poll loop
// Polls HistForge for tasks and dispatches them through the executor
// registry (src/executors/index.js). Executors hold a slot for the
// duration of their work via claimExecutorSlot / releaseExecutorSlot;
// the next-poll gate reads hasActiveExecutor() and skips a poll cycle
// while a task is in flight so a second row can't be claimed under a
// single operator. The gate is mode-agnostic: the registry contract is
// one task at a time, so adding a new executor mode does not require
// touching this file — the executor just calls the slot API like the
// existing two.
//
// Polls are kicked by chrome.alarms 'pollTasks' (armed by startPolling
// with period = pollIntervalSec). The token is already embedded in
// getNextTaskUrl() at popup-save time, so the runner does not read the
// token directly.
//
// Runtime deps (resolved at call time): getStopFlag / clearStopFlag
// (stop-flag.js), getPauseReason / clearPauseReason (state.js),
// setIsEnabled / setLastPoll (state.js), getNextTaskUrl /
// getPollIntervalSec (settings.js), fetchWithTimeout (http.js),
// resetConsecutiveFailures / bumpConsecutiveFailures (state.js),
// executeTaskViaExtension (executors/index.js — forward-ref, resolved
// at call time), safeLog (logger.js).

let pollingInProgress = false;
let activeExecutors = 0;

function claimExecutorSlot() {
  activeExecutors += 1;
}

function releaseExecutorSlot() {
  activeExecutors = Math.max(0, activeExecutors - 1);
}

function hasActiveExecutor() {
  return activeExecutors > 0;
}

async function startPolling() {
  safeLog('Starting polling…');
  await setIsEnabled(true);
  clearStopFlag();
  if (typeof clearPauseReason === 'function') clearPauseReason();
  if (typeof resetConsecutiveFailures === 'function') resetConsecutiveFailures();

  const intervalSec = getPollIntervalSec();
  // chrome.alarms takes minutes; convert from seconds. MV3 alarms have
  // a minimum of 30s for unpacked dev / 60s for store builds. We always
  // pass the computed value — Chrome silently clamps if the install is
  // a store build with intervalSec < 60.
  const periodInMinutes = Math.max(1 / 60, intervalSec / 60);
  chrome.alarms.create('pollTasks', {
    delayInMinutes: periodInMinutes,
    periodInMinutes,
  });
  safeLog(`Polling armed every ${intervalSec}s (${periodInMinutes}min alarm)`);
}

async function stopPolling() {
  safeLog('Stopping polling…');
  await setIsEnabled(false);
  chrome.alarms.clear('pollTasks');
  if (typeof clearPauseReason === 'function') clearPauseReason();
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'pollTasks') return;
  if (pollingInProgress) {
    safeLog('Alarm skipped — another poll already in progress');
    return;
  }
  await pollForTasks();
});

async function pollForTasks() {
  if (getStopFlag()) {
    safeLog('⛔ STOPPED — not polling');
    return { stopped: true };
  }

  const reason = (typeof getPauseReason === 'function') ? getPauseReason() : null;
  if (reason) {
    safeLog(`⏸ Paused (${reason}) — not polling`);
    return { paused: true, reason };
  }

  if (pollingInProgress) {
    safeLog('⚠️ Poll already in progress — skipping');
    return { skipped: true, reason: 'poll_in_progress' };
  }

  if (hasActiveExecutor()) {
    safeLog(`⏳ executor task in flight (${activeExecutors}) — skipping poll`);
    return { skipped: true, reason: 'executor_in_flight' };
  }

  const url = getNextTaskUrl();
  if (!url) {
    safeLog('No next-task URL configured — popup not set up yet');
    return { noConfig: true };
  }

  pollingInProgress = true;
  try {
    await setLastPoll(new Date().toISOString());
    safeLog('Polling:', url);
    let response;
    try {
      response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }, 15_000);
    } catch (e) {
      safeLog('✗ Poll error:', e && e.message ? e.message : e);
      if (typeof bumpConsecutiveFailures === 'function') bumpConsecutiveFailures();
      return { error: e && e.message ? e.message : String(e) };
    }

    let task;
    try {
      const text = await response.text();
      task = text ? JSON.parse(text) : {};
    } catch (_e) {
      safeLog('Empty/invalid response from webhook — treating as no tasks');
      task = {};
    }

    // Shape check. Empty / malformed → no tasks; anything with id+mode
    // dispatches through the executor registry.
    if (!task || !task.id || !task.mode) {
      safeLog('No tasks');
      if (typeof resetConsecutiveFailures === 'function') resetConsecutiveFailures();
      return { noTasks: true };
    }

    safeLog(`Received task: ${task.id} mode=${task.mode} — dispatching`);
    if (typeof resetConsecutiveFailures === 'function') resetConsecutiveFailures();
    // Fire-and-forget. image-hitl is operator-blocking and would hold
    // the slot for hours if awaited; the executor reports back via the
    // submit-result webhook in its own time. hasActiveExecutor() gates
    // the next poll so no second row is claimed in the meantime.
    if (typeof executeTaskViaExtension === 'function') {
      try {
        const p = executeTaskViaExtension(task);
        if (p && typeof p.catch === 'function') {
          p.catch((e) => {
            safeLog(`✗ Executor for ${task.id} failed:`, e && e.message ? e.message : e);
          });
        }
      } catch (e) {
        safeLog(`✗ Executor dispatch threw for ${task.id}:`, e && e.message ? e.message : e);
      }
    } else {
      safeLog('executeTaskViaExtension not loaded — task not dispatched');
    }
    return { received: true, task };
  } finally {
    pollingInProgress = false;
  }
}
