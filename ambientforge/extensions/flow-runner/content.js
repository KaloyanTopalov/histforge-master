// VEO Flow API - Content Script (MAIN world)
// Runs in page context - has access to grecaptcha and page JS objects
// Communicates with content-bridge.js via window.postMessage

(function() {
  'use strict';

  const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

  console.log('[YouForge Flow] [content] Content script loaded (MAIN world)');

  // reCAPTCHA hook lives in recaptcha-hook.js (document_start) — it owns
  // `window.__VEO_LAST_ACTION`, which this script reads as the captured-action
  // fallback below.

  // Listen for token requests from the bridge
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'VEO_REQUEST_RECAPTCHA') {
      const requestedAction = event.data.recaptchaAction || null;
      console.log('[YouForge Flow] [content] reCAPTCHA token requested, action:', requestedAction);
      try {
        const token = await getRecaptchaToken(requestedAction);
        window.postMessage({
          type: 'VEO_RECAPTCHA_RESPONSE',
          requestId: event.data.requestId,
          token: token
        }, window.location.origin);
      } catch (err) {
        console.error('[YouForge Flow] [content] reCAPTCHA error:', err);
        window.postMessage({
          type: 'VEO_RECAPTCHA_RESPONSE',
          requestId: event.data.requestId,
          error: err.message
        }, window.location.origin);
      }
    }

    if (event.data?.type === 'VEO_REQUEST_SESSION') {
      console.log('[YouForge Flow] [content] Session token requested');
      try {
        const session = await getSessionToken();
        window.postMessage({
          type: 'VEO_SESSION_RESPONSE',
          requestId: event.data.requestId,
          session: session
        }, window.location.origin);
      } catch (err) {
        console.error('[YouForge Flow] [content] Session error:', err);
        window.postMessage({
          type: 'VEO_SESSION_RESPONSE',
          requestId: event.data.requestId,
          error: err.message
        }, window.location.origin);
      }
    }
  });

  async function getRecaptchaToken(requestedAction) {
    let attempts = 0;
    while (!window.grecaptcha?.enterprise?.execute && attempts < 30) {
      await new Promise(r => setTimeout(r, 500));
      attempts++;
    }

    if (!window.grecaptcha?.enterprise?.execute) {
      throw new Error('reCAPTCHA not available on page');
    }

    // Use action from request, or captured from Google's own code (via the
    // document_start hook in recaptcha-hook.js)
    const action = requestedAction || window.__VEO_LAST_ACTION || 'IMAGE_GENERATION';
    console.log('[YouForge Flow] [content] Using reCAPTCHA action:', action);

    const token = await window.grecaptcha.enterprise.execute(RECAPTCHA_SITE_KEY, {
      action: action
    });

    console.log('[YouForge Flow] [content] reCAPTCHA token obtained, length:', token.length);
    return token;
  }

  async function getSessionToken() {
    const resp = await fetch('https://labs.google/fx/api/auth/session', {
      credentials: 'include'
    });

    if (!resp.ok) {
      throw new Error(`Session fetch failed: ${resp.status}`);
    }

    const data = await resp.json();

    if (!data.access_token) {
      throw new Error('No access_token in session response');
    }

    console.log('[YouForge Flow] [content] Session token obtained, user:', data.user?.name);
    return {
      accessToken: data.access_token,
      user: data.user,
      expires: data.expires
    };
  }

  // Signal ready
  window.postMessage({ type: 'VEO_CONTENT_READY' }, window.location.origin);
})();
