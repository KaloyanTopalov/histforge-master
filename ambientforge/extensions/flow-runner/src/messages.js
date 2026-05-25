// YouForge Flow - chrome.runtime.onMessage router
// Single switch statement that maps every inbound message action to the
// module that owns the corresponding behaviour. Business logic lives in
// those owning modules; this file is coordination only — no IIFEs, no
// shape-building, no storage reads, no stats math in case bodies.
//
// Runtime deps (resolved at call time): runner.startPolling /
// stopPolling / pollForTasksFIFO / handleContentReady /
// resetActiveTaskCount / forceStopAllTabs, handlers.handleTaskCompletedFIFO
// / handleTaskFailedFIFO / handleVideoFoundFIFO, settings.updateWebhooks
// / updateConcurrency / setMode, control-panel.openControlPanel,
// account-tier.clearCachedTier, stop-flag.setStopFlag / clearStopFlag /
// getStopFlag, status.getStatus, media-fetch.fetchImageAsBase64,
// stats.bumpStat, state.setGrantedOrigin / clearGrantedOrigin, safeLog.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  safeLog('Background received message:', message.action);

  switch (message.action) {
    case 'startPolling':
      startPolling();
      sendResponse({ success: true });
      break;

    case 'stopPolling':
      stopPolling();
      sendResponse({ success: true });
      break;

    case 'stopAllProcessing':
      safeLog('⛔ STOPPING ALL PROCESSING');
      setStopFlag();
      stopPolling();
      clearCachedTier();
      forceStopAllTabs();
      sendResponse({ success: true });
      break;

    case 'getStatus':
      getStatus().then(sendResponse);
      return true;

    case 'taskCompleted':
      safeLog('✓ taskCompleted');
      handleTaskCompletedFIFO(message.data);
      sendResponse({ success: true });
      break;

    case 'videoFound':
      safeLog('✓ videoFound (generated image)');
      handleVideoFoundFIFO(message);
      sendResponse({ success: true });
      break;

    case 'taskFailed':
      safeLog('✗ taskFailed');
      handleTaskFailedFIFO(message.data);
      sendResponse({ success: true });
      break;

    case 'autoStopped':
      safeLog(`[router] ❌ AUTO-STOPPED: ${message.data.reason}`);
      safeLog(`[router] Last error: ${message.data.lastError}`);
      setStopFlag();
      stopPolling();
      resetActiveTaskCount();
      sendResponse({ success: true });
      break;

    case 'taskRetrying':
      safeLog(`[router] Task ${message.data.taskId} retrying (attempt ${message.data.attempt}/3)`);
      safeLog(`[router] Error was: ${message.data.error}`);
      bumpStat('retries')
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          safeLog('[router] bumpStat(retries) failed:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'manualPoll':
      clearStopFlag();
      pollForTasksFIFO().then(sendResponse);
      return true;

    case 'requestNextTask':
      safeLog('Content finished entering task, ready for next');
      if (getStopFlag()) {
        safeLog('⛔ STOPPED - not polling for next task');
        sendResponse({ stopped: true });
        return true;
      }
      pollForTasksFIFO().then(sendResponse);
      return true;

    case 'openControlPanel':
      openControlPanel();
      sendResponse({ success: true });
      break;

    case 'fetchImage':
      fetchImageAsBase64(message.imageUrl).then(sendResponse);
      return true;

    case 'debugLog':
      if (message.data) {
        safeLog('[content]', message.message, message.data);
      } else {
        safeLog('[content]', message.message);
      }
      break;

    case 'contentReady':
      handleContentReady().then(sendResponse);
      return true;

    case 'updateWebhooks':
      updateWebhooks(message);
      sendResponse({ success: true });
      break;

    case 'updateConcurrency':
      updateConcurrency(message.concurrency);
      sendResponse({ success: true });
      break;

    case 'setMode':
      setMode(message.mode);
      sendResponse({ success: true });
      break;

    case 'setGrantedOrigin':
      // Popup writes grantedOrigin through this action instead of
      // chrome.storage.local.set so state.js's cache stays in sync
      // without a chrome.storage.onChanged listener. `origin: null`
      // clears.
      (message.origin ? setGrantedOrigin(message.origin) : clearGrantedOrigin())
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          safeLog('[router] setGrantedOrigin failed:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;
  }
});
