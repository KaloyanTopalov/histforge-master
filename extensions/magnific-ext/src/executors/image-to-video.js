// Magnific HITL - image-to-video executor
// Handles the `image-to-video` mode: drive Magnific's Seedance / image-to-
// video UI from a HistForge-dispatched task, wait for the content script
// to report the rendered video's URL, and POST that URL back to HistForge
// via the submit-result webhook.
//
// Unlike image-hitl this mode is NOT operator-blocking — the content
// script uploads the reference image (fetched from the artifact URL),
// fills the motion prompt, clicks Generate, and polls the Magnific UI
// for completion automatically. The executor still keeps the slot held
// (no second image-to-video claim under the same magnific session) but
// the dispatch_timeout reaper in HistForge is the safety net if the UI
// hangs — failure here rejects without POSTing submit-result, so the
// queue row stays dispatched and the reaper requeues after the
// configured age.
//
// Runtime deps (resolved at call time): chrome.tabs.{query, create,
// update, sendMessage}, chrome.windows.update, fetchWithTimeout
// (src/http.js), getSubmitResultUrl (src/settings.js),
// MAGNIFIC_IMAGE_TO_VIDEO_URL (src/constants.js), claimExecutorSlot
// and releaseExecutorSlot (src/runner.js — mode-agnostic slot
// accounting that keeps the poll loop from claiming a second row while
// one task is in flight), waitForContentScriptReady
// (src/executors/content-script-handshake.js), safeLog (src/logger.js).
//
// The pendingI2V Map is the rendezvous between this file and
// messages.js: the message router translates a
// `magnificImageToVideoCompleted` inbound into a
// notifyImageToVideoCompleted(taskId, resultUrl) call, which resolves
// the executor's awaiting promise. A `magnificImageToVideoFailed`
// inbound rejects via notifyImageToVideoFailed so the runner logs the
// failure and the dispatched-row sits until the reaper requeues it.

const pendingI2V = new Map();

async function openOrFocusMagnificI2VTab() {
  const url = MAGNIFIC_IMAGE_TO_VIDEO_URL;
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

async function runImageToVideo(task) {
  const taskId = task.id;
  if (!taskId) throw new Error('runImageToVideo: missing task.id');
  safeLog(`[image-to-video] Starting task ${taskId}`);
  if (typeof claimExecutorSlot === 'function') {
    claimExecutorSlot();
  }

  // Set up the rendezvous BEFORE sending the content-script message so
  // a fast completion can't race the Map insertion.
  const pending = new Promise((resolve, reject) => {
    pendingI2V.set(taskId, { resolve, reject });
  });

  try {
    const tabId = await openOrFocusMagnificI2VTab();
    await waitForContentScriptReady(tabId);
    await chrome.tabs.sendMessage(tabId, {
      action: 'magnificStartImageToVideo',
      taskId,
      prompt: task.prompt,
      model: task.model || '',
      referenceImageUrl: task.reference_image_url || '',
    });

    const resultUrl = await pending;
    const submitResultUrl = getSubmitResultUrl();
    if (!submitResultUrl) {
      throw new Error('submit-result URL not configured');
    }
    const response = await fetchWithTimeout(
      submitResultUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: taskId,
          external_task_id: taskId,
          status: 'done',
          resultUrl,
        }),
      },
      15_000,
    );
    if (!response.ok) {
      safeLog(`[image-to-video] submit-result returned HTTP ${response.status} for task ${taskId}`);
    } else {
      safeLog(`[image-to-video] submit-result OK for task ${taskId}`);
    }
    return { taskId, resultUrl };
  } finally {
    pendingI2V.delete(taskId);
    if (typeof releaseExecutorSlot === 'function') {
      releaseExecutorSlot();
    }
  }
}

// Called by the messages.js router when the content script reports a
// completed render. Returns true if the taskId was awaiting and we
// resolved its promise; false if the message was stale.
function notifyImageToVideoCompleted(taskId, resultUrl) {
  const entry = pendingI2V.get(taskId);
  if (!entry) return false;
  entry.resolve(resultUrl);
  return true;
}

// Called by the messages.js router if the content script reports a
// failure (e.g., reference upload failed, generate button missing,
// session expired). Rejects the pending promise; runImageToVideo's
// caller (runner.js fire-and-forget) logs the error. No submit-result
// POST: leaving the row in `dispatched` lets the reaper requeue it
// after the configured dispatch_timeout (handoff §Decision 8).
function notifyImageToVideoFailed(taskId, reason) {
  const entry = pendingI2V.get(taskId);
  if (!entry) return false;
  entry.reject(new Error(reason || 'magnific image-to-video failed'));
  return true;
}
