// VEO Flow Automation - Popup Script v9.0.0
// Combined: Automated Mode (FIFO) + Manual Mode (Baserow)

const FLOW_URL = 'https://labs.google/fx/de/tools/flow';
const DEFAULT_POLL_URL = 'https://n8n.n8nsamerjonas.de/webhook/Veo-polling';
const DEFAULT_RESULT_URL = 'https://n8n.n8nsamerjonas.de/webhook/Veo-polling';
const UPDATE_SERVER = 'http://78.46.146.79:8090';

let currentMode = 'automated';
let manualTasks = [];

// ============================================
// DOM ELEMENTS
// ============================================

const tabAutomated = document.getElementById('tab-automated');
const tabManual = document.getElementById('tab-manual');
const automatedModeDiv = document.getElementById('automated-mode');
const manualModeDiv = document.getElementById('manual-mode');

// Automated
const pollingToggle = document.getElementById('polling-toggle');
const toggleLabel = document.getElementById('toggle-label');
const keepAliveToggle = document.getElementById('keep-alive-toggle');
const keepAliveLabel = document.getElementById('keep-alive-label');
const statusIndicator = document.getElementById('status-indicator');
const currentStatus = document.getElementById('current-status');
const lastPoll = document.getElementById('last-poll');
const processedCount = document.getElementById('processed-count');
const failedCount = document.getElementById('failed-count');
const historyCount = document.getElementById('history-count');
const pollNowBtn = document.getElementById('poll-now-btn');
const openFlowBtn = document.getElementById('open-flow-btn');
const taskInfo = document.getElementById('task-info');
const taskId = document.getElementById('task-id');

// Mode display (removed from UI in v9.0.0)

// Manual
const connectionStatus = document.getElementById('connection-status');
const baserowTokenInput = document.getElementById('baserow-token');
const baserowTableIdInput = document.getElementById('baserow-table-id');
const baserowUrlInput = document.getElementById('baserow-url');
const connectBaserowBtn = document.getElementById('connect-baserow-btn');
const taskListCard = document.getElementById('task-list-card');
const taskCount = document.getElementById('task-count');
const taskSummary = document.getElementById('task-summary');
const taskTableBody = document.getElementById('task-table-body');
const filterPendingCheckbox = document.getElementById('filter-pending');
const refreshTasksBtn = document.getElementById('refresh-tasks-btn');
const startManualBtn = document.getElementById('start-manual-btn');
const stopManualBtn = document.getElementById('stop-manual-btn');
const manualStats = document.getElementById('manual-stats');
const manualProcessed = document.getElementById('manual-processed');
const manualFailed = document.getElementById('manual-failed');
const manualPending = document.getElementById('manual-pending');

// Outputs selector
const outputsSelector = document.getElementById('outputs-selector');
// output-mode-badge removed from UI
const outputBtns = document.querySelectorAll('.output-btn');

// Common
const clearTaskBtn = document.getElementById('clear-task-btn');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const settingsToggle = document.getElementById('settings-toggle');
const settingsAccordion = document.getElementById('settings-accordion');
const pollUrlInput = document.getElementById('poll-url');
const resultUrlInput = document.getElementById('result-url');
const saveUrlsBtn = document.getElementById('save-urls-btn');

// Mode icons (SVG)
const modeIcons = {
  text: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
    <polyline points="14 2 14 8 20 8"></polyline>
    <line x1="16" y1="13" x2="8" y2="13"></line>
    <line x1="16" y1="17" x2="8" y2="17"></line>
  </svg>`,
  image: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <polyline points="21 15 16 10 5 21"></polyline>
  </svg>`,
  frames: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="2" y="2" width="8" height="8" rx="1"></rect>
    <rect x="14" y="2" width="8" height="8" rx="1"></rect>
    <path d="M9 6h6"></path>
    <path d="M12 3v6"></path>
    <rect x="8" y="14" width="8" height="8" rx="1"></rect>
  </svg>`,
  imagegen: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <path d="M21 15l-5-5L5 21"></path>
    <path d="M17 3l2 2-2 2"></path>
    <path d="M21 7l-2-2 2-2"></path>
  </svg>`,
  createImage: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
    <circle cx="8.5" cy="8.5" r="1.5"></circle>
    <path d="M21 15l-5-5L5 21"></path>
    <path d="M17 3l2 2-2 2"></path>
    <path d="M21 7l-2-2 2-2"></path>
  </svg>`
};

const modeLabels = {
  text: { name: 'Text to Video', desc: 'Prompt only' },
  image: { name: 'Image to Video', desc: 'Prompt + reference image' },
  frames: { name: 'Frames to Video', desc: 'Start + End frame' },
  imagegen: { name: 'Create Image', desc: 'Image generation' },
  createImage: { name: 'Create Image', desc: 'Image generation' }
};

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  await updateUI();

  // Non-blocking update check
  checkForUpdate();

  // Non-blocking status message check
  checkStatusMessage();

  // Mode tabs
  tabAutomated.addEventListener('click', () => switchMode('automated'));
  tabManual.addEventListener('click', () => switchMode('manual'));

  // Automated
  pollingToggle.addEventListener('change', handlePollingToggle);
  keepAliveToggle.addEventListener('change', handleKeepAliveToggle);
  if (pollNowBtn) pollNowBtn.addEventListener('click', handlePollNow);
  if (openFlowBtn) openFlowBtn.addEventListener('click', handleOpenFlow);
  settingsToggle.addEventListener('click', () => settingsAccordion.classList.toggle('open'));
  saveUrlsBtn.addEventListener('click', handleSaveUrls);

  // Manual
  connectBaserowBtn.addEventListener('click', handleConnectBaserow);
  refreshTasksBtn?.addEventListener('click', handleRefreshTasks);
  filterPendingCheckbox?.addEventListener('change', renderTaskTable);
  startManualBtn.addEventListener('click', handleStartManual);
  stopManualBtn.addEventListener('click', handleStopManual);

  // Outputs selector
  outputBtns.forEach(btn => {
    if (btn.dataset.count) {
      btn.addEventListener('click', () => handleOutputSelect(parseInt(btn.dataset.count)));
    }
  });

  // v13: Generate Mode selector (Image | Video) — toggles model/aspect/upscale visibility
  document.querySelectorAll('[data-genmode]').forEach(btn => {
    btn.addEventListener('click', () => handleGenerateModeSelect(btn.dataset.genmode));
  });

  // Video Aspect Ratio selector (Landscape | Portrait)
  document.querySelectorAll('[data-aspect]').forEach(btn => {
    btn.addEventListener('click', () => handleAspectSelect(btn.dataset.aspect));
  });

  // v13: Image Aspect Ratio selector (16:9, 4:3, 1:1, 3:4, 9:16)
  document.querySelectorAll('[data-imgaspect]').forEach(btn => {
    btn.addEventListener('click', () => handleImgAspectSelect(btn.dataset.imgaspect));
  });

  // Image Model selector
  document.querySelectorAll('[data-imgmodel]').forEach(btn => {
    btn.addEventListener('click', () => handleImageModelSelect(btn.dataset.imgmodel));
  });

  // Video Model selector
  document.querySelectorAll('[data-vidmodel]').forEach(btn => {
    btn.addEventListener('click', () => handleVideoModelSelect(btn.dataset.vidmodel));
  });

  // Image Upscale selector
  document.querySelectorAll('[data-imgupscale]').forEach(btn => {
    btn.addEventListener('click', () => handleImgUpscaleSelect(btn.dataset.imgupscale));
  });

  // Video Upscale selector
  document.querySelectorAll('[data-vidupscale]').forEach(btn => {
    btn.addEventListener('click', () => handleVidUpscaleSelect(btn.dataset.vidupscale));
  });

  // Download Results link - opens extension downloader page in new tab
  const downloadLink = document.getElementById('download-link');
  if (downloadLink) {
    downloadLink.addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: chrome.runtime.getURL('downloader.html') });
    });
  }

  // Common
  clearTaskBtn.addEventListener('click', handleClearTask);
  clearHistoryBtn.addEventListener('click', handleClearHistory);

  // Listen for manual mode updates
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'manualTaskUpdate') {
      updateManualStats(message);
      updateTaskStatus(message.rowId, message.status);
    }
    if (message.action === 'manualModeComplete') {
      showNotification('All tasks completed!', 'success');
      stopManualBtn.disabled = true;
      startManualBtn.disabled = false;
    }
  });

  // Update UI periodically
  setInterval(updateUI, 2000);
});

// ============================================
// SETTINGS
// ============================================

async function loadSettings() {
  try {
    const settings = await chrome.storage.local.get([
      'pollUrl', 'resultUrl', 'uiMode',
      'baserowToken', 'baserowTableId', 'baserowUrl', 'baserowConnected',
      'outputCount', 'aspectRatio', 'imageAspectRatio', 'imageModel', 'videoModel',
      'imgUpscale', 'vidUpscale', 'accountTier', 'generateMode'
    ]);

    pollUrlInput.value = settings.pollUrl || DEFAULT_POLL_URL;
    resultUrlInput.value = settings.resultUrl || DEFAULT_RESULT_URL;

    // v13: Generate mode (image | video) — controls visibility of model/aspect/upscale cards
    updateGenerateModeSelector(settings.generateMode || 'image');

    // Load output count (default: 1)
    updateOutputSelector(settings.outputCount || 1);

    // Load video aspect ratio (default: landscape)
    updateAspectSelector(settings.aspectRatio || 'landscape');

    // v13: Load image aspect ratio (default: 16:9). Migrate from old 'aspectRatio' if not set.
    let initialImgAspect = settings.imageAspectRatio;
    if (!initialImgAspect) {
      initialImgAspect = settings.aspectRatio === 'portrait' ? '9:16' : '16:9';
      // Persist the migration so background.js + future popup loads see it
      chrome.storage.local.set({ imageAspectRatio: initialImgAspect });
    }
    updateImgAspectSelector(initialImgAspect);

    // Load image model (default: NARWHAL)
    updateImageModelSelector(settings.imageModel || 'NARWHAL');

    // Load video model (default: fast)
    updateVideoModelSelector(settings.videoModel || 'fast');

    // Load upscale settings
    updateImgUpscaleSelector(settings.imgUpscale || 'none');
    updateVidUpscaleSelector(settings.vidUpscale || 'none');

    // Apply account tier restrictions (Pro: no 4K, no Quality/Lower Priority)
    if (settings.accountTier) {
      applyAccountTierRestrictions(settings.accountTier);
    }

    // Apply Imagen 4 ref-block + other model-specific constraints
    applyImageModelConstraints(settings.imageModel || 'NARWHAL');

    // Actively detect account tier from Flow page (don't wait for first generation)
    detectAccountTierFromPopup();

    if (settings.uiMode) switchMode(settings.uiMode);

    if (settings.baserowToken) baserowTokenInput.value = settings.baserowToken;
    if (settings.baserowTableId) baserowTableIdInput.value = settings.baserowTableId;
    if (settings.baserowUrl && baserowUrlInput) baserowUrlInput.value = settings.baserowUrl;

    // Don't auto-refresh on load - just show that we were connected before
    if (settings.baserowConnected && settings.baserowToken && settings.baserowTableId) {
      updateConnectionStatus(true, 'Previously connected - click Connect to refresh');
    }
  } catch (e) {
    console.error('Load settings error:', e);
  }
}

async function handleSaveUrls() {
  const pollUrl = pollUrlInput.value.trim();
  const resultUrl = resultUrlInput.value.trim();

  if (!pollUrl || !resultUrl) {
    showNotification('Please enter both URLs', 'error');
    return;
  }

  // Validate URLs
  try {
    new URL(pollUrl);
    new URL(resultUrl);
  } catch (e) {
    showNotification('Invalid URL format', 'error');
    return;
  }

  await chrome.storage.local.set({ pollUrl, resultUrl });
  await chrome.runtime.sendMessage({ action: 'updateWebhooks', pollUrl, resultUrl });
  showNotification('Webhook URLs saved!', 'success');
}

// ============================================
// MODE SWITCHING
// ============================================

function switchMode(mode) {
  currentMode = mode;
  tabAutomated.classList.toggle('active', mode === 'automated');
  tabManual.classList.toggle('active', mode === 'manual');
  automatedModeDiv.classList.toggle('active', mode === 'automated');
  manualModeDiv.classList.toggle('active', mode === 'manual');
  const dlBanner = document.getElementById('download-link-banner');
  if (dlBanner) dlBanner.style.display = mode === 'manual' ? '' : 'none';
  chrome.storage.local.set({ uiMode: mode });
}

function updateModeDisplay(mode, isProcessing = false) {
  const modeKey = mode || 'image';
  // v9.0.0: Mode display card removed from UI, just update outputs selector
  updateOutputsForMode(modeKey);
}

// ============================================
// UI UPDATE
// ============================================

async function updateUI() {
  try {
    const status = await chrome.runtime.sendMessage({ action: 'getStatus' });

    // Update toggle
    pollingToggle.checked = status.isPolling;
    toggleLabel.textContent = status.isPolling ? 'Enabled - FIFO Mode (10s)' : 'Disabled';

    // Update keep alive toggle
    const { keepAlivePolling } = await chrome.storage.local.get('keepAlivePolling');
    keepAliveToggle.checked = !!keepAlivePolling;
    keepAliveLabel.textContent = keepAlivePolling ? 'Polling stays on permanently' : 'Stops after tasks complete';

    // Status indicator
    statusIndicator.className = 'status-dot';
    if (status.manualModeActive) {
      statusIndicator.classList.add('processing');
      currentStatus.textContent = 'Manual mode active';
    } else if (status.contentScriptBusy || status.isProcessing) {
      statusIndicator.classList.add('processing');
      currentStatus.textContent = 'Processing task...';
    } else if (status.isPolling) {
      statusIndicator.classList.add('active');
      currentStatus.textContent = 'Waiting for tasks';
    } else {
      statusIndicator.classList.add('inactive');
      currentStatus.textContent = 'Idle';
    }

    // Last poll
    if (status.lastPoll) {
      const pollDate = new Date(status.lastPoll);
      const diffSec = Math.floor((Date.now() - pollDate) / 1000);
      lastPoll.textContent = diffSec < 60 ? `${diffSec}s ago` :
                             diffSec < 3600 ? `${Math.floor(diffSec / 60)}m ago` :
                             pollDate.toLocaleTimeString();
    } else {
      lastPoll.textContent = 'Never';
    }

    // Task info and mode display
    if (status.currentTask) {
      taskInfo.style.display = 'flex';
      taskId.textContent = status.currentTask.id || '-';
      updateModeDisplay(status.currentTask.mode, true);

      if (status.currentTask.status === 'failed') {
        currentStatus.textContent = `Failed: ${status.currentTask.error || 'Unknown'}`;
        statusIndicator.classList.remove('processing', 'active');
        statusIndicator.classList.add('error');
      }
    } else {
      taskInfo.style.display = 'none';
      updateModeDisplay('image', false);
    }

    // Stats
    processedCount.textContent = status.stats?.processed || 0;
    failedCount.textContent = status.stats?.failed || 0;
    historyCount.textContent = status.processedCount || 0;

    // Manual mode stats
    if (status.manualModeActive) {
      manualStats.style.display = 'flex';
      manualProcessed.textContent = status.manualModeStats?.completed || 0;
      manualFailed.textContent = status.manualModeStats?.failed || 0;
      manualPending.textContent = status.manualModeStats?.pending || 0;

      stopManualBtn.disabled = false;
      startManualBtn.disabled = true;
    } else {
      // Manual mode not active - reset stats display and enable start button if we have pending tasks
      manualStats.style.display = 'none';
      manualProcessed.textContent = '0';
      manualFailed.textContent = '0';
      manualPending.textContent = '0';
      stopManualBtn.disabled = true;
      if (manualTasks.length > 0) {
        const hasPending = manualTasks.some(t => {
          const s = getStatusValue(t.Status);
          return s === 'pending' || s === '';
        });
        if (hasPending) {
          startManualBtn.disabled = false;
        }
      }
    }
  } catch (e) {
    console.error('Update UI error:', e);
    currentStatus.textContent = 'Connection error';
    statusIndicator.className = 'status-dot error';
  }
}

// ============================================
// AUTOMATED MODE HANDLERS
// ============================================

async function handlePollingToggle() {
  const action = pollingToggle.checked ? 'startPolling' : 'stopPolling';
  await chrome.runtime.sendMessage({ action });
  await updateUI();
}

async function handleKeepAliveToggle() {
  const keepAlive = keepAliveToggle.checked;
  await chrome.storage.local.set({ keepAlivePolling: keepAlive });
  keepAliveLabel.textContent = keepAlive ? 'Polling stays on permanently' : 'Stops after tasks complete';
  console.log('[Popup] Keep Alive polling set to:', keepAlive);
}

async function handlePollNow() {
  if (!pollNowBtn) return;
  pollNowBtn.disabled = true;
  pollNowBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
      <path d="M21 12a9 9 0 11-6.219-8.56"></path>
    </svg>
    Polling...
  `;

  try {
    const result = await chrome.runtime.sendMessage({ action: 'manualPoll' });
    console.log('Manual poll result:', result);

    if (result.noTasks) {
      showNotification('No tasks available');
    } else if (result.task) {
      showNotification(`Task received: ${result.task.id}`, 'success');
    } else if (result.skipped) {
      showNotification(`Skipped: ${result.reason}`);
    } else if (result.error) {
      showNotification(`Error: ${result.error}`, 'error');
    }
  } catch (error) {
    console.error('Poll error:', error);
    showNotification('Poll failed', 'error');
  }

  pollNowBtn.disabled = false;
  pollNowBtn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <polyline points="23 4 23 10 17 10"></polyline>
      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
    </svg>
    Poll Now
  `;
  await updateUI();
}

async function handleOpenFlow() {
  const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
  if (tabs.length > 0) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url: FLOW_URL });
  }
}

// ============================================
// MANUAL MODE HANDLERS
// ============================================

// Helper: extract status value (handles string or Baserow single-select object)
function getStatusValue(status) {
  if (!status) return '';
  if (typeof status === 'string') return status.toLowerCase();
  if (typeof status === 'object' && status.value) return status.value.toLowerCase();
  return '';
}

// Helper: extract any Baserow field value (handles string or single-select object)
function getFieldValue(field, defaultVal = '') {
  if (!field) return defaultVal;
  if (typeof field === 'string') return field;
  if (typeof field === 'object' && field.value) return field.value;
  return defaultVal;
}

function updateConnectionStatus(connected, message = null) {
  const statusIcon = connectionStatus.querySelector('.status-icon');
  const statusText = connectionStatus.querySelector('.status-text');

  if (connected) {
    statusIcon.className = 'status-icon connected';
    statusIcon.textContent = '';
    statusText.textContent = message || 'Connected';
    connectionStatus.classList.add('connected');
  } else {
    statusIcon.className = 'status-icon disconnected';
    statusIcon.textContent = '';
    statusText.textContent = message || 'Not connected';
    connectionStatus.classList.remove('connected');
  }
}

let isConnecting = false;

async function handleConnectBaserow() {
  if (isConnecting) {
    console.log('[Popup] Already connecting, ignoring...');
    return;
  }

  const token = baserowTokenInput.value.trim();
  const tableId = baserowTableIdInput.value.trim();
  const baseUrl = (baserowUrlInput?.value || '').trim();  // empty = use cloud default

  if (!token || !tableId) {
    showNotification('Enter API Token and Table ID', 'error');
    return;
  }

  isConnecting = true;
  connectBaserowBtn.disabled = true;
  connectBaserowBtn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-6.219-8.56"></path></svg> Connecting...';

  console.log('[Popup] Connecting to Baserow table:', tableId, baseUrl ? `(${baseUrl})` : '(cloud)');

  try {
    const result = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        action: 'baserowConnect',
        token,
        tableId,
        baseUrl
      }, (response) => {
        if (chrome.runtime.lastError) {
          console.error('[Popup] Chrome runtime error:', chrome.runtime.lastError);
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          console.log('[Popup] Got response:', response);
          resolve(response);
        }
      });
    });

    console.log('[Popup] Connection result:', result);

    if (result && result.success) {
      await chrome.storage.local.set({
        baserowToken: token,
        baserowTableId: tableId,
        baserowUrl: baseUrl,
        baserowConnected: true
      });

      manualTasks = result.tasks || [];
      console.log('[Popup] Loaded tasks:', manualTasks.length);

      updateConnectionStatus(true, `Connected (${manualTasks.length} rows)`);
      showTaskList();
      renderTaskTable();
      showNotification(`Loaded ${manualTasks.length} tasks`, 'success');
    } else {
      const errorMsg = result?.error || 'Connection failed - no response';
      console.error('[Popup] Connection failed:', errorMsg);
      updateConnectionStatus(false, 'Failed');
      showNotification(errorMsg, 'error');
    }
  } catch (e) {
    console.error('[Popup] Connection exception:', e);
    updateConnectionStatus(false, 'Error');
    showNotification(`Error: ${e.message}`, 'error');
  }

  isConnecting = false;
  connectBaserowBtn.disabled = false;
  connectBaserowBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path><polyline points="10 17 15 12 10 7"></polyline><line x1="15" y1="12" x2="3" y2="12"></line></svg> Connect & Load Tasks';
}

async function handleRefreshTasks() {
  const token = baserowTokenInput.value.trim();
  const tableId = baserowTableIdInput.value.trim();
  const baseUrl = (baserowUrlInput?.value || '').trim();

  if (!token || !tableId) return;

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'baserowFetchTasks',
      token,
      tableId,
      baseUrl
    });

    if (result?.success) {
      manualTasks = result.tasks || [];
      updateConnectionStatus(true, `Connected (${manualTasks.length} rows)`);
      renderTaskTable();
    }
  } catch (e) {
    console.error('Refresh error:', e);
  }
}

function showTaskList() {
  taskListCard.style.display = 'block';
  manualStats.style.display = 'flex';

  // CRITICAL: Enable the Start Processing button when tasks are loaded!
  // Check if there are pending tasks
  const pendingTasks = manualTasks.filter(t => {
    const status = getStatusValue(t.Status);
    return status === 'pending' || status === '';
  });

  if (pendingTasks.length > 0) {
    startManualBtn.disabled = false;
    console.log('[Popup] Start button enabled - found', pendingTasks.length, 'pending tasks');
  } else {
    startManualBtn.disabled = true;
    console.log('[Popup] Start button disabled - no pending tasks');
  }
}

function renderTaskTable() {
  const filterPending = filterPendingCheckbox?.checked ?? true;

  let filteredTasks = manualTasks;
  if (filterPending) {
    filteredTasks = manualTasks.filter(t => {
      const status = getStatusValue(t.Status);
      return status === 'pending' || status === '';
    });
  }

  // Count stats
  const pending = manualTasks.filter(t => {
    const s = getStatusValue(t.Status);
    return s === 'pending' || s === '';
  }).length;
  const completed = manualTasks.filter(t => getStatusValue(t.Status) === 'completed').length;
  const failed = manualTasks.filter(t => getStatusValue(t.Status) === 'failed').length;

  taskCount.textContent = filteredTasks.length;
  taskSummary.textContent = `${pending} pending, ${completed} completed, ${failed} failed`;

  // Update manual stats
  manualProcessed.textContent = completed;
  manualFailed.textContent = failed;
  manualPending.textContent = pending;

  // Update Start button state based on pending tasks
  if (pending > 0) {
    startManualBtn.disabled = false;
  }

  // Render table
  taskTableBody.innerHTML = '';

  for (const task of filteredTasks) {
    const row = document.createElement('tr');
    row.setAttribute('data-row-id', task.id);

    const id = task.ID || task.id;
    // Get prompt - also check 'Image Prompt' for imagegen mode
    const prompt = task['VEO Prompt'] || task['Image Prompt'] || task.prompt || task.imagePrompt || '';
    const modeRaw = task.Mode || task.mode || 'text';
    const mode = (typeof modeRaw === 'object' && modeRaw.value) ? modeRaw.value : modeRaw;
    const status = getStatusValue(task.Status) || 'pending';
    const statusDisplay = status.charAt(0).toUpperCase() + status.slice(1);

    row.innerHTML = `
      <td>${id}</td>
      <td class="prompt-cell" title="${prompt}">${prompt.substring(0, 30)}${prompt.length > 30 ? '...' : ''}</td>
      <td><span class="mode-badge ${String(mode).toLowerCase()}">${mode}</span></td>
      <td><span class="status-badge ${status}">${statusDisplay}</span></td>
    `;

    taskTableBody.appendChild(row);
  }
}

function updateTaskStatus(rowId, status) {
  const task = manualTasks.find(t => t.id === rowId);
  if (task) {
    task.Status = status;
    renderTaskTable();
  }
}

function updateManualStats(data) {
  if (data.completed !== undefined) manualProcessed.textContent = data.completed;
  if (data.failed !== undefined) manualFailed.textContent = data.failed;

  const total = data.total || manualTasks.length;
  const done = (data.completed || 0) + (data.failed || 0);
  manualPending.textContent = total - done;
}

async function handleStartManual() {
  const token = baserowTokenInput.value.trim();
  const tableId = baserowTableIdInput.value.trim();
  const baseUrl = (baserowUrlInput?.value || '').trim();

  if (!token || !tableId) {
    showNotification('Connect to Baserow first', 'error');
    return;
  }

  const pendingTasks = manualTasks.filter(t => {
    const status = getStatusValue(t.Status);
    return status === 'pending' || status === '';
  });

  if (pendingTasks.length === 0) {
    showNotification('No pending tasks', 'error');
    return;
  }

  startManualBtn.disabled = true;
  startManualBtn.innerHTML = '<svg class="spin" width="14" height="14" viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-6.219-8.56"></path></svg> Starting...';

  try {
    const result = await chrome.runtime.sendMessage({
      action: 'startManualMode',
      token,
      tableId,
      baseUrl,
      tasks: manualTasks
    });

    if (result?.success) {
      showNotification(`Processing ${result.count || pendingTasks.length} tasks`, 'success');
      stopManualBtn.disabled = false;
    } else {
      showNotification(result?.error || 'Start failed', 'error');
      startManualBtn.disabled = false;
    }
  } catch (e) {
    showNotification('Start error', 'error');
    startManualBtn.disabled = false;
  }

  startManualBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg> Start Processing';
}

async function handleStopManual() {
  stopManualBtn.disabled = true;
  await chrome.runtime.sendMessage({ action: 'stopAllProcessing' });
  showNotification('Stopped', 'success');
  startManualBtn.disabled = false;
  stopManualBtn.disabled = true;
  await updateUI();
}

// ============================================
// COMMON HANDLERS
// ============================================

async function handleClearTask() {
  clearTaskBtn.disabled = true;
  clearTaskBtn.textContent = 'Stopping...';

  await chrome.runtime.sendMessage({ action: 'stopPolling' });
  await chrome.runtime.sendMessage({ action: 'stopAllProcessing' });
  await chrome.storage.local.set({ currentTask: null, currentJobId: null });

  showNotification('Stopped!', 'success');
  clearTaskBtn.disabled = false;
  clearTaskBtn.textContent = 'Clear & Stop';
  pollingToggle.checked = false;
  startManualBtn.disabled = false;
  stopManualBtn.disabled = true;
  await updateUI();
}

async function handleClearHistory() {
  if (confirm('Clear all job history? This will allow reprocessing of previously completed jobs.')) {
    await chrome.runtime.sendMessage({ action: 'clearJobHistory' });
    showNotification('Job history cleared', 'success');
    await updateUI();
  }
}

// ============================================
// OUTPUT COUNT SELECTOR
// ============================================

function handleOutputSelect(count) {
  updateOutputSelector(count);
  chrome.storage.local.set({ outputCount: count });
  console.log('[Popup] Output count set to:', count);
}

function updateOutputSelector(count) {
  outputBtns.forEach(btn => {
    if (!btn.dataset.count) return;
    const btnCount = parseInt(btn.dataset.count);
    btn.classList.toggle('active', btnCount === count);
  });
}

function handleAspectSelect(aspect) {
  updateAspectSelector(aspect);
  chrome.storage.local.set({ aspectRatio: aspect });
  console.log('[Popup] Aspect ratio set to:', aspect);
}

function updateAspectSelector(aspect) {
  document.querySelectorAll('[data-aspect]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.aspect === aspect);
  });
}

// ============================================
// IMAGE MODEL SELECTOR
// ============================================

function handleImageModelSelect(model) {
  updateImageModelSelector(model);
  chrome.storage.local.set({ imageModel: model });
  applyImageModelConstraints(model);
  console.log('[Popup] Image model set to:', model);
}

function updateImageModelSelector(model) {
  document.querySelectorAll('[data-imgmodel]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imgmodel === model);
  });
}

// ============================================
// VIDEO MODEL SELECTOR
// ============================================

function handleVideoModelSelect(model) {
  updateVideoModelSelector(model);
  chrome.storage.local.set({ videoModel: model });
  console.log('[Popup] Video model set to:', model);
}

function updateVideoModelSelector(model) {
  document.querySelectorAll('[data-vidmodel]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vidmodel === model);
  });
}

// ============================================
// IMAGE UPSCALE SELECTOR
// ============================================

function handleImgUpscaleSelect(value) {
  updateImgUpscaleSelector(value);
  chrome.storage.local.set({ imgUpscale: value });
  console.log('[Popup] Image upscale set to:', value);
}

function updateImgUpscaleSelector(value) {
  document.querySelectorAll('[data-imgupscale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imgupscale === value);
  });
}

// ============================================
// VIDEO UPSCALE SELECTOR
// ============================================

function handleVidUpscaleSelect(value) {
  updateVidUpscaleSelector(value);
  chrome.storage.local.set({ vidUpscale: value });
  console.log('[Popup] Video upscale set to:', value);
}

function updateVidUpscaleSelector(value) {
  document.querySelectorAll('[data-vidupscale]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.vidupscale === value);
  });
}

// ============================================
// v13: GENERATE MODE SELECTOR (Image | Video)
// ============================================

function handleGenerateModeSelect(mode) {
  updateGenerateModeSelector(mode);
  chrome.storage.local.set({ generateMode: mode });
  console.log('[Popup] Generate mode set to:', mode);
}

function updateGenerateModeSelector(mode) {
  document.querySelectorAll('[data-genmode]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.genmode === mode);
  });
  // Show/hide image- vs video-specific cards
  const isImage = mode === 'image';
  document.querySelectorAll('.gen-image-only').forEach(el => {
    el.style.display = isImage ? '' : 'none';
  });
  document.querySelectorAll('.gen-video-only').forEach(el => {
    el.style.display = isImage ? 'none' : '';
  });
}

// ============================================
// v13: IMAGE ASPECT RATIO SELECTOR (16:9, 4:3, 1:1, 3:4, 9:16)
// ============================================

function handleImgAspectSelect(value) {
  updateImgAspectSelector(value);
  chrome.storage.local.set({ imageAspectRatio: value });
  console.log('[Popup] Image aspect ratio set to:', value);
}

function updateImgAspectSelector(value) {
  document.querySelectorAll('[data-imgaspect]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.imgaspect === value);
  });
}

// ============================================
// v13: IMAGE MODEL CONSTRAINTS
// Imagen 4 (IMAGEN_3_5) does not support reference images. UI-side warning.
// ============================================

function applyImageModelConstraints(model) {
  // v13.0.3: 1K upscale removed (Google API has no UPSAMPLE_IMAGE_RESOLUTION_1K).
  // Imagen 4 has no upscale support at all → 2K/4K disabled, fallback to Off.
  document.querySelectorAll('[data-imgmodel="IMAGEN_3_5"]').forEach(btn => {
    btn.title = 'Imagen 4: no reference image support, no upscale';
  });
  const isImagen4 = model === 'IMAGEN_3_5';
  document.querySelectorAll('[data-imgupscale="2k"], [data-imgupscale="4k"]').forEach(btn => {
    if (isImagen4) {
      btn.disabled = true;
      btn.title = 'Imagen 4 does not support upscale';
      if (btn.classList.contains('active')) {
        handleImgUpscaleSelect('none');
      }
    } else {
      btn.disabled = false;
      btn.title = '';
    }
  });
  if (isImagen4) {
    console.log('[Popup] Imagen 4 selected — refs disabled, upscale disabled');
  }
  // Re-apply tier restrictions in case we just enabled 4K Image Upscale for a Pro account.
  if (currentAccountTier) applyAccountTierRestrictions(currentAccountTier);
}

// Update output mode badge + available options based on current task mode
function updateOutputsForMode(mode) {
  const isVideo = mode === 'text' || mode === 'image' || mode === 'frames';

  // Badge removed - no mode indicator needed

  // All 4 buttons always enabled (both video and image support 1-4)
  outputBtns.forEach(btn => {
    btn.disabled = false;
  });
  // Re-apply tier restrictions so we don't accidentally re-enable 4K / Lite Lower
  // for a Pro account when output mode toggles.
  if (currentAccountTier) applyAccountTierRestrictions(currentAccountTier);
}

// ============================================
// ACCOUNT TIER RESTRICTIONS (Pro vs Ultra)
// ============================================

// Module-level cache so other UI updates (image model constraints, output mode
// switches) can re-apply tier restrictions without losing them.
let currentAccountTier = null;

function applyAccountTierRestrictions(tier) {
  currentAccountTier = tier;
  const isPro = tier === 'pro';
  const ultraOnlyTip = 'Ultra only';

  // 4K Video Upscale → Ultra only
  document.querySelectorAll('[data-vidupscale="4k"]').forEach(btn => {
    btn.disabled = isPro;
    btn.title = isPro ? ultraOnlyTip : '';
    if (isPro && btn.classList.contains('active')) handleVidUpscaleSelect('1080p');
  });

  // 4K Image Upscale → Ultra only
  document.querySelectorAll('[data-imgupscale="4k"]').forEach(btn => {
    btn.disabled = isPro;
    btn.title = isPro ? ultraOnlyTip : '';
    if (isPro && btn.classList.contains('active')) handleImgUpscaleSelect('2k');
  });

  // VEO 3.1 Lite (Lower Priority) → available on both Pro and Ultra (confirmed via
  // testing 2026-05-05). Always enabled, no tooltip, no auto-fallback.
  document.querySelectorAll('[data-vidmodel="lower"]').forEach(btn => {
    btn.disabled = false;
    btn.title = '';
  });

  // VEO 3.1 Quality → available on both Pro and Ultra (confirmed via testing 2026-05-05).
  // Always enabled, no tooltip, no auto-fallback.
  document.querySelectorAll('[data-vidmodel="quality"]').forEach(btn => {
    btn.disabled = false;
    btn.title = '';
  });

  console.log(`[Popup] Account tier=${tier}; Ultra-only features ${isPro ? 'DISABLED' : 'enabled'}: 4K Upscale (Image + Video)`);
}

// Detect account tier on popup open by querying credits API via Flow tab
async function detectAccountTierFromPopup() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://labs.google/fx/*' });
    if (tabs.length === 0) return; // No Flow tab open

    // First get session token from page
    const tokenResults = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
      world: 'MAIN',
      func: async () => {
        try {
          const resp = await fetch('/fx/api/auth/session');
          const data = await resp.json();
          return { token: data.access_token || null };
        } catch (e) {
          return { error: e.message };
        }
      }
    });
    const token = tokenResults?.[0]?.result?.token;
    if (!token) return;

    // Then use it to query credits
    const results = await chrome.scripting.executeScript({
      target: { tabId: tabs[0].id },
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
      args: [token]
    });

    const result = results?.[0]?.result;
    if (result?.data?.userPaygateTier) {
      const credits = result.data;
      // v13: Use both SKU + paygate tier for robust detection
      const tier = (credits.sku === 'WS_ULTRA' || credits.userPaygateTier === 'PAYGATE_TIER_TWO') ? 'ultra' : 'pro';
      console.log(`[Popup] Account tier detected: ${tier} (paygate=${credits.userPaygateTier}, sku=${credits.sku}, ${credits.credits} credits)`);
      chrome.storage.local.set({
        accountTier: tier,
        accountSku: credits.sku || null,
        accountCredits: credits.credits || 0
      });
      applyAccountTierRestrictions(tier);
    }
  } catch (e) {
    console.log('[Popup] Account tier detection skipped:', e.message);
  }
}

// Listen for account tier changes from background.js
chrome.storage.onChanged.addListener((changes) => {
  if (changes.accountTier) {
    applyAccountTierRestrictions(changes.accountTier.newValue);
  }
});

// ============================================
// AUTO-UPDATE CHECK
// ============================================

function isNewerVersion(remote, local) {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, l.length); i++) {
    const rPart = r[i] || 0;
    const lPart = l[i] || 0;
    if (rPart > lPart) return true;
    if (rPart < lPart) return false;
  }
  return false;
}

async function checkForUpdate() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(UPDATE_SERVER + '/version.json', {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) return;

    const data = await response.json();
    const localVersion = chrome.runtime.getManifest().version;

    if (!data.version || !isNewerVersion(data.version, localVersion)) return;

    // Check if user dismissed this version
    const { dismissedVersion } = await chrome.storage.local.get('dismissedVersion');
    if (dismissedVersion === data.version && !data.required) return;

    // Show the banner
    const banner = document.getElementById('update-banner');
    const versionSpan = document.getElementById('update-version');
    const changelogP = document.getElementById('update-changelog');
    const downloadBtn = document.getElementById('update-download-btn');
    const dismissBtn = document.getElementById('update-dismiss');

    versionSpan.textContent = data.version;
    changelogP.textContent = data.changelog || '';

    // Set update instructions from server (or default)
    const instructionsP = document.getElementById('update-instructions');
    instructionsP.textContent = data.instructions || 'Download ZIP → Extract → Replace the "VEO ExtensionV8" folder → Go to chrome://extensions → Click "Update"';

    banner.style.display = 'block';

    downloadBtn.addEventListener('click', () => {
      chrome.tabs.create({ url: data.downloadUrl });
    });

    dismissBtn.addEventListener('click', async () => {
      banner.style.display = 'none';
      await chrome.storage.local.set({ dismissedVersion: data.version });
    });
  } catch (e) {
    // Silently ignore network errors
  }
}

// ============================================
// STATUS MESSAGE CHECK (broadcast from server)
// ============================================

async function checkStatusMessage() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(UPDATE_SERVER + '/status.json', {
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!response.ok) return;

    const data = await response.json();

    if (!data.active || !data.message) return;

    // Show the status banner
    const banner = document.getElementById('status-banner');
    const messageSpan = document.getElementById('status-banner-message');
    const iconDiv = document.getElementById('status-banner-icon');
    const dismissBtn = document.getElementById('status-dismiss');

    const type = data.type || 'warning';
    banner.className = 'status-banner ' + type;

    if (type === 'error') {
      iconDiv.textContent = 'X';
    } else if (type === 'info') {
      iconDiv.textContent = 'i';
    } else {
      iconDiv.textContent = '!';
    }

    messageSpan.textContent = data.message;
    banner.style.display = 'block';

    dismissBtn.addEventListener('click', () => {
      banner.style.display = 'none';
    });
  } catch (e) {
    // Silently ignore network errors
  }
}

// ============================================
// UTILITIES
// ============================================

function showNotification(message, type = '') {
  document.querySelectorAll('.notification').forEach(n => n.remove());

  const notification = document.createElement('div');
  notification.className = `notification ${type}`;
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('fade-out');
    setTimeout(() => notification.remove(), 300);
  }, 2500);
}

// Add spin animation CSS
const style = document.createElement('style');
style.textContent = `
  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }
  .spin { animation: spin 1s linear infinite; }
`;
document.head.appendChild(style);
