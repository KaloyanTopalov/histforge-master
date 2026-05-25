// YouForge Flow - settings module
// Owns all user-configurable state sourced from chrome.storage.local:
// the three HistForge webhooks, the account token, the desired generation
// mode, the concurrency limit, and the six per-task executor settings
// (output count, aspect ratio, image/video model choices, image/video
// upscale). Other modules read via getters and mutate via the named
// update helpers (updateWebhooks, updateConcurrency, setMode,
// updateExecutorSettings); loadSettings is also invoked on
// chrome.runtime.onStartup and at cold bootstrap (MV3 lifecycle).

// Webhook URLs — sourced from chrome.storage.local at load time. No defaults:
// the popup blocks Start until the user pastes in HistForge-minted URLs.
let POLL_URL = '';
let RESULT_URL = '';
let STATUS_URL = '';
// Per-instance account identifier that HistForge mints. Included in every
// outbound body; the token is also present in the URL path (belt + braces).
let ACCOUNT_TOKEN = '';

// Parallel processing (per-instance setting, sourced from chrome.storage.local)
let MAX_CONCURRENT = 5;
let currentMode = 'image'; // Default mode: image-to-video

// Per-task executor settings. Defaults match what executors/index.js
// used to substitute when the storage read returned undefined — the
// getters are cache-backed so the per-task storage round-trip goes away.
let outputCount = 1;
let aspectRatio = 'landscape';
let imageModel = 'NARWHAL';
let videoModel = 'fast';
let imgUpscale = 'none';
let vidUpscale = 'none';

// Memoize the load so concurrent callers share one storage round-trip and
// late consumers (e.g. getStatus from the popup during MV3 wake) can
// `await loadSettings()` to guarantee the cache is populated before they
// read.
let loadPromise = null;
function loadSettings() {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const settings = await chrome.storage.local.get([
        'pollUrl', 'resultUrl', 'statusUrl', 'accountToken',
        'generationMode', 'concurrency',
        'outputCount', 'aspectRatio', 'imageModel', 'videoModel',
        'imgUpscale', 'vidUpscale',
      ]);
      if (settings.pollUrl) POLL_URL = settings.pollUrl;
      if (settings.resultUrl) RESULT_URL = settings.resultUrl;
      if (settings.statusUrl) STATUS_URL = settings.statusUrl;
      if (settings.accountToken) ACCOUNT_TOKEN = settings.accountToken;
      if (settings.generationMode) currentMode = settings.generationMode;
      if (Number.isFinite(settings.concurrency)) {
        MAX_CONCURRENT = Math.max(
          1,
          Math.min(MAX_CONCURRENT_MAX, Math.floor(settings.concurrency)),
        );
      }
      if (settings.outputCount) outputCount = settings.outputCount;
      if (settings.aspectRatio) aspectRatio = settings.aspectRatio;
      if (settings.imageModel) imageModel = settings.imageModel;
      if (settings.videoModel) videoModel = settings.videoModel;
      if (settings.imgUpscale) imgUpscale = settings.imgUpscale;
      if (settings.vidUpscale) vidUpscale = settings.vidUpscale;
      safeLog('Settings loaded - Mode:', currentMode, 'Poll:', POLL_URL, 'Concurrency:', MAX_CONCURRENT);
    } catch (e) {
      safeLog('Failed to load settings:', e);
    }
  })();
  return loadPromise;
}

function updateWebhooks(message) {
  POLL_URL = message.pollUrl || '';
  RESULT_URL = message.resultUrl || '';
  STATUS_URL = message.statusUrl || '';
  if (typeof message.accountToken === 'string') ACCOUNT_TOKEN = message.accountToken;
  safeLog('Webhook URLs updated - Poll:', POLL_URL, 'Result:', RESULT_URL, 'Status:', STATUS_URL);
}

function updateConcurrency(value) {
  const n = Math.max(
    1,
    Math.min(MAX_CONCURRENT_MAX, Math.floor(Number(value) || 5)),
  );
  MAX_CONCURRENT = n;
  safeLog('Concurrency updated:', MAX_CONCURRENT);
}

function setMode(mode) {
  currentMode = mode;
  safeLog('Generation mode set to:', currentMode);
}

// Refresh the executor-settings cache from a popup / message-router
// payload. Mirrors updateWebhooks / updateConcurrency / setMode — the
// router is not yet wired to call this today; the load-at-bootstrap
// path (loadSettings) is sufficient for the HistForge-driven write
// flow. Provided so future popup UI for these six keys has a cache
// refresh entry point.
function updateExecutorSettings(message) {
  if (message.outputCount !== undefined) outputCount = message.outputCount;
  if (message.aspectRatio !== undefined) aspectRatio = message.aspectRatio;
  if (message.imageModel !== undefined) imageModel = message.imageModel;
  if (message.videoModel !== undefined) videoModel = message.videoModel;
  if (message.imgUpscale !== undefined) imgUpscale = message.imgUpscale;
  if (message.vidUpscale !== undefined) vidUpscale = message.vidUpscale;
  safeLog('Executor settings updated - outputCount:', outputCount,
    'aspect:', aspectRatio, 'image:', imageModel, 'video:', videoModel,
    'imgUpscale:', imgUpscale, 'vidUpscale:', vidUpscale);
}

function getPollUrl() { return POLL_URL; }
function getResultUrl() { return RESULT_URL; }
function getStatusUrl() { return STATUS_URL; }
function getAccountToken() { return ACCOUNT_TOKEN; }
function getMaxConcurrent() { return MAX_CONCURRENT; }
function getCurrentMode() { return currentMode; }
function getOutputCount() { return outputCount; }
function getAspectRatio() { return aspectRatio; }
function getImageModel() { return imageModel; }
function getVideoModel() { return videoModel; }
function getImgUpscale() { return imgUpscale; }
function getVidUpscale() { return vidUpscale; }
