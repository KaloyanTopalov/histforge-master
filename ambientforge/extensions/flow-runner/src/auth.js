// YouForge Flow - auth helpers
// Fetches the session Bearer token, reCAPTCHA token, and Flow project id
// out of the labs.google tab via content-bridge.js (chrome.tabs.sendMessage)
// and MAIN-world executeScript probes. All three are short-lived caches
// that the executor modules reuse across a single task execution.
//
// Runtime deps (resolved at call time): safeLog (src/logger.js),
// assertNotStopped (src/stop-flag.js), clearSessionExpiredReport +
// notifySessionExpired (src/webhook.js — loads before auth.js).
// cachedAccountTier lives in src/account-tier.js, not here.

let cachedSessionToken = null;
let cachedSessionTime = 0;
let cachedProjectId = null;

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

async function getSessionTokenFromPage(tabId) {
  // Session tokens last longer, cache for 5 minutes
  const now = Date.now();
  if (cachedSessionToken && (now - cachedSessionTime) < 5 * 60 * 1000) {
    safeLog('Using cached session token');
    return cachedSessionToken;
  }

  safeLog('Requesting session token from page...');
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getSessionToken' });
    const token = response?.session?.accessToken || response?.token;
    if (token) {
      cachedSessionToken = token;
      cachedSessionTime = now;
      clearSessionExpiredReport(); // Healthy session — re-arm expiry notification.
      safeLog('Got session token:', token.substring(0, 30) + '...');
      return token;
    }
    safeLog('No session token in response:', response);
    await notifySessionExpired('no access_token in session response');
    return null;
  } catch (e) {
    safeLog('Failed to get session token:', e.message);
    // `Session fetch failed: 401` or similar from content.js bubbles here.
    if (/session fetch failed|401|access_token/i.test(e.message || '')) {
      await notifySessionExpired(e.message);
    }
    return null;
  }
}

async function getProjectIdCached(tabId) {
  if (cachedProjectId) return cachedProjectId;

  safeLog('Getting project ID...');

  // Method 1: Extract from tab URL (e.g. /flow/project/PROJECT_ID)
  try {
    const tab = await chrome.tabs.get(tabId);
    const urlMatch = tab.url?.match(/\/flow\/project\/([a-f0-9-]+)/i);
    if (urlMatch) {
      cachedProjectId = urlMatch[1];
      safeLog('Got project ID from URL:', cachedProjectId);
      return cachedProjectId;
    }
    safeLog('No project ID in URL:', tab.url);
  } catch (e) {
    safeLog('Could not get tab URL:', e.message);
  }

  // Method 2: trpc API call from page context (needs cookies)
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: async () => {
        try {
          const url = 'https://labs.google/fx/api/trpc/project.searchUserProjects?input=' +
            encodeURIComponent(JSON.stringify({ json: { pageSize: 1, toolName: 'PINHOLE', cursor: null } }));
          const response = await fetch(url, { credentials: 'include' });
          if (!response.ok) return { error: `HTTP ${response.status}` };
          const result = await response.json();
          return { data: result };
        } catch (e) {
          return { error: e.message };
        }
      }
    });
    const scriptResult = results?.[0]?.result;
    safeLog('trpc result:', JSON.stringify(scriptResult)?.substring(0, 500));

    if (scriptResult?.data) {
      const projects = scriptResult.data?.result?.data?.json?.projects || [];
      if (projects.length > 0) {
        cachedProjectId = projects[0].projectId;
        safeLog('Got project ID from trpc:', cachedProjectId);
        return cachedProjectId;
      }
      safeLog('No projects in trpc response');
    } else {
      safeLog('trpc error:', scriptResult?.error);
    }
  } catch (e) {
    safeLog('executeScript failed:', e.message);
  }

  safeLog('All methods to get project ID failed');
  return null;
}
