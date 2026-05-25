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
//   - pollForTasksFIFO(bucket) — the orchestrator; safe to call from any
//     caller. Bucket is 'image' or 'video' — required, no any-bucket form.
//   - pollBothBuckets — wraps two sequential pollForTasksFIFO calls (one
//     per bucket) with a launchStaggerMs() pause; messages router uses
//     it for manualPoll / requestNextTask, which are bucket-agnostic.
//   - handleContentReady — stub for the messages router.
//   - markVideoSlotFreedForUpscale — video executors call this when
//     handing a slot back mid-flight (upscale is lower priority than a
//     fresh task). Image-only; no image equivalent because image upscale
//     runs synchronously inside the slot.
//   - forceStopAllTabs — sweeps every labs.google tab with stopProcessing
//     so the messages router's stop case stays switch-only.
//
// Slot counter primitives: activeCounts (per-bucket: image, video) +
// getActiveCount(bucket) / incrementActiveCount(bucket) /
// decrementActiveCount(bucket) / resetActiveCounts.
//
// Poll phases (the orchestrator pollForTasksFIFO chains these in order):
//   - ensureBridgeAlive(flowTabId) — 3-ping + reload, true/false.
//   - fetchNextTask(pollUrl, accountToken, mode, wantBucket) — HTTP POST
//     + JSON parse. wantBucket is the authoritative bucket filter; the
//     legacy `mode` field is preserved per ADR 0005 §Decision 3.
//   - validateTask(task) — mode-aware id+prompt presence check.
//   - dispatchTask(task, flowTabId) — fire-and-forget executor chain;
//     derives bucket from task.mode and re-polls the same bucket on
//     completion.
//
// The rate-limit cool-off subsystem (triggerRateLimitCooldown,
// pauseGenerationOnly / resumeGenerationOnly, the rateLimitCooldown
// alarm listener, and the _launchStaggerMs / _taskPollIntervalMinutes
// config accessors) lives in src/cooldown.js. runner.js still *clears*
// cool-off state at the start/stop boundary (chrome.alarms.clear
// 'rateLimitCooldown' + clearPauseReason + setCooldownUntil(null))
// because that's the lifecycle entry point — only the cool-off
// implementation moved out, not its teardown.
//
// Runtime deps (resolved at call time): getStopFlag / clearStopFlag
// (src/stop-flag.js), startCreditsPolling / stopCreditsPolling
// (src/credits-poller.js), executeTaskWithSessionGuard
// (src/session-guard.js), handleTaskCompletedFIFO / handleTaskFailedFIFO
// (src/handlers.js), getPollUrl / getAccountToken / getCurrentMode /
// getMaxConcurrent (src/settings.js), setIsEnabled / setLastPoll /
// getProcessedJobIds / clearPauseReason / setCooldownUntil
// (src/state.js), POLL_INTERVAL_MINUTES (src/constants.js),
// _launchStaggerMs / _taskPollIntervalMinutes (src/cooldown.js),
// clearAuthProbe (src/auth-probe.js), safeLog.

const activeCounts = { image: 0, video: 0 };
let pollingInProgress = false;

function getActiveCount(bucket) {
  return activeCounts[bucket] ?? 0;
}

function incrementActiveCount(bucket) {
  activeCounts[bucket] = (activeCounts[bucket] ?? 0) + 1;
}

function decrementActiveCount(bucket) {
  activeCounts[bucket] = Math.max(0, (activeCounts[bucket] ?? 0) - 1);
}

function resetActiveCounts() {
  activeCounts.image = 0;
  activeCounts.video = 0;
}

// Video executors call this when a video task hands its slot back
// mid-flight (upscale is lower priority than a fresh task, so we free
// the slot before the upscale runs). Video-only by construction: image
// upscale runs synchronously inside the slot, so no image counterpart
// exists. Runner owns both the counter and the "now re-poll" verb so
// executors depend on one narrow symbol instead of four internals.
function markVideoSlotFreedForUpscale() {
  decrementActiveCount('video');
  safeLog(`[api] Video slot freed for upscale (active video: ${getActiveCount('video')}/${getMaxConcurrent('video')}) - new tasks can start`);
  if (!getStopFlag()) {
    // Reuses launchStaggerMs deliberately: the upscale slot-free and
    // the post-completion refill both produce the same per-second
    // pressure on Google's rate limit. Same constant keeps the spacing
    // consistent across both paths. Same-bucket re-poll only.
    setTimeout(() => pollForTasksFIFO('video'), _launchStaggerMs());
  }
}

// Fire both buckets sequentially with a launchStaggerMs() pause between
// them. The messages router's manualPoll / requestNextTask cases call
// this so they cover both buckets without leaking bucket knowledge into
// the router. Returns `{ image, video }` with each bucket's poll result.
async function pollBothBuckets() {
  const image = await pollForTasksFIFO('image');
  await new Promise((r) => setTimeout(r, _launchStaggerMs()));
  const video = await pollForTasksFIFO('video');
  return { image, video };
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

chrome.alarms.onAlarm.addListener(async (alarm) => {
  // The rateLimitCooldown alarm is handled by a separate listener in
  // src/cooldown.js — runner.js only owns the periodic pollTasks alarm.
  if (alarm.name !== 'pollTasks') return;
  if (pollingInProgress) {
    safeLog('Alarm skipped - Another poll already in progress');
    return;
  }
  // Fire both buckets sequentially with a stagger between them; the
  // pollingInProgress mutex serializes any other entry points but does
  // NOT prevent the two bucket polls below from being interleaved by
  // the .then chain — we want them spaced by _launchStaggerMs() so the
  // two requests don't burst back-to-back.
  for (const bucket of ['image', 'video']) {
    const max = getMaxConcurrent(bucket);
    const active = getActiveCount(bucket);
    if (active < max) {
      safeLog(`[runner] Alarm triggered - polling ${bucket} (active: ${active}/${max})...`);
      await pollForTasksFIFO(bucket);
    } else {
      safeLog(`[runner] Alarm triggered - ${bucket} at capacity (${active}/${max}), skipping`);
    }
    if (bucket === 'image') {
      await new Promise((r) => setTimeout(r, _launchStaggerMs()));
    }
  }
});

async function startPolling() {
  safeLog('Starting polling (every 10 seconds - FIFO mode)...');
  await setIsEnabled(true);
  clearStopFlag();
  // User-initiated restart gets a clean breaker budget. Without this, a
  // post-trip Stop→Start leaves the counter at threshold so the next
  // failure re-trips immediately.
  resetConsecutiveFailures();
  // Defensive: clear any soft-pause state that survived a non-stopPolling
  // entry path (e.g. a future caller that arms the runner without going
  // through stopPolling first). stopPolling already clears these; this
  // guards entry points that don't.
  clearPauseReason();
  setCooldownUntil(null);
  chrome.alarms.clear('rateLimitCooldown');
  // Cancel the session-expired auto-resume probe (src/auth-probe.js). A
  // manual Start from the popup or a probe-driven start both want the
  // alarm gone; idempotent when no alarm is armed.
  clearAuthProbe();

  // Tell any live content scripts to reset their stop flag too.
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'resetStop' });
      } catch (_e) { /* tab might not have content script */ }
    }
  } catch (_e) { /* ignore */ }

  const _startIntervalMin = _taskPollIntervalMinutes();
  chrome.alarms.create('pollTasks', {
    delayInMinutes: _startIntervalMin,
    periodInMinutes: _startIntervalMin,
  });

  resetActiveCounts();
  const maxImage = getMaxConcurrent('image');
  const maxVideo = getMaxConcurrent('video');
  async function fillInitialSlots() {
    // Interleave bucket fills so a slow-saturating bucket can't starve
    // the other one during cold-start. Each bucket independently bails
    // on noTasks/error/stopped or when it hits its own per-bucket
    // ceiling; the loop exits when both buckets have bailed.
    const open = { image: true, video: true };
    const max = { image: maxImage, video: maxVideo };
    const filled = { image: 0, video: 0 };
    while (open.image || open.video) {
      if (getStopFlag()) break;
      for (const bucket of ['image', 'video']) {
        if (!open[bucket]) continue;
        if (filled[bucket] >= max[bucket]) {
          open[bucket] = false;
          continue;
        }
        const result = await pollForTasksFIFO(bucket);
        filled[bucket] += 1;
        if (result?.noTasks || result?.error || result?.stopped) {
          open[bucket] = false;
          continue;
        }
        await new Promise((r) => setTimeout(r, _launchStaggerMs()));
      }
    }
  }
  fillInitialSlots();

  startCreditsPolling();
}

async function stopPolling() {
  safeLog('Stopping polling...');
  await setIsEnabled(false);
  chrome.alarms.clear('pollTasks');
  // Tear down any in-flight rate-limit cool-off (Task 3.2) so a user-
  // initiated halt doesn't leave a dormant resume alarm that re-arms
  // pollTasks after the user thought they stopped everything.
  chrome.alarms.clear('rateLimitCooldown');
  // notifySessionExpired calls stopPolling() and then re-arms the auth
  // probe — clearing here is the right pre-condition for that ordering
  // and also the right behavior for a user-initiated Stop.
  clearAuthProbe();
  clearPauseReason();
  setCooldownUntil(null);
  stopCreditsPolling();
}

// Probe the content bridge — reCAPTCHA tokens can't be minted without it.
// 3-attempt ping, then a reload-and-retry. True if reachable (fresh or
// post-reload), false if still unreachable after the reload pass.
async function ensureBridgeAlive(flowTabId) {
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(flowTabId, { action: 'ping' });
      safeLog('Content bridge is alive');
      return true;
    } catch (e) {
      lastError = (e && e.message) ? e.message : String(e);
      safeLog(`[runner] Content bridge ping attempt ${attempt}/3 failed`);
      if (attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
  }
  safeLog('Content bridge disconnected - reloading tab...');
  // Tail-risk signal — surfaces to HistForge so the backend can
  // proactively alert / rotate accounts before the session-expired
  // storm begins. Telemetry is advisory; never throw.
  try {
    await postStatusEvent({
      type: 'StatusEvent',
      event: 'bridge_reload',
      attempts: 3,
      lastError,
    });
  } catch (_e) { /* advisory */ }
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
// `mode` is the legacy any-mode hint preserved per ADR 0005 §Decision 3;
// `wantBucket` is the authoritative bucket filter the server consumes.
async function fetchNextTask(pollUrl, accountToken, mode, wantBucket) {
  safeLog('Fetching from:', pollUrl, 'bucket:', wantBucket);
  const response = await fetchWithTimeout(pollUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'TaskRequest',
      accountToken,
      mode,
      wantBucket,
    }),
  }, 15_000);
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
// (.then / .catch) decrements the same bucket's slot and kicks off
// another poll on that bucket only — no cross-bucket pokes (ADR 0005
// §Decision 4; the alarm cadence covers idle-bucket wakeup latency).
// STOP_REQUESTED failures skip the handler + re-poll — the stop sweep
// owns cleanup.
function dispatchTask(task, flowTabId) {
  // Closure-capture the bucket once at increment time so the completion
  // arms decrement and re-poll the same bucket the slot was claimed
  // against, even if the EXECUTORS table changes shape mid-flight.
  // Unknown modes fall through to 'video' — matches the executeTaskViaAPI
  // fallback (executors/index.js: unknown mode → EXECUTORS.text → video).
  const bucket = (EXECUTORS[(task.mode || '').toLowerCase()]?.isImageGen)
    ? 'image'
    : 'video';
  const maxImage = getMaxConcurrent('image');
  const maxVideo = getMaxConcurrent('video');
  incrementActiveCount(bucket);
  // Per-task correlation id — threaded through executor ctx, log lines,
  // submitResult/submitFailure payloads. session-guard stashes it on any
  // rethrown error so the catch arm below can plumb it without separate
  // bookkeeping. See docs/plans/...task 1.3.
  const correlationId = (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `cid-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const cidShort = correlationId.slice(0, 8);
  safeLog(`[runner] [cid=${cidShort}] Executing task via API: ${task.id} (bucket=${bucket}, active image: ${getActiveCount('image')}/${maxImage}, video: ${getActiveCount('video')}/${maxVideo})`);

  executeTaskWithSessionGuard(task, flowTabId, correlationId).then(async (result) => {
    decrementActiveCount(bucket);
    safeLog(`[runner] [cid=${cidShort}] ✓ Task completed: ${task.id} (bucket=${bucket}, active image: ${getActiveCount('image')}/${maxImage}, video: ${getActiveCount('video')}/${maxVideo})`);
    // Ensure cid + timings reach handlers even if the executor didn't
    // attach them itself (defensive for the no-op success path).
    const enriched = {
      ...result,
      correlationId: result?.correlationId || correlationId,
    };
    await handleTaskCompletedFIFO(enriched);
    if (!getStopFlag()) {
      // Stagger the refill (Task 3.4) — back-to-back completions trip
      // Google's per-second rate limit even when the per-minute quota
      // is fine. Same-bucket re-poll only (ADR 0005 §Decision 4).
      setTimeout(() => pollForTasksFIFO(bucket), _launchStaggerMs());
    }
  }).catch(async (error) => {
    decrementActiveCount(bucket);
    safeLog(`[runner] [cid=${cidShort}] ✗ Task failed: ${task.id} (bucket=${bucket}, active image: ${getActiveCount('image')}/${maxImage}, video: ${getActiveCount('video')}/${maxVideo}):`, error.message.substring(0, 100));
    if (error.message !== 'STOP_REQUESTED') {
      // session-guard stashed correlationId on the error already — leave
      // it. submitFailure reads it off the Error.
      await handleTaskFailedFIFO({ task, error });
      if (!getStopFlag()) {
        setTimeout(() => pollForTasksFIFO(bucket), _launchStaggerMs());
      }
    }
  });
}

async function pollForTasksFIFO(bucket) {
  safeLog('========================================');
  safeLog(`Polling for next task (bucket: ${bucket})...`);

  if (getStopFlag()) {
    safeLog('⛔ STOPPED - not polling');
    return { stopped: true };
  }

  // Soft-pause gate. The pollTasks alarm is cleared when paused, but
  // in-flight completions still call pollForTasksFIFO(bucket) directly
  // via the .then chain — this gate stops them.
  const reason = getPauseReason();
  if (reason !== null) {
    safeLog(`⏸ Paused (${reason}) - not polling`);
    return { paused: true, reason };
  }

  if (pollingInProgress) {
    safeLog('⚠️ Another poll already in progress - SKIPPING to prevent race condition');
    return { skipped: true, reason: 'poll_in_progress' };
  }

  const maxConcurrent = getMaxConcurrent(bucket);
  const activeCount = getActiveCount(bucket);
  if (activeCount >= maxConcurrent) {
    safeLog(`[runner] ${bucket} at capacity (${activeCount}/${maxConcurrent}), skipping poll`);
    return { skipped: true, reason: 'at_capacity', bucket };
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

    const task = await fetchNextTask(getPollUrl(), getAccountToken(), getCurrentMode(), bucket);

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

    // Defensive bucket assertion (choice #5). With wantBucket sent, the
    // server should only return matching tasks; if a returned task's
    // bucket disagrees with the requested bucket, it indicates server/
    // extension mode-map drift — reject and re-poll rather than
    // dispatching to the wrong counter.
    const returnedBucket = (EXECUTORS[(task.mode || '').toLowerCase()]?.isImageGen)
      ? 'image'
      : 'video';
    if (returnedBucket !== bucket) {
      safeLog(`⚠️ [runner] Bucket mismatch — requested ${bucket}, got task mode "${task.mode}" (bucket ${returnedBucket}). Rejecting.`);
      return { skipped: true, reason: 'bucket_mismatch', requested: bucket, returned: returnedBucket };
    }

    if (getActiveCount(bucket) >= maxConcurrent) {
      safeLog(`[runner] ${bucket} at capacity (${getActiveCount(bucket)}/${maxConcurrent}), waiting...`);
      return { atCapacity: true, bucket };
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
