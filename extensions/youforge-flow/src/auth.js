// YouForge Flow - auth helpers
// Fetches the session Bearer token and reCAPTCHA token out of the
// labs.google tab via content-bridge.js (chrome.tabs.sendMessage) and
// MAIN-world executeScript probes. Both are short-lived caches that the
// executor modules reuse across a single task execution. Per-(video,
// account) Flow project IDs are owned by src/project-mgmt.js.
//
// Runtime deps (resolved at call time): safeLog (src/logger.js),
// assertNotStopped (src/stop-flag.js), clearSessionExpiredReport +
// notifySessionExpired (src/webhook.js — loads before auth.js).
// cachedAccountTier lives in src/account-tier.js, not here.

let cachedSessionToken = null;
let cachedSessionExpiry = 0; // Date.now() ms when cache becomes invalid

async function getRecaptchaTokenFromPage(tabId, recaptchaAction) {
  assertNotStopped();
  safeLog('Requesting reCAPTCHA token, action:', recaptchaAction);
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getRecaptchaToken', recaptchaAction });
    if (response && response.token) {
      safeLog('Got reCAPTCHA token:', response.token.substring(0, 30) + '...');
      return response.token;
    }
    safeLog('No reCAPTCHA token in response:', response);
    return null;
  } catch (e) {
    safeLog('Failed to get reCAPTCHA token:', e.message);
    return null;
  }
}

// Detects the session-expired pattern in an error message. Used both to
// short-circuit retryWithBackoff (don't retry these — they're terminal)
// and to decide whether to fire notifySessionExpired in the catch arm.
function _isSessionExpiredErrorMessage(msg) {
  return /session fetch failed|401|access_token/i.test(msg || '');
}

// Drops the in-memory session-token cache. Called from the session-expired
// catch arm here, and exposed so external 401 paths (notifySessionExpired
// in webhook.js, session-guard.js) can invalidate without reaching into
// auth.js internals. Bridge-unreachable failures must NOT call this — a
// transient sendMessage blip should retry, not invalidate.
function clearAuthCache() {
  cachedSessionToken = null;
  cachedSessionExpiry = 0;
}

async function getSessionTokenFromPage(tabId) {
  const now = Date.now();
  if (cachedSessionToken && now < cachedSessionExpiry) {
    safeLog('Using cached session token');
    return cachedSessionToken;
  }

  safeLog('Requesting session token from page...');
  try {
    // Wrap sendMessage in retryWithBackoff (Phase 2 task 2.6) so a
    // transient "bridge unreachable" blip doesn't mark the session
    // expired. Session-expired-shaped errors short-circuit (shouldRetry
    // returns false).
    const response = await retryWithBackoff(async () => {
      return await chrome.tabs.sendMessage(tabId, { action: 'getSessionToken' });
    }, {
      retries: getSessionReFetchRetries(),
      baseMs: 1000,
      capMs: 5000,
      jitter: true,
      shouldRetry: (e) => !_isSessionExpiredErrorMessage(e && e.message),
    });
    const token = response?.session?.accessToken || response?.token;
    if (token) {
      cachedSessionToken = token;
      // Cache until min(expires - 60s safety margin, now + 60min cap).
      // Token responses without `expires` fall back to the prior 5-minute TTL.
      const expiresValue = response?.session?.expires;
      let expiresMs = NaN;
      if (typeof expiresValue === 'number') {
        // Treat ≤1e10 as Unix seconds; >1e10 as ms.
        expiresMs = expiresValue > 1e10 ? expiresValue : expiresValue * 1000;
      } else if (typeof expiresValue === 'string') {
        expiresMs = Date.parse(expiresValue);
      }
      const capMs = now + 60 * 60 * 1000;
      const fromExpires = Number.isFinite(expiresMs)
        ? (expiresMs - 60 * 1000)
        : (now + 5 * 60 * 1000);
      cachedSessionExpiry = Math.min(capMs, fromExpires);
      clearSessionExpiredReport(); // Healthy session — re-arm expiry notification.
      safeLog('Got session token:', token.substring(0, 30) + '...');
      return token;
    }
    safeLog('No session token in response:', response);
    clearAuthCache();
    await notifySessionExpired('no access_token in session response');
    return null;
  } catch (e) {
    safeLog('Failed to get session token:', e.message);
    if (_isSessionExpiredErrorMessage(e.message)) {
      clearAuthCache();
      await notifySessionExpired(e.message);
    }
    return null;
  }
}

