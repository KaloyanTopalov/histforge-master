// YouForge Flow - Background Service Worker
// Thin bootstrapper for a service worker whose actual logic lives in the
// modules imported below. Load order is leaves-first (constants before
// anything that reads them, settings before anything that reads config,
// webhook before auth which calls clearSessionExpiredReport). Forward
// references across modules resolve at call time, not parse time — see
// docs/plans/2026-04-21-youforge-flow-audit-modularize.md §3.17.

importScripts('src/logger.js');
importScripts('src/constants.js');
importScripts('src/stop-flag.js');
importScripts('src/settings.js');
importScripts('src/state.js');
importScripts('src/stats.js');
importScripts('src/webhook.js');
importScripts('src/host-permission.js');
importScripts('src/control-panel.js');
importScripts('src/auth.js');
importScripts('src/account-tier.js');
importScripts('src/page-call.js');
importScripts('flow-api.js');
importScripts('src/poll-video.js');
importScripts('src/client-context.js');
importScripts('src/executors/shared.js');
importScripts('src/executors/text-to-video.js');
importScripts('src/executors/image-to-video.js');
importScripts('src/executors/frames-to-video.js');
importScripts('src/executors/image.js');
importScripts('src/executors/upscale.js');
importScripts('src/executors/index.js');
importScripts('src/media-fetch.js');
importScripts('src/handlers.js');
importScripts('src/credits-poller.js');
importScripts('src/runner.js');
importScripts('src/session-guard.js');
importScripts('src/status.js');
importScripts('src/messages.js');

chrome.runtime.onInstalled.addListener(async () => {
  safeLog('Extension installed / upgraded');

  // Remove upstream-era keys so a profile that previously ran the VEO
  // upstream gets a clean slate. `processedJobIds` is deliberately NOT in
  // this list: it's the defensive dedup ring the live code writes, and
  // HistForge's reaper covers the redispatch case if we lose it anyway.
  // Our own keys (pollUrl/resultUrl/statusUrl/accountToken/concurrency/
  // grantedOrigin) also stay intact.
  await chrome.storage.local.remove([
    'manualModeState',
    'jobQueue',
    'currentJobId',
    'currentTask',
    'waitingForReload',
    'dismissedVersion',
    'pendingRetryTask',
  ]);

  await chrome.storage.local.set({
    isEnabled: false,
    lastPoll: null,
    stats: { processed: 0, failed: 0, retries: 0 },
    generationMode: 'image',
  });
});

// Both listener and direct call are intentional: the listener fires on
// MV3 service-worker wake; the direct call covers cold-load when
// onStartup doesn't fire (extension install / manual reload).
chrome.runtime.onStartup.addListener(loadSettings);
chrome.runtime.onStartup.addListener(loadState);
loadSettings();
loadState();
