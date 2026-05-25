// YouForge Flow - HistForge webhook I/O
// Owns every outbound call to the HistForge endpoints (submit-result /
// status / project / operation-started) and the session-expired de-dup
// flag. Split out so auth.js, host-permission.js, runner.js, and
// handlers.js all funnel their HistForge-facing notifications through
// one place.
//
// Runtime deps (resolved at call time): getResultUrl / getStatusUrl /
// getProjectUrl / getOperationStartedUrl / getAccountToken
// (src/settings.js), setStopFlag (src/stop-flag.js), stopPolling
// (src/runner.js — forward-ref, resolves at call time),
// scheduleAuthProbe (src/auth-probe.js — forward-ref), safeLog
// (src/logger.js).

// De-dup flag: emit the session_expired status event at most once per
// expiry. Reset via clearSessionExpiredReport when auth succeeds again.
let sessionExpiredReported = false;

// Anti-spam gate for postProgressEvent. Once a status post fails, stop
// firing until something explicitly resets it (next task / config
// change). Avoids the per-task progress-spam storm the plan calls out
// for the up-to-10-minute video poll. Reset via resetProgressGate.
let progressGateOk = true;

// One-shot OperationStarted post. No retry — a lost post just means
// the next requeue for this task will fall back to a fresh submit
// (the same path we'd take if persistence had never been added), so a
// single missed write degrades gracefully rather than blocking the
// pipeline.
async function postOperationStarted({ taskId, operationName, projectId }) {
  const operationStartedUrl = getOperationStartedUrl();
  if (!operationStartedUrl) {
    safeLog('[webhook] postOperationStarted skipped — operationStartedUrl not configured');
    return false;
  }
  const accountToken = getAccountToken();
  try {
    const response = await fetchWithTimeout(operationStartedUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'OperationStarted',
        accountToken,
        taskId,
        operationName,
        projectId,
        at: new Date().toISOString(),
      }),
    }, 15_000);
    return response.ok;
  } catch (e) {
    safeLog('postOperationStarted failed:', e.message);
    return false;
  }
}

// One-shot ProjectCreated post. No retry — a lost post just means the
// next dispatch for the same (video, account) will re-create the Flow
// project (Google-side orphan acceptable per operator policy).
async function postProjectCreated({ videoId, projectId, projectTitle }) {
  const projectUrl = getProjectUrl();
  if (!projectUrl) {
    safeLog('[webhook] postProjectCreated skipped — projectUrl not configured');
    return false;
  }
  const accountToken = getAccountToken();
  try {
    const response = await fetchWithTimeout(projectUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ProjectCreated',
        accountToken,
        videoId,
        projectId,
        projectTitle,
        at: new Date().toISOString(),
      }),
    }, 15_000);
    return response.ok;
  } catch (e) {
    safeLog('postProjectCreated failed:', e.message);
    return false;
  }
}

async function postStatusEvent(payload) {
  const statusUrl = getStatusUrl();
  const accountToken = getAccountToken();
  if (!statusUrl || !accountToken) return false;
  const _vStart = Date.now();
  try {
    const response = await fetchWithTimeout(statusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        accountToken,
        at: new Date().toISOString(),
      }),
    }, 15_000);
    verboseLog('postStatusEvent ←', 'event:', payload?.event, 'status:', response.status,
      'duration:', (Date.now() - _vStart) + 'ms');
    return response.ok;
  } catch (e) {
    safeLog('Status event failed:', e.message);
    return false;
  }
}

// Fires a 'progress' StatusEvent during long polls. Skips when no
// statusUrl is configured OR a previous progress post failed (gate
// flipped to closed). Callers that want to retry a closed gate (e.g.
// the start of a new task) call resetProgressGate first.
async function postProgressEvent(payload) {
  if (!getStatusUrl()) return false;
  if (!progressGateOk) return false;
  const ok = await postStatusEvent({
    type: 'StatusEvent',
    event: 'progress',
    taskId: payload?.taskId || null,
    correlationId: payload?.correlationId || null,
    pollAttempt: payload?.pollAttempt,
    totalAttempts: payload?.totalAttempts,
    estimatedPct: payload?.estimatedPct,
  });
  if (!ok) progressGateOk = false;
  return ok;
}

function resetProgressGate() {
  progressGateOk = true;
}

async function notifySessionExpired(context) {
  if (sessionExpiredReported) return;
  sessionExpiredReported = true;
  safeLog('Session expired (' + (context || 'unknown') + '), halting polling');
  // Drop the auth cache so a polling re-arm without an SW restart re-fetches
  // the token instead of replaying the stale one. Forward-ref: clearAuthCache
  // lives in src/auth.js, which loads after webhook.js — resolved at call time.
  clearAuthCache();
  setStopFlag();
  try { await stopPolling(); } catch (e) { /* ignore */ }
  // Passive Chrome notification (Task 4.4) so the user sees the halt
  // without polling the popup. Default-on; the popup checkbox writes
  // notificationsEnabled. The chrome.notifications API is gated by the
  // 'notifications' manifest permission added alongside this task.
  const notificationsOn = getNotificationsEnabled();
  if (notificationsOn && chrome?.notifications?.create) {
    try {
      await chrome.notifications.create('youforge-session-expired', {
        type: 'basic',
        iconUrl: 'logo-128.png',
        title: 'YouForge Flow: session expired',
        message: 'Re-login at labs.google to resume task processing.',
        priority: 1,
      });
    } catch (_e) { /* notifications are advisory; never throw */ }
  }
  await postStatusEvent({ type: 'StatusEvent', event: 'session_expired' });
  // Auto-resume probe: poll the labs.google tab for a fresh session token
  // every minute. When it comes back, restart polling automatically so the
  // operator doesn't have to click Start in the popup after re-logging.
  // The probe self-cancels on success and is also cleared by start/stopPolling.
  // Forward-ref: scheduleAuthProbe lives in src/auth-probe.js, loaded after
  // webhook.js — resolved at call time.
  scheduleAuthProbe();
}

function clearSessionExpiredReport() {
  sessionExpiredReported = false;
}

function isSessionExpiredReported() {
  return sessionExpiredReported;
}

// Submit a successful result to HistForge with up to 3 retries (5s,
// 10s back-off). Returns true on the first success, false if all
// attempts fail — the caller decides whether to mark the job completed
// or leave it for HistForge's reaper to requeue.
async function submitResult(data, mediaFiles) {
  const resultUrl = getResultUrl();
  const accountToken = getAccountToken();
  try {
    return await retryWithBackoff(async (attempt) => {
      const _vStart = Date.now();
      const response = await fetchWithTimeout(resultUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'ResultSubmission',
          accountToken,
          taskId: data.taskId,
          resultUrl: data.resultUrl,
          mode: data.mode || 'image',
          timestamp: new Date().toISOString(),
          mediaFiles: mediaFiles && mediaFiles.length > 0 ? mediaFiles : null,
          correlationId: data.correlationId || null,
          timings: data.timings || null,
        }),
      }, 15_000);
      const responseText = await response.text();
      verboseLog('submitResult ←', 'attempt:', attempt + 1, 'status:', response.status,
        'body:', responseText.length, 'bytes', 'duration:', (Date.now() - _vStart) + 'ms');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${responseText.substring(0, 300)}`);
      }
      let parsedResp;
      try { parsedResp = JSON.parse(responseText); } catch (_e) { parsedResp = {}; }
      if (parsedResp.success === false) {
        safeLog('[webhook] HistForge returned success:false - treating as failed submission');
        throw new Error('HistForge rejected result (success:false)');
      }
      safeLog(`[webhook] Result submitted (HTTP ${response.status}):`, responseText.substring(0, 200));
      return true;
    }, {
      retries: getWebhookMaxRetries(),
      baseMs: 5000,
      capMs: 30000,
      jitter: true,
      shouldRetry: (e) => !!e && typeof e.message === 'string' && (
        e.message.startsWith('TIMEOUT:') ||
        /HTTP (5\d\d|429)/.test(e.message)
      ),
    });
  } catch (webhookErr) {
    safeLog('[webhook] Result submission failed after retries:', webhookErr.message);
    return false;
  }
}

// One-shot failure report. No retry — a lost failure report is cheaper
// than a double-submitted one, and HistForge's reaper will eventually
// requeue any orphaned dispatched rows if the submit is missed.
//
// Payload schema v2 (docs/plans/2026-04-24-youforge-flow-flow2api-improvements.md
// task 1.2):
//   {
//     type: 'ResultSubmission',
//     schemaVersion: 2,
//     accountToken,
//     taskId, mode,
//     error: string,            // human-readable message (always present)
//     errorCode: string|null,   // structured reason from parseFlowApiError
//     errorCategory: string|null,
//     httpStatus: number|null,
//     retryable: boolean|null,
//     contentPolicyTag: string|null,
//     timestamp,
//   }
// HistForge consumer: src/app/api/flow/submit-result/[token]/route.ts
// must accept the new fields (older builds emitted only `error`).
//
// TODO(histforge): the consumer currently ignores the v2 fields. To use
// them, branch on `schemaVersion === 2` and route on `errorCategory`:
//   - 'content_policy' → fail-and-skip (don't requeue)
//   - 'rate_limit' / 'quota' → pause-and-requeue
//   - 'transient' (or `retryable === true`) → requeue with backoff
//   - 'auth' / 'invalid_argument' → fail-and-alert
// See docs/plans/2026-04-24-youforge-flow-flow2api-improvements.md task 1.2.
//
// `errorOrMessage` accepts either a structured Error (with reason/category/
// httpStatus/retryable/contentPolicyTag from src/flow-error.js) or a plain
// string for backward compatibility.
async function submitFailure(task, errorOrMessage) {
  const resultUrl = getResultUrl();
  const accountToken = getAccountToken();
  const isErrorObj = errorOrMessage && typeof errorOrMessage === 'object';
  const errorMessage = isErrorObj
    ? (typeof errorOrMessage.message === 'string' ? errorOrMessage.message : String(errorOrMessage))
    : (typeof errorOrMessage === 'string' ? errorOrMessage : '');
  const errorCode = isErrorObj && typeof errorOrMessage.reason === 'string'
    ? errorOrMessage.reason : null;
  const errorCategory = isErrorObj && typeof errorOrMessage.category === 'string'
    ? errorOrMessage.category : null;
  const httpStatus = isErrorObj && typeof errorOrMessage.httpStatus === 'number'
    ? errorOrMessage.httpStatus : null;
  const retryable = isErrorObj && typeof errorOrMessage.retryable === 'boolean'
    ? errorOrMessage.retryable : null;
  const contentPolicyTag = isErrorObj && typeof errorOrMessage.contentPolicyTag === 'string'
    ? errorOrMessage.contentPolicyTag : null;
  const correlationId = isErrorObj && typeof errorOrMessage.correlationId === 'string'
    ? errorOrMessage.correlationId : null;
  const timings = isErrorObj && errorOrMessage.timings && typeof errorOrMessage.timings === 'object'
    ? errorOrMessage.timings : null;
  const _vStart = Date.now();
  try {
    const response = await fetchWithTimeout(resultUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ResultSubmission',
        schemaVersion: 2,
        accountToken,
        taskId: task?.id,
        mode: task?.mode || 'image',
        error: errorMessage,
        errorCode,
        errorCategory,
        httpStatus,
        retryable,
        contentPolicyTag,
        correlationId,
        timings,
        timestamp: new Date().toISOString(),
      }),
    }, 15_000);
    verboseLog('submitFailure ←', 'taskId:', task?.id, 'status:', response.status,
      'errorCode:', errorCode, 'duration:', (Date.now() - _vStart) + 'ms');
    safeLog('Failure reported to HistForge');
  } catch (e) {
    safeLog('Failed to report error:', e);
  }
}
