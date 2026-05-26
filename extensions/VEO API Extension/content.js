// VEO Flow API - Content Script (MAIN world)
// Runs in page context - has access to grecaptcha and page JS objects
// Communicates with content-bridge.js via window.postMessage

(function() {
  'use strict';

  const RECAPTCHA_SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';
  let capturedAction = null;

  console.log('[VEO-API] Content script loaded (MAIN world)');

  // INTERCEPT grecaptcha.enterprise.execute to discover the correct action
  // Google's own code calls this - we spy on it to learn the action parameter
  function hookRecaptcha() {
    if (!window.grecaptcha?.enterprise?.execute) return false;
    if (window.grecaptcha.enterprise._veoHooked) return true;

    const original = window.grecaptcha.enterprise.execute;
    window.grecaptcha.enterprise.execute = function(siteKey, options) {
      console.log('[VEO-API] grecaptcha.enterprise.execute intercepted!');
      console.log('[VEO-API]   siteKey:', siteKey);
      console.log('[VEO-API]   action:', options?.action);
      if (options?.action) {
        capturedAction = options.action;
        console.log('[VEO-API]   Captured action:', capturedAction);
      }
      return original.call(this, siteKey, options);
    };
    window.grecaptcha.enterprise._veoHooked = true;
    console.log('[VEO-API] grecaptcha.enterprise.execute hooked successfully');
    return true;
  }

  // Try to hook immediately and retry
  if (!hookRecaptcha()) {
    const hookInterval = setInterval(() => {
      if (hookRecaptcha()) clearInterval(hookInterval);
    }, 1000);
    setTimeout(() => clearInterval(hookInterval), 30000);
  }

  // Listen for token requests from the bridge
  window.addEventListener('message', async (event) => {
    if (event.source !== window) return;

    if (event.data?.type === 'VEO_REQUEST_RECAPTCHA') {
      const requestedAction = event.data.recaptchaAction || null;
      console.log('[VEO-API] reCAPTCHA token requested, action:', requestedAction, 'capturedAction:', capturedAction);
      try {
        const token = await getRecaptchaToken(requestedAction);
        window.postMessage({
          type: 'VEO_RECAPTCHA_RESPONSE',
          requestId: event.data.requestId,
          token: token
        }, '*');
      } catch (err) {
        console.error('[VEO-API] reCAPTCHA error:', err);
        window.postMessage({
          type: 'VEO_RECAPTCHA_RESPONSE',
          requestId: event.data.requestId,
          error: err.message
        }, '*');
      }
    }

    if (event.data?.type === 'VEO_REQUEST_SESSION') {
      console.log('[VEO-API] Session token requested');
      try {
        const session = await getSessionToken();
        window.postMessage({
          type: 'VEO_SESSION_RESPONSE',
          requestId: event.data.requestId,
          session: session
        }, '*');
      } catch (err) {
        console.error('[VEO-API] Session error:', err);
        window.postMessage({
          type: 'VEO_SESSION_RESPONSE',
          requestId: event.data.requestId,
          error: err.message
        }, '*');
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

    // Use action from request, or captured from Google's own code
    const action = requestedAction || capturedAction || 'IMAGE_GENERATION';
    console.log('[VEO-API] Using reCAPTCHA action:', action);

    const token = await window.grecaptcha.enterprise.execute(RECAPTCHA_SITE_KEY, {
      action: action
    });

    console.log('[VEO-API] reCAPTCHA token obtained, length:', token.length);
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

    console.log('[VEO-API] Session token obtained, user:', data.user?.name);
    return {
      accessToken: data.access_token,
      user: data.user,
      expires: data.expires
    };
  }

  // Signal ready
  window.postMessage({ type: 'VEO_CONTENT_READY' }, '*');
})();
