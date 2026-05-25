// YouForge Flow - video status poller
// Polls checkVideoStatus every 5s (interruptible via assertNotStopped)
// until all media entries reach a terminal state, then returns their
// URLs. Entries that resolve without a direct `url` field fall back to
// the tRPC media.getMediaUrlRedirect endpoint — run in MAIN world on the
// Flow tab so cookies + credentials follow the redirect.
//
// Runtime deps (resolved at call time): checkVideoStatus (flow-api.js),
// assertNotStopped (src/stop-flag.js), safeLog (src/logger.js).

async function pollVideoUntilDone(authToken, mediaIds, taskId, tabId) {
  const MAX_POLL_ATTEMPTS = 120; // 10 minutes at 5s interval
  const POLL_INTERVAL = 5000;

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    assertNotStopped();

    // Interruptible sleep - check stop flag every 500ms during the 5s wait
    for (let ms = 0; ms < POLL_INTERVAL; ms += 500) {
      assertNotStopped();
      await new Promise((r) => setTimeout(r, 500));
    }

    try {
      const statuses = await checkVideoStatus(authToken, mediaIds);
      safeLog(`[poll] Video poll ${attempt}/${MAX_POLL_ATTEMPTS}:`,
        statuses.map((s) => `${s.name?.substring(0, 8)}=${s.state}`).join(', '));

      const allDone = statuses.every((s) =>
        s.state === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' ||
        s.state === 'MEDIA_GENERATION_STATUS_FAILED',
      );

      if (allDone) {
        const successful = statuses.filter((s) => s.state === 'MEDIA_GENERATION_STATUS_SUCCESSFUL');
        const urls = [];

        for (const s of successful) {
          if (s.url) {
            urls.push(s.url);
            continue;
          }
          safeLog('No URL in status, trying getMediaUrlRedirect for:', s.name);
          try {
            const redirectUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${s.name}`;
            const results = await chrome.scripting.executeScript({
              target: { tabId },
              world: 'MAIN',
              func: async (url) => {
                try {
                  const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
                  return { url: resp.url, ok: resp.ok };
                } catch (e) {
                  return { error: e.message };
                }
              },
              args: [redirectUrl],
            });
            const redirectResult = results?.[0]?.result;
            if (redirectResult?.url && redirectResult.url.includes('storage.googleapis.com')) {
              urls.push(redirectResult.url);
              safeLog('Got video URL via redirect:', redirectResult.url.substring(0, 80));
            } else {
              urls.push(`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${s.name}`);
              safeLog('Using redirect URL as fallback for:', s.name);
            }
          } catch (e) {
            safeLog('getMediaUrlRedirect failed:', e.message);
            urls.push(`media:${s.name}`);
          }
        }

        if (urls.length === 0) {
          const failed = statuses.filter((s) => s.state === 'MEDIA_GENERATION_STATUS_FAILED');
          const failureDetails = failed.map((s) => {
            const err = s.error || {};
            const reasons = err.failureReasons || [];
            if (reasons.includes('CHILD_DANGER') || err.message?.includes('CHILD_DANGER')) {
              return 'Content policy violation (CHILD_DANGER)';
            }
            if (reasons.includes('SAFETY') || err.message?.includes('SAFETY')) {
              return 'Content safety filter';
            }
            return `${s.state}: ${JSON.stringify(err).substring(0, 100)}`;
          });
          const errorMsg = failureDetails.join(', ') || 'All videos failed (unknown reason)';
          const err = new Error(`Video generation failed: ${errorMsg}`);
          err.isGenerationFailure = true;
          throw err;
        }

        return urls;
      }
    } catch (e) {
      if (e.message === 'STOP_REQUESTED') throw e;
      if (e.isGenerationFailure) throw e;
      safeLog(`[poll] Video poll error (attempt ${attempt}):`, e.message);
    }
  }

  throw new Error('Video generation timed out after 10 minutes');
}
