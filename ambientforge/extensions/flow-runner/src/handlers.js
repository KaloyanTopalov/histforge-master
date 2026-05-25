// YouForge Flow - task-completion handlers
// Orchestrates the tail of each task's lifecycle: fetching the media
// payload, submitting success/failure to HistForge, recording it in the
// local defensive-dedup ring, and bumping `stats`. Called by runner.js
// from the fire-and-forget chain — this module itself never polls.
//
// Runtime deps (resolved at call time): fetchMediaFiles
// (src/media-fetch.js), submitResult / submitFailure (src/webhook.js),
// getStopFlag (src/stop-flag.js), addProcessedJobId (src/state.js),
// bumpStat (src/stats.js), safeLog (src/logger.js).

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
    const mediaFiles = await fetchMediaFiles(data.resultUrl);

    if (getStopFlag()) {
      safeLog('Stopped - skipping result submission for:', data.taskId);
      return;
    }

    const webhookSuccess = await submitResult(data, mediaFiles);

    if (webhookSuccess) {
      await markJobAsCompleted(data.taskId);
      await bumpStat('processed');
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

async function handleTaskFailedFIFO(data) {
  safeLog('Task failed:', data.task?.id, data.error);

  const task = data.task;
  const errorMessage = data.error || 'Unknown error';

  // Report the raw error to HistForge and let the submit-result handler
  // classify it (content-policy → fail, 429/quota → pause+requeue,
  // transient → retry). The extension no longer categorizes locally.
  await submitFailure(task, errorMessage);

  // Mark locally so the extension doesn't re-pick the same task.id if
  // it happens to be redispatched (HistForge's dispatch-qualified IDs
  // make that unlikely, but cheap insurance).
  await markJobAsCompleted(task?.id);

  await bumpStat('failed');
}
