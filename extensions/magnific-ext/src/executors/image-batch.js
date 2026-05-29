// Magnific HITL - image-batch executor (narrative Magnific image gen)
// Handles the `image-batch` mode: open the video's Magnific Project, drive
// the content script through ensure/verify-Project → generator → prompt →
// model → Generate → harvest, then POST the harvested image URL back to
// HistForge via the submit-result webhook.
//
// Unlike image-hitl this mode is NOT operator-blocking; unlike image-to-video
// it does NOT upload a reference frame. The executor opens the Projects tab
// at `${MAGNIFIC_PROJECTS_URL}/<uuid>` when HistForge already cached a Project
// for this video, else `${MAGNIFIC_PROJECTS_URL}/work` where the content
// script creates one and harvests its UUID.
//
// ── Terminal vs transient (the load-bearing contract) ───────────────────
// The question is: did the run reach a deliberate "this can't succeed"
// CONCLUSION, or did it die before concluding?
//   • TERMINAL  → the content script emits a structured outcome
//     (magnificImageBatchCompleted / magnificImageBatchFailed). The executor
//     POSTs submit-result — `done` on success, `failed` with the reason on a
//     concluded failure (selector miss, wrong_project_active, project_missing,
//     model-not-found, generation-never-appeared). These become `failed` rows
//     the operator retries; there is no auto-requeue.
//   • TRANSIENT → an exception is thrown BEFORE the rendezvous resolves (tab
//     never opened, readiness handshake timed out, message channel died), OR
//     the content script crashes without emitting any outcome so the pending
//     promise never resolves. The executor does NOT POST; the queue row stays
//     `dispatched` and HistForge's reaper requeues it after dispatch_timeout
//     (same as image-to-video).
// DO NOT collapse these two paths: posting `failed` on a transient error would
// burn the operator's retry on a problem a re-dispatch would have fixed; not
// posting on a concluded failure would strand the row until the reaper, hiding
// an operator-actionable error behind a timeout.
//
// Runtime deps (resolved at call time): chrome.tabs.{query, create, update,
// sendMessage}, chrome.windows.update, fetchWithTimeout (src/http.js),
// getSubmitResultUrl (src/settings.js), MAGNIFIC_PROJECTS_URL
// (src/constants.js), claimExecutorSlot / releaseExecutorSlot (src/runner.js),
// waitForContentScriptReady (src/executors/content-script-handshake.js),
// safeLog (src/logger.js).
//
// The pendingImageBatch Map is the rendezvous with messages.js: the router
// translates a magnificImageBatchCompleted/Failed inbound into a
// notifyImageBatch{Completed,Failed} call, which RESOLVES the executor's
// awaiting promise with a structured outcome (both success and concluded
// failure resolve — neither is an exception).

const pendingImageBatch = new Map();

async function openOrFocusImageBatchTab(url) {
  const matchPattern = url.endsWith('/') ? `${url}*` : `${url}/*`;
  const tabs = await chrome.tabs.query({ url: matchPattern });
  if (tabs && tabs.length > 0) {
    const existing = tabs[0];
    await chrome.tabs.update(existing.id, { active: true });
    if (typeof existing.windowId === 'number' && chrome.windows) {
      try {
        await chrome.windows.update(existing.windowId, { focused: true });
      } catch (_e) { /* focusing is advisory */ }
    }
    return existing.id;
  }
  const created = await chrome.tabs.create({ url, active: true });
  return created.id;
}

async function runImageBatch(task) {
  const taskId = task.id;
  if (!taskId) throw new Error('runImageBatch: missing task.id');
  safeLog(`[image-batch] Starting task ${taskId}`);
  if (typeof claimExecutorSlot === 'function') {
    claimExecutorSlot();
  }

  // Set up the rendezvous BEFORE sending the content-script message so a
  // fast outcome can't race the Map insertion.
  const pending = new Promise((resolve) => {
    pendingImageBatch.set(taskId, { resolve });
  });

  try {
    const projectId = task.magnific_project_id || '';
    const tabUrl = projectId
      ? `${MAGNIFIC_PROJECTS_URL}/${projectId}`
      : `${MAGNIFIC_PROJECTS_URL}/work`;
    const tabId = await openOrFocusImageBatchTab(tabUrl);
    await waitForContentScriptReady(tabId);
    await chrome.tabs.sendMessage(tabId, {
      action: 'magnificStartImageBatch',
      taskId,
      prompt: task.prompt,
      model: task.model || '',
      videoTitle: task.video_title || '',
      magnificProjectId: projectId || null,
    });

    // Reached-conclusion outcome (done | failed). A transient error throws
    // above this await and skips the POST entirely (reaper path).
    const outcome = await pending;
    const submitResultUrl = getSubmitResultUrl();
    if (!submitResultUrl) {
      throw new Error('submit-result URL not configured');
    }

    let body;
    if (outcome.status === 'done') {
      body = {
        id: taskId,
        external_task_id: taskId,
        status: 'done',
        resultUrl: outcome.resultUrl,
      };
      // Present only on the first row per video (the one that created the
      // Project); HistForge caches it so later rows reuse it.
      if (outcome.magnificProjectId) {
        body.magnific_project_id = outcome.magnificProjectId;
      }
    } else {
      body = {
        id: taskId,
        external_task_id: taskId,
        status: 'failed',
        error: outcome.reason || 'image_batch_failed',
      };
      // project_missing: the cached Project was deleted in Magnific — tell
      // HistForge to clear the stale id so the next row recreates one.
      if (outcome.clearProjectId) {
        body.magnific_project_id = null;
      }
    }

    const response = await fetchWithTimeout(
      submitResultUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      15_000,
    );
    if (!response.ok) {
      safeLog(`[image-batch] submit-result returned HTTP ${response.status} for task ${taskId}`);
    } else {
      safeLog(`[image-batch] submit-result (${body.status}) OK for task ${taskId}`);
    }
    return { taskId, outcome };
  } finally {
    pendingImageBatch.delete(taskId);
    if (typeof releaseExecutorSlot === 'function') {
      releaseExecutorSlot();
    }
  }
}

// Content script reported a harvested image. Resolves the pending promise
// with a `done` outcome; magnificProjectId is non-null only when the content
// script just created the Project. Returns false for a stale taskId.
function notifyImageBatchCompleted(taskId, resultUrl, magnificProjectId) {
  const entry = pendingImageBatch.get(taskId);
  if (!entry) return false;
  entry.resolve({
    status: 'done',
    resultUrl,
    magnificProjectId: magnificProjectId || null,
  });
  return true;
}

// Content script reported a reached-conclusion failure. Resolves (does NOT
// reject) the pending promise with a `failed` outcome so the executor POSTs
// submit-result failed. clearProjectId=true marks the project_missing case.
// Returns false for a stale taskId.
function notifyImageBatchFailed(taskId, reason, clearProjectId) {
  const entry = pendingImageBatch.get(taskId);
  if (!entry) return false;
  entry.resolve({
    status: 'failed',
    reason,
    clearProjectId: clearProjectId === true,
  });
  return true;
}
