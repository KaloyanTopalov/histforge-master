// Magnific HITL - chrome.runtime.onMessage router
// Single switch statement that maps every inbound message action to the
// module that owns the corresponding behaviour. Business logic lives in
// those owning modules; this file is coordination only.
//
// Runtime deps (resolved at call time): runner.startPolling /
// stopPolling, status.getStatus, settings.updateWebhooks /
// setVerboseLogging / setPollIntervalSec, state.setGrantedOrigin /
// clearGrantedOrigin, stop-flag.setStopFlag, safeLog.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
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
      sendResponse({ success: true });
      break;

    case 'getStatus':
      getStatus().then(sendResponse);
      return true;

    case 'updateWebhooks':
      updateWebhooks(message)
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          safeLog('[router] updateWebhooks failed:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'setVerboseLogging':
      setVerboseLogging(message.value)
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          safeLog('[router] setVerboseLogging failed:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'setPollIntervalSec':
      setPollIntervalSec(message.value)
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          safeLog('[router] setPollIntervalSec failed:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'setGrantedOrigin':
      // Popup writes grantedOrigin through this action instead of
      // chrome.storage.local.set so state.js's cache stays in sync
      // without a chrome.storage.onChanged listener.
      (message.origin ? setGrantedOrigin(message.origin) : clearGrantedOrigin())
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          safeLog('[router] setGrantedOrigin failed:', e);
          sendResponse({ success: false, error: e.message });
        });
      return true;

    case 'magnificVariationSelected': {
      // Content script reports an operator-picked variation. Route
      // through the executor's pending-task Map; matched=false means
      // the taskId never dispatched (or was already resolved/timed out)
      // and the message router quietly drops it.
      const matched =
        typeof notifyVariationSelected === 'function'
          ? notifyVariationSelected(message.taskId, message.resultUrl)
          : false;
      sendResponse({ success: true, matched });
      break;
    }

    case 'magnificVariationFailed': {
      // Content script reports a silent-bail failure on the image-hitl
      // path (prompt input missing, generate button missing/disabled).
      // Reject the pending promise so runImageHitl's `finally` releases
      // the slot; the reaper requeues the dispatched row server-side
      // after dispatch_timeout. Mirror of magnificImageToVideoFailed —
      // both modes share the same registry contract and must release
      // their slot symmetrically so the runner doesn't wedge.
      const matched =
        typeof notifyVariationFailed === 'function'
          ? notifyVariationFailed(message.taskId, message.reason)
          : false;
      sendResponse({ success: true, matched });
      break;
    }

    case 'magnificImageToVideoCompleted': {
      // Image-to-video content script reports a harvested result video
      // URL. Same rendezvous pattern as image-hitl: matched=false means
      // the taskId is stale (executor already resolved/timed out) and
      // we silently drop the message.
      const matched =
        typeof notifyImageToVideoCompleted === 'function'
          ? notifyImageToVideoCompleted(message.taskId, message.resultUrl)
          : false;
      sendResponse({ success: true, matched });
      break;
    }

    case 'magnificImageToVideoFailed': {
      // Image-to-video content script reports an unrecoverable failure
      // (e.g., reference fetch failed, generate button missing). Reject
      // the pending promise; the reaper requeues the dispatched row
      // server-side after dispatch_timeout (handoff §Decision 8).
      const matched =
        typeof notifyImageToVideoFailed === 'function'
          ? notifyImageToVideoFailed(message.taskId, message.reason)
          : false;
      sendResponse({ success: true, matched });
      break;
    }

    case 'fetchReference': {
      // Cross-origin proxy for the i2v content script. The script runs on
      // https://www.magnific.com so a direct fetch() of the HistForge
      // artifact URL is blocked as mixed content (HTTPS page → HTTP
      // localhost) and would also fail CORS even on the HTTPS side. The
      // SW has the user-granted host permission (host-permission.js) and
      // no mixed-content restrictions, so the fetch happens here and the
      // bytes come back as a data URL the content script reconstructs
      // into a File for the advanced-selection-modal upload input.
      (async () => {
        try {
          const r = await fetch(message.url);
          if (!r.ok) {
            sendResponse({ ok: false, error: `HTTP ${r.status}` });
            return;
          }
          const blob = await r.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () =>
              reject(reader.error || new Error('FileReader failed'));
            reader.readAsDataURL(blob);
          });
          sendResponse({ ok: true, dataUrl });
        } catch (e) {
          sendResponse({
            ok: false,
            error: e && e.message ? e.message : String(e),
          });
        }
      })();
      return true; // async response
    }
  }
});
