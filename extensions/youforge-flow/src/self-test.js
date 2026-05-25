// YouForge Flow - popup self-test (Task 4.5)
// Probes the eight dependencies the runner needs in order to actually
// process a task: a labs.google tab, a session token, the credits
// endpoint, the content bridge, and the four HistForge webhooks. The
// popup renders the result list inline as colored dots so the user can
// triage a "why isn't it polling" without opening DevTools.
//
// Each check is independent except where one strictly depends on
// another (session needs a tab; credits needs a session). Dependent
// checks return `status: 'skip'` rather than running with a known-bad
// upstream.
//
// Runtime deps (resolved at call time):
//   chrome.tabs, getSessionTokenFromPage (src/auth.js),
//   getCredits (flow-api.js), fetchWithTimeout (src/http.js),
//   getPollUrl / getResultUrl / getStatusUrl / getProjectUrl /
//   getAccountToken (src/settings.js), safeLog.

async function runSelfTest() {
  const checks = [];
  const skip = (name, detail) => checks.push({ name, status: 'skip', detail });
  const pass = (name, detail) => checks.push({ name, status: 'pass', detail });
  const fail = (name, detail) => checks.push({ name, status: 'fail', detail });

  // 1. labs.google tab — every other tab-side check depends on this one.
  let tabId = null;
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    if (tabs && tabs.length > 0) {
      tabId = tabs[0].id;
      pass('tab', `tab id ${tabId}`);
    } else {
      fail('tab', 'no labs.google tab open');
    }
  } catch (e) {
    fail('tab', e.message);
  }

  // 2. session token — needs a tab.
  let sessionToken = null;
  if (tabId === null) {
    skip('session', 'no tab');
  } else {
    try {
      sessionToken = await getSessionTokenFromPage(tabId);
      if (sessionToken) {
        pass('session', `${sessionToken.substring(0, 8)}…`);
      } else {
        fail('session', 'no token returned');
      }
    } catch (e) {
      fail('session', e.message);
    }
  }

  // 3. credits — needs a session token.
  if (!sessionToken) {
    skip('credits', 'no session token');
  } else {
    try {
      const credits = await getCredits(sessionToken);
      if (credits && typeof credits.credits === 'number') {
        pass('credits', `${credits.credits} (${credits.tier || 'unknown'})`);
      } else {
        fail('credits', 'credits API returned null');
      }
    } catch (e) {
      fail('credits', e.message);
    }
  }

  // 4. content bridge — independent of session, only needs a tab.
  if (tabId === null) {
    skip('bridge', 'no tab');
  } else {
    try {
      await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      pass('bridge', 'ping ok');
    } catch (e) {
      fail('bridge', e.message);
    }
  }

  // 5-8. HistForge endpoint pings. Each is independent. A 4xx counts as
  // pass — what we want to know is whether the endpoint is reachable.
  // Network failure is the only "fail" condition. HistForge is expected
  // to no-op on { type: 'Ping' }.
  await pingHistForge('pollUrl', getPollUrl, checks);
  await pingHistForge('resultUrl', getResultUrl, checks);
  await pingHistForge('statusUrl', getStatusUrl, checks);
  await pingHistForge('projectUrl', getProjectUrl, checks);

  const ok = checks.every((c) => c.status !== 'fail');
  return { ok, checks };
}

async function pingHistForge(name, urlGetter, checks) {
  const url = urlGetter();
  if (!url) {
    checks.push({ name, status: 'skip', detail: 'not configured' });
    return;
  }
  try {
    const accountToken = getAccountToken();
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'Ping',
        accountToken,
        at: new Date().toISOString(),
      }),
    }, 10_000);
    checks.push({ name, status: 'pass', detail: `HTTP ${response.status}` });
  } catch (e) {
    checks.push({ name, status: 'fail', detail: e.message });
  }
}
