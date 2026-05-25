// AmbientForge Suno Runner — content script (suno.com).
//
// Receives messages from background.js and performs the actual Suno work
// (submit / poll / download / credits) by calling Suno's authenticated API
// endpoints from the page origin (where the auth cookies live) or by driving
// the DOM where there's no public API path.
//
// In this Session 4 scaffolding the handlers are placeholders. Fill in the
// real Suno API calls in a follow-up session — endpoint discovery (study the
// network tab on suno.com/create) is the prerequisite. Pattern:
//   - submit  -> POST https://studio-api.suno.ai/api/generate/v2/  (or current)
//   - poll    -> GET  https://studio-api.suno.ai/api/feed/v2?ids=... (or current)
//   - download-> fetch the audio_url from the poll response, return bytes
//   - credits -> GET  https://studio-api.suno.ai/api/billing/info/  (or current)
//
// All fetch() calls run with credentials: 'include' so the user's logged-in
// session cookie is attached automatically (same pattern as YouForge Flow).

(function () {
  'use strict';
  console.log('[suno-runner] content script loaded');

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    handle(msg)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: String(err.message ?? err) }));
    return true; // keep the message channel open for async sendResponse
  });

  async function handle(msg) {
    switch (msg && msg.kind) {
      case 'getCredits':
        return getCredits();
      case 'submit':
        return submit(msg.payload);
      case 'poll':
        return poll(msg.payload);
      case 'download':
        return download(msg.payload);
      case 'ping':
        return { pong: true };
      default:
        throw new Error('UNKNOWN_MESSAGE: ' + JSON.stringify(msg));
    }
  }

  // ---- placeholders ------------------------------------------------------
  // Replace each of these with real calls once Suno's current API surface is
  // confirmed by the operator. See top-of-file comment for hints.

  // getCredits is wired: tries Suno's billing API first (cookie auth), falls
  // back to scraping the credit count from the suno.com DOM if the API path
  // changes. Throws a precise error tag on failure so worker logs are useful.
  async function getCredits() {
    const apiEndpoints = [
      'https://studio-api.suno.ai/api/billing/info/',
      'https://studio-api.suno.ai/api/billing/info',
    ];
    const apiErrors = [];
    for (const url of apiEndpoints) {
      try {
        const res = await fetch(url, {
          method: 'GET',
          credentials: 'include',
          headers: { accept: 'application/json' },
        });
        if (res.status === 404) {
          apiErrors.push(`404 ${url}`);
          continue;
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          apiErrors.push(`${res.status} ${url} :: ${body.slice(0, 80)}`);
          continue;
        }
        const data = await res.json();
        const credits = pickCredits(data);
        if (typeof credits === 'number' && Number.isFinite(credits)) {
          return { credits, source: 'api' };
        }
        apiErrors.push(`parse-fail ${url} :: ${JSON.stringify(data).slice(0, 120)}`);
      } catch (err) {
        apiErrors.push(`fetch-error ${url} :: ${String(err && err.message ? err.message : err)}`);
      }
    }
    const dom = scrapeCreditsFromDom();
    if (typeof dom === 'number' && Number.isFinite(dom)) {
      return { credits: dom, source: 'dom' };
    }
    throw new Error(
      'SUNO_CREDITS_UNAVAILABLE — api: [' + apiErrors.join(' | ') + '] ; dom: no credit element found'
    );
  }

  function pickCredits(data) {
    if (!data || typeof data !== 'object') return undefined;
    if (typeof data.total_credits_left === 'number') return data.total_credits_left;
    if (typeof data.credits_left === 'number') return data.credits_left;
    if (typeof data.credits === 'number') return data.credits;
    if (typeof data.balance === 'number') return data.balance;
    if (typeof data.monthly_limit === 'number' && typeof data.monthly_usage === 'number') {
      return data.monthly_limit - data.monthly_usage;
    }
    return undefined;
  }

  // Best-effort DOM scrape: look at any element whose text or aria-label
  // contains "credit" and extract the first integer found in/near it. Suno's
  // sidebar shows the credit count next to the user avatar.
  function scrapeCreditsFromDom() {
    const candidates = Array.from(
      document.querySelectorAll('[aria-label*="credit" i], [class*="credit" i], [data-testid*="credit" i]')
    );
    for (const el of candidates) {
      const text = `${el.getAttribute('aria-label') || ''} ${el.textContent || ''}`;
      const m = text.match(/(\d[\d,]*)/);
      if (m) {
        const n = Number(m[1].replace(/,/g, ''));
        if (Number.isFinite(n)) return n;
      }
    }
    return undefined;
  }
  async function submit(_payload) {
    throw new Error('STUB — wire submit to suno.com generate endpoint');
  }
  async function poll(_payload) {
    throw new Error('STUB — wire poll to suno.com feed endpoint');
  }
  async function download(_payload) {
    throw new Error('STUB — wire download to fetch audio_url + base64 the body');
  }
})();
