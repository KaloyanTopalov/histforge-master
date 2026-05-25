// Magnific HITL - image-to-video content script
// Drives Magnific's Seedance / image-to-video page from a HistForge-
// dispatched task: fetches the reference image from the HistForge
// artifact route, uploads it via the advanced-selection-modal as both
// start-frame and end-frame, optionally selects a model, fills the
// motion prompt, clicks Generate, then polls the DOM for the rendered
// video element/URL and reports back to the service worker.
//
// Unlike content-magnific.js this is NOT operator-gated — the executor
// is fire-and-forget per slot, and the dispatch_timeout reaper requeues
// stuck rows server-side. On error we still emit a failure message so
// the executor can reject and the runner can log the cause; the row
// stays dispatched until the reaper requeues.
//
// Selectors are validated `data-cy` hooks ported from ambientforge's
// freepik-runner (2026-05-17/18 verification against the live signed-in
// app). On any selector miss, the script dumps a capped snapshot of the
// page's [data-cy] attributes so the operator can paste it back when
// reporting a regression in a future Magnific UI update.
//
// Step model: each step logs a structured `[i2v] step=X status=Y` line.
// Frame uploads and model select are best-effort — a miss logs and the
// flow continues so multiple step misses can be observed in one run.
// Prompt fill and Generate click are critical — a miss aborts the flow
// and reports failure to the service worker (the dispatch reaper then
// requeues the row).
//
// This script runs in the ISOLATED world declared by the manifest
// content_scripts entry. The Magnific image-gen content script runs
// in the same isolated world and listens for `magnificFillAndGenerate`;
// the two scripts self-filter by message action so they coexist on the
// same www.magnific.com pages without conflict.
//
// Shared DOM helpers (setNativeValue, editableFrom, waitFor, escapeRegex,
// dumpDataCyAttributes, fillPrompt, DATA_CY_DUMP_CAP) live in
// content-shared.js, loaded first per the manifest content_scripts
// entry so the helpers are reachable as isolated-world globals from
// inside this IIFE.

(function () {
  'use strict';

  const LOG_PREFIX = '[magnific-ext content-i2v]';

  // Validated `data-cy` selectors ported from ambientforge's freepik-runner
  // (2026-05-17/18 verification against the live signed-in Magnific app).
  // If a hook breaks in a future Magnific update, the diagnostic logs below
  // dump the available [data-cy] attrs so the operator can paste the snapshot
  // back when reporting a regression.
  const PROMPT_INPUT_DATA_CY = '[data-cy="video-prompt-input"]';
  const GENERATE_BUTTON_SELECTOR = 'button[data-cy="generate-button"]';
  const MODEL_TRIGGER_DATA_CY = '[data-cy="video-model-selector-trigger"]';
  const MODEL_SEARCH_DATA_CY = '[data-cy="ai-model-selector-search-input"]';
  // The Seedance lookup table — these are the rows ambientforge confirmed
  // exist in the video model dialog. Other models fall through to the
  // prefix-match fallback below.
  const VIDEO_MODEL_DATA_CY = {
    'seedance 2.0 fast': 'ai-model-item-bytedance-seedance-fast-2.0',
    'seedance 2.0 pro': 'ai-model-item-bytedance-seedance-pro-2.0',
  };
  const RESULT_VIDEO_SELECTOR = 'video[src*="cdnpk.net"]';

  // Frame-upload selectors (start + end share the advanced-selection-modal
  // flow; only the slot opener differs). Each slot's click mounts the modal,
  // whose upload input accepts a DataTransfer-assigned File via plain DOM
  // (no `chrome.debugger` / CDP). The new feed-image-item that appears post-
  // upload is the tile we commit by clicking the add-images button.
  const START_FRAME_SLOT_DATA_CY = '[data-cy="video-start-frame-input"]';
  const END_FRAME_SLOT_DATA_CY = '[data-cy="video-end-frame-input"]';
  // ambientforge captured both i18n shapes for the End-image thumbnail alt
  // text — Magnific switches between them across bundle versions and we want
  // the idempotency skip to fire on either.
  const END_FRAME_PRESENT_SELECTOR =
    'img[alt="End image"], img[alt="End image "]';
  const END_FRAME_LABEL_TEXT = 'End image';
  const ADV_MODAL_DATA_CY = '[data-cy="advanced-selection-modal"]';
  const ADV_UPLOAD_INPUT_SELECTOR =
    'input[data-cy="advanced-selection-upload-file-input"]';
  const ADV_CLEAR_ALL_DATA_CY =
    '[data-cy="advanced-selection-clear-all-button"]';
  const ADV_ADD_IMAGES_DATA_CY =
    '[data-cy="advanced-selection-add-images-button"]';
  const FEED_IMAGE_ITEM_PREFIX_SELECTOR = '[data-cy^="feed-image-item-"]';

  function log(...args) {
    try { console.log(LOG_PREFIX, ...args); } catch (_e) { /* ignore */ }
  }

  async function waitForPromptFill(text, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fillPrompt(text, PROMPT_INPUT_DATA_CY, [
        'textarea[placeholder*="Describe" i]',
        'textarea[aria-label*="prompt" i]',
        'textarea[placeholder*="motion" i]',
      ])) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  async function fetchReferenceAsFile(url) {
    // The page origin is https://www.magnific.com — a direct fetch() of
    // the HistForge artifact URL is blocked as mixed content (HTTPS page →
    // HTTP localhost) and would also fail CORS even on the HTTPS side.
    // The SW has the user-granted host permission and no mixed-content
    // restrictions, so we route through messages.js's `fetchReference`
    // handler. The SW replies with a data URL; data: URLs decode in any
    // origin so the final blob conversion stays inside this script.
    const resp = await chrome.runtime.sendMessage({
      action: 'fetchReference',
      url,
    });
    if (!resp || !resp.ok) {
      const reason = resp && resp.error ? resp.error : 'reference fetch failed';
      throw new Error(reason);
    }
    const blob = await (await fetch(resp.dataUrl)).blob();
    const filename = 'loop_image.png';
    // File extends Blob; some Magnific upload UIs check .name.
    return new File([blob], filename, { type: blob.type || 'image/png' });
  }

  function feedItemIds() {
    const out = [];
    for (const el of document.querySelectorAll(FEED_IMAGE_ITEM_PREFIX_SELECTOR)) {
      const id = el.getAttribute('data-cy');
      if (id) out.push(id);
    }
    return out;
  }

  // Assign a File to an `<input type=file>` via DataTransfer + a synthetic
  // `change` event. Some Radix-gated inputs (and certain jsdom builds) treat
  // `files` as a readonly slot, so we attempt both the plain assignment AND
  // `defineProperty` — whichever succeeds first is enough to satisfy the
  // listener that fires on `change`. No CDP path: Plan 2 Phase 2.2 Task 2
  // explicitly trimmed `chrome.debugger` out of magnific-ext's manifest, so
  // DOM-only is the contract; if a future Magnific update gates this on
  // `isTrusted` only, the diagnostic logs name the exact step and the next
  // iteration can decide whether to re-add the CDP layer.
  function setFileInputFile(inputEl, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    try { inputEl.files = dt.files; } catch (_e) { /* readonly in some envs */ }
    try {
      Object.defineProperty(inputEl, 'files', {
        value: dt.files,
        configurable: true,
      });
    } catch (_e) { /* ignore */ }
    inputEl.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Drive the advanced-selection-modal flow for one frame slot. Returns:
  //   'ok' | 'slot-not-found' | 'modal-did-not-open' | 'upload-input-not-found'
  //   | 'upload-no-new-tile' | 'commit-button-not-found'
  // Each return value pairs with a `[i2v]` status=error log line so the
  // operator can paste the snapshot back when reporting a regression.
  // Best-effort: the caller logs the outcome but does NOT abort the overall
  // flow on a non-'ok' return — see the file header.
  //
  // `resolveSlot` is a function returning the clickable slot (or null) so
  // callers can implement multi-shape lookups (the end-frame slot has been
  // captured as both `[data-cy=video-end-frame-input]` and an "End image"
  // label span — the start-frame slot is single-shape so its caller just
  // returns a `querySelector` result). `slotDescriptor` is the human-readable
  // list of shapes tried, surfaced in the diagnostic log on a miss.
  async function uploadFrameViaModal(file, resolveSlot, label, slotDescriptor) {
    // Single-shot slot lookup: by the time this runs the page has been
    // through fetch + earlier slots, so the slot either exists or won't.
    // A poll loop here would burn budget on the fail path without buying
    // anything on the happy path (ambientforge follows the same pattern).
    const slot = resolveSlot();
    if (!(slot instanceof HTMLElement)) {
      log(`[i2v] step=${label}-slot status=error reason=slot-not-found tried=${slotDescriptor}`);
      dumpDataCyAttributes();
      return 'slot-not-found';
    }
    clickClickable(slot);
    log(`[i2v] step=${label}-slot status=ok`);

    const modal = await waitFor(ADV_MODAL_DATA_CY, 10_000);
    if (!modal) {
      log(`[i2v] step=${label}-modal status=error reason=modal-did-not-open tried=${ADV_MODAL_DATA_CY}`);
      dumpDataCyAttributes();
      return 'modal-did-not-open';
    }
    log(`[i2v] step=${label}-modal status=ok`);

    const beforeItems = new Set(feedItemIds());

    const fileInput = await waitFor(ADV_UPLOAD_INPUT_SELECTOR, 8_000);
    if (!(fileInput instanceof HTMLInputElement)) {
      log(`[i2v] step=${label}-upload-input status=error reason=not-found tried=${ADV_UPLOAD_INPUT_SELECTOR}`);
      dumpDataCyAttributes();
      return 'upload-input-not-found';
    }
    setFileInputFile(fileInput, file);
    log(`[i2v] step=${label}-upload status=ok`);

    // Magnific renders the uploaded image as a NEW [data-cy^="feed-image-item-"]
    // tile once the upload completes. 45 s matches ambientforge's tuned bound;
    // the operator's network + Magnific's storage backend dominate this.
    let newId = null;
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      const fresh = feedItemIds().filter((id) => !beforeItems.has(id));
      if (fresh.length > 0) {
        newId = fresh[0];
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!newId) {
      log(`[i2v] step=${label}-tile-appeared status=error reason=upload-no-new-tile`);
      dumpDataCyAttributes();
      return 'upload-no-new-tile';
    }
    log(`[i2v] step=${label}-tile-appeared status=ok id=${newId}`);

    // Clear any default selection FIRST so only our uploaded tile becomes the
    // reference. ambientforge observed a default-selected tile from the
    // operator's prior session that otherwise survived the commit.
    const clearAll = document.querySelector(ADV_CLEAR_ALL_DATA_CY);
    if (clearAll instanceof HTMLElement) {
      clickClickable(clearAll);
      await new Promise((r) => setTimeout(r, 200));
    }
    const tileEl = document.querySelector(`[data-cy="${newId}"]`);
    if (tileEl instanceof HTMLElement) {
      clickClickable(tileEl);
      await new Promise((r) => setTimeout(r, 200));
    }

    const commit = document.querySelector(ADV_ADD_IMAGES_DATA_CY);
    if (!(commit instanceof HTMLElement)) {
      log(`[i2v] step=${label}-commit status=error reason=add-images-button-not-found tried=${ADV_ADD_IMAGES_DATA_CY}`);
      dumpDataCyAttributes();
      return 'commit-button-not-found';
    }
    clickClickable(commit);
    log(`[i2v] step=${label}-commit status=ok`);
    return 'ok';
  }

  // A data-cy node may be a non-interactive wrapper whose click handler lives
  // on an ancestor (Vue rows in the video-model dialog) — prefer the closest
  // ancestor <button>, else the node itself.
  function clickClickable(el) {
    const target = el.closest('button') || el;
    target.click();
  }

  async function typeIntoInput(el, text) {
    el.focus();
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Empty `modelName` skips silently — per Plan 2 §Phase 2.3, that means "let
  // Magnific use its UI default". Returns 'ok' | 'skipped' | 'no-trigger'
  // | 'not-found' so the diagnostic logger can record what happened. The
  // ambientforge port uses a per-model data-cy lookup table; on a miss it
  // narrows the list via the search box, then prefix-matches the visible rows.
  async function selectModelIfPossible(modelName) {
    if (!modelName) {
      log('[i2v] step=model-select status=skipped reason=empty-model');
      return 'skipped';
    }
    const trigger = await waitFor(MODEL_TRIGGER_DATA_CY, 15_000);
    if (!(trigger instanceof HTMLElement)) {
      log(`[i2v] step=model-select status=error reason=trigger-not-found tried=${MODEL_TRIGGER_DATA_CY}`);
      dumpDataCyAttributes();
      return 'no-trigger';
    }
    trigger.click();
    await new Promise((r) => setTimeout(r, 500));

    const key = (modelName || '').trim().toLowerCase();
    const dataCy = VIDEO_MODEL_DATA_CY[key];

    if (dataCy) {
      let item = await waitFor(`[data-cy="${dataCy}"]`, 4_000);
      if (!(item instanceof HTMLElement)) {
        // Long/virtualized list — narrow via the dialog's search box.
        const search = document.querySelector(MODEL_SEARCH_DATA_CY);
        if (search instanceof HTMLElement) {
          await typeIntoInput(search, modelName);
          item = await waitFor(`[data-cy="${dataCy}"]`, 4_000);
        }
      }
      if (item instanceof HTMLElement) {
        clickClickable(item);
        await new Promise((r) => setTimeout(r, 400));
        log(`[i2v] step=model-select status=ok model=${modelName}`);
        return 'ok';
      }
    }

    // Fallback: prefix-match visible model rows by text.
    const re = new RegExp(`^${escapeRegex(modelName)}`, 'i');
    for (const row of document.querySelectorAll('[data-cy^="ai-model-item-"]')) {
      if (re.test((row.textContent || '').trim())) {
        clickClickable(row);
        await new Promise((r) => setTimeout(r, 400));
        log(`[i2v] step=model-select status=ok model=${modelName} match=prefix`);
        return 'ok';
      }
    }
    log(`[i2v] step=model-select status=error reason=option-not-found model=${modelName}`);
    dumpDataCyAttributes();
    return 'not-found';
  }

  // Snapshot every `video[src*="cdnpk.net"]` URL currently in the DOM. The
  // caller takes this BEFORE clicking Generate; the poll below then ignores
  // any URL already in the snapshot. Magnific keeps the previous run's video
  // element in the DOM while the new one renders, so a naive querySelector
  // returns the stale URL — the snapshot is what makes the diff reliable.
  function collectResultVideoUrls() {
    const urls = [];
    for (const el of document.querySelectorAll(RESULT_VIDEO_SELECTOR)) {
      if (el.src) urls.push(el.src);
    }
    return urls;
  }

  async function waitForNewResultVideo(snapshotUrls, timeoutMs = 30 * 60 * 1000) {
    const snapshot = new Set(snapshotUrls);
    const start = Date.now();
    // Emit the wait-phase marker BEFORE the first url scan so the operator
    // sees "polling started, waiting" rather than a silent gap between the
    // generate-click log and the eventual result-poll-ok log. A subsequent
    // periodic emit (~30s cadence) keeps the loop visible on long renders.
    log('[i2v] step=result-poll status=waiting elapsed=0s');
    let lastWaitLog = start;
    while (Date.now() - start < timeoutMs) {
      for (const url of collectResultVideoUrls()) {
        if (!snapshot.has(url)) return url;
      }
      const now = Date.now();
      if (now - lastWaitLog >= 30_000) {
        log(`[i2v] step=result-poll status=waiting elapsed=${Math.floor((now - start) / 1000)}s`);
        lastWaitLog = now;
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return null;
  }

  function reportCompletion(taskId, resultUrl) {
    chrome.runtime.sendMessage({
      action: 'magnificImageToVideoCompleted',
      taskId,
      resultUrl,
    }, () => {
      if (chrome.runtime.lastError) {
        log('sendMessage(completed) failed:', chrome.runtime.lastError.message);
      }
    });
  }

  function reportFailure(taskId, reason) {
    chrome.runtime.sendMessage({
      action: 'magnificImageToVideoFailed',
      taskId,
      reason,
    }, () => {
      if (chrome.runtime.lastError) {
        log('sendMessage(failed) failed:', chrome.runtime.lastError.message);
      }
    });
  }

  async function uploadStartFrame(file) {
    return uploadFrameViaModal(
      file,
      () => document.querySelector(START_FRAME_SLOT_DATA_CY),
      'start-frame',
      START_FRAME_SLOT_DATA_CY,
    );
  }

  // Climb to the closest clickable ancestor. Mirrors ambientforge's heuristic:
  // <button>, role=button, a `cursor-pointer` class, or a containing element
  // whose data-cy hints at a frame/slot/card semantics. A bounded climb avoids
  // walking off the top of the document and gets us back to a positionable
  // container the click handler is bound on.
  function climbToClickable(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur; i++) {
      if (cur instanceof HTMLElement) {
        if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button') {
          return cur;
        }
        const cls = typeof cur.className === 'string' ? cur.className : '';
        if (/cursor-pointer/.test(cls)) return cur;
        const cy = cur.getAttribute && cur.getAttribute('data-cy');
        if (cy && /end|frame|reference|card|slot|drop/i.test(cy)) return cur;
      }
      cur = cur.parentElement;
    }
    let up = el;
    for (let i = 0; i < 4 && up && up.parentElement; i++) up = up.parentElement;
    return up instanceof HTMLElement ? up : null;
  }

  // Locate the End-image picker opener. ambientforge captured two shapes for
  // this slot — the data-cy primary AND an "End image" label span wrapped in a
  // clickable ancestor. We try data-cy first because it's the cheapest match;
  // failing that we walk back from the label so a Magnific update that drops
  // the data-cy still works as long as the visible label survives.
  function findEndFrameSlot() {
    const direct = document.querySelector(END_FRAME_SLOT_DATA_CY);
    if (direct instanceof HTMLElement) return direct;
    for (const s of document.querySelectorAll('span')) {
      if ((s.textContent || '').trim() === END_FRAME_LABEL_TEXT) {
        const c = climbToClickable(s);
        if (c) return c;
      }
    }
    return null;
  }

  async function uploadEndFrame(file) {
    // Idempotency: if Magnific is already rendering an End-image thumbnail
    // (operator set it by hand, or an earlier run got this far before
    // failing later), the upload is a no-op. ambientforge captured both
    // `alt="End image"` and the trailing-space variant — the selector
    // matches either.
    if (document.querySelector(END_FRAME_PRESENT_SELECTOR)) {
      log('[i2v] step=end-frame-idempotency status=skip reason=end-image-already-set');
      return 'already-set';
    }
    return uploadFrameViaModal(
      file,
      findEndFrameSlot,
      'end-frame',
      `${END_FRAME_SLOT_DATA_CY}, span"${END_FRAME_LABEL_TEXT}"`,
    );
  }

  async function startImageToVideo(taskId, prompt, model, referenceImageUrl) {
    log(`[i2v] start taskId=${taskId} model=${model || '(default)'} ref=${referenceImageUrl}`);

    let file;
    try {
      file = await fetchReferenceAsFile(referenceImageUrl);
      log('[i2v] step=fetch-reference status=ok');
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      log(`[i2v] step=fetch-reference status=error reason=${msg}`);
      reportFailure(taskId, `reference_fetch_failed: ${msg}`);
      return;
    }

    // Best-effort uploads + model select. A miss logs but doesn't abort: the
    // diagnostic stream is more useful when several steps' state is observed
    // in one run, and the result-poll will time out if no Generate actually
    // produced a video.
    await uploadStartFrame(file);
    await uploadEndFrame(file);
    await selectModelIfPossible(model);

    const filled = await waitForPromptFill(prompt, 10_000);
    if (!filled) {
      log(
        `[i2v] step=prompt-fill status=error reason=input-not-found tried=${PROMPT_INPUT_DATA_CY}, ` +
        `textarea[placeholder*="Describe" i], textarea[aria-label*="prompt" i], ` +
        `textarea[placeholder*="motion" i], textarea, [contenteditable="true"]`,
      );
      dumpDataCyAttributes();
      reportFailure(taskId, 'prompt_input_not_found');
      return;
    }
    log('[i2v] step=prompt-fill status=ok');

    const generateBtn = await waitFor(GENERATE_BUTTON_SELECTOR, 5_000);
    if (!(generateBtn instanceof HTMLElement)) {
      log(`[i2v] step=generate-click status=error reason=not-found tried=${GENERATE_BUTTON_SELECTOR}`);
      dumpDataCyAttributes();
      reportFailure(taskId, 'generate_button_not_found');
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
    if (generateBtn.disabled || generateBtn.getAttribute('aria-disabled') === 'true') {
      log('[i2v] step=generate-click status=error reason=disabled');
      reportFailure(taskId, 'generate_button_disabled');
      return;
    }
    // Snapshot the existing result-video URLs immediately before clicking
    // Generate so the post-click poll only fires on a genuinely new URL.
    const resultSnapshot = collectResultVideoUrls();
    generateBtn.click();
    log('[i2v] step=generate-click status=ok');

    const resultUrl = await waitForNewResultVideo(resultSnapshot);
    if (!resultUrl) {
      log('[i2v] step=result-poll status=error reason=timeout');
      dumpDataCyAttributes();
      reportFailure(taskId, 'result_poll_timeout');
      return;
    }
    log(`[i2v] step=result-poll status=ok url=${resultUrl}`);
    reportCompletion(taskId, resultUrl);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    // Readiness handshake — see content-magnific.js for the rationale.
    // The i2v executor pings this tab before dispatching the real start
    // message to avoid the "Receiving end does not exist" race on freshly
    // created tabs.
    if (message.action === 'ping') {
      sendResponse({ ready: true });
      return;
    }
    if (message.action === 'magnificStartImageToVideo') {
      startImageToVideo(
        message.taskId,
        message.prompt,
        message.model,
        message.referenceImageUrl,
      )
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          const msg = e && e.message ? e.message : String(e);
          log('startImageToVideo threw:', msg);
          sendResponse({ success: false, error: msg });
        });
      return true; // async response
    }
  });

  log('loaded');
})();
