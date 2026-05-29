// Magnific HITL — Background Service Worker
// Thin bootstrapper. Real logic lives in src/* modules loaded in
// leaves-first dependency order via importScripts. Forward references
// across modules resolve at call time, not parse time, so a forward-ref
// (e.g. host-permission.js referencing stopPolling from runner.js) is
// fine as long as the call site fires after the chain has completed.

importScripts('src/logger.js');
importScripts('src/http.js');
importScripts('src/constants.js');
importScripts('src/stop-flag.js');
importScripts('src/settings-schema.js');
importScripts('src/settings.js');
importScripts('src/state.js');
importScripts('src/host-permission.js');
importScripts('src/runner.js');
importScripts('src/executors/content-script-handshake.js');
importScripts('src/executors/image-hitl.js');
importScripts('src/executors/image-to-video.js');
importScripts('src/executors/image-batch.js');
importScripts('src/executors/index.js');
importScripts('src/status.js');
importScripts('src/messages.js');

chrome.runtime.onInstalled.addListener(async () => {
  safeLog('Extension installed / upgraded');
  // Seed runtime state. Settings are seeded by SETTINGS_SCHEMA defaults
  // on first load; we only zero out the runtime-state slice here.
  await chrome.storage.local.set({
    isEnabled: false,
    lastPoll: null,
  });
});

// Both listener and direct call are intentional: the listener fires on
// MV3 service-worker wake; the direct call covers cold-load when
// onStartup doesn't fire (extension install / manual reload). Mirrors
// the youforge-flow bootstrap.
chrome.runtime.onStartup.addListener(loadSettings);
chrome.runtime.onStartup.addListener(loadState);
loadSettings();
loadState();
