// YouForge Flow - HistForge webhook I/O
// Owns every outbound call to the three HistForge endpoints (poll/result/
// status) and the session-expired de-dup flag. Split out so auth.js,
// host-permission.js, runner.js, and handlers.js all funnel their
// HistForge-facing notifications through one place.
//
// Runtime deps (resolved at call time): getResultUrl / getStatusUrl /
// getAccountToken (src/settings.js), setStopFlag (src/stop-flag.js),
// stopPolling (src/runner.js — forward-ref, resolves at call time),
// safeLog (src/logger.js).

// De-dup flag: emit the session_expired status event at most once per
// expiry. Reset via clearSessionExpiredReport when auth succeeds again.
let sessionExpiredReported = false;

async function postStatusEvent(payload) {
  const statusUrl = getStatusUrl();
  const accountToken = getAccountToken();
  if (!statusUrl || !accountToken) return false;
  try {
    const response = await fetch(statusUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        accountToken,
        at: new Date().toISOString(),
      }),
    });
    return response.ok;
  } catch (e) {
    safeLog('Status event failed:', e.message);
    return false;
  }
}

async function notifySessionExpired(context) {
  if (sessionExpiredReported) return;
  sessionExpiredReported = true;
  safeLog('Session expired (' + (context || 'unknown') + '), halting polling');
  setStopFlag();
  try { await stopPolling(); } catch (e) { /* ignore */ }
  await postStatusEvent({ type: 'StatusEvent', event: 'session_expired' });
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
  for (let webhookAttempt = 1; webhookAttempt <= 3; webhookAttempt++) {
    try {
      const response = await fetch(resultUrl, {
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
        }),
      });
      const responseText = await response.text();
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
    } catch (webhookErr) {
      safeLog(`[webhook] Webhook attempt ${webhookAttempt}/3 failed:`, webhookErr.message);
      if (webhookAttempt < 3) {
        const delay = 5000 * webhookAttempt;
        safeLog(`[webhook] Retrying webhook in ${delay / 1000}s...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  return false;
}

// One-shot failure report. No retry — a lost failure report is cheaper
// than a double-submitted one, and HistForge's reaper will eventually
// requeue any orphaned dispatched rows if the submit is missed.
async function submitFailure(task, errorMessage) {
  const resultUrl = getResultUrl();
  const accountToken = getAccountToken();
  try {
    await fetch(resultUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ResultSubmission',
        accountToken,
        taskId: task?.id,
        mode: task?.mode || 'image',
        error: errorMessage,
        timestamp: new Date().toISOString(),
      }),
    });
    safeLog('Failure reported to HistForge');
  } catch (e) {
    safeLog('Failed to report error:', e);
  }
}
