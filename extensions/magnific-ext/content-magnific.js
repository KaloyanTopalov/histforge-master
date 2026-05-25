// Magnific HITL - image-gen content script
// Drives Magnific's text-to-image page from a HistForge-dispatched
// task: fills the prompt, optionally selects a model in the model
// picker, clicks Generate, then waits for variations to render and
// overlays a "Use this image for HistForge" button on each one. The
// operator clicks the overlay; we harvest the variation's image URL and
// emit `magnificVariationSelected` back to the service worker.
//
// Why operator-click instead of auto-pick: per handoff Open Q4, the
// "first variation that renders" race against Magnific's lazy-loading
// UI is unreliable; operator gating turns a flaky DOM heuristic into a
// deterministic event. The cost is one extra click per image.
//
// Selectors are validated `data-cy` hooks ported from ambientforge's
// freepik-runner (2026-05-17/18 verification against the live signed-in
// app). They are still load-bearing on Magnific's DOM, so any future
// rename will break this script. On any selector miss, the script dumps
// the [data-cy] attributes present on the page so the operator can paste
// the snapshot back when reporting a regression.
//
// This script runs in the ISOLATED world declared by the manifest
// content_scripts entry. It does not need the MAIN-world bridge pattern
// from youforge-flow because Magnific's UI is driven via plain DOM
// events; no in-page globals (grecaptcha, fetch interception) need to
// be reached.
//
// Shared DOM helpers (setNativeValue, editableFrom, waitFor, escapeRegex,
// dumpDataCyAttributes, fillPrompt, DATA_CY_DUMP_CAP) live in
// content-shared.js, loaded first per the manifest content_scripts
// entry so the helpers are reachable as isolated-world globals from
// inside this IIFE.

(function () {
  'use strict';

  const LOG_PREFIX = '[magnific-ext content]';

  // Track the active task so a stray DOM event can't fire a stale
  // variationSelected. The SW dispatches one task at a time per
  // executor slot (runner.hasActiveExecutor gate), so a single-slot
  // state is sufficient.
  let activeTaskId = null;
  // Set of variation URLs we've already overlay-decorated. URL-keyed (not
  // element-keyed) because Magnific's feed sometimes re-mounts result
  // tiles into different DOM nodes (e.g. when the operator scrolls), so
  // a WeakSet keyed by element would let the same image get a duplicate
  // overlay after a remount.
  const decoratedUrls = new Set();
  // Strong refs to every overlay button we've injected on this page. The
  // click handler iterates this set to disable siblings synchronously
  // (before the SW round-trip resolves) so a worried double-click can't
  // fire a stale magnificVariationSelected against the wrong tile.
  const decoratedOverlays = new Set();

  // CSS selectors — verify at task time against the live Magnific UI.
  // Validated against the signed-in app per ambientforge's freepik-runner
  // (2026-05-17/18). If a hook breaks in a future Magnific update, the
  // diagnostic logs below dump the available [data-cy] attrs.
  const PROMPT_INPUT_DATA_CY = '[data-cy="image-prompt-input"]';
  const GENERATE_BUTTON_SELECTOR = 'button[data-cy="generate-button"]';
  const MODEL_TRIGGER_DATA_CY = '[data-cy="tti-mode-selector-v3-trigger"]';
  // Magnific results are delivered from *.cdnpk.net per ambientforge's
  // validated heuristic (content.js:792). The size floor rejects tracking
  // pixels, sidebar thumbnails, and stale-tile placeholders that share
  // the CDN host.
  const VARIATION_IMG_SELECTOR = 'img[src*="cdnpk.net"]';
  const VARIATION_MIN_DIMENSION = 200;

  function log(...args) {
    try { console.log(LOG_PREFIX, ...args); } catch (_e) { /* ignore */ }
  }

  // Mirror of content-magnific-i2v.js's reportFailure. The two executors
  // share a registry contract (`{ run: (task) => Promise }`) and a
  // rendezvous-via-pending-Map pattern — without this, a silent bail
  // here leaves runImageHitl's pending promise unresolved, its slot held,
  // and the runner skipping image-hitl polls until the operator clicks
  // Stop. The dispatch_timeout reaper requeues the row server-side, but
  // the extension's local slot must release too. See SOLID audit #2
  // (docs/refactoring/solid-audit-2026-05-22.md).
  function reportFailure(taskId, reason) {
    chrome.runtime.sendMessage({
      action: 'magnificVariationFailed',
      taskId,
      reason,
    }, () => {
      if (chrome.runtime.lastError) {
        log('sendMessage(failed) failed:', chrome.runtime.lastError.message);
      }
    });
  }

  function findButtonByText(re) {
    const buttons = document.querySelectorAll('button, [role="option"], [role="button"]');
    for (const btn of buttons) {
      const text = (btn.textContent || '').trim();
      if (re.test(text)) return btn;
    }
    return null;
  }

  // Skip silently when modelName is empty — the executor contract per
  // Plan 2 §Phase 2.3 is that an empty model means "let Magnific use its
  // UI default". The trigger's text reflects the already-selected model;
  // if it already matches what we want, no dropdown open is needed.
  async function selectModelIfPossible(modelName) {
    if (!modelName) return;
    const trigger = await waitFor(MODEL_TRIGGER_DATA_CY, 5_000);
    if (!(trigger instanceof HTMLElement)) {
      log(`model trigger not found — skipping model selection. tried: ${MODEL_TRIGGER_DATA_CY}`);
      dumpDataCyAttributes();
      return;
    }
    const current = (trigger.textContent || '').replace(/\s+/g, ' ').trim();
    const already =
      current.toLowerCase() === modelName.toLowerCase() ||
      new RegExp(`^${escapeRegex(modelName)}\\b`, 'i').test(current);
    if (already) {
      log(`model already set to "${current}"`);
      return;
    }
    trigger.click();
    await new Promise((r) => setTimeout(r, 500));

    // Magnific's option buttons concatenate label + credit-badge + subtitle
    // into one textContent without whitespace separators. Try strict-to-loose:
    // exact → word-boundary prefix → plain prefix → progressively shorter
    // prefixes (kept >= 2 words to avoid picking the wrong sub-model).
    const words = modelName.split(/\s+/).filter(Boolean);
    const candidates = [
      new RegExp(`^${escapeRegex(modelName)}$`),
      new RegExp(`^${escapeRegex(modelName)}\\b`),
      new RegExp(`^${escapeRegex(modelName)}`),
    ];
    for (let i = words.length - 1; i >= Math.min(2, words.length); i--) {
      candidates.push(new RegExp(`^${escapeRegex(words.slice(0, i).join(' '))}`));
    }
    for (const re of candidates) {
      const btn = findButtonByText(re);
      if (btn instanceof HTMLElement) {
        btn.click();
        log(`selected model: ${modelName}`);
        return;
      }
    }
    log(`model option "${modelName}" not found — letting Magnific use its default`);
  }

  async function fillAndGenerate(taskId, prompt, model) {
    activeTaskId = taskId;
    log(`fill+generate taskId=${taskId} model=${model || '(default)'}`);
    await selectModelIfPossible(model);

    // Poll up to 10s for the prompt field to render — SPA route transitions
    // can leave the editor unmounted for a few hundred ms after navigation.
    const filled = await waitForFill(prompt, 10_000);
    if (!filled) {
      log(
        `prompt input not found — aborting. tried: ${PROMPT_INPUT_DATA_CY}, ` +
        `textarea[placeholder*="Describe" i], textarea[aria-label*="prompt" i], ` +
        `textarea, [contenteditable="true"]`,
      );
      dumpDataCyAttributes();
      reportFailure(taskId, 'prompt_input_not_found');
      return;
    }

    const result = await clickGenerate();
    if (result !== 'ok') {
      reportFailure(
        taskId,
        result === 'not-found' ? 'generate_button_not_found' : 'generate_button_disabled',
      );
      return;
    }
    log('clicked Generate; waiting for variations');
    startVariationWatcher();
  }

  // Returns 'ok' | 'not-found' | 'disabled'. The distinct disabled state
  // surfaces "prerequisite unmet" cases (e.g. operator signed out, or
  // Magnific requires a reference image we haven't supplied) loudly
  // instead of clicking a dead button and waiting out the timeout.
  async function clickGenerate() {
    const btn = await waitFor(GENERATE_BUTTON_SELECTOR, 5_000);
    if (!(btn instanceof HTMLElement)) {
      log(`generate button not found — aborting. tried: ${GENERATE_BUTTON_SELECTOR}`);
      dumpDataCyAttributes();
      return 'not-found';
    }
    // Brief settle so Vue/React can reconcile the button's disabled state
    // after the prompt fill mutation.
    await new Promise((r) => setTimeout(r, 400));
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      log('generate button is disabled — aborting (prerequisite unmet)');
      return 'disabled';
    }
    btn.click();
    return 'ok';
  }

  async function waitForFill(text, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (fillPrompt(text, PROMPT_INPUT_DATA_CY, [
        'textarea[placeholder*="Describe" i]',
        'textarea[aria-label*="prompt" i]',
      ])) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  }

  // Collect candidate result-image URLs that meet the size floor. The
  // floor rejects tracking pixels, sidebar thumbnails, and stale-tile
  // placeholders that share the CDN host but aren't actual results.
  function collectResultImages() {
    const out = [];
    document.querySelectorAll(VARIATION_IMG_SELECTOR).forEach((img) => {
      if (!(img instanceof HTMLImageElement)) return;
      if (!img.src) return;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < VARIATION_MIN_DIMENSION || h < VARIATION_MIN_DIMENSION) return;
      out.push(img);
    });
    return out;
  }

  function startVariationWatcher() {
    // Each tick we re-scan the document for unseen result URLs and inject
    // an overlay for any new ones. Recomputing the full set per tick
    // (instead of inspecting only MutationObserver's `addedNodes`) keeps
    // us robust against Magnific re-mounting tiles when the operator
    // scrolls — the URL-keyed dedupe in decoratedUrls prevents redundant
    // overlays.
    const tick = () => {
      for (const img of collectResultImages()) {
        const url = img.src;
        if (decoratedUrls.has(url)) continue;
        decoratedUrls.add(url);
        injectOverlay(img, url);
      }
    };
    tick();
    const obs = new MutationObserver(tick);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // Visual + text for each overlay state. Centralizing here keeps the
  // click handler thin: every transition is one call. The visual cue
  // matters because operators worried-re-click during the SW round-trip
  // when the button doesn't acknowledge (handoff 2026-05-22) — colour
  // and opacity shifts make the state legible at a glance.
  const OVERLAY_BASE_STYLE =
    'position:absolute;top:8px;left:8px;z-index:2147483647;' +
    'padding:6px 10px;font:600 12px system-ui,sans-serif;' +
    'color:#fff;border:0;border-radius:6px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.25);';
  const OVERLAY_STATES = {
    idle:       { css: 'background:#0ea5e9;cursor:pointer;',                 text: 'Use this image for HistForge' },
    submitting: { css: 'background:#475569;cursor:wait;opacity:0.75;',       text: 'Submitting to HistForge…' },
    sent:       { css: 'background:#10b981;cursor:default;opacity:0.95;',    text: 'Sent ✓' },
    failed:     { css: 'background:#ef4444;cursor:pointer;',                 text: 'Send failed — click to retry' },
    // 'inert' is what sibling overlays look like while one of their peers
    // is mid-submit — still blue but dimmed so the clicked one visually
    // owns the operator's attention.
    inert:      { css: 'background:#0ea5e9;cursor:not-allowed;opacity:0.4;', text: 'Use this image for HistForge' },
  };
  function applyOverlayState(btn, state) {
    const s = OVERLAY_STATES[state] || OVERLAY_STATES.idle;
    btn.style.cssText = OVERLAY_BASE_STYLE + s.css;
    btn.textContent = s.text;
  }

  function injectOverlay(img, resultUrl) {
    // Anchor to the [data-cy^="feed-image-item-"] tile (the stable Radix
    // container) so the overlay rides along with Magnific's tile layout.
    // The image's immediate parent is often a presentational div whose
    // computed position is unset — mutating its inline style there
    // visibly shifts the tile. Falling back to parentElement keeps the
    // overlay reachable when the result image renders outside any
    // feed-image-item (e.g. preview row).
    const anchor = img.closest('[data-cy^="feed-image-item-"]') ?? img.parentElement;
    if (!anchor) return;
    const btn = document.createElement('button');
    btn.setAttribute('data-magnific-ext-overlay', '1');
    applyOverlayState(btn, 'idle');
    const cs = window.getComputedStyle(anchor);
    if (cs.position === 'static') anchor.style.position = 'relative';
    anchor.appendChild(btn);
    decoratedOverlays.add(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const taskId = activeTaskId;
      if (!taskId) {
        log('overlay clicked but no active task — ignoring');
        return;
      }
      // Visual ack happens synchronously, before the SW round-trip, so
      // the operator doesn't worried-re-click during the gap. Terminal
      // state is set in the callback below.
      applyOverlayState(btn, 'submitting');
      btn.disabled = true;
      for (const other of decoratedOverlays) {
        if (other !== btn) {
          other.disabled = true;
          applyOverlayState(other, 'inert');
        }
      }
      log(`overlay clicked — reporting variation for task ${taskId}: ${resultUrl}`);
      chrome.runtime.sendMessage({
        action: 'magnificVariationSelected',
        taskId,
        resultUrl,
      }, (resp) => {
        if (chrome.runtime.lastError) {
          log('sendMessage failed:', chrome.runtime.lastError.message);
          // Transient SW unload. Recover so the operator can retry the
          // same tile or pick a different one.
          applyOverlayState(btn, 'failed');
          btn.disabled = false;
          for (const other of decoratedOverlays) {
            if (other !== btn) {
              other.disabled = false;
              applyOverlayState(other, 'idle');
            }
          }
          return;
        }
        if (resp && resp.matched) {
          activeTaskId = null;
          applyOverlayState(btn, 'sent');
          // Clicked button stays disabled; sibling overlays stay in
          // their 'inert' state — task is done, further picks would
          // be no-ops.
        } else {
          // matched=false: stale taskId or already resolved. Defensive
          // path; shouldn't be reachable from a real first-click.
          log('overlay click matched=false (stale taskId or already resolved)');
          applyOverlayState(btn, 'idle');
          btn.disabled = false;
          for (const other of decoratedOverlays) {
            if (other !== btn) {
              other.disabled = false;
              applyOverlayState(other, 'idle');
            }
          }
        }
      });
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    // Readiness handshake. The SW's executor races chrome's content-script
    // injection on freshly-created tabs and a magnificFillAndGenerate sent
    // before this listener registers is dropped silently with "Could not
    // establish connection." The SW polls this ping until it answers, then
    // dispatches the real message — making the handshake explicit.
    if (message.action === 'ping') {
      sendResponse({ ready: true });
      return; // synchronous reply; do not hold the channel open
    }
    if (message.action === 'magnificFillAndGenerate') {
      fillAndGenerate(message.taskId, message.prompt, message.model)
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          log('fillAndGenerate threw:', e && e.message ? e.message : e);
          sendResponse({ success: false, error: e && e.message ? e.message : String(e) });
        });
      return true; // async response
    }
  });

  log('loaded');
})();
