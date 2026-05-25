// VEO Flow API - Content Bridge (ISOLATED world)
// Bridges between background.js (extension messaging) and content.js (MAIN world)
// content.js runs in page context (can access grecaptcha), this script talks to both sides

(function() {
  'use strict';

  console.log('[YouForge Flow] [bridge] Loaded');

  let pendingRequests = new Map();

  // Listen for messages from background.js
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
      sendResponse({ ok: true });
      return;
    }

    if (message.action === 'getRecaptchaToken') {
      const requestId = 'recaptcha_' + Date.now() + '_' + Math.random();
      pendingRequests.set(requestId, sendResponse);

      window.postMessage({
        type: 'VEO_REQUEST_RECAPTCHA',
        requestId: requestId,
        recaptchaAction: message.recaptchaAction || null
      }, window.location.origin);

      return true; // Keep channel open for async response
    }

    if (message.action === 'getSessionToken') {
      const requestId = 'session_' + Date.now() + '_' + Math.random();
      pendingRequests.set(requestId, sendResponse);

      window.postMessage({
        type: 'VEO_REQUEST_SESSION',
        requestId: requestId
      }, window.location.origin);

      return true;
    }
  });

  // Listen for responses from content.js (MAIN world)
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'VEO_RECAPTCHA_RESPONSE') {
      const callback = pendingRequests.get(event.data.requestId);
      if (callback) {
        pendingRequests.delete(event.data.requestId);
        if (event.data.error) {
          callback({ error: event.data.error });
        } else {
          callback({ token: event.data.token });
        }
      }
    }

    if (event.data?.type === 'VEO_SESSION_RESPONSE') {
      const callback = pendingRequests.get(event.data.requestId);
      if (callback) {
        pendingRequests.delete(event.data.requestId);
        if (event.data.error) {
          callback({ error: event.data.error });
        } else {
          callback({ session: event.data.session });
        }
      }
    }

    if (event.data?.type === 'VEO_CONTENT_READY') {
      console.log('[YouForge Flow] [bridge] MAIN world content script ready');
      chrome.runtime.sendMessage({ action: 'contentReady' }).catch(() => {});
    }
  });
})();
