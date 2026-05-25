// YouForge Flow - task-completion handlers
// Orchestrates the tail of each task's lifecycle: fetching the media
// payload, submitting success/failure to HistForge, recording it in the
// local defensive-dedup ring, and bumping `stats`. Called by runner.js
// from the fire-and-forget chain — this module itself never polls.
//
// Runtime deps (resolved at call time): fetchMediaFiles
// (src/media-fetch.js), submitResult / submitFailure / postStatusEvent
// (src/webhook.js), getStopFlag / setStopFlag (src/stop-flag.js),
// stopPolling (src/runner.js — forward ref), addProcessedJobId /
// bumpConsecutiveFailures / resetConsecutiveFailures (src/state.js),
// bumpStat (src/stats.js), safeLog (src/logger.js).
//
// Circuit breaker (Task 3.1): a consecutive-failures counter trips a
// hard stop after `circuitBreakerThreshold` account-health failures in
// a row (default 5 via settings-schema.js). Session-expired,
// content-policy, and rate-limit failures are excluded — they have
// their own halt / cool-off paths.

// True when the failure should count toward the circuit-breaker budget.
// Categories with their own halt branch (session-expired) or their own
// throttle (rate_limit) and user-content rejections (content_policy)
// are excluded — counting them would conflate user / quota issues with
// account-health degradation.
function _shouldCountForCircuitBreaker(error) {
  if (!error || typeof error !== 'object') return true;
  if (error.isSessionExpired === true) return false;
  if (error.category === 'content_policy') return false;
  if (error.category === 'rate_limit') return false;
  return true;
}

async function markJobAsCompleted(jobId) {
  const total = await addProcessedJobId(jobId);
  safeLog(`[handler] Job ${jobId} marked as completed. Total processed: ${total}`);
}

// Adapter for the content script's `videoFound` message (fired when Flow
// renders a generated image directly, without a poll). Translates the
// `{ task, videoUrl, isGeneratedImage }` shape sent by content.js into
// the `{ taskId, resultUrl, isGeneratedImage }` shape that
// handleTaskCompletedFIFO consumes. Lives here (not in messages.js) so
// the router case stays a one-line delegate.
function handleVideoFoundFIFO(message) {
  return handleTaskCompletedFIFO({
    taskId: message.data.task?.id,
    resultUrl: message.data.videoUrl,
    isGeneratedImage: message.data.isGeneratedImage,
  });
}

async function handleTaskCompletedFIFO(data) {
  safeLog('Task completed:', data.taskId, getStopFlag() ? '(stopped but still saving result)' : '');

  try {
    const fetchStart = Date.now();
    const mediaFiles = await fetchMediaFiles(data.resultUrl);
    const fetchMediaMs = Date.now() - fetchStart;
    // Stamp our local timing into the executor-supplied timings object
    // so submitResult sees the full per-attempt trace.
    const timings = {
      ...(data.timings && typeof data.timings === 'object' ? data.timings : {}),
      fetchMediaMs,
    };
    const dataWithTimings = { ...data, timings };

    if (getStopFlag()) {
      safeLog('Stopped - skipping result submission for:', data.taskId);
      return;
    }

    const webhookSuccess = await submitResult(dataWithTimings, mediaFiles);

    if (webhookSuccess) {
      await markJobAsCompleted(data.taskId);
      await bumpStat('processed');
      // Account-health signal — a successful round-trip means the
      // breaker budget should reset. See Task 3.1.
      resetConsecutiveFailures();
      safeLog('Task done, continuing...');
    } else {
      // Don't mark as completed — HistForge's reaper will requeue the
      // dispatched row after google_flow_dispatch_timeout_minutes.
      safeLog('CRITICAL: Webhook failed after 3 attempts for task:', data.taskId, '- HistForge reaper will recover');
    }
  } catch (error) {
    safeLog('Failed to submit result:', error);
    // Don't mark as completed — HistForge's reaper will requeue the
    // dispatched row after google_flow_dispatch_timeout_minutes, and a
    // fresh claim will mint a new external_task_id.
    safeLog('Task NOT marked as completed - HistForge reaper will recover it');
  }
}

// Report the error to HistForge and mark the job complete locally.
// HistForge's submit-result handler classifies the error
// (content-policy → fail, 429/quota → pause+requeue, transient →
// retry); the extension no longer categorizes locally, it just
// forwards the structured fields. The local mark guards against the
// extension re-picking the same task.id if it happens to be
// redispatched — HistForge's dispatch-qualified IDs make that
// unlikely, but cheap insurance.
async function submitFailureToHistForge(task, errorOrMessage) {
  await submitFailure(task, errorOrMessage);
  await markJobAsCompleted(task?.id);
}

// Bump the rolling `failed` counter and the per-category daily
// counters. bumpStat handles the date rollover. Per-category counters
// only fire for structured errors carrying err.category from
// src/flow-error.js parseFlowApiError.
async function bumpFailureStats(errorOrMessage) {
  await bumpStat('failed');
  const category = errorOrMessage && typeof errorOrMessage === 'object'
    ? errorOrMessage.category
    : null;
  if (category === 'content_policy') {
    await bumpStat('todayContentPolicy');
  } else if (category === 'rate_limit') {
    await bumpStat('todayRateLimited');
  }
}

// Circuit breaker (Task 3.1) — count account-health failures and trip
// a hard stop at the threshold. Excludes session-expired (own halt
// branch), content_policy (user content), and rate_limit (own
// cool-off, Task 3.2).
async function maybeTripCircuitBreaker(errorOrMessage) {
  if (!_shouldCountForCircuitBreaker(errorOrMessage)) return;
  const count = bumpConsecutiveFailures();
  const threshold = getCircuitBreakerThreshold();
  if (count < threshold) return;
  const lastError = typeof errorOrMessage === 'string'
    ? errorOrMessage
    : (errorOrMessage && errorOrMessage.message) || 'unknown';
  safeLog(`[handler] Circuit breaker tripped (${count}/${threshold}) - halting`);
  setStopFlag();
  try { await stopPolling(); } catch (_e) { /* ignore */ }
  try {
    await postStatusEvent({
      type: 'StatusEvent',
      event: 'circuit_breaker_tripped',
      consecutiveFailures: count,
      lastError,
    });
  } catch (_e) { /* advisory */ }
}

async function handleTaskFailedFIFO(data) {
  safeLog('Task failed:', data.task?.id, data.error);

  // data.error may be an Error object (post task 1.2) or a string
  // (legacy / fallback). Hand the value through unchanged — submitFailure
  // reads structured fields off Errors when present.
  const errorOrMessage = data.error == null
    ? 'Unknown error'
    : data.error;

  await submitFailureToHistForge(data.task, errorOrMessage);
  await bumpFailureStats(errorOrMessage);
  await maybeTripCircuitBreaker(errorOrMessage);
}
