// Magnific HITL - image-hitl executor
// Handles the `image-hitl` mode: drive Magnific's text-to-image UI from
// a prompt, wait for the operator to pick a variation, and POST the
// chosen image URL back to HistForge via the submit-result webhook.
//
// MV3 service worker lifecycle: the executor returns a Promise that
// resolves only when notifyVariationSelected is called. The SW stays
// awake as long as something is awaiting it; chrome keeps the worker
// alive on active message ports / pending promises. If the SW dies
// before the operator picks, the queue row stays dispatched (no_timeout=1)
// and the next poll re-claims it.
//
// Runtime deps (resolved at call time): chrome.tabs.{query, create,
// update, sendMessage}, chrome.windows.update, fetchWithTimeout
// (src/http.js), getSubmitResultUrl (src/settings.js),
// MAGNIFIC_IMAGE_GEN_URL (src/constants.js), claimExecutorSlot and
// releaseExecutorSlot (src/runner.js — mode-agnostic slot accounting
// that keeps the poll loop from claiming a second row while one task
// is in flight), waitForContentScriptReady (src/executors/content-script-handshake.js),
// safeLog (src/logger.js).
//
// The pendingHitl Map is the rendezvous between this file and
// messages.js: the message router translates a `magnificVariationSelected`
// inbound into a notifyVariationSelected(taskId, resultUrl) call, which
// resolves the executor's awaiting promise.

const pendingHitl = new Map();

async function openOrFocusMagnificTab() {
  const url = MAGNIFIC_IMAGE_GEN_URL;
  // chrome.tabs.query accepts a URL match pattern; trailing-/ scheme://
  // host// pattern matches the Magnific origin without pinning a path.
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

async function runImageHitl(task) {
  const taskId = task.id;
  if (!taskId) throw new Error('runImageHitl: missing task.id');
  safeLog(`[image-hitl] Starting task ${taskId}`);
  if (typeof claimExecutorSlot === 'function') {
    claimExecutorSlot();
  }

  // Set up the rendezvous BEFORE sending the content-script message so
  // an instantaneous variation pick (test fixtures, fast operators) can't
  // race the Map insertion.
  const pending = new Promise((resolve, reject) => {
    pendingHitl.set(taskId, { resolve, reject });
  });

  try {
    const tabId = await openOrFocusMagnificTab();
    await waitForContentScriptReady(tabId);
    await chrome.tabs.sendMessage(tabId, {
      action: 'magnificFillAndGenerate',
      taskId,
      prompt: task.prompt,
      model: task.model || '',
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
      safeLog(`[image-hitl] submit-result returned HTTP ${response.status} for task ${taskId}`);
    } else {
      safeLog(`[image-hitl] submit-result OK for task ${taskId}`);
    }
    return { taskId, resultUrl };
  } finally {
    pendingHitl.delete(taskId);
    if (typeof releaseExecutorSlot === 'function') {
      releaseExecutorSlot();
    }
  }
}

// Called by the messages.js router when a content script reports a
// variation pick. Returns true if the taskId was awaiting and we
// resolved its promise; false if the message was stale (e.g., already
// resolved, never dispatched). The router uses this to decide whether
// to log the unmatched event.
function notifyVariationSelected(taskId, resultUrl) {
  const entry = pendingHitl.get(taskId);
  if (!entry) return false;
  entry.resolve(resultUrl);
  return true;
}

// Called by the messages.js router if the content script reports a
// failure (or the user closes the Magnific tab — surfaced via tabs.onRemoved
// in a future iteration). Mirror of notifyVariationSelected; rejects the
// pending promise so runImageHitl's caller observes the failure.
function notifyVariationFailed(taskId, reason) {
  const entry = pendingHitl.get(taskId);
  if (!entry) return false;
  entry.reject(new Error(reason || 'magnific variation pick failed'));
  return true;
}
