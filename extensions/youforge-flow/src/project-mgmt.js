// YouForge Flow - per-(video, account) Flow project creation
// Owns the trpc createProject call and the per-videoId in-flight mutex
// that prevents concurrent dispatches for the same video from each
// minting a separate Flow project.
//
// HistForge's next-task payload tells us either:
//   - flowProjectId set: HistForge already has a project for (this account,
//     this video); reuse it.
//   - flowProjectId null: first dispatch for this (video, account); we
//     create a fresh project, named after the video, and report it back
//     via postProjectCreated so future dispatches reuse it.
//
// Each Chrome profile = one Google identity = one HistForge account
// (operator constraint), so the SW only needs to dedupe per-videoId,
// not per-(video, account).
//
// Runtime deps (resolved at call time): safeLog (src/logger.js),
// assertNotStopped (src/stop-flag.js), makeFlowApiError +
// throwFromResponse (src/flow-error.js — every HTTP-status rung routes
// through throwFromResponse so parseFlowApiError + the rate-limit
// cool-off arming are funneled through one path; the JSON-shape /
// network-error rungs build the error directly because there's no HTTP
// response to classify), postProjectCreated (src/webhook.js — loads
// after project-mgmt; resolved at call time).

const _inFlight = new Map();

async function getOrCreateProjectId(task, ctx) {
  assertNotStopped();
  const videoId = task && task.videoId;
  if (task && task.flowProjectId) return task.flowProjectId;
  if (videoId && _inFlight.has(videoId)) return _inFlight.get(videoId);

  const p = (async () => {
    try {
      const rawTitle = (task && task.projectTitle) || videoId || '';
      const title = _sanitizeProjectTitle(rawTitle);
      const newId = await _createFlowProject(ctx.tabId, title);
      try {
        await postProjectCreated({ videoId, projectId: newId, projectTitle: title });
      } catch (e) {
        safeLog('postProjectCreated threw (advisory):', e && e.message);
      }
      return newId;
    } finally {
      if (videoId) _inFlight.delete(videoId);
    }
  })();
  if (videoId) _inFlight.set(videoId, p);
  return p;
}

async function _createFlowProject(tabId, projectTitle) {
  assertNotStopped();
  safeLog('Creating Flow project, title:', projectTitle);

  let raw;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (title) => {
        try {
          const resp = await fetch('https://labs.google/fx/api/trpc/project.createProject', {
            method: 'POST',
            credentials: 'include',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ json: { projectTitle: title, toolName: 'PINHOLE' } }),
          });
          const text = await resp.text();
          return {
            ok: resp.ok,
            status: resp.status,
            body: text,
            retryAfter: resp.headers && typeof resp.headers.get === 'function'
              ? resp.headers.get('retry-after')
              : null,
          };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [projectTitle],
    });
    raw = results && results[0] && results[0].result;
  } catch (e) {
    safeLog('createProject network error:', e && e.message);
    throw makeFlowApiError({
      reason: 'CREATE_PROJECT_NETWORK',
      category: 'transient',
      retryable: true,
      message: 'createProject network error: ' + (e && e.message),
    });
  }

  if (!raw || (raw.error && typeof raw.status !== 'number')) {
    safeLog('createProject network error (in-page):', raw && raw.error);
    throw makeFlowApiError({
      reason: 'CREATE_PROJECT_NETWORK',
      category: 'transient',
      retryable: true,
      message: 'createProject network error: ' + (raw && raw.error),
    });
  }

  const status = raw.status;
  const body = typeof raw.body === 'string' ? raw.body : '';
  const truncated = body.length > 500 ? body.slice(0, 500) : body;

  if (typeof status === 'number' && status >= 400 && status <= 599) {
    safeLog('createProject HTTP ' + status + ' body:', truncated);
    // 401 → 'auth', 429 → 'rate_limit', 5xx → 'transient' all match
    // parseFlowApiError's defaults. The remaining 4xx codes default to
    // 'invalid_argument' / 'not_found' / 'unknown' — HistForge's classifier
    // expects 'create_project_failed' on those so the (video, account) row
    // gets flagged and dispatch is suppressed for that pair.
    const isGeneric4xx = status >= 400 && status <= 499
      && status !== 401 && status !== 429;
    await throwFromResponse({
      httpStatus: status,
      body,
      retryAfterHeader: raw.retryAfter,
      contextLabel: 'createProject',
      categoryOverride: isGeneric4xx ? 'create_project_failed' : undefined,
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (_e) {
    safeLog('createProject body not JSON:', truncated);
    throw makeFlowApiError({
      reason: 'CREATE_PROJECT_BODY_NOT_JSON',
      category: 'create_project_failed',
      httpStatus: status,
      retryable: false,
      message: 'createProject body not JSON: ' + truncated,
    });
  }

  const projectId = parsed && parsed.result && parsed.result.data
    && parsed.result.data.json && parsed.result.data.json.result
    && parsed.result.data.json.result.projectId;

  if (typeof projectId === 'undefined') {
    safeLog('createProject envelope unexpected:', truncated);
    throw makeFlowApiError({
      reason: 'CREATE_PROJECT_SHAPE_UNEXPECTED',
      category: 'create_project_failed',
      httpStatus: status,
      retryable: false,
      message: 'createProject envelope unexpected: ' + truncated,
    });
  }

  if (typeof projectId !== 'string' || projectId.length === 0) {
    safeLog('createProject empty projectId:', truncated);
    throw makeFlowApiError({
      reason: 'CREATE_PROJECT_NO_ID',
      category: 'create_project_failed',
      httpStatus: status,
      retryable: false,
      message: 'createProject empty projectId: ' + truncated,
    });
  }

  safeLog('createProject success, projectId:', projectId);
  return projectId;
}

function _sanitizeProjectTitle(raw) {
  const cleaned = String(raw == null ? '' : raw)
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 250);
  return cleaned || 'Untitled video';
}

function clearInFlight() {
  _inFlight.clear();
}
