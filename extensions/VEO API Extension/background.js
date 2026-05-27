// VEO Flow API - Background Service Worker v13.0.0
// Combined: Automated Mode (FIFO) + Manual Mode (Baserow)
// API-based: Direct API calls instead of UI clicking

importScripts('flow-api.js');

// Update server URL for auto-update notifications
const UPDATE_SERVER = 'http://78.46.146.79:8090';

// Default webhook URLs (can be overridden by user settings)
let POLL_URL = 'https://n8n.n8nsamerjonas.de/webhook/Veo-polling';
let RESULT_URL = 'https://n8n.n8nsamerjonas.de/webhook/Veo-polling';

const FLOW_URL = 'https://labs.google/fx/de/tools/flow';
const POLL_INTERVAL_MINUTES = 0.1667; // 10 seconds (faster for continuous mode)
const MAX_RETRIES = 3; // Maximum retry attempts for failed tasks
const BASEROW_API_DEFAULT = 'https://api.baserow.io/api';

// Resolve Baserow API base from a user-provided URL. Empty/missing string falls back
// to the cloud default. Strips a trailing slash and an optional `/api` so users can
// paste either `https://baserow.example.com` or `https://baserow.example.com/api`.
function resolveBaserowApi(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string' || !baseUrl.trim()) return BASEROW_API_DEFAULT;
  let u = baseUrl.trim().replace(/\/+$/, '');
  if (!/\/api$/.test(u)) u += '/api';
  return u;
}

let isProcessing = false;
let controlPanelWindowId = null;
let currentMode = 'image'; // Default mode: image-to-video

// GLOBAL STOP FLAG - prevents new tasks from being sent
let globalStopFlag = false;

// Parallel processing
const MAX_CONCURRENT = 5;
let activeTaskCount = 0;
let tasksInFlight = 0; // Tracks tasks still running (including upscale) - used for RetryFailed gating
// Legacy alias
let contentScriptBusy = false; // kept for compatibility checks

// RACE CONDITION FIX: Track if a poll is currently in progress
// This prevents concurrent polls from alarm + requestNextTask
let pollingInProgress = false;

// RACE CONDITION FIX: Track if manual mode task sending is in progress
let manualTaskSendInProgress = false;

// ============================================
// MANUAL MODE STATE (persisted to chrome.storage)
// ============================================
let manualModeActive = false;
let manualModeTasks = [];
let manualModeNextIndex = 0;
let manualModeToken = null;
let manualModeTableId = null;
let manualModeBaseUrl = '';  // empty = cloud (api.baserow.io); non-empty = self-hosted
let manualModeCompletedCount = 0;
let manualModeFailedCount = 0;
let manualModeProcessedRowIds = new Set();

// ============================================
// MANUAL MODE PERSISTENCE FUNCTIONS
// ============================================
async function saveManualModeState() {
  const state = {
    manualModeActive,
    manualModeTasks,
    manualModeNextIndex,
    manualModeToken,
    manualModeTableId,
    manualModeBaseUrl,
    manualModeCompletedCount,
    manualModeFailedCount,
    manualModeProcessedRowIds: Array.from(manualModeProcessedRowIds)
  };
  await chrome.storage.local.set({ manualModeState: state });
  console.log('[VEO Manual] State saved - active:', manualModeActive, 'index:', manualModeNextIndex);
}

async function restoreManualModeState() {
  const result = await chrome.storage.local.get('manualModeState');
  const state = result.manualModeState;

  if (state && state.manualModeActive) {
    const tasks = state.manualModeTasks || [];
    const index = state.manualModeNextIndex || 0;

    // Check if state is stale (all tasks already processed)
    if (index >= tasks.length) {
      console.log('[VEO Manual] State is stale (index >= tasks) - clearing instead of restoring');
      await clearManualModeState();
      return false;
    }

    manualModeActive = state.manualModeActive;
    manualModeTasks = tasks;
    manualModeNextIndex = index;
    manualModeToken = state.manualModeToken;
    manualModeTableId = state.manualModeTableId;
    manualModeBaseUrl = state.manualModeBaseUrl || '';
    manualModeCompletedCount = state.manualModeCompletedCount || 0;
    manualModeFailedCount = state.manualModeFailedCount || 0;
    manualModeProcessedRowIds = new Set(state.manualModeProcessedRowIds || []);
    console.log('[VEO Manual] State restored - active:', manualModeActive, 'tasks:', manualModeTasks.length, 'index:', manualModeNextIndex);
    return true;
  }
  return false;
}

async function clearManualModeState() {
  await chrome.storage.local.remove('manualModeState');
  console.log('[VEO Manual] State cleared');
}

// ============================================
// INITIALIZATION
// ============================================

chrome.runtime.onInstalled.addListener(async () => {
  console.log('[VEO] Extension installed');
  await chrome.storage.local.set({
    isEnabled: false,
    currentTask: null,
    lastPoll: null,
    stats: { processed: 0, failed: 0 },
    jobQueue: [],
    processedJobIds: [],
    currentJobId: null,
    generationMode: 'image',
    pollUrl: POLL_URL,
    resultUrl: RESULT_URL,
    dismissedVersion: null
  });
});

// Load settings on startup
chrome.runtime.onStartup.addListener(loadSettings);
loadSettings(); // Also load immediately

async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get(['pollUrl', 'resultUrl', 'generationMode']);
    if (settings.pollUrl) POLL_URL = settings.pollUrl;
    if (settings.resultUrl) RESULT_URL = settings.resultUrl;
    if (settings.generationMode) currentMode = settings.generationMode;
    console.log('[VEO] Settings loaded - Mode:', currentMode, 'Poll:', POLL_URL);

    // Restore Manual Mode state if it was active
    const restored = await restoreManualModeState();
    if (restored) {
      console.log('[VEO] Manual Mode state restored from storage');
    }
  } catch (e) {
    console.error('[VEO] Failed to load settings:', e);
  }
}

// ============================================
// CONTROL PANEL WINDOW
// ============================================

chrome.action.onClicked.addListener(async () => {
  await openControlPanel();
});

async function openControlPanel() {
  if (controlPanelWindowId !== null) {
    try {
      const window = await chrome.windows.get(controlPanelWindowId);
      await chrome.windows.update(controlPanelWindowId, { focused: true });
      return;
    } catch (e) {
      controlPanelWindowId = null;
    }
  }

  const window = await chrome.windows.create({
    url: chrome.runtime.getURL('popup.html'),
    type: 'popup',
    width: 360,
    height: 620,
    top: 100,
    left: 100
  });

  controlPanelWindowId = window.id;

  chrome.windows.onRemoved.addListener(function listener(windowId) {
    if (windowId === controlPanelWindowId) {
      controlPanelWindowId = null;
      chrome.windows.onRemoved.removeListener(listener);
    }
  });
}

// ============================================
// MESSAGE HANDLING
// ============================================

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[VEO] Background received message:', message.action);

  switch (message.action) {
    case 'startPolling':
      startPolling();
      sendResponse({ success: true });
      break;

    case 'stopPolling':
      stopPolling();
      sendResponse({ success: true });
      break;

    case 'stopAllProcessing':
      // Stop EVERYTHING - polling, queues, content script, BOTH modes
      console.log('[VEO] ⛔ STOPPING ALL PROCESSING (Automated + Manual)');
      globalStopFlag = true;  // CRITICAL: Set stop flag FIRST
      stopPolling();
      contentScriptBusy = false;
      activeTaskCount = 0;  // Reset parallel task counter
      tasksInFlight = 0;  // Reset in-flight counter
      retryFailedSent = false;  // Reset retry flag
      retryFailedCycles = 0;  // Reset retry cycle counter
      permanentlyFailedTasks = [];  // Reset failed tasks tracker
      cachedAccountTier = null;  // Reset account tier cache
      pollingInProgress = false;  // Release polling lock

      // ALSO stop Manual Mode
      manualModeActive = false;
      manualModeTasks = [];
      manualModeNextIndex = 0;
      clearManualModeState();

      // Tell content script to stop IMMEDIATELY
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
          for (const tab of tabs) {
            try {
              await chrome.tabs.sendMessage(tab.id, { action: 'stopProcessing' });
              console.log(`[VEO] Sent stop signal to tab ${tab.id}`);
            } catch (e) {
              // Tab might not have content script
            }
          }
        } catch (e) {
          console.error('[VEO] Error stopping tabs:', e);
        }
      })();

      sendResponse({ success: true });
      break;

    case 'getStatus':
      getStatus().then(sendResponse);
      return true;

    case 'taskCompleted':
      console.log('[VEO] ✓ taskCompleted - manualMode:', manualModeActive);
      if (manualModeActive) {
        handleManualTaskComplete(message.data.taskId, message.data.resultUrl);
      } else {
        handleTaskCompletedFIFO(message.data);
      }
      sendResponse({ success: true });
      break;

    // Handler for generated images detected by MutationObserver (Create Image mode)
    case 'videoFound':
      console.log('[VEO] ✓ videoFound (generated image) - manualMode:', manualModeActive);
      // Convert videoFound data format to taskCompleted format
      const imageData = {
        taskId: message.data.task?.id,
        resultUrl: message.data.videoUrl,
        isGeneratedImage: message.data.isGeneratedImage
      };
      if (manualModeActive) {
        handleManualTaskComplete(imageData.taskId, imageData.resultUrl);
      } else {
        handleTaskCompletedFIFO(imageData);
      }
      sendResponse({ success: true });
      break;

    case 'taskFailed':
      console.log('[VEO] ✗ taskFailed - manualMode:', manualModeActive);
      if (manualModeActive) {
        handleManualTaskFailed(message.data.task?.id, message.data.error);
      } else {
        handleTaskFailedFIFO(message.data);
      }
      sendResponse({ success: true });
      break;
      
    // v9.0.2: Content script auto-stopped after 3 consecutive errors
    case 'autoStopped':
      console.log(`[VEO] ❌ AUTO-STOPPED: ${message.data.reason}`);
      console.log(`[VEO] Last error: ${message.data.lastError}`);
      globalStopFlag = true;
      stopPolling();
      contentScriptBusy = false;
      activeTaskCount = 0;
      tasksInFlight = 0;
      sendResponse({ success: true });
      break;

    // Task will be retried locally in content script
    case 'taskRetrying':
      console.log(`[VEO FIFO] Task ${message.data.taskId} retrying (attempt ${message.data.attempt}/3)`);
      console.log(`[VEO FIFO] Error was: ${message.data.error}`);
      // Don't reset contentScriptBusy - content script continues!
      // Just update stats
      (async () => {
        const { stats } = await chrome.storage.local.get('stats');
        await chrome.storage.local.set({
          stats: {
            ...stats,
            retries: (stats?.retries || 0) + 1
          }
        });
      })();
      sendResponse({ success: true });
      break;

    case 'manualPoll':
      // Manual poll resets stop flag
      globalStopFlag = false;
      pollForTasksFIFO().then(sendResponse);
      return true;
      
    // Content script requests next task (after clicking Erstellen)
    case 'requestNextTask':
      console.log('[VEO FIFO] Content finished entering task, ready for next');
      contentScriptBusy = false;  // Previous task done entering

      // IMPORTANT: Check Manual Mode FIRST - it should work regardless of globalStopFlag
      if (manualModeActive) {
        console.log('[VEO FIFO] Manual mode active, sending next manual task');
        handleRequestNextManualTask().then(sendResponse);
        return true;
      }

      // CHECK STOP FLAG - only for automated mode
      if (globalStopFlag) {
        console.log('[VEO FIFO] ⛔ STOPPED - not polling for next task');
        sendResponse({ stopped: true });
        return true;
      }

      pollForTasksFIFO().then(sendResponse);
      return true;

    case 'clearJobHistory':
      clearJobHistory().then(sendResponse);
      return true;

    case 'openControlPanel':
      openControlPanel();
      sendResponse({ success: true });
      break;

    case 'clickElement':
      clickElementInPage(sender.tab.id, message.searchText).then(sendResponse);
      return true;

    case 'fetchImage':
      fetchImageAsBase64(message.imageUrl).then(sendResponse);
      return true;

    case 'debugLog':
      if (message.data) {
        console.log('[CONTENT]', message.message, message.data);
      } else {
        console.log('[CONTENT]', message.message);
      }
      break;

    // Content script signals it's ready for task
    case 'contentReady':
      handleContentReady(sender.tab.id).then(sendResponse);
      return true;

    // Update webhook URLs
    case 'updateWebhooks':
      POLL_URL = message.pollUrl;
      RESULT_URL = message.resultUrl;
      console.log('[VEO] Webhook URLs updated - Poll:', POLL_URL, 'Result:', RESULT_URL);
      sendResponse({ success: true });
      break;

    // Set generation mode
    case 'setMode':
      currentMode = message.mode;
      console.log('[VEO] Generation mode set to:', currentMode);
      sendResponse({ success: true });
      break;

    // ========== BASEROW / MANUAL MODE ==========
    case 'baserowConnect':
      (async () => {
        try {
          const result = await baserowConnect(message.token, message.tableId, message.baseUrl);
          console.log('[VEO] baserowConnect result:', result);
          sendResponse(result);
        } catch (e) {
          console.error('[VEO] baserowConnect error:', e);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'baserowFetchTasks':
      (async () => {
        try {
          const result = await baserowFetchTasks(message.token, message.tableId, message.baseUrl);
          sendResponse(result);
        } catch (e) {
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'baserowUpdateRow':
      baserowUpdateRow(message.token, message.tableId, message.rowId, message.data, message.baseUrl).then(sendResponse);
      return true;

    case 'startManualMode':
      startManualMode(message.token, message.tableId, message.tasks, message.baseUrl).then(sendResponse);
      return true;

    case 'stopManualMode':
      console.log('[VEO Manual] ⛔ STOPPING manual mode IMMEDIATELY');
      manualModeActive = false;
      manualModeTasks = [];
      manualModeNextIndex = 0;
      manualModeCompletedCount = 0;
      manualModeFailedCount = 0;
      contentScriptBusy = false;
      clearManualModeState();

      // CRITICAL: Also tell content script to STOP immediately!
      (async () => {
        try {
          const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
          for (const tab of tabs) {
            try {
              await chrome.tabs.sendMessage(tab.id, { action: 'stopProcessing' });
              console.log(`[VEO Manual] Sent stop signal to tab ${tab.id}`);
            } catch (e) {
              // Tab might not have content script
            }
          }
        } catch (e) {
          console.error('[VEO Manual] Error stopping tabs:', e);
        }
      })();

      sendResponse({ success: true });
      break;

    case 'getManualModeStatus':
      sendResponse({
        active: manualModeActive,
        totalTasks: manualModeTasks.length,
        nextIndex: manualModeNextIndex,
        completed: manualModeCompletedCount,
        failed: manualModeFailedCount,
        pending: manualModeTasks.length - manualModeCompletedCount - manualModeFailedCount
      });
      break;
  }
});

// Handle when content script signals it's ready
async function handleContentReady(tabId) {
  console.log('[VEO FIFO] Content script ready on tab', tabId);

  // Reset busy flag - page just loaded
  contentScriptBusy = false;

  // Clear any old flags
  await chrome.storage.local.set({
    waitingForReload: false,
    currentTask: null,
    currentJobId: null
  });

  // Check if automated mode (polling) is enabled
  const { isEnabled } = await chrome.storage.local.get('isEnabled');

  // Only restore Manual Mode if automated mode is NOT active
  // This prevents mixing automated and manual tasks
  if (!manualModeActive && !isEnabled) {
    const restored = await restoreManualModeState();
    if (restored) {
      console.log('[VEO] Manual mode state restored from storage');
    }
  } else if (isEnabled) {
    console.log('[VEO FIFO] Automated mode is enabled, not restoring manual mode');
  }

  // If manual mode is active and we have more tasks to send, fill slots
  if (manualModeActive && manualModeNextIndex < manualModeTasks.length) {
    console.log('[VEO] Manual mode active after page reload, continuing from task', manualModeNextIndex + 1, '/', manualModeTasks.length);
    activeTaskCount = 0; // Reset after reload
    setTimeout(async () => {
      await fillManualTaskSlots(tabId);
    }, 2000);
  } else if (manualModeActive) {
    console.log('[VEO] Manual mode active but all tasks already sent, waiting for completions...');
  }

  // In FIFO mode, just signal ready - polling will send tasks
  return { hasTask: false, manualMode: manualModeActive };
}

// Fetch image and return as base64 (bypasses CORS)
async function fetchImageAsBase64(imageUrl) {
  try {
    console.log('[VEO] Background fetching image:', imageUrl);
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();

    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => {
        console.log('[VEO] Image fetched successfully, size:', blob.size);
        resolve({
          success: true,
          base64: reader.result,
          type: blob.type,
          size: blob.size
        });
      };
      reader.onerror = () => {
        console.error('[VEO] FileReader error');
        resolve({ success: false, error: 'FileReader error' });
      };
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('[VEO] Background fetch error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// API AUTH HELPERS (communicate with content-bridge.js)
// ============================================

// Cache for auth tokens (short-lived)
let cachedRecaptchaToken = null;
let cachedRecaptchaTime = 0;
let cachedSessionToken = null;
let cachedSessionTime = 0;
let cachedProjectId = null;
let cachedAccountTier = null; // 'ultra', 'pro', or null (auto-detected from credits API)

async function getFlowTabId() {
  const tabs = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
  if (tabs.length === 0) return null;
  return tabs[0].id;
}

async function getRecaptchaTokenFromPage(tabId, recaptchaAction) {
  if (globalStopFlag) throw new Error('STOP_REQUESTED');
  console.log('[VEO API] Requesting reCAPTCHA token, action:', recaptchaAction);
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getRecaptchaToken', recaptchaAction });
    if (response && response.token) {
      console.log('[VEO API] Got reCAPTCHA token:', response.token.substring(0, 30) + '...');
      return response.token;
    }
    console.error('[VEO API] No reCAPTCHA token in response:', response);
    return null;
  } catch (e) {
    console.error('[VEO API] Failed to get reCAPTCHA token:', e.message);
    return null;
  }
}

async function getSessionTokenFromPage(tabId) {
  // Session tokens last longer, cache for 5 minutes
  const now = Date.now();
  if (cachedSessionToken && (now - cachedSessionTime) < 5 * 60 * 1000) {
    console.log('[VEO API] Using cached session token');
    return cachedSessionToken;
  }

  console.log('[VEO API] Requesting session token from page...');
  try {
    const response = await chrome.tabs.sendMessage(tabId, { action: 'getSessionToken' });
    const token = response?.session?.accessToken || response?.token;
    if (token) {
      cachedSessionToken = token;
      cachedSessionTime = now;
      console.log('[VEO API] Got session token:', token.substring(0, 30) + '...');
      return token;
    }
    console.error('[VEO API] No session token in response:', response);
    return null;
  } catch (e) {
    console.error('[VEO API] Failed to get session token:', e.message);
    return null;
  }
}

async function getProjectIdCached(tabId) {
  if (cachedProjectId) return cachedProjectId;

  console.log('[VEO API] Getting project ID...');

  // Method 1: Extract from tab URL (e.g. /flow/project/PROJECT_ID)
  try {
    const tab = await chrome.tabs.get(tabId);
    const urlMatch = tab.url?.match(/\/flow\/project\/([a-f0-9-]+)/i);
    if (urlMatch) {
      cachedProjectId = urlMatch[1];
      console.log('[VEO API] Got project ID from URL:', cachedProjectId);
      return cachedProjectId;
    }
    console.log('[VEO API] No project ID in URL:', tab.url);
  } catch (e) {
    console.log('[VEO API] Could not get tab URL:', e.message);
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
    console.log('[VEO API] trpc result:', JSON.stringify(scriptResult)?.substring(0, 500));

    if (scriptResult?.data) {
      const projects = scriptResult.data?.result?.data?.json?.projects || [];
      if (projects.length > 0) {
        cachedProjectId = projects[0].projectId;
        console.log('[VEO API] Got project ID from trpc:', cachedProjectId);
        return cachedProjectId;
      }
      console.log('[VEO API] No projects in trpc response');
    } else {
      console.error('[VEO API] trpc error:', scriptResult?.error);
    }
  } catch (e) {
    console.error('[VEO API] executeScript failed:', e.message);
  }

  // Method 3: Try __NEXT_DATA__
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: () => {
        try {
          const nd = window.__NEXT_DATA__;
          if (nd) return { found: true, props: JSON.stringify(nd.props?.pageProps || {}).substring(0, 500) };
        } catch (e) {}
        return { found: false };
      }
    });
    console.log('[VEO API] __NEXT_DATA__:', JSON.stringify(results?.[0]?.result));
  } catch (e) {}

  console.error('[VEO API] All methods to get project ID failed');
  return null;
}

// ============================================
// ACCOUNT TIER DETECTION (Pro vs Ultra)
// ============================================

async function detectAccountTier(tabId) {
  if (cachedAccountTier) return cachedAccountTier;

  // Method 1: Use session token + credits API with Bearer auth
  try {
    const sessionToken = cachedSessionToken || await getSessionTokenFromPage(tabId);
    if (sessionToken) {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (bearer) => {
          try {
            const resp = await fetch('https://aisandbox-pa.googleapis.com/v1/credits?key=AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY', {
              headers: { 'authorization': 'Bearer ' + bearer }
            });
            const text = await resp.text();
            if (!resp.ok) return { error: 'HTTP ' + resp.status };
            return { data: JSON.parse(text) };
          } catch (e) {
            return { error: e.message };
          }
        },
        args: [sessionToken]
      });
      const result = results?.[0]?.result;
      if (result?.data?.userPaygateTier) {
        const credits = result.data;
        // v13: Use both SKU + paygate tier for robust detection.
        // Confirmed from tracker recon (2026-05-03):
        //   Ultra: sku=WS_ULTRA, userPaygateTier=PAYGATE_TIER_TWO, serviceTier=SERVICE_TIER_ADVANCED
        //   Pro:   sku=G1_TIER1, userPaygateTier=PAYGATE_TIER_ONE, serviceTier=SERVICE_TIER_INTERMEDIATE
        if (credits.sku === 'WS_ULTRA' || credits.userPaygateTier === 'PAYGATE_TIER_TWO') {
          cachedAccountTier = 'ultra';
        } else {
          cachedAccountTier = 'pro';
        }
        console.log(`[VEO API] Account tier detected: ${cachedAccountTier} (${credits.userPaygateTier}, sku=${credits.sku}, ${credits.credits} credits)`);
        chrome.storage.local.set({
          accountTier: cachedAccountTier,
          accountSku: credits.sku || null,
          accountCredits: credits.credits || 0
        });
        return cachedAccountTier;
      }
      if (result?.error) {
        console.error('[VEO API] Credits API error:', result.error);
      }
    }
  } catch (e) {
    console.error('[VEO API] Failed to detect account tier:', e.message);
  }

  // Default to ultra if detection fails
  cachedAccountTier = 'ultra';
  console.log('[VEO API] Account tier detection failed, defaulting to ultra');
  return cachedAccountTier;
}

// Cache: uploaded mediaId → source image dimensions (set during upload, read during
// video-gen to compute proper cropCoordinates).
const uploadedImageDims = new Map();

// Cache: `${projectId}:${imageUrl}` → Promise<mediaId>. Lets multiple tasks reuse the
// same uploaded mediaId instead of re-uploading the same source image. Stores promises
// (not values) so concurrent callers for the same URL deduplicate to one network upload.
// Cleared on service-worker restart (Map lives in SW memory only).
const uploadedImageCache = new Map();

// Compute cropCoordinates that center-crop a source image to the target video aspect.
// Webapp HAR shows Google rejects (code 13 NOT_FOUND) when crop region's aspect doesn't
// match the requested video aspect. Returns full image if dims unknown or already match.
function computeCropForVideo(mediaId, isPortrait) {
  const dims = uploadedImageDims.get(mediaId);
  const fullCrop = { top: 0, left: 0, bottom: 1, right: 1 };
  if (!dims || !dims.w || !dims.h) return fullCrop;
  const srcAspect = dims.w / dims.h;
  const targetAspect = isPortrait ? 9 / 16 : 16 / 9;
  if (Math.abs(srcAspect - targetAspect) < 0.01) return fullCrop;
  if (srcAspect > targetAspect) {
    // source is wider → crop left/right
    const ratio = (dims.h * targetAspect) / dims.w;
    const margin = (1 - ratio) / 2;
    return { top: 0, left: margin, bottom: 1, right: 1 - margin };
  } else {
    // source is taller → crop top/bottom
    const ratio = (dims.w / targetAspect) / dims.h;
    const margin = (1 - ratio) / 2;
    return { top: margin, left: 0, bottom: 1 - margin, right: 1 };
  }
}

// Get model keys based on account tier + user quality setting
// v13: Map UI image-aspect-ratio value (e.g. '16:9') to Google API enum.
// Falls back to legacy `aspectRatio` storage key if `imageAspectRatio` isn't set yet
// (so users upgrading from v12 don't lose their landscape/portrait preference).
function imageAspectToEnum(imageAspect, legacyAspect) {
  // Prefer the new key if it's a recognized 5-value choice
  switch ((imageAspect || '').toLowerCase()) {
    case '16:9':
    case 'landscape':
      return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    case '4:3':
      return 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE';
    case '1:1':
    case 'square':
      return 'IMAGE_ASPECT_RATIO_SQUARE';
    case '3:4':
      return 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR';
    case '9:16':
    case 'portrait':
      return 'IMAGE_ASPECT_RATIO_PORTRAIT';
  }
  // Legacy fallback (v12 only had landscape/portrait)
  return legacyAspect === 'portrait' ? 'IMAGE_ASPECT_RATIO_PORTRAIT' : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}

// v13: Updated model keys based on Ultra+Pro tracker recon (2026-05-03)
// Ultra: keys end with _ultra. Pro: no _ultra suffix. Lite: same in both tiers.
// Frames duration baked into key as _4s/_6s (8s = no suffix). Pro Frames doesn't expose duration.
function getVideoModelKeys(accountTier, qualitySetting, aspectRatio) {
  const isPortrait = aspectRatio === 'portrait';
  const paygate = accountTier === 'pro' ? 'PAYGATE_TIER_ONE' : 'PAYGATE_TIER_TWO';

  // VEO Lite — same keys for all account tiers, no duration setting (always 8s)
  if (qualitySetting === 'lite') {
    return {
      t2v: 'veo_3_1_t2v_lite',
      r2v: 'veo_3_1_r2v_lite',
      // StartImage endpoint requires the i2v key (not r2v) — confirmed via
      // labs.google webapp HAR. r2v_lite + StartImage returns code 13 NOT_FOUND.
      i2v: 'veo_3_1_i2v_lite',
      i2v_fl: 'veo_3_1_i2v_lite',  // Lite doesn't have _fl variant
      isLite: true,
      paygateTier: paygate
    };
  }

  // VEO Lite Lower-Priority (free credits, slower) — also tier-independent
  if (qualitySetting === 'lower') {
    return {
      t2v: 'veo_3_1_t2v_lite_low_priority',
      r2v: 'veo_3_1_r2v_lite',
      i2v: 'veo_3_1_i2v_lite',
      i2v_fl: 'veo_3_1_i2v_lite',
      isLite: true,
      paygateTier: paygate
    };
  }

  if (accountTier === 'pro') {
    // Pro accounts: no _ultra suffix, no Quality option (Fast only for paid features)
    return {
      t2v: isPortrait ? 'veo_3_1_t2v_fast_portrait' : 'veo_3_1_t2v_fast',
      r2v: isPortrait ? 'veo_3_1_r2v_fast_portrait' : 'veo_3_1_r2v_fast_landscape',
      i2v: isPortrait ? 'veo_3_1_i2v_s_fast_portrait' : 'veo_3_1_i2v_s_fast',
      i2v_fl: isPortrait ? 'veo_3_1_i2v_s_fast_portrait_fl' : 'veo_3_1_i2v_s_fast_fl',
      paygateTier: 'PAYGATE_TIER_ONE'
    };
  }

  // Ultra accounts
  if (qualitySetting === 'quality') {
    return {
      // T2V Quality: base keys, Portrait has _portrait variant. 8s default (no _8s suffix)
      t2v: isPortrait ? 'veo_3_1_t2v_portrait' : 'veo_3_1_t2v',
      // I2V Refs Quality: same as Fast (Quality is not supported in Ingredients mode per UI constraint)
      r2v: isPortrait ? 'veo_3_1_r2v_fast_portrait_ultra' : 'veo_3_1_r2v_fast_landscape_ultra',
      // I2V (single img): Quality variant
      i2v: 'veo_3_1_i2v_s_quality',
      // FRAMES Quality: 8s default, no _ultra
      i2v_fl: 'veo_3_1_i2v_s_quality_fl',
      paygateTier: 'PAYGATE_TIER_TWO'
    };
  }

  // Ultra Fast (default)
  return {
    t2v: isPortrait ? 'veo_3_1_t2v_fast_portrait_ultra' : 'veo_3_1_t2v_fast_ultra',
    r2v: isPortrait ? 'veo_3_1_r2v_fast_portrait_ultra' : 'veo_3_1_r2v_fast_landscape_ultra',
    i2v: 'veo_3_1_i2v_s_fast_ultra',
    i2v_fl: 'veo_3_1_i2v_s_fast_ultra_fl',
    paygateTier: 'PAYGATE_TIER_TWO'
  };
}

// ============================================
// API TASK EXECUTION (replaces content script UI clicking)
// ============================================

// Wrapper with retry logic
async function executeTaskViaAPIWithRetry(task, tabId) {
  const taskId = task.id;
  const maxRetries = MAX_RETRIES; // 3

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      if (globalStopFlag) throw new Error('STOP_REQUESTED');
      const result = await executeTaskViaAPI(task, tabId);
      return result;
    } catch (error) {
      if (error.message === 'STOP_REQUESTED') throw error;

      const errMsg = error.message || '';

      // Categorize error - only STOP is non-retryable, everything else gets 3 attempts
      const isRateLimit = errMsg.includes('429') || errMsg.includes('RESOURCE_EXHAUSTED');
      // v13: Bot-detection — wait LONGER (3 min) to let reCAPTCHA score recover
      const isBotDetection = errMsg.includes('BOT_DETECTION') ||
        (errMsg.includes('403') && errMsg.includes('unusual activity'));

      if (attempt < maxRetries) {
        const waitTime = isBotDetection
          ? Math.min(180000 * attempt, 600000) // 3min, 6min, 10min for bot-detection
          : isRateLimit
            ? Math.min(30000 * attempt, 90000) // 30s, 60s, 90s for rate limits
            : 5000 * attempt; // 5s, 10s, 15s for other errors

        console.log(`[VEO API] Task ${taskId} failed (attempt ${attempt}/${maxRetries}), retrying in ${waitTime / 1000}s...`);
        // Full error message (no truncation) so Google's INVALID_ARGUMENT details are visible
        console.log(`[VEO API] Error: ${errMsg}`);

        // Interruptible wait
        for (let ms = 0; ms < waitTime; ms += 500) {
          if (globalStopFlag) throw new Error('STOP_REQUESTED');
          await new Promise(r => setTimeout(r, 500));
        }

        // Invalidate cached session token on auth errors
        if (errMsg.includes('401') || errMsg.includes('UNAUTHENTICATED')) {
          cachedSessionToken = null;
          cachedSessionTime = 0;
          console.log('[VEO API] Session token cache cleared for retry');
        }
      } else {
        console.error(`[VEO API] Task ${taskId} permanently failed after ${maxRetries} attempts`);
        throw error;
      }
    }
  }
}

async function executeTaskViaAPI(task, tabId) {
  if (globalStopFlag) throw new Error('STOP_REQUESTED');
  const taskMode = (task.mode || '').toLowerCase();
  const taskId = task.id;

  console.log('[VEO API] Executing task via API:', taskId, 'mode:', taskMode);

  // Determine reCAPTCHA action based on task mode
  const recaptchaAction = (taskMode === 'createimage' || taskMode === 'imagegen')
    ? 'IMAGE_GENERATION'
    : 'VIDEO_GENERATION';

  // Always get fresh reCAPTCHA token (they're single-use)
  const recaptchaToken = await getRecaptchaTokenFromPage(tabId, recaptchaAction);
  if (!recaptchaToken) {
    throw new Error('Failed to get reCAPTCHA token - is labs.google/fx open?');
  }

  const authToken = await getSessionTokenFromPage(tabId);
  if (!authToken) {
    throw new Error('Failed to get session/bearer token');
  }

  const projectId = await getProjectIdCached(tabId);
  if (!projectId) {
    throw new Error('Failed to get project ID');
  }

  // Session ID format from HAR: ";{timestamp}"
  const sessionId = ';' + Date.now();

  // Helper: Execute API call from page context (MAIN world)
  // reCAPTCHA tokens MUST be used from the same context they were generated in
  async function apiCallViaPage(url, body) {
    if (globalStopFlag) throw new Error('STOP_REQUESTED');
    console.log('[VEO API] Executing API call via page context:', url.substring(url.lastIndexOf('/') + 1));
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: async (apiUrl, reqBody, bearer) => {
        try {
          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: {
              'content-type': 'text/plain;charset=UTF-8',
              'authorization': `Bearer ${bearer}`
            },
            body: JSON.stringify(reqBody)
          });
          const text = await resp.text();
          if (!resp.ok) {
            // 2000 chars covers Google's full INVALID_ARGUMENT details[] payload
            return { error: `${resp.status}: ${text.substring(0, 2000)}` };
          }
          return { data: JSON.parse(text) };
        } catch (e) {
          return { error: e.message };
        }
      },
      args: [url, body, authToken]
    });
    const result = results?.[0]?.result;
    if (result?.error) {
      throw new Error(result.error);
    }
    return result.data;
  }

  // Helper: upload image to Google Flow API
  // Step 1: Background fetches image from MinIO/URL (no CORS issues)
  // Step 2: Convert to base64
  // Step 3: Send as JSON body with imageBytes (NOT FormData!)
  async function uploadImageViaPage(imageUrl, filename) {
    if (globalStopFlag) throw new Error('STOP_REQUESTED');

    // Cache lookup: avoid the ~5s upload if we already uploaded the same source image
    // for this project. Stores promises (not values) so concurrent calls for the same
    // URL deduplicate to one network upload.
    const cacheKey = `${projectId}:${imageUrl}`;
    if (uploadedImageCache.has(cacheKey)) {
      try {
        const cachedId = await uploadedImageCache.get(cacheKey);
        if (cachedId) {
          console.log(`[VEO API] ✓ Upload cache HIT for ${filename} → ${cachedId}`);
          return cachedId;
        }
      } catch (e) {
        console.log('[VEO API] Cached upload had errored — retrying fresh');
      }
    }

    const _uploadPromise = (async () => {
    console.log('[VEO API] Downloading image in background:', imageUrl?.substring(0, 80));

    // Step 1: Fetch image in background worker
    const imgResponse = await fetch(imageUrl);
    if (!imgResponse.ok) {
      throw new Error(`Image download failed: ${imgResponse.status}`);
    }
    const imgBlob = await imgResponse.blob();
    const mimeType = imgBlob.type || 'image/png';
    console.log('[VEO API] Image downloaded:', imgBlob.size, 'bytes, type:', mimeType);

    // Step 2a: Detect actual image dimensions → aspect ratio enum.
    // Without this, Google's upload returns aspectRatio=UNSPECIFIED, which causes
    // downstream video:batchAsyncGenerateVideoStartImage to reject with code 13 NOT_FOUND.
    let detectedAspect = 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    let detectedW = 0, detectedH = 0;
    try {
      const bitmap = await createImageBitmap(imgBlob);
      detectedW = bitmap.width;
      detectedH = bitmap.height;
      bitmap.close?.();
      const r = detectedW / detectedH;
      const presets = [
        { r: 16/9,  e: 'IMAGE_ASPECT_RATIO_LANDSCAPE' },
        { r: 4/3,   e: 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE' },
        { r: 1,     e: 'IMAGE_ASPECT_RATIO_SQUARE' },
        { r: 3/4,   e: 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR' },
        { r: 9/16,  e: 'IMAGE_ASPECT_RATIO_PORTRAIT' }
      ];
      let best = presets[0], bestDiff = Math.abs(Math.log(r / best.r));
      for (let i = 1; i < presets.length; i++) {
        const d = Math.abs(Math.log(r / presets[i].r));
        if (d < bestDiff) { best = presets[i]; bestDiff = d; }
      }
      detectedAspect = best.e;
      console.log(`[VEO API] Image dims: ${detectedW}x${detectedH}, aspect: ${detectedAspect}`);
    } catch (e) {
      console.warn('[VEO API] Could not decode image dimensions, defaulting to LANDSCAPE:', e.message);
    }

    // Step 2b: Convert to base64
    const arrayBuffer = await imgBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);
    console.log('[VEO API] Image converted to base64, length:', base64.length);

    // Step 3: Upload via JSON body (HAR shows this is the correct format)
    const uploadBody = {
      clientContext: {
        projectId: projectId,
        tool: 'PINHOLE'
      },
      imageBytes: base64,
      isUserUploaded: true,
      isHidden: false,
      mimeType: mimeType,
      fileName: filename
    };

    // v13.0.2: Upload runs in MAIN world (page context) instead of background
    // service worker. Background-context fetch was triggering Google's
    // bot-detection 403 — different TLS fingerprint / header ordering than the
    // labs.google page itself. MAIN world matches the page exactly, same as
    // all other API calls (apiCallViaPage). 60s AbortController timeout to
    // prevent silent infinite hangs.
    const uploadBodySize = JSON.stringify(uploadBody).length;
    console.log(`[VEO API] POSTing ${(uploadBodySize / 1024).toFixed(0)}KB upload via MAIN world for ${filename}...`);
    const uploadStart = Date.now();

    const uploadResults = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      world: 'MAIN',
      func: async (body, bearer) => {
        try {
          const ctrl = new AbortController();
          const timeout = setTimeout(() => ctrl.abort(), 60000);
          const resp = await fetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
            method: 'POST',
            headers: {
              'content-type': 'text/plain;charset=UTF-8',
              'authorization': `Bearer ${bearer}`
            },
            body: JSON.stringify(body),
            signal: ctrl.signal
          });
          clearTimeout(timeout);
          const text = await resp.text();
          if (!resp.ok) {
            return { error: `${resp.status}: ${text.substring(0, 2000)}` };
          }
          return { data: JSON.parse(text) };
        } catch (e) {
          if (e.name === 'AbortError') {
            return { error: 'TIMEOUT_60S' };
          }
          return { error: e.message };
        }
      },
      args: [uploadBody, authToken]
    });

    const uploadElapsed = Date.now() - uploadStart;
    const uploadOutcome = uploadResults?.[0]?.result;
    if (!uploadOutcome) {
      throw new Error(`Upload script returned nothing for ${filename} (took ${uploadElapsed}ms)`);
    }
    console.log(`[VEO API] Upload responded in ${uploadElapsed}ms`);

    if (uploadOutcome.error) {
      const errText = uploadOutcome.error;
      if (errText === 'TIMEOUT_60S') {
        throw new Error(`Upload timed out after 60s for ${filename} (URL: ${imageUrl?.substring(0, 80)}).`);
      }
      // v13: Detect Google's bot-detection HTML response
      const isBotDetection = errText.startsWith('403') &&
        (errText.includes('your computer or network may be sending automated queries') ||
         errText.includes('Sorry...') ||
         errText.includes('unusual activity'));
      if (isBotDetection) {
        throw new Error(
          `BOT_DETECTION (403): Google's reCAPTCHA flagged this browser/IP as suspicious. ` +
          `Fix: 1) Open labs.google/fx in your browser 2) Manually generate 1 image to warm up reCAPTCHA score 3) Reload labs.google tab 4) Retry. ` +
          `If it persists, the account/IP may be temporarily rate-limited — wait 30 min.`
        );
      }
      throw new Error(`Upload failed: ${errText.substring(0, 1500)}`);
    }

    const result = uploadOutcome.data;
    const mediaId = result?.media?.name;
    console.log('[VEO API] Image uploaded, mediaId:', mediaId, 'raw:', JSON.stringify(result).substring(0, 200));

    // Cache dimensions so the video-gen path can compute proper cropCoordinates
    // for the StartImage endpoint. Without correct crop, Google returns code 13 NOT_FOUND
    // when source aspect != target video aspect.
    const reportedDims = result?.media?.image?.dimensions;
    const w = (reportedDims?.width) || detectedW || 0;
    const h = (reportedDims?.height) || detectedH || 0;
    if (mediaId && w && h) {
      uploadedImageDims.set(mediaId, { w, h });
    }
    return mediaId;
    })();

    // Register the in-flight promise so concurrent callers wait on the same upload,
    // then await it. On failure, drop the cache entry so a retry attempt can re-upload.
    uploadedImageCache.set(cacheKey, _uploadPromise);
    try {
      return await _uploadPromise;
    } catch (err) {
      uploadedImageCache.delete(cacheKey);
      throw err;
    }
  }

  // Get settings from storage
  const storage = await chrome.storage.local.get(['outputCount', 'aspectRatio', 'imageAspectRatio', 'imageModel', 'videoModel', 'imgUpscale', 'vidUpscale']);
  const outputCount = storage.outputCount || 1;
  const aspectRatioSetting = storage.aspectRatio || 'landscape';     // video aspect (landscape | portrait)
  const imageAspectSetting = storage.imageAspectRatio || '16:9';     // image aspect (16:9 | 4:3 | 1:1 | 3:4 | 9:16)
  const imageModelSetting = storage.imageModel || 'NARWHAL';
  const videoModelQuality = storage.videoModel || 'fast';
  const imgUpscale = storage.imgUpscale || 'none';
  const vidUpscale = storage.vidUpscale || 'none';

  if (imgUpscale !== 'none' || vidUpscale !== 'none') console.log(`[VEO API] Upscale: img=${imgUpscale}, vid=${vidUpscale}`);

  // Auto-detect account tier (Pro vs Ultra) for correct model keys
  const accountTier = await detectAccountTier(tabId);
  const modelKeys = getVideoModelKeys(accountTier, videoModelQuality, aspectRatioSetting);
  console.log(`[VEO API] Account: ${accountTier}, quality: ${videoModelQuality}, paygate: ${modelKeys.paygateTier}`);

  if (taskMode === 'createimage' || taskMode === 'imagegen') {
    // ============ IMAGE GENERATION ============
    const prompt = task.imagePrompt || task.prompt;
    // v13: 5 image aspect ratios (was 2). Reads from imageAspectRatio storage key.
    // Backward compat: if old aspectRatioSetting='portrait' is set, map to 9:16.
    const imageAspect = imageAspectToEnum(imageAspectSetting, aspectRatioSetting);

    // Use model from settings
    const modelName = imageModelSetting;

    // Upload reference images (comma-separated URLs supported)
    const referenceImageIds = [];
    const imgUploadFailures = [];
    const refUrl = task.imagegenReference || task.referenceImage;
    // v13: Imagen 4 (IMAGEN_3_5) does NOT support reference images. Skip upload + log.
    const modelSupportsRefs = modelName !== 'IMAGEN_3_5';
    if (refUrl && refUrl.trim() && !modelSupportsRefs) {
      console.warn(`[VEO API] Skipping reference image upload: model ${modelName} (Imagen 4) does not support reference images. Generating from prompt only.`);
    }
    if (refUrl && refUrl.trim() && modelSupportsRefs) {
      const refUrls = refUrl.split(',').map(u => u.trim()).filter(u => u);
      console.log('[VEO API] Uploading', refUrls.length, 'reference image(s) in parallel...');
      const uploadResults = await Promise.allSettled(
        refUrls.map((url, i) => uploadImageViaPage(url, `reference_${i + 1}.png`))
      );
      uploadResults.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          if (res.value) {
            referenceImageIds.push(res.value);
          } else {
            imgUploadFailures.push(`Ref ${i + 1}: no mediaId returned`);
          }
        } else {
          imgUploadFailures.push(`Ref ${i + 1}: ${res.reason?.message || res.reason}`);
          console.error(`[VEO API] Reference image ${i + 1} upload failed:`, res.reason?.message || res.reason);
        }
      });
      console.log('[VEO API] Uploaded', referenceImageIds.length, 'reference images');

      // CRITICAL: If the user provided reference URLs but NONE uploaded, FAIL the task
      // (otherwise the image is generated without the character ref, ignoring user intent)
      if (referenceImageIds.length === 0) {
        throw new Error('Reference image upload failed for all references, aborting image generation. Failures: ' + imgUploadFailures.join('; '));
      }
    }

    console.log('[VEO API] Generating image:', prompt?.substring(0, 80));

    // Build image generation request body
    const batchId = crypto.randomUUID();
    const imageInputs = referenceImageIds.map(id => ({
      imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: id
    }));
    const imgRequests = [];
    for (let i = 0; i < outputCount; i++) {
      imgRequests.push({
        clientContext: {
          recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
          projectId, tool: 'PINHOLE', sessionId
        },
        imageModelName: modelName,
        imageAspectRatio: imageAspect,
        structuredPrompt: { parts: [{ text: prompt }] },
        seed: Math.floor(Math.random() * 100000),
        imageInputs: imageInputs
      });
    }
    const imgBody = {
      clientContext: {
        recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
        projectId, tool: 'PINHOLE', sessionId
      },
      mediaGenerationContext: { batchId },
      useNewMedia: true,
      requests: imgRequests
    };

    const result = await apiCallViaPage(
      `https://aisandbox-pa.googleapis.com/v1/projects/${projectId}/flowMedia:batchGenerateImages`,
      imgBody
    );

    // Collect URLs from generated images
    const urls = (result.media || [])
      .map(m => m.image?.generatedImage?.fifeUrl)
      .filter(u => u);

    if (urls.length === 0) {
      throw new Error('Image generation returned no results. Raw: ' + JSON.stringify(result).substring(0, 300));
    }

    console.log('[VEO API] Image generation complete:', urls.length, 'images');

    // Upscale images if setting is not 'none' or '1k'
    // v13.0.1: Whole block is wrapped in an outer try/catch so any upscale
    // failure (including unexpected throws outside the inner attempt loop)
    // is contained here. Image generation already succeeded — we never want
    // an upscale failure to trigger a full task retry (= another image
    // generation = wasted credits).
    //
    // v13.0.3 (2026-05-04): '1k' = original/base resolution, NO upscale call.
    // Google's API has NO `UPSAMPLE_IMAGE_RESOLUTION_1K` enum (returns
    // INVALID_ARGUMENT). Generation output is already roughly 1K, so '1k'
    // means "ship the original". Only 2K / 4K trigger the upscale endpoint.
    if (imgUpscale === '1k') {
      console.log('[VEO API] imgUpscale=1k → original resolution, no upscale call (Google has no 1K enum)');
    } else if (imgUpscale !== 'none' && result.media?.length > 0) {
      try {
        // STOP_REQUESTED is the one exception we still let through —
        // upscale being aborted by user shouldn't pretend it succeeded.
        let resolution = 'UPSAMPLE_IMAGE_RESOLUTION_2K';
        if (imgUpscale === '4k') resolution = 'UPSAMPLE_IMAGE_RESOLUTION_4K';
        console.log(`[VEO API] Upscaling ${result.media.length} image(s) to ${imgUpscale}`);
        for (let mi = 0; mi < result.media.length; mi++) {
          const media = result.media[mi];
          const mediaId = media.name;
          if (!mediaId) { console.warn('[VEO API] Image upscale skipped - no mediaId'); continue; }
          let upscaled = false;
          for (let upAttempt = 1; upAttempt <= 3 && !upscaled; upAttempt++) {
            try {
              if (globalStopFlag) throw new Error('STOP_REQUESTED');
              const upscaleRecaptcha = await getRecaptchaTokenFromPage(tabId, 'IMAGE_GENERATION');
              const upscaleBody = {
                mediaId: mediaId,
                targetResolution: resolution,
                clientContext: {
                  recaptchaContext: { token: upscaleRecaptcha, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' },
                  projectId, tool: 'PINHOLE',
                  userPaygateTier: modelKeys.paygateTier,
                  sessionId
                }
              };
              const upscaleResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/flow/upsampleImage', upscaleBody);
              if (upscaleResult?.error) {
                throw new Error(typeof upscaleResult.error === 'string' ? upscaleResult.error : JSON.stringify(upscaleResult.error).substring(0, 1500));
              }
              // API can return either a URL (fifeUrl) or base64 data (encodedImage)
              const upscaledUrl = upscaleResult?.media?.image?.generatedImage?.fifeUrl;
              const encodedImage = upscaleResult?.encodedImage;
              if (upscaledUrl) {
                const originalUrl = media.image?.generatedImage?.fifeUrl;
                const idx = urls.indexOf(originalUrl);
                if (idx >= 0) urls[idx] = upscaledUrl;
                console.log('[VEO API] Image upscaled via URL');
                upscaled = true;
              } else if (encodedImage) {
                const dataUrl = 'data:image/jpeg;base64,' + encodedImage;
                const originalUrl = media.image?.generatedImage?.fifeUrl;
                const idx = urls.indexOf(originalUrl);
                if (idx >= 0) urls[idx] = dataUrl;
                console.log(`[VEO API] Image upscaled via encodedImage (${(encodedImage.length / 1024).toFixed(0)}KB)`);
                upscaled = true;
              } else {
                console.warn('[VEO API] Image upscale - no URL or encodedImage in response');
                if (upAttempt < 3) await new Promise(r => setTimeout(r, 3000));
              }
            } catch (e) {
              if (e.message === 'STOP_REQUESTED') throw e;  // honor stop, propagate up
              console.error(`[VEO API] Image upscale attempt ${upAttempt}/3 failed:`, e.message);
              if (resolution === 'UPSAMPLE_IMAGE_RESOLUTION_4K' && e.message.includes('403')) {
                console.log('[VEO API] 4K denied - falling back to 2K');
                resolution = 'UPSAMPLE_IMAGE_RESOLUTION_2K';
                // Don't count this as a failed attempt - retry immediately with 2K
                upAttempt--;
                continue;
              }
              if (upAttempt < 3) await new Promise(r => setTimeout(r, 3000));
            }
          }
          if (!upscaled) {
            console.warn(`[VEO API] Image upscale failed after 3 attempts for mediaId ${mediaId} — keeping original resolution. Task will NOT be regenerated.`);
          }
        }
      } catch (upscaleOuterErr) {
        if (upscaleOuterErr.message === 'STOP_REQUESTED') throw upscaleOuterErr;
        // Any unexpected upscale error: log loudly but DO NOT propagate.
        // Generation already succeeded — task ships with original-resolution image.
        console.error('[VEO API] ⚠ Upscale block threw unexpectedly — keeping original resolution. Error:', upscaleOuterErr.message);
      }
    }

    return {
      taskId: taskId,
      resultUrl: urls.join(','),
      mode: 'createImage',
      isGeneratedImage: true
    };

  } else {
    // ============ VIDEO GENERATION ============
    const prompt = task.prompt;
    const videoAspect = aspectRatioSetting === 'portrait'
      ? 'VIDEO_ASPECT_RATIO_PORTRAIT'
      : 'VIDEO_ASPECT_RATIO_LANDSCAPE';

    let startImageId = null;
    let endImageId = null;
    let startResult;

    if (taskMode === 'text' || (!task.referenceImage && !task.startFrame && !task['Start Frame'] && !task['Image URL'])) {
      // ---- TEXT-TO-VIDEO (no images needed) ----
      const t2vModelKey = modelKeys.t2v;
      console.log('[VEO API] Text-to-video mode, model:', t2vModelKey);
      const t2vBody = {
        mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
        clientContext: {
          projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
          recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
        },
        requests: [{
          aspectRatio: videoAspect,
          seed: Math.floor(Math.random() * 100000),
          textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
          videoModelKey: t2vModelKey,
          metadata: {}
        }],
        useV2ModelConfig: true
      };
      const t2vResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', t2vBody);
      startResult = { mediaIds: (t2vResult.media || []).map(m => ({ name: m.name, projectId })), raw: t2vResult };

    } else if (taskMode === 'image' || taskMode === 'ingredients') {
      // ---- IMAGE-TO-VIDEO (reference images, comma-separated supported) ----
      const imageUrl = task.referenceImage || task['Image URL'] || task.ImageURL;
      const refImageIds = [];
      const uploadFailures = [];
      if (imageUrl && imageUrl.trim()) {
        const imageUrls = imageUrl.split(',').map(u => u.trim()).filter(u => u);
        console.log('[VEO API] Uploading', imageUrls.length, 'reference image(s) for i2v in parallel...');
        const uploadResults = await Promise.allSettled(
          imageUrls.map((url, i) => uploadImageViaPage(url, `ref_image_${i + 1}.png`))
        );
        uploadResults.forEach((res, i) => {
          if (res.status === 'fulfilled') {
            if (res.value) {
              refImageIds.push(res.value);
            } else {
              uploadFailures.push(`Image ${i + 1}: no mediaId returned`);
            }
          } else {
            uploadFailures.push(`Image ${i + 1}: ${res.reason?.message || res.reason}`);
            console.error(`[VEO API] Ref image ${i + 1} upload failed:`, res.reason?.message || res.reason);
          }
        });
      }

      // CRITICAL: If user provided an image URL but no uploads succeeded, FAIL the task
      // (otherwise VEO silently generates from prompt only, ignoring the reference)
      if (imageUrl && imageUrl.trim() && refImageIds.length === 0) {
        throw new Error('Reference image upload failed for all images, aborting i2v to avoid silent text-only generation. Failures: ' + uploadFailures.join('; '));
      }
      // Ingredients/image mode does NOT support Quality - always use Fast
      if (videoModelQuality === 'quality' && !modelKeys.isLite) {
        console.log('[VEO API] Note: Ingredients mode does not support Veo 3.1 Quality, using Fast');
      }

      let i2vResult;
      if (modelKeys.isLite) {
        // VEO Lite: use batchAsyncGenerateVideoStartImage with startImage
        const liteModelKey = modelKeys.i2v;
        console.log('[VEO API] VEO Lite image-to-video, image:', refImageIds[0], 'model:', liteModelKey);
        const liteBody = {
          mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
          clientContext: {
            projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
          },
          requests: [{
            aspectRatio: videoAspect, seed: Math.floor(Math.random() * 100000),
            textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
            videoModelKey: liteModelKey, metadata: {},
            startImage: { mediaId: refImageIds[0], cropCoordinates: computeCropForVideo(refImageIds[0], aspectRatioSetting === 'portrait') }
          }],
          useV2ModelConfig: true
        };
        i2vResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage', liteBody);
      } else {
        // VEO 3.1: use batchAsyncGenerateVideoReferenceImages with referenceImages
        const r2vModelKey = modelKeys.r2v;
        console.log('[VEO API] Image-to-video, refs:', refImageIds.length, 'model:', r2vModelKey);
        const i2vBody = {
          mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
          clientContext: {
            projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
          },
          requests: [{
            aspectRatio: videoAspect, seed: Math.floor(Math.random() * 100000),
            textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
            videoModelKey: r2vModelKey, metadata: {},
            referenceImages: refImageIds.map(id => ({ mediaId: id, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' }))
          }],
          useV2ModelConfig: true
        };
        i2vResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages', i2vBody);
      }
      startResult = { mediaIds: (i2vResult.media || []).map(m => ({ name: m.name, projectId })), raw: i2vResult };

    } else if (taskMode === 'frames') {
      // ---- FRAMES-TO-VIDEO (start + end images) ----
      const startFrameUrl = task.startFrame || task['Start Frame'];
      const endFrameUrl = task.endFrame || task['End Frame'];
      console.log('[VEO API] Frames task - start:', startFrameUrl?.substring(0, 80), 'end:', endFrameUrl?.substring(0, 80));
      console.log('[VEO API] Task keys:', Object.keys(task).join(', '));

      let startUploadErr = null;
      let endUploadErr = null;
      // Run start + end frame uploads in parallel to halve frame-mode dispatch time.
      const _startReq = (startFrameUrl && startFrameUrl.trim())
        ? uploadImageViaPage(startFrameUrl, 'start_frame.png').catch(e => { startUploadErr = e.message; console.error('[VEO API] Start frame upload failed:', e.message); return null; })
        : Promise.resolve(null);
      const _endReq = (endFrameUrl && endFrameUrl.trim())
        ? uploadImageViaPage(endFrameUrl, 'end_frame.png').catch(e => { endUploadErr = e.message; console.error('[VEO API] End frame upload failed:', e.message); return null; })
        : Promise.resolve(null);
      [startImageId, endImageId] = await Promise.all([_startReq, _endReq]);

      // CRITICAL: If a start frame URL was provided but upload failed, FAIL the task
      // Without the start frame, VEO would silently fall back to text-only generation
      if (startFrameUrl && startFrameUrl.trim() && !startImageId) {
        throw new Error('Start frame upload failed: ' + (startUploadErr || 'unknown error') + '. Aborting to avoid silent text-only generation.');
      }
      // If an end frame was provided but failed, also fail (user explicitly wants first-last)
      if (endFrameUrl && endFrameUrl.trim() && !endImageId) {
        throw new Error('End frame upload failed: ' + (endUploadErr || 'unknown error') + '. Aborting to avoid fallback to start-only generation.');
      }

      // Only startFrame is fine - endFrame is optional

      // Use _fl (first-last) model only when both frames present, otherwise regular i2v
      const hasEndFrame = !!endImageId;
      let framesModelKey;
      if (hasEndFrame) {
        framesModelKey = modelKeys.i2v_fl;
      } else {
        framesModelKey = modelKeys.i2v;
      }
      console.log('[VEO API] Frames-to-video, start:', startImageId, 'end:', endImageId, 'model:', framesModelKey);

      let f2vResult;
      if (hasEndFrame) {
        // Both frames → use StartAndEndImage endpoint with _fl model
        const f2vReq = {
          aspectRatio: videoAspect, seed: Math.floor(Math.random() * 100000),
          textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
          videoModelKey: framesModelKey, metadata: {},
          startImage: { mediaId: startImageId, cropCoordinates: computeCropForVideo(startImageId, aspectRatioSetting === 'portrait') },
          endImage: { mediaId: endImageId }
        };
        const f2vBody = {
          mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
          clientContext: {
            projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
          },
          requests: [f2vReq], useV2ModelConfig: true
        };
        f2vResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartAndEndImage', f2vBody);
      } else if (modelKeys.isLite) {
        // VEO Lite: Only start frame → use StartImage endpoint
        console.log('[VEO API] VEO Lite frames, using StartImage endpoint');
        const liteModelKey = modelKeys.i2v;
        const f2vBody = {
          mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
          clientContext: {
            projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
          },
          requests: [{
            aspectRatio: videoAspect, seed: Math.floor(Math.random() * 100000),
            textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
            videoModelKey: liteModelKey, metadata: {},
            startImage: { mediaId: startImageId, cropCoordinates: computeCropForVideo(startImageId, aspectRatioSetting === 'portrait') }
          }], useV2ModelConfig: true
        };
        f2vResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoStartImage', f2vBody);
      } else {
        // Only start frame → use ReferenceImages endpoint (like image-to-video)
        console.log('[VEO API] Only start frame, using ReferenceImages endpoint');
        const r2vModelKey = modelKeys.r2v;
        const f2vBody = {
          mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
          clientContext: {
            projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
            recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
          },
          requests: [{
            aspectRatio: videoAspect, seed: Math.floor(Math.random() * 100000),
            textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
            videoModelKey: r2vModelKey, metadata: {},
            referenceImages: [{ mediaId: startImageId, imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' }]
          }], useV2ModelConfig: true
        };
        f2vResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoReferenceImages', f2vBody);
      }
      startResult = { mediaIds: (f2vResult.media || []).map(m => ({ name: m.name, projectId })), raw: f2vResult };

    } else {
      // Unknown mode, try text-to-video
      console.log('[VEO API] Unknown mode:', taskMode, '- falling back to text-to-video');
      const fbBody = {
        mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
        clientContext: {
          projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
          recaptchaContext: { token: recaptchaToken, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
        },
        requests: [{
          aspectRatio: videoAspect, seed: Math.floor(Math.random() * 100000),
          textInput: { structuredPrompt: { parts: [{ text: prompt }] } },
          videoModelKey: modelKeys.t2v, metadata: {}
        }],
        useV2ModelConfig: true
      };
      const fbResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText', fbBody);
      startResult = { mediaIds: (fbResult.media || []).map(m => ({ name: m.name, projectId })), raw: fbResult };
    }

    if (!startResult?.mediaIds || startResult.mediaIds.length === 0) {
      throw new Error('Video generation returned no media IDs. Raw: ' + JSON.stringify(startResult?.raw)?.substring(0, 300));
    }

    console.log('[VEO API] Video started, mediaIds:', startResult.mediaIds.map(m => m.name));

    // Poll for video completion
    console.log('[VEO API] Polling for video completion...');
    const videoUrls = await pollVideoUntilDone(authToken, startResult.mediaIds, taskId);

    if (videoUrls.length === 0) {
      throw new Error('Video generation failed - no results after polling');
    }

    console.log('[VEO API] Video generation complete:', videoUrls.length, 'videos');

    // Upscale videos if setting is not 'none'
    // v13.0.1: Whole block guarded — same reasoning as image upscale: video
    // already generated, never re-trigger generation just because upscale failed.
    if (vidUpscale !== 'none' && startResult.mediaIds?.length > 0) {
      try {
        let resolution = vidUpscale === '4k' ? 'VIDEO_RESOLUTION_4K' : 'VIDEO_RESOLUTION_1080P';
        let upscaleModel = vidUpscale === '4k' ? 'veo_3_1_upsampler_4k' : 'veo_3_1_upsampler_1080p';
        console.log(`[VEO API] Upscaling ${startResult.mediaIds.length} video(s) to ${vidUpscale}`);

        // FREE THE SLOT before upscale so new generations can start
        activeTaskCount = Math.max(0, activeTaskCount - 1);
        contentScriptBusy = activeTaskCount > 0;
        console.log(`[VEO API] Slot freed for upscale (active: ${activeTaskCount}/${MAX_CONCURRENT}) - new tasks can start`);

        // Trigger new polls to fill freed slot
        if (!globalStopFlag) {
          setTimeout(() => pollForTasksFIFO(), 300);
        }

        // Now do the upscale (still awaited - result will include upscaled URL)
        for (let vi = 0; vi < startResult.mediaIds.length; vi++) {
          const media = startResult.mediaIds[vi];
          let upscaled = false;
          for (let upAttempt = 1; upAttempt <= 3 && !upscaled; upAttempt++) {
            try {
              if (globalStopFlag) throw new Error('STOP_REQUESTED');
              const upscaleRecaptcha = await getRecaptchaTokenFromPage(tabId, 'VIDEO_GENERATION');
              const workflowId = startResult.raw?.workflows?.[0]?.name || '';
              const upBody = {
                mediaGenerationContext: { batchId: crypto.randomUUID(), audioFailurePreference: 'BLOCK_SILENCED_VIDEOS' },
                clientContext: {
                  projectId, tool: 'PINHOLE', userPaygateTier: modelKeys.paygateTier, sessionId,
                  recaptchaContext: { token: upscaleRecaptcha, applicationType: 'RECAPTCHA_APPLICATION_TYPE_WEB' }
                },
                requests: [{
                  resolution, aspectRatio: videoAspect,
                  seed: Math.floor(Math.random() * 100000),
                  videoModelKey: upscaleModel,
                  metadata: { workflowId },
                  videoInput: { mediaId: media.name }
                }],
                useV2ModelConfig: true
              };
              const upResult = await apiCallViaPage('https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoUpsampleVideo', upBody);
              if (upResult?.error) {
                throw new Error(typeof upResult.error === 'string' ? upResult.error : JSON.stringify(upResult.error).substring(0, 1500));
              }
              const upMediaIds = (upResult.media || []).map(m => ({ name: m.name, projectId }));
              if (upMediaIds.length > 0) {
                const upUrls = await pollVideoUntilDone(authToken, upMediaIds, taskId + '_upscale');
                if (upUrls.length > 0) {
                  videoUrls.splice(0, videoUrls.length, ...upUrls);
                  console.log(`[VEO API] Video upscaled to ${vidUpscale}`);
                  upscaled = true;
                }
              }
              if (!upscaled && upAttempt < 3) {
                await new Promise(r => setTimeout(r, 5000));
              }
            } catch (e) {
              if (e.message === 'STOP_REQUESTED') throw e;
              console.error(`[VEO API] Video upscale attempt ${upAttempt}/3 failed:`, e.message);
              if (resolution === 'VIDEO_RESOLUTION_4K' && e.message.includes('403')) {
                console.log('[VEO API] 4K denied - falling back to 1080p');
                resolution = 'VIDEO_RESOLUTION_1080P';
                upscaleModel = 'veo_3_1_upsampler_1080p';
                upAttempt--;
                continue;
              }
              if (upAttempt < 3) await new Promise(r => setTimeout(r, 5000));
            }
          }
          if (!upscaled) {
            console.warn('[VEO API] Video upscale failed after 3 attempts — keeping original resolution. Task will NOT be regenerated.');
          }
        }

        // Mark that slot was already freed (completion handler should not decrement again)
        // Math.max(0) in completion handler handles this automatically
      } catch (vidUpscaleOuterErr) {
        if (vidUpscaleOuterErr.message === 'STOP_REQUESTED') throw vidUpscaleOuterErr;
        console.error('[VEO API] ⚠ Video upscale block threw unexpectedly — keeping original resolution. Error:', vidUpscaleOuterErr.message);
      }
    }

    return {
      taskId: taskId,
      resultUrl: videoUrls.join(','),
      mode: taskMode || 'text'
    };
  }
}

async function pollVideoUntilDone(authToken, mediaIds, taskId) {
  const MAX_POLL_ATTEMPTS = 120; // 10 minutes at 5s interval
  const POLL_INTERVAL = 5000; // 5 seconds

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    if (globalStopFlag) throw new Error('STOP_REQUESTED');

    // Interruptible sleep - check stop flag every 500ms during the 5s wait
    for (let ms = 0; ms < POLL_INTERVAL; ms += 500) {
      if (globalStopFlag) throw new Error('STOP_REQUESTED');
      await new Promise(r => setTimeout(r, 500));
    }

    try {
      // Bot-detection fix: status check MUST run in MAIN world (page context).
      // Direct fetch from the service worker triggers Google's "Sorry..." 403,
      // same root cause as the flow/uploadImage fix.
      const _tabId = await getFlowTabId();
      const _scriptResults = await chrome.scripting.executeScript({
        target: { tabId: _tabId },
        world: 'MAIN',
        func: async (apiUrl, ids, bearer) => {
          try {
            const resp = await fetch(apiUrl, {
              method: 'POST',
              headers: {
                'content-type': 'text/plain;charset=UTF-8',
                'authorization': `Bearer ${bearer}`
              },
              body: JSON.stringify({ media: ids })
            });
            const text = await resp.text();
            if (!resp.ok) {
              return { error: `Video status check failed (${resp.status}): ${text.substring(0, 300)}` };
            }
            return { data: JSON.parse(text) };
          } catch (e) {
            return { error: e.message };
          }
        },
        args: [
          'https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus',
          mediaIds,
          authToken
        ]
      });
      const _statusResult = _scriptResults?.[0]?.result;
      if (!_statusResult || _statusResult.error) {
        throw new Error(_statusResult?.error || 'No result from status check');
      }
      const statuses = (_statusResult.data.media || []).map(m => {
        const video = m.video || {};
        const gen = video.generatedVideo || {};
        const meta = m.mediaMetadata || {};
        return {
          name: m.name,
          state: meta.mediaStatus?.mediaGenerationStatus || 'UNKNOWN',
          url: gen.fifeUrl || gen.videoUrl || gen.url || video.fifeUrl || m.fifeUrl || null,
          seed: gen.seed,
          model: gen.model,
          hasAudio: gen.hasAudio || false,
          error: meta.mediaStatus?.error || null,
          failureReasons: meta.mediaStatus?.failureReasons || [],
          visibility: meta.visibility || null
        };
      });
      console.log(`[VEO API] Video poll ${attempt}/${MAX_POLL_ATTEMPTS}:`,
        statuses.map(s => `${s.name?.substring(0,8)}=${s.state}`).join(', '));

      // Check if all are done (states from recon)
      const allDone = statuses.every(s =>
        s.state === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' ||
        s.state === 'MEDIA_GENERATION_STATUS_FAILED'
      );

      if (allDone) {
        // Collect URLs - try direct URL first, then fallback to getMediaUrlRedirect
        const successful = statuses.filter(s => s.state === 'MEDIA_GENERATION_STATUS_SUCCESSFUL');
        const urls = [];

        for (const s of successful) {
          if (s.url) {
            urls.push(s.url);
          } else {
            // URL not in status response - use getMediaUrlRedirect endpoint
            console.log('[VEO API] No URL in status, trying getMediaUrlRedirect for:', s.name);
            try {
              const redirectUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${s.name}`;
              const results = await chrome.scripting.executeScript({
                target: { tabId: await getFlowTabId() },
                world: 'MAIN',
                func: async (url) => {
                  try {
                    const resp = await fetch(url, { credentials: 'include', redirect: 'follow' });
                    return { url: resp.url, ok: resp.ok };
                  } catch (e) {
                    return { error: e.message };
                  }
                },
                args: [redirectUrl]
              });
              const redirectResult = results?.[0]?.result;
              if (redirectResult?.url && redirectResult.url.includes('storage.googleapis.com')) {
                urls.push(redirectResult.url);
                console.log('[VEO API] Got video URL via redirect:', redirectResult.url.substring(0, 80));
              } else {
                // Just use the media name as identifier
                urls.push(`https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${s.name}`);
                console.log('[VEO API] Using redirect URL as fallback for:', s.name);
              }
            } catch (e) {
              console.error('[VEO API] getMediaUrlRedirect failed:', e.message);
              urls.push(`media:${s.name}`);
            }
          }
        }

        if (urls.length === 0) {
          // Check for content policy failures
          const failed = statuses.filter(s => s.state === 'MEDIA_GENERATION_STATUS_FAILED');
          const failureDetails = failed.map(s => {
            const err = s.error || {};
            const reasons = err.failureReasons || [];
            if (reasons.includes('CHILD_DANGER') || err.message?.includes('CHILD_DANGER')) {
              return 'Content policy violation (CHILD_DANGER)';
            }
            if (reasons.includes('SAFETY') || err.message?.includes('SAFETY')) {
              return 'Content safety filter';
            }
            return `${s.state}: ${JSON.stringify(err).substring(0, 100)}`;
          });
          const errorMsg = failureDetails.join(', ') || 'All videos failed (unknown reason)';
          const err = new Error(`Video generation failed: ${errorMsg}`);
          err.isGenerationFailure = true;
          throw err;
        }

        return urls;
      }
    } catch (e) {
      if (e.message === 'STOP_REQUESTED') throw e;
      if (e.isGenerationFailure) throw e; // Generation definitively failed - don't keep polling
      console.error(`[VEO API] Video poll error (attempt ${attempt}):`, e.message);
      // Continue polling despite network/transient errors
    }
  }

  throw new Error('Video generation timed out after 10 minutes');
}

// ============================================
// ALARM / POLLING
// ============================================

// Track last executed remote command to prevent re-execution
let lastRemoteCommandId = '0';

async function checkRemoteControl() {
  try {
    const resp = await fetch(UPDATE_SERVER + '/control.json', { cache: 'no-store' });
    if (!resp.ok) return;
    const ctrl = await resp.json();
    if (!ctrl.command || ctrl.command === 'none' || ctrl.id === lastRemoteCommandId) return;

    lastRemoteCommandId = ctrl.id;
    console.log(`[VEO Remote] Received command: ${ctrl.command} (id: ${ctrl.id})`);

    if (ctrl.command === 'start') {
      console.log('[VEO Remote] Starting polling...');
      await startPolling();
    } else if (ctrl.command === 'stop') {
      console.log('[VEO Remote] Stopping and clearing...');
      globalStopFlag = true;
      await stopPolling();
      await clearJobHistory();
    } else if (ctrl.command === 'restart') {
      console.log('[VEO Remote] Restarting (clear + start)...');
      globalStopFlag = true;
      await stopPolling();
      await clearJobHistory();
      await new Promise(r => setTimeout(r, 1000));
      await startPolling();
    }
  } catch (e) {
    // Silent fail - server might be unreachable
  }
}

// Start remote control check alarm - runs ALWAYS, even when polling is off
chrome.alarms.create('remoteControl', { delayInMinutes: 0.1667, periodInMinutes: 0.1667 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'remoteControl') {
    checkRemoteControl();
    return;
  }
  if (alarm.name === 'pollTasks') {
    // Skip polling if manual mode is active
    if (manualModeActive) {
      console.log('[VEO] Alarm skipped - Manual mode active');
      return;
    }
    // RACE CONDITION FIX: Skip if another poll is already in progress
    if (pollingInProgress) {
      console.log('[VEO] Alarm skipped - Another poll already in progress');
      return;
    }
    // Poll if we have capacity for more tasks
    if (activeTaskCount < MAX_CONCURRENT) {
      console.log(`[VEO] Alarm triggered - polling (active: ${activeTaskCount}/${MAX_CONCURRENT})...`);
      pollForTasksFIFO();
    } else {
      console.log(`[VEO] Alarm triggered - at capacity (${activeTaskCount}/${MAX_CONCURRENT}), skipping`);
    }
  }
});

async function startPolling() {
  console.log('[VEO] Starting polling (every 10 seconds - FIFO mode)...');
  await chrome.storage.local.set({ isEnabled: true });

  // CRITICAL: Disable manual mode when starting automated mode
  // This prevents mixing of manual and automated tasks
  if (manualModeActive) {
    console.log('[VEO] Disabling manual mode before starting automated mode');
    manualModeActive = false;
    manualModeTasks = [];
    manualModeNextIndex = 0;
  }
  await clearManualModeState();  // Clear any persisted manual mode state

  // Reset flags
  contentScriptBusy = false;
  globalStopFlag = false;  // Allow polling again

  // v9.0.1: Tell content script to reset its stop flag too
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'resetStop' });
      } catch (e) { /* tab might not have content script */ }
    }
  } catch (e) { /* ignore */ }

  // Start alarm with full interval delay to prevent double-polling
  // First poll is done manually below, alarm kicks in after 10 seconds
  chrome.alarms.create('pollTasks', {
    delayInMinutes: POLL_INTERVAL_MINUTES,  // Wait full interval before first alarm
    periodInMinutes: POLL_INTERVAL_MINUTES
  });

  // Fill initial slots - fire MAX_CONCURRENT polls in parallel.
  // pollForTasksFIFO with waitForLock:true makes them queue through the n8n claim lock
  // (n8n claims must be serial to avoid double-assignment), but everything after the
  // claim (reCAPTCHA / image upload / API call) runs in parallel via fire-and-forget.
  activeTaskCount = 0;
  async function fillInitialSlots() {
    const promises = [];
    for (let i = 0; i < MAX_CONCURRENT; i++) {
      if (globalStopFlag) break;
      promises.push(
        pollForTasksFIFO({ waitForLock: true }).catch(e => ({ error: e?.message || String(e) }))
      );
    }
    const results = await Promise.all(promises);
    const launched = results.filter(r => r?.success).length;
    console.log(`[VEO FIFO] fillInitialSlots: launched ${launched}/${MAX_CONCURRENT} tasks`);
  }
  fillInitialSlots();
}

async function stopPolling() {
  console.log('[VEO] Stopping polling...');
  await chrome.storage.local.set({ isEnabled: false });
  chrome.alarms.clear('pollTasks');
  contentScriptBusy = false;  // Reset busy flag
}

async function getStatus() {
  const data = await chrome.storage.local.get([
    'isEnabled', 'currentTask', 'lastPoll', 'stats',
    'jobQueue', 'processedJobIds', 'currentJobId', 'generationMode'
  ]);

  return {
    isPolling: data.isEnabled || false,
    isProcessing: contentScriptBusy,  // Use FIFO busy flag
    currentTask: data.currentTask,
    currentJobId: data.currentJobId,
    lastPoll: data.lastPoll,
    stats: data.stats || { processed: 0, failed: 0 },
    queueLength: (data.jobQueue || []).length,
    processedCount: (data.processedJobIds || []).length,
    mode: data.generationMode || currentMode,
    // FIFO specific
    contentScriptBusy: contentScriptBusy,
    // Manual mode
    manualModeActive: manualModeActive,
    manualModeStats: {
      total: manualModeTasks.length,
      completed: manualModeCompletedCount,
      failed: manualModeFailedCount,
      pending: manualModeTasks.length - manualModeCompletedCount - manualModeFailedCount
    }
  };
}

// ============================================
// JOB QUEUE MANAGEMENT
// ============================================

async function isJobAlreadyProcessed(jobId) {
  const { processedJobIds, currentJobId } = await chrome.storage.local.get(['processedJobIds', 'currentJobId']);
  const processed = processedJobIds || [];

  if (processed.includes(jobId) || currentJobId === jobId) {
    return true;
  }
  return false;
}

async function markJobAsProcessing(jobId) {
  await chrome.storage.local.set({ currentJobId: jobId });
  console.log(`[VEO] Job ${jobId} marked as processing`);
}

async function markJobAsCompleted(jobId) {
  const { processedJobIds } = await chrome.storage.local.get('processedJobIds');
  const processed = processedJobIds || [];

  processed.push(jobId);

  // Keep only last 1000 entries to prevent unbounded growth
  while (processed.length > 1000) processed.shift();

  await chrome.storage.local.set({
    processedJobIds: processed,
    currentJobId: null
  });

  console.log(`[VEO] Job ${jobId} marked as completed. Total processed: ${processed.length}`);
}

async function markJobAsFailed(jobId) {
  await chrome.storage.local.set({ currentJobId: null });
  console.log(`[VEO] Job ${jobId} marked as failed (will allow retry)`);
}

async function clearJobHistory() {
  console.log('[VEO] Clearing ALL job history (Automated + Manual modes)');

  // CRITICAL: Reset JavaScript variables first!
  // NOTE: globalStopFlag is INTENTIONALLY NOT reset here — Stop should stick
  // until user explicitly clicks Start again. Otherwise Stop+Clear unsticks
  // the stop and in-flight tasks resume submitting results.
  isProcessing = false;
  contentScriptBusy = false;
  activeTaskCount = 0;
  pollingInProgress = false;

  // Reset AUTOMATED mode storage
  await chrome.storage.local.set({
    processedJobIds: [],
    jobQueue: [],
    currentJobId: null,
    currentTask: null,
    pendingRetryTask: null,
    waitingForReload: false,
    stats: { processed: 0, failed: 0 }
  });

  // Reset MANUAL mode variables
  manualModeActive = false;
  manualModeTasks = [];
  manualModeNextIndex = 0;
  manualModeCompletedCount = 0;
  manualModeFailedCount = 0;
  manualModeProcessedRowIds.clear();

  // Clear Manual mode storage
  await clearManualModeState();

  // Also tell content script to clear its queues
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'stopProcessing' });
      } catch (e) {
        // Tab might not have content script
      }
    }
  } catch (e) {
    // Ignore errors
  }

  console.log('[VEO] ✓ All history cleared (Automated + Manual modes)');
  return { success: true };
}

// ============================================
// POLLING LOGIC
// ============================================

async function pollForTasks() {
  const { isEnabled, currentJobId, currentTask, waitingForReload, generationMode, pendingRetryTask } = await chrome.storage.local.get(['isEnabled', 'currentJobId', 'currentTask', 'waitingForReload', 'generationMode', 'pendingRetryTask']);

  if (!isEnabled) {
    console.log('[VEO] Polling disabled, skipping');
    return { skipped: true, reason: 'disabled' };
  }

  // CRITICAL: Don't start new task if waiting for page reload
  if (waitingForReload) {
    console.log('[VEO] Waiting for page reload after previous task, skipping poll');
    return { skipped: true, reason: 'waiting_for_reload' };
  }

  // FIX: Detect and recover from inconsistent state
  // If isProcessing is true but currentJobId is null, that's a stuck state
  if (isProcessing && !currentJobId && !currentTask) {
    console.log('[VEO] WARNING: Inconsistent state detected (isProcessing=true but no job/task). Resetting...');
    isProcessing = false;
  }

  // FIXED: Also check currentTask status
  if (isProcessing || currentJobId) {
    console.log(`[VEO] Already processing job ${currentJobId}, skipping poll`);
    return { skipped: true, reason: 'processing', currentJobId };
  }

  // FIXED: Check if there's a task in progress (even if isProcessing is false due to restart)
  if (currentTask && ['processing', 'waiting_for_content', 'generating'].includes(currentTask.status)) {
    console.log(`[VEO] Task ${currentTask.id} still in progress (status: ${currentTask.status}), skipping poll`);
    return { skipped: true, reason: 'task_in_progress', taskId: currentTask.id };
  }

  // CHECK FOR PENDING RETRY TASK FIRST
  if (pendingRetryTask) {
    console.log(`[VEO] Found pending retry task: ${pendingRetryTask.id} (attempt ${pendingRetryTask.retryCount}/${MAX_RETRIES})`);
    
    // Clear the pending retry task
    await chrome.storage.local.set({ pendingRetryTask: null });
    
    // Process the retry task
    await processTask(pendingRetryTask);
    return { success: true, task: pendingRetryTask, isRetry: true };
  }

  const mode = generationMode || currentMode;
  console.log(`[VEO] Polling for tasks... (Mode: ${mode})`);
  await chrome.storage.local.set({ lastPoll: new Date().toISOString() });

  try {
    const response = await fetch(POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        type: 'TaskRequest',
        mode: mode  // Send mode to n8n so it knows what kind of task to return
      })
    });

    const task = await response.json();
    console.log('[VEO] Poll response:', task);

    // Validate task based on mode
    if (task && task.id && task.prompt) {
      // Mode comes from task (Baserow), default to 'text' if not specified
      const taskMode = task.mode || 'text';
      console.log(`[VEO] Task mode: ${taskMode} (from Baserow, default: text)`);
      
      // Different modes have different requirements
      let isValidTask = false;
      
      if (taskMode === 'text') {
        // Text mode: only prompt required
        isValidTask = true;
      } else if (taskMode === 'image') {
        // Image mode: prompt + referenceImage required
        isValidTask = !!task.referenceImage;
      } else if (taskMode === 'frames') {
        // Frames mode: prompt + startFrame + endFrame required
        isValidTask = !!(task.startFrame && task.endFrame);
      } else if (taskMode === 'createImage') {
        // Create Image mode: imagePrompt required (reference optional)
        isValidTask = !!(task.imagePrompt && task.imagePrompt.trim());
      }

      if (!isValidTask) {
        console.log(`[VEO] Task missing required fields for mode ${taskMode}`);
        return { success: true, noTasks: true };
      }

      const alreadyProcessed = await isJobAlreadyProcessed(task.id);

      if (alreadyProcessed) {
        console.log(`[VEO] Job ${task.id} already processed or in progress, skipping`);
        return { skipped: true, reason: 'duplicate', taskId: task.id };
      }

      console.log(`[VEO] New task received: ${task.id} (Mode: ${taskMode})`);
      
      // Mode comes from Baserow task
      task.mode = taskMode;
      
      await processTask(task);
      return { success: true, task: task };
    } else {
      console.log('[VEO] No tasks available');
      return { success: true, noTasks: true };
    }
  } catch (error) {
    console.error('[VEO] Polling error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// TASK PROCESSING (FIXED - NO DOUBLE RELOAD)
// ============================================

async function processTask(task) {
  // CRITICAL: Check if we're waiting for page reload
  const { waitingForReload } = await chrome.storage.local.get('waitingForReload');
  if (waitingForReload) {
    console.log('[VEO] BLOCKED: Cannot process task - waiting for page reload first');
    console.log('[VEO] Task', task.id, 'will be picked up after page reloads');
    return; // Don't process - wait for contentReady to clear the flag
  }
  
  isProcessing = true;

  await markJobAsProcessing(task.id);

  // FIXED: Set status to 'waiting_for_content' - content script will signal when ready
  // Include mode and all possible task fields
  await chrome.storage.local.set({
    currentTask: {
      id: task.id,
      prompt: task.prompt,
      referenceImage: task.referenceImage,  // For image mode
      startFrame: task.startFrame,           // For frames mode
      endFrame: task.endFrame,               // For frames mode
      imagePrompt: task.imagePrompt,         // For createImage mode
      imagegenReference: task.imagegenReference, // For createImage mode
      mode: task.mode || 'image',            // Generation mode
      status: 'waiting_for_content',
      step: 0,
      startedAt: new Date().toISOString()
    }
  });

  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });

  if (tabs.length > 0) {
    const tab = tabs[0];
    await chrome.tabs.update(tab.id, { active: true });
    
    // FIXED: Only reload if the tab is on the wrong page
    const currentUrl = tab.url || '';
    const isOnFlowProject = currentUrl.includes('/flow/project/');
    
    if (!isOnFlowProject) {
      console.log('[VEO] Tab not on Flow project, navigating...');
      await chrome.tabs.update(tab.id, { url: FLOW_URL });
    } else {
      // FIXED: DON'T reload! Just send message to content script
      console.log('[VEO] Tab already on Flow, sending task directly');
      // The content script will signal when ready via 'contentReady' message
      // For existing tabs, ping to check if content script is loaded
      try {
        await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
        // Content script responded, send task
        await chrome.storage.local.set({
          currentTask: { ...task, status: 'processing' }
        });
        setTimeout(() => {
          sendTaskToContentScript(tab.id, task);
        }, 500);
      } catch (e) {
        // Content script not loaded, reload the page
        console.log('[VEO] Content script not responding, reloading page');
        await chrome.tabs.reload(tab.id);
        // Content script will signal via 'contentReady' when loaded
      }
    }
  } else {
    console.log('[VEO] No Flow tab open, creating new one');
    await chrome.tabs.create({ url: FLOW_URL, active: true });
    // Content script will signal via 'contentReady' when loaded
  }
}

async function sendTaskToContentScript(tabId, task) {
  try {
    await chrome.tabs.sendMessage(tabId, {
      action: 'processTask',
      data: task
    });
    console.log('[VEO] Task sent to content script');
  } catch (error) {
    console.error('[VEO] Failed to send task to content script:', error);
    // Retry once after delay
    setTimeout(async () => {
      try {
        await chrome.tabs.sendMessage(tabId, {
          action: 'processTask',
          data: task
        });
      } catch (e) {
        console.error('[VEO] Retry failed:', e);
        isProcessing = false;
      }
    }, 2000);
  }
}

// Execute click in page context using chrome.scripting API (bypasses CSP)
async function clickElementInPage(tabId, searchText) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabId },
      func: (text) => {
        const selectors = [
          'button',
          '[role="button"]',
          '[role="option"]',
          '[role="menuitem"]',
          '[role="listbox"] *',
          '[role="menu"] *',
          '[role="listbox"]',
          '[role="menu"]',
          'li',
          'div[tabindex]',
          'span[tabindex]'
        ].join(', ');

        const elements = document.querySelectorAll(selectors);
        let targetElement = null;
        let allTexts = [];

        console.log('[VEO-INJECTED] Searching for:', text);
        console.log('[VEO-INJECTED] Found', elements.length, 'potential elements');

        let allMatches = [];

        for (const el of elements) {
          const elText = el.innerText || el.textContent || '';
          if (allTexts.length < 20 && elText.trim()) {
            allTexts.push(elText.substring(0, 50).replace(/\n/g, ' '));
          }

          if (elText.includes(text)) {
            const rect = el.getBoundingClientRect();
            allMatches.push({
              tag: el.tagName,
              role: el.getAttribute('role'),
              text: elText.substring(0, 40).replace(/\n/g, ' '),
              top: Math.round(rect.top),
              left: Math.round(rect.left),
              visible: rect.width > 0 && rect.height > 0
            });

            if (!targetElement) {
              targetElement = el;
            } else if (text.length <= 5 && el.tagName === 'I' && targetElement.tagName !== 'I') {
              targetElement = el;
            } else if (el.tagName === 'BUTTON' && targetElement.tagName !== 'BUTTON' && targetElement.tagName !== 'I') {
              targetElement = el;
            } else if (el.tagName === targetElement.tagName && el.innerText.length < targetElement.innerText.length) {
              targetElement = el;
            }
          }
        }

        console.log('[VEO-INJECTED] All matches for "' + text + '":', allMatches);
        console.log('[VEO-INJECTED] Sample elements found:', allTexts.slice(0, 10));

        if (!targetElement) {
          console.log('[VEO-INJECTED] Not found:', text);
          return { success: false, searched: text, sampleElements: allTexts.slice(0, 5) };
        }

        console.log('[VEO-INJECTED] Found element:', targetElement.innerText?.substring(0, 50), 'Tag:', targetElement.tagName, 'Role:', targetElement.getAttribute('role'));

        const rect = targetElement.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        const eventOptions = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY,
          screenX: centerX,
          screenY: centerY,
          button: 0,
          buttons: 1
        };

        const pointerOptions = {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: centerX,
          clientY: centerY,
          screenX: centerX,
          screenY: centerY,
          pointerId: 1,
          pointerType: 'mouse',
          isPrimary: true,
          button: 0,
          buttons: 1,
          width: 1,
          height: 1,
          pressure: 0.5
        };

        targetElement.dispatchEvent(new PointerEvent('pointerover', pointerOptions));
        targetElement.dispatchEvent(new PointerEvent('pointerenter', pointerOptions));
        targetElement.dispatchEvent(new PointerEvent('pointermove', pointerOptions));
        targetElement.dispatchEvent(new PointerEvent('pointerdown', pointerOptions));
        targetElement.focus();
        targetElement.dispatchEvent(new PointerEvent('pointerup', pointerOptions));
        targetElement.dispatchEvent(new MouseEvent('mouseenter', eventOptions));
        targetElement.dispatchEvent(new MouseEvent('mouseover', eventOptions));
        targetElement.dispatchEvent(new MouseEvent('mousemove', eventOptions));
        targetElement.dispatchEvent(new MouseEvent('mousedown', { ...eventOptions, buttons: 1 }));
        targetElement.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        targetElement.dispatchEvent(new MouseEvent('click', eventOptions));
        targetElement.click();

        console.log('[VEO-INJECTED] Dispatched full pointer+mouse event sequence for:', text);
        return { success: true, clicked: text, element: targetElement.tagName };
      },
      args: [searchText],
      world: 'MAIN'
    });
    console.log('[VEO] executeScript result:', results);
    return results[0]?.result;
  } catch (error) {
    console.error('[VEO] executeScript error:', error);
    return { success: false, error: error.message };
  }
}

// ============================================
// TASK COMPLETION HANDLING
// ============================================

// ============================================
// FIFO MODE - Task Completion Handlers
// These don't wait for page reload!
// ============================================

async function handleTaskCompletedFIFO(data) {
  // EARLY BAIL: if user clicked Stop, don't even fetch media or submit result.
  // In-flight API calls finish in async-land — without this, every pending
  // generation that resolves AFTER stop still POSTs to the webhook.
  if (globalStopFlag) {
    console.log('[VEO FIFO] ⛔ STOP active — dropping completion for:', data.taskId);
    isProcessing = false;
    return;
  }

  console.log('[VEO FIFO] Task completed:', data.taskId);

  // Don't set waitingForReload - we want to continue!
  isProcessing = false;

  try {
    // v9.0.1: Fetch media as base64 using chrome.scripting.executeScript in MAIN world
    // MAIN world has access to Google's session cookies (content scripts don't!)
    let mediaFiles = [];
    try {
      const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
      if (tabs.length > 0) {
        // Parse URLs from resultUrl, handling data URLs (which contain internal commas)
        // data URLs look like: "data:image/jpeg;base64,/9j/..." - split(',') would break them
        const rawParts = (data.resultUrl || '').split(',');
        const urls = [];
        for (let i = 0; i < rawParts.length; i++) {
          if (rawParts[i].startsWith('http')) {
            urls.push(rawParts[i]);
          } else if (rawParts[i].startsWith('data:')) {
            // Data URL was split at its internal comma - rejoin with next part
            if (i + 1 < rawParts.length && !rawParts[i + 1].startsWith('http') && !rawParts[i + 1].startsWith('data:')) {
              urls.push(rawParts[i] + ',' + rawParts[i + 1]);
              i++; // skip the base64 content part
            } else {
              urls.push(rawParts[i]);
            }
          }
        }
        console.log(`[VEO FIFO] Fetching ${urls.length} media file(s) as base64 (MAIN world)...`);

        for (const url of urls) {
          // Handle data URLs (from image upscale) - extract base64 directly
          if (url.startsWith('data:')) {
            try {
              const [header, b64] = url.split(',');
              const mimeType = header.split(':')[1].split(';')[0];
              const size = Math.round(b64.length * 3 / 4);
              mediaFiles.push({ base64: b64, mimeType, size, originalUrl: '(upscaled-image)' });
              console.log(`[VEO FIFO] ✓ Upscaled image from data URL: ${(size / 1024).toFixed(0)}KB (${mimeType})`);
            } catch (e) {
              console.error('[VEO FIFO] Failed to parse data URL:', e.message);
            }
            continue;
          }
          let fetched = false;
          for (let fetchAttempt = 1; fetchAttempt <= 3 && !fetched; fetchAttempt++) {
            try {
              // Re-query tabs in case page reloaded
              const freshTabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
              if (freshTabs.length === 0) {
                console.log('[VEO FIFO] No Flow tab for media fetch');
                break;
              }
              if (fetchAttempt > 1) {
                if (globalStopFlag) break;
                console.log(`[VEO FIFO] Media fetch retry ${fetchAttempt}/3, waiting 3s...`);
                await new Promise(r => setTimeout(r, 3000));
                if (globalStopFlag) break;
              }
              const results = await chrome.scripting.executeScript({
                target: { tabId: freshTabs[0].id },
                world: 'MAIN',
                func: async (mediaUrl) => {
                  try {
                    const response = await fetch(mediaUrl);
                    if (!response.ok) {
                      return { error: `HTTP ${response.status} ${response.statusText}` };
                    }
                    const blob = await response.blob();
                    if (blob.size > 50 * 1024 * 1024) {
                      return { error: `Too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB` };
                    }
                    return new Promise((resolve) => {
                      const reader = new FileReader();
                      reader.onloadend = () => resolve({
                        base64: reader.result.split(',')[1],
                        mimeType: blob.type || 'application/octet-stream',
                        size: blob.size
                      });
                      reader.onerror = () => resolve({ error: 'FileReader failed' });
                      reader.readAsDataURL(blob);
                    });
                  } catch (e) {
                    return { error: e.message || 'Unknown fetch error' };
                  }
                },
                args: [url]
              });
              const mediaData = results?.[0]?.result;
              if (mediaData && mediaData.base64) {
                mediaFiles.push({
                  base64: mediaData.base64,
                  mimeType: mediaData.mimeType,
                  size: mediaData.size,
                  originalUrl: url
                });
                console.log(`[VEO FIFO] ✓ Fetched media: ${(mediaData.size / 1024).toFixed(0)}KB (${mediaData.mimeType})`);
                fetched = true;
              } else {
                console.log(`[VEO FIFO] ⚠ Media fetch attempt ${fetchAttempt}/3 failed:`, mediaData?.error || 'unknown');
              }
            } catch (e) {
              console.log(`[VEO FIFO] ⚠ Media fetch attempt ${fetchAttempt}/3 error: ${e.message}`);
            }
          }
        }
      }
    } catch (e) {
      console.log('[VEO FIFO] Could not fetch media:', e.message);
    }

    // Skip result submission if stopped
    if (globalStopFlag) {
      console.log('[VEO FIFO] Stopped - skipping result submission for:', data.taskId);
      return;
    }

    // Submit result to webhook with retry (up to 3 attempts)
    let webhookSuccess = false;
    for (let webhookAttempt = 1; webhookAttempt <= 3 && !webhookSuccess; webhookAttempt++) {
      try {
        const response = await fetch(RESULT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'ResultSubmission',
            taskId: data.taskId,
            resultUrl: data.resultUrl,
            mode: data.mode || 'image',
            timestamp: new Date().toISOString(),
            mediaFiles: mediaFiles.length > 0 ? mediaFiles : null
          })
        });

        const responseText = await response.text();
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${responseText.substring(0, 300)}`);
        }
        // Check if n8n actually accepted the result (not just HTTP 200)
        let parsedResp;
        try { parsedResp = JSON.parse(responseText); } catch (e) { parsedResp = {}; }
        if (parsedResp.success === false) {
          console.warn(`[VEO FIFO] n8n returned success:false - treating as failed submission`);
          throw new Error('n8n rejected result (success:false)');
        }
        console.log(`[VEO FIFO] Result submitted (HTTP ${response.status}):`, responseText.substring(0, 200));
        webhookSuccess = true;
      } catch (webhookErr) {
        console.error(`[VEO FIFO] Webhook attempt ${webhookAttempt}/3 failed:`, webhookErr.message);
        if (webhookAttempt < 3) {
          const delay = 5000 * webhookAttempt;
          console.log(`[VEO FIFO] Retrying webhook in ${delay / 1000}s...`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (webhookSuccess) {
      await markJobAsCompleted(data.taskId);
      const { stats } = await chrome.storage.local.get('stats');
      await chrome.storage.local.set({
        stats: {
          ...stats,
          processed: (stats?.processed || 0) + 1
        }
      });
      console.log('[VEO FIFO] Task done, continuing...');
    } else {
      // DON'T mark as completed - task stays in processing so RetryFailed can pick it up
      console.error('[VEO FIFO] CRITICAL: Webhook failed after 3 attempts for task:', data.taskId, '- NOT marking as completed');
    }

  } catch (error) {
    console.error('[VEO FIFO] Failed to submit result:', error);
    // DON'T mark as completed - let RetryFailed pick it up
    console.error('[VEO FIFO] Task NOT marked as completed - will be retried via RetryFailed');
  }
}

async function handleTaskFailedFIFO(data) {
  console.log('[VEO FIFO] Task permanently failed:', data.task?.id, data.error);

  // DON'T reset contentScriptBusy - content script may still be processing other tasks!
  // contentScriptBusy is only reset by requestNextTask

  const task = data.task;
  const errorMessage = data.error || 'Unknown error';

  // Track permanently failed tasks for end-of-run notification
  const rowId = task?.id?.split('_')[0] || task?.id;
  let reason = 'Unknown error';
  if (errorMessage.includes('PUBLIC_ERROR_IP_INPUT_IMAGE')) {
    reason = 'Image rejected (copyright/IP violation detected by Google)';
  } else if (errorMessage.includes('PUBLIC_ERROR_AUDIO_FILTERED')) {
    reason = 'Audio content filtered';
  } else if (errorMessage.includes('PUBLIC_ERROR_MODEL_ACCESS_DENIED')) {
    reason = 'Model access denied (account may not have access to this model)';
  } else if (errorMessage.includes('PERMISSION_DENIED')) {
    reason = 'Permission denied';
  } else if (errorMessage.includes('violate') || errorMessage.includes('policy')) {
    reason = 'Content policy violation';
  } else {
    reason = errorMessage.substring(0, 100);
  }
  permanentlyFailedTasks.push({ rowId, taskId: task?.id, reason });
  
  // Send failure to n8n
  try {
    await fetch(RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'TaskFailed',
        taskId: task?.id,
        error: errorMessage,
        timestamp: new Date().toISOString()
      })
    });
    console.log('[VEO FIFO] Failure reported to n8n');
  } catch (e) {
    console.error('[VEO FIFO] Failed to report error:', e);
  }
  
  // Mark as completed (failed) so it doesn't get picked up again
  await markJobAsCompleted(task?.id);
  
  // Update stats
  const { stats } = await chrome.storage.local.get('stats');
  await chrome.storage.local.set({
    stats: {
      ...stats,
      failed: (stats?.failed || 0) + 1
    }
  });
}

// ============================================
// FIFO MODE - Poll without blocking checks
// ============================================

// Track recently sent tasks to prevent race condition duplicates
let recentlySentTaskIds = new Map();
// Track if RetryFailed was already sent (to avoid spamming)
let retryFailedSent = false;
let retryFailedCycles = 0;  // Count consecutive RetryFailed cycles to detect stuck loops
const MAX_RETRY_CYCLES = 3;  // Stop retrying after this many consecutive cycles with same rows
let permanentlyFailedTasks = [];  // Track tasks that permanently failed with their error reasons
let allowReprocessing = false;  // Separate flag: stays true during retry cycles so already-processed tasks can be re-run
const DUPLICATE_PREVENTION_MS = 5000;  // Prevent same task within 5 seconds

async function pollForTasksFIFO(opts = {}) {
  console.log('[VEO FIFO] ========================================');
  console.log('[VEO FIFO] Polling for next task...');

  // Check if stopped
  if (globalStopFlag) {
    console.log('[VEO FIFO] ⛔ STOPPED - not polling');
    return { stopped: true };
  }

  // Lock contention strategy: callers from fillInitialSlots pass {waitForLock:true}
  // so 5 parallel poll calls queue through the lock (instead of 4 of them skipping).
  // Other callers (alarm, completion handler, manual UI) keep the original SKIP
  // behavior — they shouldn't queue up indefinitely behind a slow poll.
  if (pollingInProgress) {
    if (opts.waitForLock) {
      while (pollingInProgress) {
        if (globalStopFlag) return { stopped: true };
        await new Promise(r => setTimeout(r, 50));
      }
    } else {
      console.log('[VEO FIFO] ⚠️ Another poll already in progress - SKIPPING to prevent race condition');
      return { skipped: true, reason: 'poll_in_progress' };
    }
  }

  // Check if at capacity (may have changed while waiting for lock)
  if (activeTaskCount >= MAX_CONCURRENT) {
    console.log(`[VEO FIFO] At capacity (${activeTaskCount}/${MAX_CONCURRENT}), skipping poll`);
    return { skipped: true, reason: 'at_capacity' };
  }

  // Set polling lock IMMEDIATELY before any async operations.
  // Synchronous between the while-loop exit above and this set, so no race.
  pollingInProgress = true;
  console.log('[VEO FIFO] 🔒 Polling lock acquired');

  try {
    await chrome.storage.local.set({ lastPoll: new Date().toISOString() });

    // Find Flow tab first
    const tabs = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
    console.log('[VEO FIFO] Found', tabs.length, 'Flow tabs');

    if (tabs.length === 0) {
      console.log('[VEO FIFO] No Flow tab found!');
      return { error: 'No Flow tab' };
    }

    const flowTab = tabs[0];

    // Check if content-bridge is alive (needed for reCAPTCHA tokens)
    let bridgeAlive = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await chrome.tabs.sendMessage(flowTab.id, { action: 'ping' });
        console.log('[VEO FIFO] Content bridge is alive');
        bridgeAlive = true;
        break;
      } catch (e) {
        console.log(`[VEO FIFO] Content bridge ping attempt ${attempt}/3 failed`);
        if (attempt < 3) {
          await new Promise(r => setTimeout(r, 1500));
        }
      }
    }
    if (!bridgeAlive) {
      console.log('[VEO FIFO] Content bridge disconnected - reloading tab...');
      await chrome.tabs.reload(flowTab.id);
      // Wait for bridge to reload
      await new Promise(r => setTimeout(r, 5000));
      try {
        await chrome.tabs.sendMessage(flowTab.id, { action: 'ping' });
      } catch (e) {
        return { error: 'Content bridge not ready after reload' };
      }
    }

    // Now fetch task
    console.log('[VEO FIFO] Fetching from:', POLL_URL);
    const response = await fetch(POLL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'TaskRequest',
        mode: currentMode
      })
    });

    let task;
    try {
      const responseText = await response.text();
      task = responseText ? JSON.parse(responseText) : {};
    } catch (parseErr) {
      // Empty or invalid JSON response = no tasks available
      console.log('[VEO FIFO] Empty/invalid response from webhook - treating as no tasks');
      task = {};
    }
    console.log('[VEO FIFO] Poll response:', JSON.stringify(task).substring(0, 200));

    // Validate task - check for id and appropriate prompt based on mode
    const taskMode = (task.mode || '').toLowerCase();
    const hasValidPrompt = task.prompt ||
      (taskMode === 'imagegen' && task.imagePrompt) ||
      (taskMode === 'createimage' && task.imagePrompt);

    if (!task || !task.id || !hasValidPrompt) {
      console.log('[VEO FIFO] No valid task available (missing id or prompt for mode:', taskMode, ')');

      // If no tasks in flight (including upscale) and no pending tasks, check for failed/stuck rows
      // Wait 10s before sending RetryFailed to give n8n time to update Baserow rows
      if (tasksInFlight === 0 && activeTaskCount === 0 && !retryFailedSent) {
        // Check if we've been stuck in a retry loop (same rows keep coming back)
        if (retryFailedCycles >= MAX_RETRY_CYCLES) {
          const { keepAlivePolling } = await chrome.storage.local.get('keepAlivePolling');
          if (keepAlivePolling) {
            console.log(`[VEO FIFO] Retry limit reached but Keep Alive is ON - resetting and continuing to poll...`);
            retryFailedSent = false;
            retryFailedCycles = 0;
            allowReprocessing = false;
            permanentlyFailedTasks = [];
            await chrome.storage.local.set({ processedJobIds: [] });  // Clear history so new batches work
            return { noTasks: true };
          }
          console.log(`[VEO FIFO] ✓ Retry limit reached (${MAX_RETRY_CYCLES} cycles). All remaining rows are permanently failed. Stopping.`);
          retryFailedSent = true; // Prevent re-entering this block on next alarm
          allowReprocessing = false;  // No more reprocessing
          if (permanentlyFailedTasks.length > 0) {
            notifyPermanentlyFailed(permanentlyFailedTasks);
          } else {
            notifyAllTasksDone(0, 0);
          }
          await stopPolling();
          return { noTasks: true };
        }
        console.log('[VEO FIFO] No tasks and none in flight - waiting 10s for n8n to finish, then checking for failed/stuck rows...');
        retryFailedSent = true;
        await new Promise(r => setTimeout(r, 10000));
        if (globalStopFlag) return { stopped: true };
        try {
          const retryResp = await fetch(POLL_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'RetryFailed' })
          });
          const retryResult = await retryResp.json();
          console.log('[VEO FIFO] RetryFailed response:', JSON.stringify(retryResult).substring(0, 200));

          if (retryResult.allCompleted) {
            allowReprocessing = false;  // All done, no more reprocessing
            const { keepAlivePolling } = await chrome.storage.local.get('keepAlivePolling');
            if (keepAlivePolling) {
              console.log('[VEO FIFO] ✓ All tasks completed! Keep Alive is ON - continuing to poll for new tasks...');
              retryFailedSent = false;
              retryFailedCycles = 0;
              permanentlyFailedTasks = [];
              await chrome.storage.local.set({ processedJobIds: [] });  // Clear history so new batches work
              // Don't stop polling, just reset and wait for new tasks
            } else {
              console.log('[VEO FIFO] ✓ All tasks completed! No failed/stuck rows.');
              if (permanentlyFailedTasks.length > 0) {
                notifyPermanentlyFailed(permanentlyFailedTasks);
              } else {
                notifyAllTasksDone(0, 0);
              }
            }
          } else if (retryResult.retryCount > 0) {
            retryFailedCycles++;
            allowReprocessing = true;  // Allow already-processed tasks to be re-run during retry cycles
            console.log(`[VEO FIFO] Found ${retryResult.retryCount} failed/stuck rows - resetting to pending, will retry... (cycle ${retryFailedCycles}/${MAX_RETRY_CYCLES})`);
            retryFailedSent = false; // Allow another check after retry cycle
            // Continue polling - the reset row will be picked up
            return { noTasks: false, retrying: true };
          }
        } catch (e) {
          console.log('[VEO FIFO] RetryFailed request failed:', e.message);
        }
      }

      return { noTasks: true };
    }

    // Check if already processed - but if RetryFailed just ran, allow re-processing
    const { processedJobIds } = await chrome.storage.local.get('processedJobIds');
    if ((processedJobIds || []).includes(task.id)) {
      if (allowReprocessing) {
        // RetryFailed reset this row to pending - remove from processed list and re-process
        console.log('[VEO FIFO] Task was processed before but RetryFailed reset it - re-processing:', task.id);
        const updatedIds = (processedJobIds || []).filter(id => id !== task.id);
        await chrome.storage.local.set({ processedJobIds: updatedIds });
      } else {
        console.log('[VEO FIFO] Task already processed:', task.id, '- not resetting retry flag');
        return { skipped: true, reason: 'already_processed' };
      }
    }

    // Reset retry flag and cycle counter when we get a genuinely new task
    retryFailedSent = false;
    retryFailedCycles = 0;
    allowReprocessing = false;

    // Check for race condition duplicates (same task sent twice within 5 seconds)
    const now = Date.now();
    const lastSentTime = recentlySentTaskIds.get(task.id);
    if (lastSentTime && (now - lastSentTime) < DUPLICATE_PREVENTION_MS) {
      console.log(`[VEO FIFO] ⚠️ Task ${task.id} was just sent ${now - lastSentTime}ms ago - SKIPPING duplicate`);
      return { skipped: true, reason: 'duplicate_prevention' };
    }

    // Track this send
    recentlySentTaskIds.set(task.id, now);
    // Clean old entries (older than 30 seconds)
    for (const [id, time] of recentlySentTaskIds.entries()) {
      if (now - time > 30000) recentlySentTaskIds.delete(id);
    }

    // Check stop flag before executing
    if (globalStopFlag) {
      console.log('[VEO FIFO] ⛔ STOPPED after poll - not executing task');
      return { stopped: true };
    }

    // Check if we have capacity
    if (activeTaskCount >= MAX_CONCURRENT) {
      console.log(`[VEO FIFO] At capacity (${activeTaskCount}/${MAX_CONCURRENT}), waiting...`);
      return { atCapacity: true };
    }

    // Launch task
    activeTaskCount++;
    tasksInFlight++;
    contentScriptBusy = activeTaskCount > 0;
    console.log(`[VEO FIFO] Executing task via API: ${task.id} (active: ${activeTaskCount}/${MAX_CONCURRENT}, inFlight: ${tasksInFlight})`);

    // Execute task (async - fire and forget, completion handler polls for more)
    executeTaskViaAPIWithRetry(task, flowTab.id).then(async (result) => {
      tasksInFlight = Math.max(0, tasksInFlight - 1);
      console.log(`[VEO FIFO] ✓ Task completed: ${task.id} (active: ${activeTaskCount - 1}, inFlight: ${tasksInFlight})`);
      activeTaskCount = Math.max(0, activeTaskCount - 1);
      contentScriptBusy = activeTaskCount > 0;
      await handleTaskCompletedFIFO(result);
      // Give n8n ~1s to commit the Update Video_URL1 (status='completed') before the
      // next poll fires. Otherwise a concurrent RetryFailed query can find the row
      // still in 'processing' state and reset it to pending — race condition fix.
      if (!globalStopFlag) {
        await new Promise(r => setTimeout(r, 1000));
        pollForTasksFIFO();
      }
    }).catch(async (error) => {
      tasksInFlight = Math.max(0, tasksInFlight - 1);
      console.error(`[VEO FIFO] ✗ Task failed: ${task.id}:`, error.message.substring(0, 100));
      activeTaskCount = Math.max(0, activeTaskCount - 1);
      contentScriptBusy = activeTaskCount > 0;
      if (error.message !== 'STOP_REQUESTED') {
        await handleTaskFailedFIFO({ task: task, error: error.message });
        if (!globalStopFlag) {
          await new Promise(r => setTimeout(r, 1000));
          pollForTasksFIFO();
        }
      }
    });

    return { success: true, task: task };

  } catch (error) {
    console.error('[VEO FIFO] ✗ Poll error:', error.message);
    return { error: error.message };
  } finally {
    // CRITICAL: Always release the polling lock
    pollingInProgress = false;
    console.log('[VEO FIFO] 🔓 Polling lock released');
  }
}

// ============================================
// Original handlers (kept for compatibility)
// ============================================

async function handleTaskCompleted(data) {
  console.log('[VEO] Task completed:', data);
  
  // CRITICAL: Set flag IMMEDIATELY as the very first thing!
  // This prevents any new tasks from being processed before page reload
  await chrome.storage.local.set({ waitingForReload: true });
  console.log('[VEO] waitingForReload flag set IMMEDIATELY');
  
  isProcessing = false;

  try {
    const response = await fetch(RESULT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'ResultSubmission',
        taskId: data.taskId,
        resultUrl: data.resultUrl,
        mode: data.mode || 'image',
        timestamp: new Date().toISOString()
      })
    });

    const result = await response.json();
    console.log('[VEO] Result submitted:', result);

    await markJobAsCompleted(data.taskId);

    const { stats } = await chrome.storage.local.get('stats');
    await chrome.storage.local.set({
      currentTask: null,
      currentJobId: null,  // Also clear this!
      stats: {
        ...stats,
        processed: (stats?.processed || 0) + 1
      }
    });
    
    console.log('[VEO] Waiting for page reload (content script will reload the page)...');
    
  } catch (error) {
    console.error('[VEO] Failed to submit result:', error);
    await markJobAsCompleted(data.taskId);
    await chrome.storage.local.set({ currentTask: null, currentJobId: null });
  }
}

async function handleTaskFailed(data) {
  console.log('[VEO] Task failed:', data);
  
  const task = data.task;
  const errorMessage = data.error || 'Unknown error';
  const currentRetry = task?.retryCount || 0;
  
  // Check if this is a VEO generation error (audio failed, etc.) or extension error
  const isVeoError = errorMessage.includes('VEO_GENERATION_ERROR');
  
  // ALL errors should be retryable (VEO errors AND extension errors)
  // Only non-retryable would be explicit "do not retry" messages
  const isRetryable = true;  // Retry everything!
  
  console.log(`[VEO] Error type: ${isVeoError ? 'VEO Generation Error' : 'Extension Error'}, Retryable: ${isRetryable}, Retry ${currentRetry + 1}/${MAX_RETRIES}`);
  
  // Check if we should retry
  if (isRetryable && currentRetry < MAX_RETRIES && task) {
    console.log(`[VEO] Scheduling retry ${currentRetry + 1}/${MAX_RETRIES} for task ${task.id}`);
    
    // Remove from processed jobs so it can be retried
    const { processedJobIds } = await chrome.storage.local.get('processedJobIds');
    const updatedJobIds = (processedJobIds || []).filter(id => id !== task.id);
    
    // Increment retry count
    task.retryCount = currentRetry + 1;
    
    await chrome.storage.local.set({
      processedJobIds: updatedJobIds,
      currentTask: null,
      currentJobId: null,
      waitingForReload: true,
      // Store the task to retry
      pendingRetryTask: task
    });
    
    console.log(`[VEO] Task ${task.id} will be retried on next poll (attempt ${task.retryCount}/${MAX_RETRIES})`);
    isProcessing = false;
    
    console.log('[VEO] Waiting for page reload before retry...');
    return;
  }
  
  // No more retries - mark as permanently failed
  console.log(`[VEO] Task ${task?.id} permanently failed after ${currentRetry} retries`);
  
  // CRITICAL: Set flag IMMEDIATELY as the very first thing!
  await chrome.storage.local.set({ waitingForReload: true });
  console.log('[VEO] waitingForReload flag set IMMEDIATELY after failure');
  
  isProcessing = false;

  await markJobAsFailed(data.task?.id);

  const { stats } = await chrome.storage.local.get('stats');
  await chrome.storage.local.set({
    currentTask: null,
    currentJobId: null,  // Also clear this!
    pendingRetryTask: null, // Clear any pending retry
    stats: {
      ...stats,
      failed: (stats?.failed || 0) + 1
    }
  });
  
  console.log('[VEO] Waiting for page reload after permanent failure...');
}

// ============================================
// MANUAL MODE (BASEROW) FUNCTIONS
// ============================================

async function baserowConnect(token, tableId, baseUrl) {
  const apiBase = resolveBaserowApi(baseUrl);
  console.log('[VEO Baserow] Connecting to table:', tableId, 'via', apiBase);

  // CRITICAL: Clear old manual mode state when connecting fresh
  // This prevents stale state from blocking the Start button
  if (manualModeActive) {
    console.log('[VEO Baserow] Clearing stale manual mode state before fresh connect');
    manualModeActive = false;
    manualModeTasks = [];
    manualModeNextIndex = 0;
    manualModeCompletedCount = 0;
    manualModeFailedCount = 0;
    manualModeProcessedRowIds.clear();
    await clearManualModeState();
  }

  try {
    const allRows = [];
    let page = 1;

    while (true) {
      const response = await fetch(`${apiBase}/database/rows/table/${tableId}/?user_field_names=true&size=200&page=${page}`, {
        headers: {
          'Authorization': `Token ${token}`
        }
      });

      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(`Baserow API error ${response.status}: ${errText.substring(0, 200)}`);
      }

      const data = await response.json();
      allRows.push(...(data.results || []));
      console.log('[VEO Baserow] Fetched page', page, '-', data.results?.length, 'rows (total so far:', allRows.length, ')');

      if (!data.next) break;
      page++;
    }

    // Store credentials for later use
    manualModeToken = token;
    manualModeTableId = tableId;
    manualModeBaseUrl = baseUrl || '';  // empty = cloud default

    return {
      success: true,
      tasks: allRows,
      count: allRows.length
    };
  } catch (error) {
    console.error('[VEO Baserow] Connection error:', error);
    return { success: false, error: error.message };
  }
}

async function baserowFetchTasks(token, tableId, baseUrl) {
  return baserowConnect(token, tableId, baseUrl);
}

async function baserowUpdateRow(token, tableId, rowId, data, baseUrl) {
  const apiBase = resolveBaserowApi(baseUrl);
  console.log('[VEO Baserow] Updating row', rowId, 'with:', data);

  try {
    const response = await fetch(`${apiBase}/database/rows/table/${tableId}/${rowId}/?user_field_names=true`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Token ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(data)
    });

    if (!response.ok) {
      throw new Error(`Baserow update error: ${response.status}`);
    }

    console.log('[VEO Baserow] Row updated successfully');
    return { success: true };
  } catch (error) {
    console.error('[VEO Baserow] Update error:', error);
    return { success: false, error: error.message };
  }
}

async function startManualMode(token, tableId, tasks, baseUrl) {
  console.log('[VEO Manual] Starting with', tasks.length, 'tasks');

  // Store credentials
  manualModeToken = token;
  manualModeTableId = tableId;
  manualModeBaseUrl = baseUrl || '';

  // Filter to only pending tasks and sort by ID
  manualModeTasks = tasks
    .filter(t => {
      const status = t.Status?.value || t.Status || '';
      return status.toLowerCase() === 'pending';
    })
    .sort((a, b) => {
      const idA = parseInt(a.ID || a.id || 0);
      const idB = parseInt(b.ID || b.id || 0);
      return idA - idB;
    });

  console.log('[VEO Manual] Sorted tasks:', manualModeTasks.map(t => {
    const id = t.ID || t.id;
    const mode = typeof t.Mode === 'string' ? t.Mode : t.Mode?.value || 'text';
    return `${id}(${mode})`;
  }).join(', '));

  // Reset counters
  manualModeNextIndex = 0;
  manualModeCompletedCount = 0;
  manualModeFailedCount = 0;
  manualModeProcessedRowIds.clear();
  manualModeActive = true;
  contentScriptBusy = false;
  globalStopFlag = false;  // CRITICAL: Reset stop flag when starting new session

  // Save state to storage (survives page reloads and service worker restarts)
  await saveManualModeState();

  // Stop any automated polling
  await stopPolling();

  // Find Flow tab and ping content bridge
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
  if (tabs.length === 0) {
    return { success: false, error: 'No Flow tab found. Please open labs.google/fx first.' };
  }

  const flowTabId = tabs[0].id;

  // Ping content bridge to check if it's ready (needed for reCAPTCHA)
  let bridgeReady = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.tabs.sendMessage(flowTabId, { action: 'ping' });
      console.log('[VEO Manual] Content bridge is ready');
      bridgeReady = true;
      break;
    } catch (e) {
      console.log('[VEO Manual] Ping attempt', attempt + 1, 'failed');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  if (!bridgeReady) {
    console.log('[VEO Manual] Content bridge disconnected - reloading tab...');
    await chrome.tabs.reload(flowTabId);
    await new Promise(r => setTimeout(r, 5000));
    try {
      await chrome.tabs.sendMessage(flowTabId, { action: 'ping' });
    } catch (e) {
      return { success: false, error: 'Content bridge not responding. Please refresh labs.google/fx.' };
    }
  }

  // Start initial batch of tasks (up to MAX_CONCURRENT)
  activeTaskCount = 0;
  await fillManualTaskSlots(flowTabId);
  return { success: true, taskCount: manualModeTasks.length };
}

// Fill available slots with new tasks (up to MAX_CONCURRENT running at once)
async function fillManualTaskSlots(tabId) {
  while (activeTaskCount < MAX_CONCURRENT && manualModeActive && manualModeNextIndex < manualModeTasks.length) {
    if (globalStopFlag) break;
    await launchManualTask(tabId);
  }

  if (manualModeNextIndex >= manualModeTasks.length && activeTaskCount === 0) {
    // All tasks sent and completed
  } else {
    console.log(`[VEO Manual] Active: ${activeTaskCount}/${MAX_CONCURRENT}, Queue: ${manualModeTasks.length - manualModeNextIndex} remaining`);
  }
}

async function launchManualTask(tabId) {
  if (!manualModeActive || manualModeNextIndex >= manualModeTasks.length) return;

  const task = manualModeTasks[manualModeNextIndex];
  const userVisibleId = task.ID || task.id;
  const baserowRowId = task.id;
  const taskIndex = manualModeNextIndex + 1;

  console.log(`[VEO Manual] Launching task ${taskIndex}/${manualModeTasks.length} (active: ${activeTaskCount + 1}/${MAX_CONCURRENT})`);

  // Extract mode (handle Single Select object from Baserow)
  const modeRaw = task.Mode || task.mode || '';
  const mode = (typeof modeRaw === 'string' ? modeRaw : modeRaw?.value || 'text').toLowerCase();

  // Extract fields
  let startFrame = task['Start Frame'] || task.startFrame || '';
  let endFrame = task['End Frame'] || task.endFrame || '';
  if (typeof startFrame === 'object' && startFrame?.value) startFrame = startFrame.value;
  if (typeof endFrame === 'object' && endFrame?.value) endFrame = endFrame.value;

  let imageUrl = task['Image URL'] || task.ImageURL || '';
  if (typeof imageUrl === 'object' && imageUrl?.value) imageUrl = imageUrl.value;

  let imagePrompt = task['Image Prompt'] || task.imagePrompt || '';
  if (typeof imagePrompt === 'object' && imagePrompt?.value) imagePrompt = imagePrompt.value;

  let imagegenReference = task['Imagegen Reference'] || task.imagegenReference || '';
  if (typeof imagegenReference === 'object' && imagegenReference?.value) imagegenReference = imagegenReference.value;

  let finalMode = mode;
  if (mode === 'imagegen') {
    finalMode = 'createImage';
  } else if (imagePrompt && imagePrompt.trim()) {
    finalMode = 'createImage';
  }

  const extensionTask = {
    id: `${baserowRowId}_01`,
    baserowRowId: baserowRowId,
    userVisibleId: userVisibleId,
    prompt: task['VEO Prompt'] || task.prompt || '',
    referenceImage: imageUrl,
    startFrame: startFrame,
    endFrame: endFrame,
    imagePrompt: imagePrompt,
    imagegenReference: imagegenReference,
    mode: finalMode,
    isManualMode: true
  };

  // Increment index and active count BEFORE launching (prevents double-launch)
  manualModeNextIndex++;
  activeTaskCount++;
  contentScriptBusy = activeTaskCount > 0;
  await saveManualModeState();

  // Update Baserow status
  await baserowUpdateRow(manualModeToken, manualModeTableId, baserowRowId, { 'Status': 'processing' }, manualModeBaseUrl);

  // Launch task (fire and forget - completion handler fills next slot)
  executeTaskViaAPIWithRetry(extensionTask, tabId).then(async (result) => {
    console.log(`[VEO Manual] ✓ Task completed: ${extensionTask.id} (active: ${activeTaskCount - 1})`);
    activeTaskCount = Math.max(0, activeTaskCount - 1);
    contentScriptBusy = activeTaskCount > 0;
    await handleManualTaskComplete(extensionTask.id, result.resultUrl);
    // Fill the freed slot with next task
    if (manualModeActive) {
      fillManualTaskSlots(tabId);
    }
  }).catch(async (error) => {
    console.error(`[VEO Manual] ✗ Task failed: ${extensionTask.id}:`, error.message.substring(0, 100));
    activeTaskCount = Math.max(0, activeTaskCount - 1);
    contentScriptBusy = activeTaskCount > 0;
    if (error.message !== 'STOP_REQUESTED') {
      await handleManualTaskFailed(extensionTask.id, error.message);
      // Fill the freed slot with next task
      if (manualModeActive) {
        fillManualTaskSlots(tabId);
      }
    }
  });
}

async function handleRequestNextManualTask() {
  if (!manualModeActive) {
    return { manualMode: false };
  }

  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
  if (tabs.length === 0) {
    return { error: 'No Flow tab found' };
  }

  await fillManualTaskSlots(tabs[0].id);
  return { manualMode: true };
}

async function handleManualTaskComplete(taskId, videoUrl) {
  if (!manualModeActive && globalStopFlag) {
    console.log('[VEO Manual] Ignoring completion - manual mode stopped:', taskId);
    return;
  }
  console.log('[VEO Manual] Task completed:', taskId, 'Video:', videoUrl?.substring(0, 50));

  // If videoUrl is a data URL (from image upscale), re-upload to get a real URL
  let finalUrl = videoUrl || '';
  if (finalUrl.startsWith('data:')) {
    try {
      console.log('[VEO Manual] Upscaled image is data URL, re-uploading to get storage URL...');
      const [header, b64] = finalUrl.split(',');
      const mimeType = header.split(':')[1].split(';')[0];
      // Get auth token and project ID from page
      const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
      const flowTab = tabs[0];
      if (!flowTab) throw new Error('No Flow tab found');
      const token = cachedSessionToken || await getSessionTokenFromPage(flowTab.id);
      const pid = cachedProjectId || await getProjectId(flowTab.id);
      if (!pid) throw new Error('Could not get project ID');
      const uploadBody = {
        clientContext: { projectId: pid, tool: 'PINHOLE' },
        imageBytes: b64,
        isUserUploaded: false,
        isHidden: false,
        mimeType: mimeType,
        fileName: 'upscaled_image.jpg'
      };
      const uploadResp = await fetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
        method: 'POST',
        headers: {
          'authorization': `Bearer ${token}`,
          'content-type': 'text/plain;charset=UTF-8',
          'origin': 'https://labs.google',
          'referer': 'https://labs.google/'
        },
        body: JSON.stringify(uploadBody)
      });
      if (uploadResp.ok) {
        const uploadResult = await uploadResp.json();
        const mediaName = uploadResult?.media?.name;
        if (mediaName) {
          // Use getMediaUrlRedirect to get a real URL from the mediaId
          const redirectUrl = `https://labs.google/fx/api/trpc/media.getMediaUrlRedirect?name=${mediaName}`;
          finalUrl = redirectUrl;
          console.log('[VEO Manual] ✓ Upscaled image re-uploaded, mediaId:', mediaName, 'URL:', redirectUrl.substring(0, 80));
        } else {
          console.warn('[VEO Manual] Re-upload succeeded but no media name in response');
          finalUrl = '';
        }
      } else {
        const errText = await uploadResp.text();
        console.error('[VEO Manual] Re-upload failed:', uploadResp.status, errText.substring(0, 200));
        finalUrl = '';
      }
    } catch (e) {
      console.error('[VEO Manual] Failed to re-upload upscaled image:', e.message);
      finalUrl = ''; // Can't store data URL in Baserow
    }
  }

  // Extract baserow row ID from task ID (format: "rowId_01")
  const baserowRowId = parseInt(taskId?.split('_')[0]);

  if (baserowRowId && !manualModeProcessedRowIds.has(baserowRowId)) {
    manualModeProcessedRowIds.add(baserowRowId);
    manualModeCompletedCount++;

    // Update Baserow with completed status and video URL
    await baserowUpdateRow(manualModeToken, manualModeTableId, baserowRowId, {
      'Status': 'completed',
      'Video_URL': finalUrl
    }, manualModeBaseUrl);

    console.log('[VEO Manual] ✓ Row', baserowRowId, 'marked as completed');
  }

  contentScriptBusy = activeTaskCount > 0;

  // Check if all tasks are done
  const totalProcessed = manualModeCompletedCount + manualModeFailedCount;
  if (totalProcessed >= manualModeTasks.length && manualModeActive) {
    console.log('[VEO Manual] ✓ All tasks completed!');
    manualModeActive = false;
    await clearManualModeState();
    notifyAllTasksDone(manualModeCompletedCount, manualModeFailedCount);
  } else if (manualModeActive) {
    await saveManualModeState();
  }
}

async function handleManualTaskFailed(taskId, error) {
  if (!manualModeActive && globalStopFlag) {
    console.log('[VEO Manual] Ignoring failure - manual mode stopped:', taskId);
    return;
  }
  console.log('[VEO Manual] ✗ Task failed:', taskId, error);

  const baserowRowId = parseInt(taskId?.split('_')[0]);

  if (baserowRowId && !manualModeProcessedRowIds.has(baserowRowId)) {
    manualModeProcessedRowIds.add(baserowRowId);
    manualModeFailedCount++;

    await baserowUpdateRow(manualModeToken, manualModeTableId, baserowRowId, {
      'Status': 'failed'
    }, manualModeBaseUrl);

    console.log('[VEO Manual] ✗ Row', baserowRowId, 'marked as failed');
  }

  contentScriptBusy = activeTaskCount > 0;

  // Check if all tasks are done
  const totalProcessed = manualModeCompletedCount + manualModeFailedCount;
  if (totalProcessed >= manualModeTasks.length) {
    console.log('[VEO Manual] All tasks processed (some failed)');
    manualModeActive = false;
    await clearManualModeState();
    notifyAllTasksDone(manualModeCompletedCount, manualModeFailedCount);
  } else {
    // Save state after updating counters
    await saveManualModeState();
  }
}

// Notification when all tasks are done (sound + browser notification)
function notifyPermanentlyFailed(failedTasks) {
  // Group by reason
  const grouped = {};
  for (const t of failedTasks) {
    if (!grouped[t.reason]) grouped[t.reason] = [];
    grouped[t.reason].push(t.rowId);
  }

  let msg = `⚠️ ${failedTasks.length} task(s) permanently failed:\n\n`;
  for (const [reason, rowIds] of Object.entries(grouped)) {
    msg += `❌ ${reason}\n`;
    msg += `   Row IDs: ${rowIds.join(', ')}\n\n`;
  }
  msg += `These rows could not be completed after 3 retries each. To fix them:\n`;
  msg += `1. Check the error reason above\n`;
  msg += `2. Fix the issue (e.g. use different images if copyright detected)\n`;
  msg += `3. Set the rows back to "pending" in Baserow\n`;
  msg += `4. Run the extension again`;

  console.log('[VEO] Permanently failed notification:', msg);

  try {
    chrome.tabs.query({ url: 'https://labs.google/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: (message) => {
            // Play warning sound (descending tones)
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            [784, 523, 330].forEach((freq, i) => {
              const osc = audioCtx.createOscillator();
              const gain = audioCtx.createGain();
              osc.connect(gain);
              gain.connect(audioCtx.destination);
              osc.frequency.value = freq;
              osc.type = 'sine';
              gain.gain.value = 0.3;
              osc.start(audioCtx.currentTime + i * 0.2);
              osc.stop(audioCtx.currentTime + i * 0.2 + 0.25);
            });
            setTimeout(() => alert(message), 600);
          },
          args: [msg]
        });
      }
    });
  } catch (e) {
    console.log('[VEO] Notification error:', e.message);
  }
}

function notifyAllTasksDone(completed, failed) {
  const total = completed + failed;
  const title = failed > 0
    ? `Tasks done: ${completed} completed, ${failed} failed`
    : `All ${completed} tasks completed!`;

  // Play notification sound via offscreen or tab
  try {
    chrome.tabs.query({ url: 'https://labs.google/*' }, (tabs) => {
      if (tabs.length > 0) {
        chrome.scripting.executeScript({
          target: { tabId: tabs[0].id },
          func: (msg) => {
            // Play a pleasant notification sound
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            // Play 3 ascending tones
            [523, 659, 784].forEach((freq, i) => {
              const osc = audioCtx.createOscillator();
              const gain = audioCtx.createGain();
              osc.connect(gain);
              gain.connect(audioCtx.destination);
              osc.frequency.value = freq;
              osc.type = 'sine';
              gain.gain.value = 0.3;
              osc.start(audioCtx.currentTime + i * 0.15);
              osc.stop(audioCtx.currentTime + i * 0.15 + 0.2);
            });
            // Also show alert
            setTimeout(() => alert(msg), 500);
          },
          args: [title]
        });
      }
    });
  } catch (e) {
    console.log('[VEO] Notification error:', e.message);
  }

  console.log('[VEO] Notification:', title);
}
