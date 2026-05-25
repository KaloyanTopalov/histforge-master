// Magnific HITL - content-script readiness handshake
// Shared SW-side primitive used by executors that dispatch a message to
// a freshly-opened Magnific tab. On freshly-created tabs, chrome.tabs.create
// resolves before the content script's onMessage listener registers — a
// `magnificFillAndGenerate` / `magnificStartImageToVideo` sent at that
// moment is dropped silently with "Could not establish connection. Receiving
// end does not exist." This module polls the content script with a `ping`
// action and waits for {ready:true} before the executor dispatches its real
// action. Defaults are overridable via the sandbox globals
// MAGNIFIC_PING_INTERVAL_MS / MAGNIFIC_PING_TIMEOUT_MS so tests can run the
// timeout path without burning 10s of wall time.
//
// Runtime deps (resolved at call time): chrome.tabs.sendMessage.

const PING_INTERVAL_MS =
  typeof MAGNIFIC_PING_INTERVAL_MS !== 'undefined' ? MAGNIFIC_PING_INTERVAL_MS : 200;
const PING_TIMEOUT_MS =
  typeof MAGNIFIC_PING_TIMEOUT_MS !== 'undefined' ? MAGNIFIC_PING_TIMEOUT_MS : 10_000;

async function waitForContentScriptReady(tabId) {
  const start = Date.now();
  while (Date.now() - start < PING_TIMEOUT_MS) {
    try {
      const resp = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
      if (resp && resp.ready === true) return;
    } catch (_e) {
      // Either the listener isn't registered yet ("Receiving end does not
      // exist") or the page hasn't finished navigating. Either way, keep
      // polling — production tabs become ready within a second or two.
    }
    await new Promise((r) => setTimeout(r, PING_INTERVAL_MS));
  }
  throw new Error(
    `magnific-ext: content script in tab ${tabId} did not become ready within ${PING_TIMEOUT_MS}ms`
  );
}
