// YouForge Flow - video status poller
// Polls checkVideoStatus every 5s (interruptible via assertNotStopped)
// until all media entries reach a terminal state, then returns their
// URLs. Entries that resolve without a direct `url` field fall back to
// the tRPC media.getMediaUrlRedirect endpoint — run in MAIN world on the
// Flow tab so cookies + credentials follow the redirect.
//
// Runtime deps (resolved at call time): checkVideoStatus (flow-api.js),
// assertNotStopped (src/stop-flag.js), safeLog (src/logger.js).

async function pollVideoUntilDone(authToken, mediaIds, taskId, tabId, timings, correlationId) {
  // Settings-driven (Phase 2 task 2.4) — schema defaults live in
  // src/settings-schema.js so the cache always returns a usable value.
  const baseIntervalMs = getVideoPollBaseSec() * 1000;
  const maxIntervalMs = getVideoPollMaxSec() * 1000;
  const MAX_POLL_ATTEMPTS = getVideoPollMaxAttempts();
  const stepFactor = getVideoPollStepFactor();
  const jitterMs = getVideoPollJitterMs();
  const PROGRESS_EVERY_N = getProgressEventEveryN();
  const log = forTask(correlationId);

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (timings) timings.pollCount = attempt;
    assertNotStopped();

    // Progressive interval: min(maxIntervalMs, baseIntervalMs * (1 + attempt * stepFactor)) + jitter.
    // Spreads polls across the maxConcurrent fleet so synchronized fleets
    // don't thunder-herd the video-status endpoint.
    const intervalMs = Math.min(
      maxIntervalMs,
      baseIntervalMs * (1 + attempt * stepFactor),
    ) + Math.random() * jitterMs;

    // Interruptible sleep - check stop flag every 500ms during the wait.
    for (let ms = 0; ms < intervalMs; ms += 500) {
      assertNotStopped();
      await new Promise((r) => setTimeout(r, Math.min(500, intervalMs - ms)));
    }

    // Emit a progress event at every Nth attempt so HistForge can track
    // long video generations (and the popup can render a live %). Inner
    // helper short-circuits on missing statusUrl / earlier failures.
    if (attempt % PROGRESS_EVERY_N === 0) {
      const estimatedPct = Math.min(95, Math.round((attempt / MAX_POLL_ATTEMPTS) * 100));
      try {
        await postProgressEvent({
          taskId,
          correlationId: correlationId || null,
          pollAttempt: attempt,
          totalAttempts: MAX_POLL_ATTEMPTS,
          estimatedPct,
        });
      } catch (_e) { /* progress events are advisory, never throw */ }
    }

    try {
      const statuses = await checkVideoStatus(authToken, mediaIds, tabId);
      log.safeLog(`[poll] Video poll ${attempt}/${MAX_POLL_ATTEMPTS}:`,
        statuses.map((s) => `${s.name?.substring(0, 8)}=${s.state}`).join(', '));

      const allDone = statuses.every((s) =>
        s.state === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' ||
        s.state === 'MEDIA_GENERATION_STATUS_FAILED',
      );

      if (allDone) {
        const successful = statuses.filter((s) => s.state === 'MEDIA_GENERATION_STATUS_SUCCESSFUL');
        // Resolution: direct s.url from the operations-shape poll
        // (operation.metadata.video.fifeUrl per flow2api recon). One
        // re-poll for any SUCCESSFUL entry that arrived without a URL —
        // the metadata.video block can lag the status flip by a few
        // hundred ms upstream. No tRPC-redirect fallback; the URL is
        // always present in this shape.
        const urls = [];
        const stillUnresolved = [];

        for (const s of successful) {
          if (s.url) urls.push(s.url);
          else stillUnresolved.push(s);
        }

        if (stillUnresolved.length > 0) {
          log.safeLog(`[poll] Re-running checkVideoStatus for ${stillUnresolved.length} unresolved media (URL lag)`);
          try {
            const reStatuses = await checkVideoStatus(authToken, mediaIds, tabId);
            const byName = new Map(reStatuses.map((s) => [s.name, s]));
            for (const s of stillUnresolved) {
              const fresh = byName.get(s.name);
              if (fresh && fresh.url) urls.push(fresh.url);
            }
          } catch (e) {
            log.safeLog('Re-check failed:', e.message);
          }
        }

        if (urls.length === 0) {
          const failed = statuses.filter((s) => s.state === 'MEDIA_GENERATION_STATUS_FAILED');
          // No FAILED statuses but no resolvable URLs either → upstream returned
          // SUCCESSFUL without ever populating the URL field.
          if (failed.length === 0) {
            const err = makeFlowApiError({
              reason: 'NO_URL',
              category: 'not_found',
              message: 'Video generation succeeded but no URL could be resolved after retry',
              httpStatus: null,
            });
            err.isGenerationFailure = true;
            throw err;
          }
          let detectedTag = null;
          const failureDetails = failed.map((s) => {
            const err = s.error || {};
            // failureReasons is exposed at the top level of the status
            // object by flow-api.js — `s.failureReasons`, not `err.failureReasons`.
            const reasons = s.failureReasons || err.failureReasons || [];
            for (const r of reasons) {
              if (isContentPolicyReason(r)) {
                if (!detectedTag) detectedTag = r;
                return `Content policy violation (${r})`;
              }
            }
            const msg = typeof err.message === 'string' ? err.message : '';
            // Fallback: some failures only embed the reason in error.message
            const fromMsg = findContentPolicyReasonInString(msg);
            if (fromMsg) {
              if (!detectedTag) detectedTag = fromMsg;
              return `Content policy violation (${fromMsg})`;
            }
            return `${s.state}: ${JSON.stringify(err).substring(0, 100)}`;
          });
          const errorMsg = failureDetails.join(', ') || 'All videos failed (unknown reason)';
          const err = detectedTag
            ? makeFlowApiError({
                reason: detectedTag,
                category: 'content_policy',
                contentPolicyTag: detectedTag,
                isContentPolicy: true,
                message: `Video generation failed: ${errorMsg}`,
                httpStatus: null,
              })
            : makeFlowApiError({
                reason: 'GENERATION_FAILED',
                category: 'unknown',
                message: `Video generation failed: ${errorMsg}`,
                httpStatus: null,
              });
          err.isGenerationFailure = true;
          throw err;
        }

        return urls;
      }
    } catch (e) {
      if (e.message === 'STOP_REQUESTED') throw e;
      if (e.isGenerationFailure) throw e;
      // Phase 3 fix #5: rate_limit errors must propagate so the cool-off
      // (already armed by flow-api.js's throw site) ends this poll loop
      // instead of looping for the full attempts budget against an
      // already-paused account.
      if (e.category === 'rate_limit') throw e;
      log.safeLog(`[poll] Video poll error (attempt ${attempt}):`, e.message);
    }
  }

  throw new Error('Video generation timed out after 10 minutes');
}
