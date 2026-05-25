// YouForge Flow - FIFO runner
// Owns the polling loop, concurrent-task counter, and per-poll race
// guards. startPolling arms the Chrome alarm + fills the initial slots;
// pollForTasksFIFO is called by the alarm, by startPolling, by
// message-router manual triggers, and by the fire-and-forget completion
// chain (each finished task kicks off another poll to re-fill the freed
// slot).
//
// Public verbs consumed by other modules:
//   - startPolling / stopPolling — arm / disarm the alarm.
//   - pollForTasksFIFO — the orchestrator; safe to call from any caller.
//   - handleContentReady — stub for the messages router.
//   - markSlotFreedForUpscale — executors call this when handing a slot
//     back mid-flight (upscale is lower priority than a fresh task).
//   - forceStopAllTabs — sweeps every labs.google tab with stopProcessing
//     so the messages router's stop case stays switch-only.
//
// Slot counter primitives: activeTaskCount + getActiveTaskCount /
// incrementActiveTaskCount / decrementActiveTaskCount /
// resetActiveTaskCount.
//
// Poll phases (the orchestrator pollForTasksFIFO chains these in order):
//   - ensureBridgeAlive(flowTabId) — 3-ping + reload, true/false.
//   - fetchNextTask(pollUrl, accountToken, mode) — HTTP POST + JSON parse.
//   - validateTask(task) — mode-aware id+prompt presence check.
//   - dispatchTask(task, flowTabId) — fire-and-forget executor chain.
//
// Runtime deps (resolved at call time): getStopFlag / clearStopFlag
// (src/stop-flag.js), startCreditsPolling / stopCreditsPolling
// (src/credits-poller.js), executeTaskWithSessionGuard
// (src/session-guard.js), handleTaskCompletedFIFO / handleTaskFailedFIFO
// (src/handlers.js), getPollUrl / getAccountToken / getCurrentMode /
// getMaxConcurrent (src/settings.js), setIsEnabled / setLastPoll /
// getProcessedJobIds (src/state.js), POLL_INTERVAL_MINUTES
// (src/constants.js), safeLog.

let activeTaskCount = 0;
let pollingInProgress = false;

function getActiveTaskCount() {
  return activeTaskCount;
}

function incrementActiveTaskCount() {
  activeTaskCount++;
}

function decrementActiveTaskCount() {
  activeTaskCount = Math.max(0, activeTaskCount - 1);
}

function resetActiveTaskCount() {
  activeTaskCount = 0;
}

// Executors call this when a task hands its slot back mid-flight (upscale
// is lower priority than a fresh task, so we free the slot before the
// upscale runs). Runner owns both the counter and the "now re-poll" verb
// so executors depend on one narrow symbol instead of four internals.
function markSlotFreedForUpscale() {
  decrementActiveTaskCount();
  safeLog(`[api] Slot freed for upscale (active: ${getActiveTaskCount()}/${getMaxConcurrent()}) - new tasks can start`);
  if (!getStopFlag()) {
    setTimeout(() => pollForTasksFIFO(), 300);
  }
}

// Broadcasts stopProcessing to every live labs.google tab. Called from
// the messages router's stopAllProcessing case so that case stays a thin
// delegate — the sweep is runner concern, not router concern.
async function forceStopAllTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'stopProcessing' });
        safeLog(`[router] Sent stop signal to tab ${tab.id}`);
      } catch (_e) { /* Tab might not have content script */ }
    }
  } catch (e) {
    safeLog('Error stopping tabs:', e);
  }
}

// handleContentReady is a no-op in this fork — FIFO polling delivers
// tasks independently of the content script, and onInstalled already
// wipes the upstream-era keys this handler used to clear. Kept as a
// stub so the messages router can still route the `contentReady`
// notification without a special case.
async function handleContentReady() {
  return { hasTask: false };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== 'pollTasks') return;
  if (pollingInProgress) {
    safeLog('Alarm skipped - Another poll already in progress');
    return;
  }
  const maxConcurrent = getMaxConcurrent();
  if (activeTaskCount < maxConcurrent) {
    safeLog(`[runner] Alarm triggered - polling (active: ${activeTaskCount}/${maxConcurrent})...`);
    pollForTasksFIFO();
  } else {
    safeLog(`[runner] Alarm triggered - at capacity (${activeTaskCount}/${maxConcurrent}), skipping`);
  }
});

async function startPolling() {
  safeLog('Starting polling (every 10 seconds - FIFO mode)...');
  await setIsEnabled(true);
  clearStopFlag();

  // Tell any live content scripts to reset their stop flag too.
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'resetStop' });
      } catch (_e) { /* tab might not have content script */ }
    }
  } catch (_e) { /* ignore */ }

  chrome.alarms.create('pollTasks', {
    delayInMinutes: POLL_INTERVAL_MINUTES,
    periodInMinutes: POLL_INTERVAL_MINUTES,
  });

  resetActiveTaskCount();
  const maxConcurrent = getMaxConcurrent();
  async function fillInitialSlots() {
    for (let i = 0; i < maxConcurrent; i++) {
      if (getStopFlag()) break;
      const result = await pollForTasksFIFO();
      if (result?.noTasks || result?.error || result?.stopped) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  fillInitialSlots();

  startCreditsPolling();
}

async function stopPolling() {
  safeLog('Stopping polling...');
  await setIsEnabled(false);
  chrome.alarms.clear('pollTasks');
  stopCreditsPolling();
}

// Probe the content bridge — reCAPTCHA tokens can't be minted without it.
// 3-attempt ping, then a reload-and-retry. True if reachable (fresh or
// post-reload), false if still unreachable after the reload pass.
async function ensureBridgeAlive(flowTabId) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(flowTabId, { action: 'ping' });
      safeLog('Content bridge is alive');
      return true;
    } catch (_e) {
      safeLog(`[runner] Content bridge ping attempt ${attempt}/3 failed`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  safeLog('Content bridge disconnected - reloading tab...');
  await chrome.tabs.reload(flowTabId);
  await new Promise((r) => setTimeout(r, 5000));
  try {
    await chrome.tabs.sendMessage(flowTabId, { action: 'ping' });
    return true;
  } catch (_e) {
    return false;
  }
}

// HTTP POST to the configured poll URL. Returns the parsed task, or `{}`
// when the webhook returns empty / invalid JSON (treated as "no tasks").
async function fetchNextTask(pollUrl, accountToken, mode) {
  safeLog('Fetching from:', pollUrl);
  const response = await fetch(pollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'TaskRequest',
      accountToken,
      mode,
    }),
  });
  let task;
  try {
    const responseText = await response.text();
    task = responseText ? JSON.parse(responseText) : {};
  } catch (_parseErr) {
    safeLog('Empty/invalid response from webhook - treating as no tasks');
    task = {};
  }
  safeLog('Poll response:', JSON.stringify(task).substring(0, 200));
  return task;
}

// Mode-aware id + prompt presence check. True if the task has an id and
// a prompt matching its declared mode (imagegen/createimage accept
// imagePrompt in place of prompt).
function validateTask(task) {
  const taskMode = (task.mode || '').toLowerCase();
  const hasValidPrompt = task.prompt ||
    (taskMode === 'imagegen' && task.imagePrompt) ||
    (taskMode === 'createimage' && task.imagePrompt);
  if (!task || !task.id || !hasValidPrompt) {
    safeLog('No valid task available (missing id or prompt for mode:', taskMode, ')');
    return false;
  }
  return true;
}

// Claim a slot and hand the task to the session guard. Settle path
// (.then / .catch) decrements the slot and kicks off the next poll so
// each completion re-fills the slot it just freed. STOP_REQUESTED
// failures skip the handler + re-poll — the stop sweep owns cleanup.
function dispatchTask(task, flowTabId) {
  const maxConcurrent = getMaxConcurrent();
  incrementActiveTaskCount();
  safeLog(`[runner] Executing task via API: ${task.id} (active: ${getActiveTaskCount()}/${maxConcurrent})`);

  executeTaskWithSessionGuard(task, flowTabId).then(async (result) => {
    decrementActiveTaskCount();
    safeLog(`[runner] ✓ Task completed: ${task.id} (active: ${getActiveTaskCount()})`);
    await handleTaskCompletedFIFO(result);
    if (!getStopFlag()) {
      pollForTasksFIFO();
    }
  }).catch(async (error) => {
    decrementActiveTaskCount();
    safeLog(`[runner] ✗ Task failed: ${task.id}:`, error.message.substring(0, 100));
    if (error.message !== 'STOP_REQUESTED') {
      await handleTaskFailedFIFO({ task, error: error.message });
      if (!getStopFlag()) {
        pollForTasksFIFO();
      }
    }
  });
}

async function pollForTasksFIFO() {
  safeLog('========================================');
  safeLog('Polling for next task...');

  if (getStopFlag()) {
    safeLog('⛔ STOPPED - not polling');
    return { stopped: true };
  }

  if (pollingInProgress) {
    safeLog('⚠️ Another poll already in progress - SKIPPING to prevent race condition');
    return { skipped: true, reason: 'poll_in_progress' };
  }

  const maxConcurrent = getMaxConcurrent();
  if (activeTaskCount >= maxConcurrent) {
    safeLog(`[runner] At capacity (${activeTaskCount}/${maxConcurrent}), skipping poll`);
    return { skipped: true, reason: 'at_capacity' };
  }

  pollingInProgress = true;
  safeLog('🔒 Polling lock acquired');

  try {
    await setLastPoll(new Date().toISOString());

    const tabs = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
    safeLog('Found', tabs.length, 'Flow tabs');

    if (tabs.length === 0) {
      safeLog('No Flow tab found!');
      return { error: 'No Flow tab' };
    }

    const flowTab = tabs[0];

    const bridgeAlive = await ensureBridgeAlive(flowTab.id);
    if (!bridgeAlive) {
      return { error: 'Content bridge not ready after reload' };
    }

    const task = await fetchNextTask(getPollUrl(), getAccountToken(), getCurrentMode());

    if (!validateTask(task)) {
      return { noTasks: true };
    }

    // Defensive dedup — if HistForge accidentally redispatches the same
    // external_task_id, skip instead of double-executing. The reaper
    // compensates for missed submissions.
    if (getProcessedJobIds().includes(task.id)) {
      safeLog('Task already processed:', task.id, '- skipping');
      return { skipped: true, reason: 'already_processed' };
    }

    // Second stop + capacity re-checks — state can shift during the HTTP
    // poll and the dedup storage read. Both must survive in parallel with
    // the lock acquire checks above: the earlier checks gate whether we
    // start polling; these gate whether we dispatch after observing the
    // world post-poll.
    if (getStopFlag()) {
      safeLog('⛔ STOPPED after poll - not executing task');
      return { stopped: true };
    }

    if (activeTaskCount >= maxConcurrent) {
      safeLog(`[runner] At capacity (${activeTaskCount}/${maxConcurrent}), waiting...`);
      return { atCapacity: true };
    }

    dispatchTask(task, flowTab.id);
    return { success: true, task };
  } catch (error) {
    safeLog('✗ Poll error:', error.message);
    return { error: error.message };
  } finally {
    pollingInProgress = false;
    safeLog('🔓 Polling lock released');
  }
}
