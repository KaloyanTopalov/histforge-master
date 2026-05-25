// AmbientForge Freepik Runner — content script (Pass 2).
//
// Drives www.magnific.com/ai/image-generator (Freepik post-rename) for two
// generation modes:
//   - mode === 'imagegen'         : Seedream 5 Lite Fast → returns image bytes
//   - mode === 'image-to-video'   : Seedance 2.0 Fast    → returns mp4 bytes
//
// Strategy notes:
//   - Selectors are layered (data-cy > aria-label > text content) for
//     resilience to Magnific UI refactors.
//   - Result detection: snapshot existing image/video URLs before clicking
//     Generate, then poll for a NEW one that wasn't in the snapshot.
//   - Image URL fetch: strip `&preview=1` from the result `<img src>` URL on
//     the assumption the CDN serves full-res when the flag is absent. If
//     ffprobe on the worker side shows the resulting image is below the
//     3000×3000 crop target, fall back to chrome.downloads (Pass 2.1).

const GENERATION_TIMEOUT_MS = {
  imagegen: 90_000, // Seedream 5 Lite Fast typically <30s
  'image-to-video': 6 * 60_000, // Seedance 2.0 Fast can take 1-5 min
  'imagegen-thumbnail': 120_000, // 4 candidates + a reference image
};
const POLL_INTERVAL_MS = 1500;

// Build marker — visible in the page console so we can confirm Chrome loaded
// the patched content script (not a stale cached copy) after an extension reload.
console.log('[freepik-runner] content.js build 2026-05-18g (smoke-button source path is operator-prompted — no hardcoded machine path)');

// MV3 service workers under Playwright-launched Chrome do NOT reliably
// self-wake, so the background poller can sit idle even with always-on code
// ("extension not enabled / I had to manually start it"). This page-side
// heartbeat pings the SW every few seconds: receiving a message wakes the
// SW and its handler runs a bridge poll. Content scripts run on every
// Magnific page load and their timers are NOT subject to SW termination, so
// this makes polling reliably always-on with zero manual steps.
if (!window.__afFreepikHeartbeat) {
  window.__afFreepikHeartbeat = setInterval(() => {
    try {
      const p = chrome.runtime.sendMessage({ type: 'freepik:poll-tick' });
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (_e) {
      /* extension context invalidated (reload) — next tick retries */
    }
  }, 4000);
}

// Smoke-test affordance: an always-present on-page button that runs ONLY the
// end-image add (entering the video generator + selecting Seedance first if
// needed) and STOPS before Generate. No pipeline / Suno / video render. Lets
// the operator validate the end-frame automation in isolation and confirm
// visually. Re-injected on an interval because Magnific is an SPA that wipes
// the body on route changes. (Uncommitted smoke tooling — remove after the
// end-frame path is proven.)
setInterval(() => {
  try {
    injectEndFrameSmokeButton();
  } catch (_e) {
    /* never let the smoke affordance break the page */
  }
  try {
    injectCoverPickSmokeButton();
  } catch (_e) {
    /* never let the smoke affordance break the page */
  }
  try {
    injectEditRefProbeButton();
  } catch (_e) {
    /* never let the probe affordance break the page */
  }
}, 3000);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'freepik:execute') return undefined;
  executeTask(msg.task)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ error: `EXECUTOR_THREW: ${String(err)}` }));
  return true;
});

async function executeTask(task) {
  try {
    if (task.mode === 'imagegen') return await executeImageGen(task);
    if (task.mode === 'imagegen-thumbnail') return await executeImageThumbnail(task);
    if (task.mode === 'image-to-video') return await executeImageToVideo(task);
    return { error: `UNKNOWN_MODE: ${task.mode}` };
  } catch (err) {
    return { error: `EXECUTOR_ERROR: ${err?.message ?? String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Image generation — Seedream 5 Lite Fast
// ---------------------------------------------------------------------------

async function executeImageGen(task) {
  if (!isOnImageGeneratorPage()) {
    return {
      error:
        'WRONG_PAGE — open https://www.magnific.com/app/ai-image-generator (the SIGNED-IN app, NOT the /ai/image-generator marketing page) before enabling the runner',
    };
  }

  // Dismiss one-time banners that block clicks.
  await tryClickFirst(['button[aria-label="Accept All Cookies"]'], 200);
  await tryClickFirst(
    [
      'button[aria-label="Got it"]',
      // Plain text fallback for that "Got it" dismiss
    ],
    200,
  );

  // Snapshot existing image URLs so we can detect "new" results.
  const beforeUrls = collectResultImageUrls();

  // Pick model: Seedream 5 Lite (or whatever task.model says). Magnific
  // renamed it from "Seedream 5 Lite Fast" → "Seedream 5 Lite" (2026-05-17).
  const desiredModel = task.model || 'Seedream 5 Lite';
  if (!(await ensureModelSelected(desiredModel))) {
    return { error: `MODEL_NOT_FOUND: ${desiredModel}` };
  }

  // Set aspect ratio (default 16:9 widescreen for ambient-video).
  await setAspectRatio(task.aspectRatio || '16:9');

  // Generate 4 images per run so the operator can pick the best one.
  await setImageCountToFour();

  // 4K resolution for the source.jpg crop target (3000×3000 + 1920×1080).
  await setResolutionTo4K();

  // Fill the prompt textarea.
  if (!(await fillPrompt(task.imagePrompt))) {
    return { error: 'PROMPT_TEXTAREA_NOT_FOUND' };
  }

  // Apply a saved Magnific style if the task specified one (e.g. "medievel").
  if (task.styleName) {
    const styleResult = await addSavedStyle(task.styleName);
    if (styleResult !== 'ok') return { error: styleResult };
  }

  // Premium-only: flip Unlimited Mode ON if available.
  await ensureUnlimitedModeOn();

  // Click Generate.
  {
    const g = await clickGenerate();
    if (g !== 'ok') {
      return { error: g === 'disabled' ? 'GENERATE_BUTTON_DISABLED' : 'GENERATE_BUTTON_NOT_FOUND' };
    }
  }

  // Wait for 4 results to render, then for the operator to click one of them.
  const pickedUrl = await waitForOperatorPick(beforeUrls);
  if (!pickedUrl) {
    return { error: 'TIMEOUT_WAITING_FOR_OPERATOR_PICK' };
  }

  // Fetch the bytes (strip &preview=1 in hopes the CDN serves full-res).
  const fullUrl = stripPreviewFlag(pickedUrl);
  return await fetchAsMediaResult(fullUrl);
}

// ---------------------------------------------------------------------------
// Thumbnail generation — Seedream 5 Lite with an uploaded REFERENCE image
// (not a saved style), NO operator pick, ALL candidates returned.
// ---------------------------------------------------------------------------

function tlog(...args) {
  console.log('[freepik-runner][thumb]', ...args);
}

// Radix triggers (reference cards: data-grace-area-trigger / data-state) and
// some tiles ignore a bare el.click() — they need a real pointer sequence.
// Dispatch the full pointerover→down→up + mouse + click chain at the
// element's center. (Not isTrusted, but Magnific's Radix opens on this.)
function clickReal(el) {
  if (!(el instanceof Element)) return false;
  const r = el.getBoundingClientRect();
  const o = {
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
    clientX: r.left + r.width / 2,
    clientY: r.top + r.height / 2,
    button: 0,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
  };
  try {
    el.dispatchEvent(new PointerEvent('pointerover', o));
    el.dispatchEvent(new PointerEvent('pointerenter', o));
    el.dispatchEvent(new PointerEvent('pointerdown', o));
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new PointerEvent('pointerup', o));
    el.dispatchEvent(new MouseEvent('mouseup', o));
    el.dispatchEvent(new MouseEvent('click', o));
  } catch (_e) {
    el.click();
  }
  return true;
}

// Trusted click via the SW's chrome.debugger (CDP Input.dispatchMouseEvent).
// Magnific's Radix reference cards / controls gate on event.isTrusted, so a
// content-script click is ignored — this is the only JS path. Falls back to
// the synthetic pointer sequence if the SW/CDP path is unavailable.
async function cdpClick(selector) {
  try {
    const r = await chrome.runtime.sendMessage({
      type: 'freepik:trusted-click',
      selector,
    });
    if (r && r.ok) return true;
    tlog('cdpClick failed:', selector, r && r.error);
  } catch (e) {
    tlog('cdpClick threw:', selector, String(e));
  }
  const el = document.querySelector(selector);
  if (el instanceof HTMLElement) clickReal(el);
  return false;
}

async function executeImageThumbnail(task) {
  if (!isOnImageGeneratorPage()) {
    return {
      error:
        'WRONG_PAGE — open https://www.magnific.com/app/ai-image-generator (the SIGNED-IN app) before the runner',
    };
  }
  await tryClickFirst(['button[aria-label="Accept All Cookies"]'], 200);
  await tryClickFirst(['button[aria-label="Got it"]'], 200);

  const beforeUrls = collectResultImageUrls();

  const desiredModel = task.model || 'Seedream 5 Lite';
  if (!(await ensureModelSelected(desiredModel))) {
    return { error: `MODEL_NOT_FOUND: ${desiredModel}` };
  }
  await setAspectRatio(task.aspectRatio || '16:9');
  await setImageCountToFour();
  await setResolutionTo4K();
  if (!(await fillPrompt(task.imagePrompt))) {
    return { error: 'PROMPT_TEXTAREA_NOT_FOUND' };
  }

  // Reference IMAGE instead of a saved style (see "Task 6 — Captured DOM" in
  // docs/plans/2026-05-18-ambient-video-thumbnail-magnific.md).
  const ref = await addReferenceImageViaUpload(task.referenceImagePath);
  if (ref !== 'ok') return { error: ref };
  // CDP work done — detach so the yellow "debugging this tab" banner clears
  // before the generate+poll wait (mirrors the end-frame flow).
  try {
    await chrome.runtime.sendMessage({ type: 'freepik:detach-debugger' });
  } catch (_e) {
    /* ignore — nothing attached / SW asleep */
  }

  await ensureUnlimitedModeOn();
  {
    const g = await clickGenerate();
    if (g !== 'ok') {
      return { error: g === 'disabled' ? 'GENERATE_BUTTON_DISABLED' : 'GENERATE_BUTTON_NOT_FOUND' };
    }
  }

  // Collect ALL new results — no operator pick. Want `task.count` (default 4).
  const want = Math.min(8, Math.max(1, Number(task.count) || 4));
  const deadline = Date.now() + GENERATION_TIMEOUT_MS['imagegen-thumbnail'];
  let urls = [];
  while (Date.now() < deadline) {
    urls = [...collectResultImageUrls()].filter((u) => !beforeUrls.has(u));
    if (urls.length >= want) break;
    await sleep(POLL_INTERVAL_MS);
  }
  if (urls.length === 0) {
    tlog('FAIL: no new result images before timeout');
    return { error: 'THUMB_GEN_TIMEOUT' };
  }
  const picked = urls.slice(0, want);
  tlog(`got ${urls.length} new result(s); downloading ${picked.length}`);

  const mediaFiles = [];
  for (const u of picked) {
    const r = await fetchAsMediaResult(stripPreviewFlag(u));
    if (r && Array.isArray(r.mediaFiles) && r.mediaFiles[0]) {
      mediaFiles.push(r.mediaFiles[0]);
    } else {
      tlog('WARN: failed to fetch bytes for', u.slice(0, 120));
    }
  }
  if (mediaFiles.length === 0) return { error: 'THUMB_DOWNLOAD_FAILED' };
  if (mediaFiles.length < picked.length) {
    tlog(`WARN: only ${mediaFiles.length}/${picked.length} candidates downloaded`);
  }
  tlog(`done — returning ${mediaFiles.length} candidate(s)`);
  return { mediaFiles };
}

// Upload `filePath` as a Magnific image REFERENCE via the advanced-selection
// modal (the Uploads tab + CDP file-input set + "Add"). Returns 'ok' or a
// distinct error code so the live driver loop can pinpoint the broken step.
function refCounter() {
  const i = document.querySelector('[data-cy="image-references-input"]');
  const m = i ? (i.textContent || '').match(/(\d)\s*\/\s*8/) : null;
  return m ? Number(m[1]) : 0;
}

function feedItemIds() {
  return [...document.querySelectorAll('[data-cy^="feed-image-item-"]')].map((e) =>
    e.getAttribute('data-cy'),
  );
}

// Operator-validated fresh-image reference flow (captured 2026-05-18 via
// scripts/probe-capture-demo.ts — see "Task 7" in the plan):
//   reference-add-button → advanced-selection-modal →
//   advanced-selection-upload-button (file chooser on
//   advanced-selection-upload-file-input; CDP-set it) → wait for the upload
//   to land as a NEW feed-image-item → clear-all → select that tile →
//   advanced-selection-add-images-button → references counter increments.
async function addReferenceImageViaUpload(filePath) {
  if (!filePath || typeof filePath !== 'string') return 'THUMB_REF_PATH_MISSING';
  const before = refCounter();

  const addCard = document.querySelector('[data-cy="reference-add-button"]');
  if (!(addCard instanceof HTMLElement)) return 'REFERENCE_ADD_BUTTON_NOT_FOUND';
  await cdpClick('[data-cy="reference-add-button"]');

  const modal = await waitForSelector('[data-cy="advanced-selection-modal"]', 10000);
  if (!modal) return 'REFERENCE_MODAL_NOT_OPENED';
  tlog('advanced-selection-modal open');

  const beforeItems = new Set(feedItemIds());

  // Tag the real upload input, then click "Upload media" to arm it. The SW
  // CDP-sets the file (works regardless of the native OS dialog the click
  // would open — same primitive distrokid-runner uses).
  const fileInput = await waitForSelector(
    'input[data-cy="advanced-selection-upload-file-input"]',
    8000,
  );
  if (!(fileInput instanceof HTMLElement)) return 'REF_FILE_INPUT_NOT_FOUND';
  const HOOK = 'af-thumbref-fileinput';
  fileInput.setAttribute('data-af-hook', HOOK);

  const upBtn = document.querySelector('[data-cy="advanced-selection-upload-button"]');
  if (!(upBtn instanceof HTMLElement)) return 'REF_UPLOAD_BUTTON_NOT_FOUND';
  await cdpClick('[data-cy="advanced-selection-upload-button"]');
  await sleep(300);

  let cdp;
  try {
    cdp = await chrome.runtime.sendMessage({
      type: 'freepik:set-file-input-files',
      selector: `input[data-af-hook="${HOOK}"]`,
      files: [filePath],
    });
  } catch (e) {
    tlog('FAIL: set-file-input-files threw:', String(e));
    return 'THUMB_REF_UPLOAD_FAILED';
  }
  if (!cdp || !cdp.ok) {
    tlog('FAIL: CDP setFileInputFiles error:', cdp && cdp.error);
    return 'THUMB_REF_UPLOAD_FAILED';
  }
  tlog('file CDP-set; waiting for the upload to appear as a feed tile…');

  // Wait for the uploaded image to land as a NEW feed-image-item.
  let newId = null;
  const upDeadline = Date.now() + 45_000;
  while (Date.now() < upDeadline) {
    const fresh = feedItemIds().filter((id) => id && !beforeItems.has(id));
    if (fresh.length > 0) {
      newId = fresh[0];
      break;
    }
    await sleep(1500);
  }
  if (!newId) {
    tlog('FAIL: uploaded image never appeared as a new feed-image-item');
    return 'REF_UPLOAD_NO_NEW_TILE';
  }
  tlog(`upload landed as ${newId}`);

  // Clear any default selection so ONLY our upload becomes the reference.
  const clearAll = document.querySelector('[data-cy="advanced-selection-clear-all-button"]');
  if (clearAll instanceof HTMLElement) {
    await cdpClick('[data-cy="advanced-selection-clear-all-button"]');
    await sleep(600);
  }

  // Select our uploaded tile.
  if (document.querySelector(`[data-cy="${newId}"]`)) {
    await cdpClick(`[data-cy="${newId}"]`);
    await sleep(800);
  }

  // Commit.
  const commit = await waitForEnabled('[data-cy="advanced-selection-add-images-button"]', 15000);
  if (!commit) {
    tlog('FAIL: advanced-selection-add-images-button never enabled');
    return 'REF_COMMIT_BUTTON_NOT_FOUND';
  }
  await cdpClick('[data-cy="advanced-selection-add-images-button"]');
  await sleep(2500);

  const after = refCounter();
  const modalGone = document.querySelector('[data-cy="advanced-selection-modal"]') == null;
  tlog(`reference add: modalClosed=${modalGone} counter ${before}→${after}/8`);
  if (after > before) return 'ok';
  return 'REF_UPLOAD_NOT_APPLIED';
}

// ---------------------------------------------------------------------------
// Image-to-video — Seedance 2.0 Fast
// ---------------------------------------------------------------------------

async function executeImageToVideo(task) {
  // The 'Create video' button lives on the image-generation result OR on a
  // standalone /app/ai-video-generator page. The flow Magnific captured in
  // the user's codegen session was: from a just-generated image, click
  // "Create video" → routes to the video generator with that image preloaded.
  //
  // For now we assume the operator is on the image generator with the most
  // recent result still selected. Future iteration: support starting from
  // the video-generator page with a fresh image upload.
  const beforeUrls = collectResultVideoUrls();

  // 1. Reach the video generator with the picked image as the start frame.
  //    Distinct error so a nav failure isn't misreported as MODEL_NOT_FOUND.
  if (!(await enterVideoGenerator())) {
    return { error: 'VIDEO_GENERATOR_NOT_REACHED' };
  }

  // 2. Model.
  const desiredModel = task.model || 'Seedance 2.0 Fast';
  if (!(await selectVideoModel(desiredModel))) {
    return { error: `MODEL_NOT_FOUND: ${desiredModel}` };
  }

  // 3. Aspect + duration are best-effort: the worker re-validates the clip
  // (h264, >=4s, 16:9). Seedance 2.0 Fast's min is 4s — accept 4 or 5.
  await setVideoOption('video-aspect-ratio-option', /(^|\D)16:9(\D|$)/);
  await setVideoOption('video-duration-option', /(^|\D)[45](\s*s|"|\b)/i);

  // 4. End frame = start frame (seamless loop). ensureEndFrameMatchesStart
  //    CDP-uploads task.sourceImagePath (the picked source.jpg, which is also
  //    the Seedance start frame) into the End-frame picker, then we GATE on
  //    the operator: a banner asks them to verify End==Start before Generate
  //    (and fix it by hand if CDP missed). Prevents a wasted Seedance render.
  await confirmEndFrameWithOperator(task.sourceImagePath);
  // CDP work is done (file set + Add clicked, or operator handled it). Detach
  // so the yellow "debugging this tab" banner clears before the long
  // generate+poll wait. Best-effort — mirrors distrokid's post-action detach.
  try {
    await chrome.runtime.sendMessage({ type: 'freepik:detach-debugger' });
  } catch (_e) {
    /* ignore — nothing attached / SW asleep */
  }

  // Fill the motion prompt textbox if provided. Reuses the same textarea
  // selectors as image generation — Magnific's video page uses similar
  // "Describe" / aria-label="prompt" attributes. Skip silently if no
  // prompt was passed (Seedance can run on the image alone).
  if (typeof task.prompt === 'string' && task.prompt.trim().length > 0) {
    if (!(await fillPrompt(task.prompt))) {
      return { error: 'VIDEO_PROMPT_TEXTAREA_NOT_FOUND' };
    }
  }

  await ensureUnlimitedModeOn();

  {
    const g = await clickGenerate();
    if (g !== 'ok') {
      return { error: g === 'disabled' ? 'GENERATE_BUTTON_DISABLED' : 'GENERATE_BUTTON_NOT_FOUND' };
    }
  }

  // Some flows show a T&C/credits dialog. Best-effort dismiss.
  await sleep(300);
  await tryClickFirst(
    [
      'button[aria-label="Accept and continue"]',
      // Will fall back to text matching below if aria-label is absent.
    ],
    400,
  );
  await tryClickButtonByText('Accept and continue', 400);

  const newUrl = await waitForNewResultVideo(
    beforeUrls,
    GENERATION_TIMEOUT_MS['image-to-video'],
  );
  if (!newUrl) {
    return { error: 'TIMEOUT_WAITING_FOR_VIDEO_RESULT' };
  }

  return await fetchAsMediaResult(newUrl);
}

// ---------------------------------------------------------------------------
// Selector helpers
// ---------------------------------------------------------------------------

function isOnImageGeneratorPage() {
  // ONLY the signed-in app generator. The old `/ai/image-generator` path is
  // the public marketing page (different model picker) — accepting it made
  // the runner silently drive the wrong page → MODEL_NOT_FOUND.
  return /\/app\/ai-image-generator/.test(location.pathname);
}

function getModelTrigger() {
  // Signed-in app (2026-05-17): the model selector is a <button
  // data-cy="tti-mode-selector-v3-trigger"> whose textContent is the CURRENT
  // model (e.g. "Seedream 5 Lite"). Note the hook has no "model" substring,
  // so the old [data-cy*="model"] never matched it.
  return (
    document.querySelector('[data-cy="tti-mode-selector-v3-trigger"]') ||
    document.querySelector('[data-cy*="mode-selector" i]') ||
    document.querySelector('[data-cy*="model" i]') ||
    findButtonByName(/^Auto$/) ||
    findButtonByName(/^Seedream/i) ||
    findButtonByName(/^Seedance/i) ||
    findButtonByName(/^Mystic/i) ||
    findButtonByName(/^Flux/i) ||
    findButtonByName(/^Imagen/i) ||
    document.querySelector('button[aria-label*="model" i]')
  );
}

async function ensureModelSelected(label) {
  // The trigger's text reflects the already-selected model. The app defaults
  // to "Seedream 5 Lite" — exactly what ambient-video wants — so the common
  // path is a no-op (skip the brittle dropdown entirely). Only open + pick
  // when the current model differs from what we want.
  const trigger = getModelTrigger();
  if (!(trigger instanceof HTMLElement)) return false;
  const current = (trigger.textContent || '').replace(/\s+/g, ' ').trim();
  const already =
    current.toLowerCase() === label.toLowerCase() ||
    new RegExp(`^${escapeRegex(label)}\\b`, 'i').test(current);
  if (already) return true;
  trigger.click();
  await sleep(500);
  return await clickModelOption(label);
}

async function clickModelOption(label) {
  // Magnific's option buttons concatenate text without whitespace separators
  // (label + credit-badge + subtitle all render as one textContent string).
  // Try matchers from strictest to loosest:
  //   1. exact ("Seedream 5 Lite Fast")
  //   2. prefix with word boundary  ("Seedream 5 Lite Fast " + " 473 -")
  //   3. plain prefix                ("Seedream 5 Lite Fast" + "50Fast ...")
  //   4. progressively shorter prefixes (drop trailing words one at a time)
  // The last tier lets us tolerate label drift like "Seedream 5 Lite Fast"
  // vs Magnific's current "Seedream 5 Lite" — we still bail out before
  // matching just "Seedream" alone, to avoid picking the wrong sub-model.
  const words = label.split(/\s+/).filter(Boolean);
  const candidates = [
    new RegExp(`^${escapeRegex(label)}$`),
    new RegExp(`^${escapeRegex(label)}\\b`),
    new RegExp(`^${escapeRegex(label)}`),
  ];
  // Drop trailing words; keep at least 2 to stay specific enough.
  for (let i = words.length - 1; i >= Math.min(2, words.length); i--) {
    const shorter = words.slice(0, i).join(' ');
    candidates.push(new RegExp(`^${escapeRegex(shorter)}`));
  }
  for (const re of candidates) {
    const btn = findButtonByName(re);
    if (btn) {
      btn.click();
      await sleep(300);
      return true;
    }
  }
  return false;
}

async function setAspectRatio(ratio) {
  // Prefer the stable test hook; the trigger's text reflects the current
  // ratio (e.g. "3:4", "16:9"). Skip if already on target.
  const trigger =
    document.querySelector('button[data-cy="image-aspect-ratio-input"]') ??
    findButtonByName(/^(1?:1|16?:9|9?:16|3:4|4:3)$/) ??
    findButtonByName(/Widescreen/i);
  if (!(trigger instanceof HTMLElement)) return false;
  const currentText = (trigger.textContent ?? '').trim();
  if (currentText === ratio) return true;
  trigger.click();
  await sleep(300);
  // Popover options share textContent of the form "16:9Widescreen" (label
  // glued to subtitle, no whitespace). Match the leading ratio token.
  const ratioRe = new RegExp(`^${escapeRegex(ratio)}(?:\\D|$)`);
  const options = document.querySelectorAll('button[data-cy="popover-option"]');
  for (const opt of options) {
    if (ratioRe.test((opt.textContent ?? '').trim())) {
      opt.click();
      await sleep(200);
      return true;
    }
  }
  return false;
}

async function fillPrompt(text) {
  // Signed-in app: the image prompt is <div data-cy="image-prompt-input">
  // (a contenteditable, or a wrapper around one). `video-prompt-input` is the
  // VIDEO tool's hook — wrong for image gen; keep it only as a late fallback.
  const editableFrom = (root) => {
    if (!root) return null;
    if (
      root instanceof HTMLTextAreaElement ||
      root instanceof HTMLInputElement ||
      (root instanceof HTMLElement && root.isContentEditable)
    ) {
      return root;
    }
    return root.querySelector('textarea, input, [contenteditable="true"]');
  };
  const candidates = [
    editableFrom(document.querySelector('[data-cy="image-prompt-input"]')),
    editableFrom(document.querySelector('[data-cy="video-prompt-input"]')),
    document.querySelector('textarea[placeholder*="Describe" i]'),
    document.querySelector('textarea[aria-label*="prompt" i]'),
    document.querySelector('textarea'),
    document.querySelector('[contenteditable="true"]'),
    document.querySelector('.text-surface-foreground-0.w-full'),
  ];
  const el = candidates.find((e) => e instanceof HTMLElement);
  if (!el) return false;
  el.focus();
  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    // Use native setter so Vue / React see the update.
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.textContent = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));
  }
  return true;
}

// Returns 'ok' | 'not-found' | 'disabled'. A disabled Generate button means a
// prerequisite is unmet (e.g. Magnific requires an end frame) — surface that
// fast instead of clicking a dead button and waiting out the result timeout.
async function clickGenerate() {
  // Magnific's Generate button concatenates "Generate" with a hover-revealed
  // "100" credits badge into one textContent. Prefer the stable test hook.
  const btn =
    document.querySelector('button[data-cy="generate-button"]') ||
    findButtonByName(/^Generate(\s|$)/);
  if (!(btn instanceof HTMLElement)) return 'not-found';
  await sleep(400); // let Vue settle the disabled state after prior steps
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
    return 'disabled';
  }
  btn.click();
  return 'ok';
}

async function setImageCountToFour() {
  // Magnific defaults to N=2 (sometimes 1). Click the increase stepper until
  // disabled (= at max) OR until we've clicked 3 times (1→4 worst case).
  // Cap protects against an unbounded stepper.
  for (let i = 0; i < 3; i++) {
    const btn = document.querySelector('button[data-cy="increase-number-images-button"]');
    if (!(btn instanceof HTMLElement)) return; // stepper absent — accept whatever the default is
    if (btn.hasAttribute('disabled')) return; // hit max (we accept whatever it landed on)
    btn.click();
    await sleep(150);
  }
}

async function setResolutionTo4K() {
  // Resolution picker defaults to 2K. Open the popover, click the 4K option.
  const trigger = document.querySelector('button[data-cy="image-resolution-input"]');
  if (!(trigger instanceof HTMLElement)) return;
  if (/\b4K\b/.test((trigger.textContent ?? '').trim())) return; // already 4K
  trigger.click();
  await sleep(300);
  const options = document.querySelectorAll('button[data-cy="popover-option"]');
  for (const opt of options) {
    if (/^\s*4K\b/.test(opt.textContent ?? '')) {
      opt.click();
      await sleep(200);
      return;
    }
  }
}

async function ensureUnlimitedModeOn() {
  // Premium accounts get unlimited Seedream/Seedance generations via a toggle
  // that defaults to OFF. The toggle button surfaces its state as "ON"/"OFF"
  // text inside a child span. Flip to ON if currently OFF.
  const toggle = document.querySelector('button[data-cy="unlimited-mode-toggle-button"]');
  if (!(toggle instanceof HTMLElement)) return; // toggle not present (free plan?) — proceed without it
  const text = (toggle.textContent ?? '').trim().toUpperCase();
  if (text.includes('OFF')) {
    toggle.click();
    await sleep(300);
  }
}

async function addSavedStyle(name) {
  // Magnific's Style reference-card slot opens a modal where saved styles
  // (operator-tagged like "#medievel") can be selected. Flow:
  //   1. Click the empty Style slot (a dashed-border card with a "Style" label).
  //   2. In the modal, click the "My Styles" filter to scope to saved styles.
  //   3. Find the saved style by alt text (tolerant of optional `#` prefix).
  //   4. Click the style cover image to mark it selected.
  //   5. Click the modal's "Add" button (data-cy="advanced-selection-add-images-button").
  // Returns 'ok' on success or an error code string for the bridge.
  //
  // Idempotency: Magnific keeps the previously-applied Style between
  // generations — the dashed empty slot disappears as soon as a style is
  // applied. If the requested style is already applied (matching <img alt>
  // anywhere on the page), short-circuit and return ok. Without this check
  // the second run for a channel always fails with STYLE_SLOT_NOT_FOUND
  // because the slot is permanently filled.
  const alreadyApplied = findStyleCardByName(name);
  if (alreadyApplied) {
    console.log('[freepik-runner] style already applied:', name, '— skip add');
    return 'ok';
  }
  const slot = findStyleReferenceSlot();
  if (!slot) return 'STYLE_SLOT_NOT_FOUND';
  slot.click();
  await sleep(400);

  const myStylesBtn = document.querySelector('button[data-cy="styles-filter-my-style-button"]');
  if (myStylesBtn instanceof HTMLElement) {
    myStylesBtn.click();
    await sleep(400);
  }

  const target = findStyleCardByName(name);
  if (!target) return `STYLE_NOT_FOUND: ${name}`;
  target.click();
  await sleep(200);

  const addBtn = document.querySelector('button[data-cy="advanced-selection-add-images-button"]');
  if (!(addBtn instanceof HTMLElement)) return 'STYLE_ADD_BUTTON_NOT_FOUND';
  addBtn.click();
  await sleep(400);
  return 'ok';
}

function findStyleReferenceSlot() {
  // Empty Style card: a clickable container with a "Style" text label inside.
  const labels = document.querySelectorAll('span');
  for (const label of labels) {
    if ((label.textContent ?? '').trim() !== 'Style') continue;
    const card = label.closest('.cursor-pointer');
    if (card instanceof HTMLElement) return card;
  }
  return null;
}

function findStyleCardByName(name) {
  // Style cards have <img alt="#tagname">. Operator may store the bare name
  // ("medievel") or the tag form ("#medievel") — match either.
  const stripped = name.replace(/^#/, '').toLowerCase();
  const imgs = document.querySelectorAll('img[alt]');
  for (const img of imgs) {
    const alt = (img.getAttribute('alt') ?? '').replace(/^#/, '').toLowerCase();
    if (alt === stripped) return img;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Result polling
// ---------------------------------------------------------------------------

function collectResultImageUrls() {
  // Filter out tracking pixels + tiny icons by requiring a meaningful natural
  // dimension. Generated results are >= 1024px on the long edge; we use 200
  // as a generous floor that still rejects 1x1 pixels, sub-100 icons, etc.
  const set = new Set();
  document
    .querySelectorAll('img[src*="cdnpk.net"], img[src*="freepik"], img[src*="magnific"]')
    .forEach((img) => {
      if (!img.src) return;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < 200 || h < 200) return;
      set.add(img.src);
    });
  return set;
}

function collectResultVideoUrls() {
  const set = new Set();
  document
    .querySelectorAll('video[src*="cdnpk.net"]')
    .forEach((video) => set.add(video.src));
  return set;
}

async function waitForOperatorPick(beforeUrls) {
  // Phase 1: wait up to GENERATION_TIMEOUT_MS.imagegen for 4 new result
  // images to render. Accept anything ≥200×200 to filter tracking pixels.
  const renderDeadline = Date.now() + GENERATION_TIMEOUT_MS.imagegen;
  while (Date.now() < renderDeadline) {
    const newUrls = [...collectResultImageUrls()].filter((u) => !beforeUrls.has(u));
    if (newUrls.length >= 4) break;
    await sleep(POLL_INTERVAL_MS);
  }

  // Snapshot the candidate previews (stable order = DOM/query order). The
  // popup shows them in this order so a chosen index maps 1:1 to candidates[i].
  const candidates = [...collectResultImageUrls()]
    .filter((u) => !beforeUrls.has(u))
    .slice(0, 6);
  pickLog(`render done — ${candidates.length} candidate(s):`, candidates);

  // Best-effort: hand small JPEG thumbnails of the candidates to the bridge so
  // the always-on-top popup (scripts/pick-popup.ps1) can show them and the
  // operator can choose instantly without watching this tab. Thumbnails (not
  // the raw 4K images) keep the whole offer ~100KB so the SW relay can't
  // choke on a 20-40MB message. Any failure here is non-fatal — the in-tab
  // click path below still resolves the pick (the validated 2026-05-17
  // behavior is preserved as the fallback).
  let offerSent = false;
  if (candidates.length > 0) {
    const images = await assembleOfferImages(candidates);
    offerSent = await postPickOfferWithRetry(images);
  } else {
    pickLog('no candidates — popup offer skipped; in-tab click only');
  }
  pickLog(`offerSent=${offerSent}`);

  // Phase 2: resolve the pick from EITHER the popup choice OR an in-tab click
  // (whichever happens first). 10-min human-decision timeout unchanged.
  const banner = showPickBanner(offerSent);
  let cleaned = false;
  let pollTimer = null;
  let clickHandler = null;
  let decideTimeout = null;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (clickHandler) document.removeEventListener('click', clickHandler, true);
    if (pollTimer) clearInterval(pollTimer);
    if (decideTimeout) clearTimeout(decideTimeout);
    banner.remove();
    if (offerSent) {
      try {
        chrome.runtime.sendMessage({ type: 'freepik:pick-clear' });
      } catch (_e) {
        // bridge already gone — nothing to clear
      }
    }
  };

  try {
    return await new Promise((resolve) => {
      const settle = (val, via) => {
        pickLog(`resolved via ${via}: ${typeof val === 'string' ? val.slice(0, 140) : val}`);
        cleanup();
        resolve(val);
      };

      decideTimeout = setTimeout(() => settle(null, 'timeout(10min)'), 10 * 60_000);

      // Path A — operator clicks a result image in this tab (fallback).
      clickHandler = (e) => {
        let el = e.target;
        for (let i = 0; i < 6 && el instanceof Element; i++) {
          if (el.tagName === 'IMG' && el instanceof HTMLImageElement && el.src) {
            const w = el.naturalWidth || el.width || 0;
            const h = el.naturalHeight || el.height || 0;
            if (w >= 200 && h >= 200 && !beforeUrls.has(el.src)) {
              settle(el.src, 'in-tab click');
              return;
            }
          }
          el = el.parentElement;
        }
      };
      document.addEventListener('click', clickHandler, true);

      // Path B — operator picks in the always-on-top popup. Poll the bridge
      // for the choice; resolve the matching candidate URL directly (no
      // synthetic DOM click needed — downstream only needs the URL string).
      if (offerSent) {
        pollTimer = setInterval(async () => {
          try {
            const r = await chrome.runtime.sendMessage({ type: 'freepik:pick-poll' });
            if (r && typeof r.index === 'number' && candidates[r.index]) {
              settle(candidates[r.index], 'popup #' + (r.index + 1));
            }
          } catch (_e) {
            // transient SW/bridge hiccup — keep polling
          }
        }, 1500);
      }
    });
  } finally {
    cleanup();
  }
}

function pickLog(...args) {
  console.log('[freepik-runner][pick]', ...args);
}

// Turn candidate CDN URLs into small base64 JPEG data URLs for the popup.
// Each thumbnail is built in the service worker (OffscreenCanvas) so a
// cross-origin 4K image becomes ~15KB. Returns an array aligned 1:1 with
// `candidates`; a failed thumb is '' (the popup renders a placeholder tile
// and the index stays aligned so the pick still maps correctly).
async function assembleOfferImages(candidates) {
  const images = [];
  for (let i = 0; i < candidates.length; i++) {
    const url = candidates[i];
    let dataUrl = '';
    try {
      const r = await chrome.runtime.sendMessage({ type: 'freepik:pick-thumb', url });
      if (r && r.dataUrl) {
        dataUrl = r.dataUrl;
        pickLog(
          `thumb[${i}] ok ${r.dims} ~${Math.round((r.bytes || 0) / 1024)}KB downscaled=${r.downscaled}`,
        );
      } else {
        pickLog(`thumb[${i}] FAILED: ${r && r.error} — placeholder tile (still pickable)`);
      }
    } catch (e) {
      pickLog(`thumb[${i}] sendMessage threw: ${String(e)} — placeholder tile`);
    }
    images.push(dataUrl);
  }
  const kb = Math.round(images.reduce((n, s) => n + s.length, 0) / 1024);
  pickLog(`offer assembled: ${images.length} thumb(s) ~${kb}KB total`);
  return images;
}

// Post the offer to the bridge (via the SW relay) with a few retries. A
// single transient MV3 SW miss otherwise permanently loses the popup; the
// retry makes the always-on-top path reliable. The in-tab click remains the
// untouched fallback if every attempt fails.
async function postPickOfferWithRetry(images, attempts = 3) {
  for (let a = 1; a <= attempts; a++) {
    try {
      const offer = await chrome.runtime.sendMessage({ type: 'freepik:pick-offer', images });
      if (offer && offer.offerId) {
        pickLog(`pick-offer accepted on attempt ${a} (offerId=${offer.offerId})`);
        return true;
      }
      pickLog(`pick-offer attempt ${a}/${attempts}: no offerId (resp=${JSON.stringify(offer)})`);
    } catch (e) {
      pickLog(`pick-offer attempt ${a}/${attempts} threw: ${String(e)}`);
    }
    if (a < attempts) await sleep(800);
  }
  pickLog('pick-offer FAILED after all retries — popup will not show; in-tab click only');
  return false;
}

let __afPickSmokeRunning = false;

// Smoke affordance (zero Suno / zero generation): validates the ENTIRE
// cover-pick relay — content.js → SW thumbnail → bridge /pick-offer →
// pick-popup.ps1 → /pick-choice → SW → content.js — without generating
// anything. Prefers up to 4 result images already on the page (exercises the
// real SW thumbnail path); if none are present it synthesizes 4 solid-color
// tiles so the popup + choice round-trip can still be exercised on a blank
// page. The picked index is logged; no download, no video, no pipeline.
// (Remove with the other smoke tooling once the popup path is proven.)
function injectCoverPickSmokeButton() {
  if (document.getElementById('af-pick-smoke-btn')) return;
  if (!document.body) return;
  const btn = document.createElement('button');
  btn.id = 'af-pick-smoke-btn';
  btn.type = 'button';
  btn.textContent = 'AF smoke: test cover-pick popup';
  btn.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'left:340px',
    'z-index:2147483647',
    'background:#6d28d9',
    'color:#fff',
    'padding:12px 16px',
    'border:0',
    'border-radius:10px',
    'font:700 13px/1.3 system-ui,-apple-system,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    'cursor:pointer',
    'user-select:none',
  ].join(';');
  const reset = () => {
    btn.disabled = false;
    btn.textContent = 'AF smoke: test cover-pick popup';
    btn.style.background = '#6d28d9';
  };
  btn.addEventListener('click', async () => {
    if (__afPickSmokeRunning) return;
    __afPickSmokeRunning = true;
    btn.disabled = true;
    btn.textContent = 'AF smoke: offering covers…';
    btn.style.background = '#1d4ed8';
    let offerSent = false;
    try {
      const realUrls = [...collectResultImageUrls()].slice(0, 4);
      let candidates;
      let images;
      if (realUrls.length > 0) {
        pickLog(`smoke: ${realUrls.length} on-page image(s) — exercising real SW thumbnail path`);
        candidates = realUrls;
        images = await assembleOfferImages(candidates);
      } else {
        pickLog('smoke: no on-page images — synthesizing 4 color tiles (popup/choice round-trip only)');
        candidates = ['#smoke0', '#smoke1', '#smoke2', '#smoke3'];
        images = ['#ef4444', '#22c55e', '#3b82f6', '#eab308'].map((c, i) =>
          makeSolidTileDataUrl(c, `SMOKE ${i + 1}`),
        );
      }
      offerSent = await postPickOfferWithRetry(images);
      if (!offerSent) {
        btn.textContent = 'AF smoke: offer FAILED — see [pick] console';
        btn.style.background = '#b91c1c';
        return;
      }
      btn.textContent = 'AF smoke: pick in the popup window…';
      btn.style.background = '#b45309';
      const deadline = Date.now() + 2 * 60_000;
      let picked = -1;
      while (Date.now() < deadline) {
        await sleep(1500);
        let r;
        try {
          r = await chrome.runtime.sendMessage({ type: 'freepik:pick-poll' });
        } catch (_e) {
          continue; // transient SW hiccup — keep polling
        }
        if (r && typeof r.index === 'number') {
          picked = r.index;
          break;
        }
      }
      if (picked >= 0) {
        pickLog(`smoke RESULT: popup returned index ${picked} → ${candidates[picked]}`);
        btn.textContent = `AF smoke: popup OK ✓ picked #${picked + 1}`;
        btn.style.background = '#15803d';
      } else {
        pickLog('smoke RESULT: no pick within 2min (popup not running or relay broke)');
        btn.textContent = 'AF smoke: no pick (2min) — see [pick] console';
        btn.style.background = '#b91c1c';
      }
    } catch (e) {
      pickLog('smoke ERROR:', String(e));
      btn.textContent = 'AF smoke: ERROR — see [pick] console';
      btn.style.background = '#b91c1c';
    } finally {
      try {
        if (offerSent) await chrome.runtime.sendMessage({ type: 'freepik:pick-clear' });
      } catch (_e) {
        /* bridge gone — nothing to clear */
      }
      __afPickSmokeRunning = false;
      btn.disabled = false;
      setTimeout(reset, 8000);
    }
  });
  document.body.appendChild(btn);
}

// A small solid-color PNG data URL drawn in the page (same-origin canvas, not
// tainted) — used only by the cover-pick smoke when no real images exist, so
// the popup + choice round-trip is testable on a blank Magnific page.
function makeSolidTileDataUrl(color, label) {
  try {
    const c = document.createElement('canvas');
    c.width = 320;
    c.height = 320;
    const g = c.getContext('2d');
    g.fillStyle = color;
    g.fillRect(0, 0, 320, 320);
    g.fillStyle = '#ffffff';
    g.font = 'bold 28px system-ui, sans-serif';
    g.fillText(label, 24, 168);
    return c.toDataURL('image/png');
  } catch (_e) {
    return '';
  }
}

function showPickBanner(offerSent) {
  const banner = document.createElement('div');
  banner.id = 'ambientforge-pick-banner';
  banner.textContent = offerSent
    ? 'AmbientForge: a pop-up with the 4 covers will appear — pick there (or click an image here).'
    : 'AmbientForge: click the image you want to use for this album.';
  banner.style.cssText = [
    'position:fixed',
    'top:12px',
    'right:12px',
    'z-index:2147483647',
    'background:#1d4ed8',
    'color:#fff',
    'padding:10px 14px',
    'border-radius:8px',
    'font:600 13px/1.4 system-ui,-apple-system,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.25)',
    'max-width:280px',
    'pointer-events:none',
  ].join(';');
  document.body.appendChild(banner);
  return banner;
}

async function waitForNewResultImage(beforeUrls, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // Prefer a loaded result image with the semantic `alt="text-to-image"` tag.
    const candidate = document.querySelector(
      'img.feed-image-loaded[alt="text-to-image"], img.feed-image-reveal.feed-image-loaded',
    );
    if (candidate?.src && !beforeUrls.has(candidate.src)) return candidate.src;
    // Fallback: any new pikaso URL we haven't seen.
    const all = collectResultImageUrls();
    for (const url of all) {
      if (!beforeUrls.has(url)) return url;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function waitForNewResultVideo(beforeUrls, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const all = collectResultVideoUrls();
    for (const url of all) {
      if (!beforeUrls.has(url)) return url;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch result bytes → base64 payload for the bridge.
// ---------------------------------------------------------------------------

async function fetchAsMediaResult(url) {
  // Content scripts run in the page origin and don't inherit the extension's
  // host_permissions, so cross-origin CDN fetches fail CORS. Route through
  // the service worker, which DOES get the host_permissions bypass.
  const swResult = await chrome.runtime.sendMessage({ type: 'freepik:cdn-fetch', url });
  if (swResult?.mediaFiles) return swResult;
  if (swResult?.error) return { error: `CDN_FETCH_FAILED: ${swResult.error} for ${url}` };
  // SW unavailable (unusual) — try in-page fetch as last resort.
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) {
    return { error: `CDN_FETCH_FAILED: ${res.status} for ${url}` };
  }
  const blob = await res.blob();
  const base64 = await blobToBase64(blob);
  return {
    mediaFiles: [
      {
        base64,
        mimeType: blob.type || 'application/octet-stream',
        size: blob.size,
      },
    ],
  };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      // strip "data:<mime>;base64,"
      const comma = dataUrl.indexOf(',');
      resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(blob);
  });
}

function stripPreviewFlag(url) {
  return url.replace(/[?&]preview=1\b/g, '').replace(/\?$/, '');
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function findButtonByName(re) {
  const buttons = document.querySelectorAll('button, [role="button"]');
  for (const btn of buttons) {
    const aria = btn.getAttribute('aria-label') ?? '';
    if (re.test(aria)) return btn;
    const text = (btn.textContent ?? '').trim();
    if (re.test(text)) return btn;
  }
  return null;
}

async function tryClickFirst(selectors, postClickDelay = 200) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el instanceof HTMLElement) {
      el.click();
      await sleep(postClickDelay);
      return true;
    }
  }
  return false;
}

async function tryClickButtonByText(textRe, postClickDelay = 200) {
  const re = typeof textRe === 'string' ? new RegExp(`^${escapeRegex(textRe)}$`) : textRe;
  const btn = findButtonByName(re);
  if (btn) {
    btn.click();
    await sleep(postClickDelay);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Video-generator (image-to-video) controls — keyed off Magnific's stable
// data-cy hooks captured 2026-05-16. The image-generator path keeps its own
// openModelPicker/clickModelOption helpers; the video page uses a different
// model dialog (aria-haspopup=dialog, options are <div> rows, not <button>).
// ---------------------------------------------------------------------------

const VIDEO_MODEL_DATA_CY = {
  'seedance 2.0 fast': 'ai-model-item-bytedance-seedance-fast-2.0',
  'seedance 2.0 pro': 'ai-model-item-bytedance-seedance-pro-2.0',
};

async function selectVideoModel(desiredModel) {
  // Wait for the video panel to mount — the SPA route change after entering
  // the video generator can take >1s, longer than a fixed sleep.
  const trigger = await waitForSelector('[data-cy="video-model-selector-trigger"]', 15000);
  if (!(trigger instanceof HTMLElement)) return false;
  trigger.click();
  await sleep(500);

  const key = (desiredModel || '').trim().toLowerCase();
  const dataCy = VIDEO_MODEL_DATA_CY[key];

  if (dataCy) {
    let item = await waitForSelector(`[data-cy="${dataCy}"]`, 4000);
    if (!item) {
      // Long/virtualized list — narrow it via the dialog's search box.
      const search = document.querySelector('[data-cy="ai-model-selector-search-input"]');
      if (search instanceof HTMLElement) {
        await typeIntoInput(search, desiredModel);
        item = await waitForSelector(`[data-cy="${dataCy}"]`, 4000);
      }
    }
    if (item instanceof HTMLElement) {
      clickClickable(item);
      await sleep(400);
      return true;
    }
  }

  // Fallback: prefix-match the visible model rows by text.
  const re = new RegExp(`^${escapeRegex(desiredModel)}`, 'i');
  for (const row of document.querySelectorAll('[data-cy^="ai-model-item-"]')) {
    if (re.test((row.textContent ?? '').trim())) {
      clickClickable(row);
      await sleep(400);
      return true;
    }
  }
  return false;
}

// A data-cy node may be a non-interactive wrapper whose click handler lives on
// an ancestor (Vue rows) — prefer the closest ancestor button, else the node.
function clickClickable(el) {
  const target = el.closest('button') ?? el;
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

// Best-effort: open a video option control (duration/aspect) and click the
// option whose text matches. Never hard-fails — the worker re-validates the
// produced clip and we iterate on selectors from the observed error.
async function setVideoOption(triggerDataCy, optionRe) {
  const trigger = document.querySelector(`[data-cy="${triggerDataCy}"]`);
  if (!(trigger instanceof HTMLElement)) return false;
  if (optionRe.test((trigger.textContent ?? '').trim())) return true; // already set
  trigger.click();
  await sleep(400);
  const opts = document.querySelectorAll(
    'button[data-cy="popover-option"], [role="option"], [role="menuitem"]',
  );
  for (const opt of opts) {
    if (optionRe.test((opt.textContent ?? '').trim())) {
      clickClickable(opt);
      await sleep(250);
      return true;
    }
  }
  trigger.click(); // close popover if nothing matched
  return false;
}

// Poll for an element to appear (SPA route/mount can lag fixed sleeps).
async function waitForSelector(selector, timeoutMs = 15000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector);
    if (el instanceof HTMLElement) return el;
    await sleep(intervalMs);
  }
  return null;
}

// Get from a just-generated/picked image onto the video generator with that
// image as the start frame. Primary: a "Create video" affordance on the
// result. Fallback: the most-recent feed item's "use as start frame" action.
// Returns true once the video panel's model trigger has mounted.
async function enterVideoGenerator() {
  if (document.querySelector('[data-cy="video-model-selector-trigger"]')) return true;
  const createBtn = findButtonByName(/^Create video$/);
  if (createBtn instanceof HTMLElement) {
    createBtn.click();
  } else {
    const startFrame = document.querySelector('[data-cy="thumbnail-startframe-button"]');
    if (startFrame instanceof HTMLElement) startFrame.click();
  }
  const trigger = await waitForSelector('[data-cy="video-model-selector-trigger"]', 20000);
  return trigger instanceof HTMLElement;
}

// --- End-frame diagnostics (console-only; never alters control flow) --------
// The handoff's one open gap: "the video-panel end-frame slot outerHTML was
// never captured" — so we can't confirm [data-cy="video-end-frame-input"] is
// the right picker opener. These dumps make ONE operator cycle yield the exact
// selector even if the auto-add misses. Page-console prefix: [endframe].
function efLog(...args) {
  console.log('[freepik-runner][endframe]', ...args);
}

function boundedOuterHTML(el, cap = 1600) {
  if (!el) return '(null)';
  const html = el.outerHTML || '';
  return html.length > cap ? `${html.slice(0, cap)} …(+${html.length - cap} chars)` : html;
}

function erLog(...args) {
  console.log('[freepik-runner][editref]', ...args);
}

function dumpEndFrameDom(phase) {
  try {
    efLog(`---- DOM dump @ ${phase} ----`);
    const hooks = [];
    document.querySelectorAll('[data-cy]').forEach((el) => {
      const cy = el.getAttribute('data-cy') || '';
      if (/end|start|frame|advanced-selection|upload|first-frame|last-frame/i.test(cy)) {
        hooks.push(`${cy} <${el.tagName.toLowerCase()}${el.disabled ? ' disabled' : ''}>`);
      }
    });
    efLog('frame/upload data-cy hooks present:', hooks.length ? hooks : '(none)');
    const endInput = document.querySelector('[data-cy="video-end-frame-input"]');
    efLog('video-end-frame-input found:', !!endInput);
    if (endInput) {
      efLog('video-end-frame-input outerHTML:', boundedOuterHTML(endInput));
      efLog('video-end-frame-input parent outerHTML:', boundedOuterHTML(endInput.parentElement, 1200));
    }
    const startInput = document.querySelector('[data-cy="video-start-frame-input"]');
    if (startInput) {
      efLog('video-start-frame-input outerHTML (works → reference):', boundedOuterHTML(startInput, 1200));
    }
    const modal = document.querySelector('[data-cy="advanced-selection-modal"]');
    const dialogs = [...document.querySelectorAll('[role="dialog"], [data-cy*="modal" i]')].map(
      (d) => d.getAttribute('data-cy') || `<${d.tagName.toLowerCase()} role=dialog>`,
    );
    efLog(
      'advanced-selection-modal open:',
      !!modal,
      '| dialogs/modals present:',
      dialogs.length ? dialogs : '(none)',
    );
  } catch (e) {
    efLog('dump error (non-fatal):', String(e));
  }
}

let __afSmokeRunning = false;

// Inject (idempotently) a fixed bottom-left button that exercises ONLY the
// end-image add. It will, if not already in the video generator, click
// "Create video" + select Seedance 2.0 Fast (these spend nothing — they just
// open the generator UI), then run ensureEndFrameMatchesStart(). It NEVER
// fills a prompt and NEVER clicks Generate, so no Seedance clip is rendered.
// The operator confirms visually whether the END image == the START image.
function injectEndFrameSmokeButton() {
  if (document.getElementById('af-endframe-smoke-btn')) return;
  if (!document.body) return;
  const btn = document.createElement('button');
  btn.id = 'af-endframe-smoke-btn';
  btn.type = 'button';
  btn.textContent = 'AF smoke: Add End Image (no video)';
  btn.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'left:16px',
    'z-index:2147483647',
    'background:#b45309',
    'color:#fff',
    'padding:12px 16px',
    'border:0',
    'border-radius:10px',
    'font:700 13px/1.3 system-ui,-apple-system,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    'cursor:pointer',
    'user-select:none',
  ].join(';');
  const reset = () => {
    btn.disabled = false;
    btn.textContent = 'AF smoke: Add End Image (no video)';
    btn.style.background = '#b45309';
  };
  btn.addEventListener('click', async () => {
    if (__afSmokeRunning) return;
    __afSmokeRunning = true;
    btn.disabled = true;
    btn.textContent = 'AF smoke: running… (NOT generating)';
    btn.style.background = '#1d4ed8';
    try {
      if (!document.querySelector('[data-cy="video-model-selector-trigger"]')) {
        efLog('smoke: not in video generator — entering + selecting Seedance (no spend)…');
        const entered = await enterVideoGenerator();
        if (!entered) {
          efLog('smoke FAIL: could not reach the video generator (need a generated image with "Create video")');
          btn.textContent = 'AF smoke: no video generator — see console';
          btn.style.background = '#b91c1c';
          return;
        }
        await selectVideoModel('Seedance 2.0 Fast');
      }
      // Operator supplies the path at click time — was a hardcoded
      // machine-specific absolute path (removed so the repo is portable).
      // Any album's source.jpg works (forward slashes; Chrome on Windows
      // accepts them in CDP setFileInputFiles).
      const SMOKE_SOURCE = (
        window.prompt(
          'AF smoke — absolute path to a source.jpg to add as the End frame:',
          '',
        ) || ''
      ).trim();
      if (!SMOKE_SOURCE) {
        efLog('smoke: no path entered — aborted (nothing generated)');
        btn.textContent = 'AF smoke: no path — cancelled';
        btn.style.background = '#b91c1c';
        return;
      }
      const ok = await ensureEndFrameMatchesStart(SMOKE_SOURCE, true);
      efLog(`smoke RESULT: ensureEndFrameMatchesStart → ${ok} (NO video generated — verify the End image visually)`);
      btn.textContent = ok
        ? 'AF smoke: ADDED ✓ — verify End=Start visually'
        : 'AF smoke: MISSED ✗ — see [endframe] console';
      btn.style.background = ok ? '#15803d' : '#b91c1c';
    } catch (e) {
      efLog('smoke ERROR:', String(e));
      btn.textContent = 'AF smoke: ERROR — see console';
      btn.style.background = '#b91c1c';
    } finally {
      // Detach chrome.debugger so the yellow "debugging this tab" banner
      // clears (best-effort; mirrors distrokid's post-action detach).
      try {
        await chrome.runtime.sendMessage({ type: 'freepik:detach-debugger' });
      } catch (_e) {
        /* ignore — nothing was attached or SW asleep */
      }
      __afSmokeRunning = false;
      btn.disabled = false;
      // Leave the result visible ~6s, then reset so the operator can re-run
      // after a selector patch + extension reload.
      setTimeout(reset, 6000);
    }
  });
  document.body.appendChild(btn);
  efLog('smoke button injected (bottom-left)');
}

// ===========================================================================
// Task 6 probe: capture the post-`edit-reference-button` modal DOM.
//
// The operator's manual thumbnail flow uses an image REFERENCE (not a saved
// style): hover a reference card → click its "Edit" button
// (`[data-cy="edit-reference-button"]`) → a picker opens → upload an image →
// confirm. The picker DOM after that click is NOT yet captured, so Task 7
// can't wire the flow blindly. This probe clicks ONLY the edit-reference
// button and dumps the resulting modal/dialog structure to the page console.
// It NEVER fills a prompt and NEVER clicks Generate — zero spend.
// (Uncommitted probe tooling — removed once Task 7's selectors are locked.)
// ===========================================================================

function dumpEditRefDom(phase) {
  try {
    erLog(`---- DOM dump @ ${phase} ----`);
    const interesting = /edit|reference|style|card|upload|modal|advanced-selection|drop|file|add/i;
    const hooks = [];
    document.querySelectorAll('[data-cy]').forEach((el) => {
      const cy = el.getAttribute('data-cy') || '';
      if (interesting.test(cy)) {
        hooks.push(
          `${cy} <${el.tagName.toLowerCase()}${el.disabled ? ' disabled' : ''}>`,
        );
      }
    });
    erLog('reference/upload/modal data-cy hooks:', hooks.length ? hooks : '(none)');

    const editBtn = document.querySelector('[data-cy="edit-reference-button"]');
    erLog('edit-reference-button present:', !!editBtn);
    if (editBtn) {
      erLog('edit-reference-button outerHTML:', boundedOuterHTML(editBtn));
      erLog(
        'edit-reference-button ancestor (reference card):',
        boundedOuterHTML(editBtn.closest('[data-cy*="reference" i],[class*="reference" i]') || editBtn.parentElement, 2000),
      );
    }

    const modal = document.querySelector('[data-cy="advanced-selection-modal"]');
    erLog('advanced-selection-modal open:', !!modal);
    const dialogs = [...document.querySelectorAll('[role="dialog"],[data-cy*="modal" i]')];
    erLog(
      'dialogs/modals present:',
      dialogs.length
        ? dialogs.map((d) => d.getAttribute('data-cy') || `<${d.tagName.toLowerCase()} role=dialog>`)
        : '(none)',
    );
    // Dump the most-likely picker container in full so its upload button +
    // file input + confirm button selectors can be read off the console.
    const picker = modal || dialogs[dialogs.length - 1] || null;
    if (picker) {
      erLog('picker outerHTML:', boundedOuterHTML(picker, 6000));
      const fileInputs = [...picker.querySelectorAll('input[type="file"]')];
      erLog('file inputs in picker:', fileInputs.length);
      fileInputs.forEach((fi, i) =>
        erLog(`  file input[${i}]:`, boundedOuterHTML(fi, 400)),
      );
    }
  } catch (e) {
    erLog('dump error (non-fatal):', String(e));
  }
}

let __afEditRefProbeRunning = false;

function injectEditRefProbeButton() {
  if (document.getElementById('af-editref-probe-btn')) return;
  if (!document.body) return;
  const btn = document.createElement('button');
  btn.id = 'af-editref-probe-btn';
  btn.type = 'button';
  btn.textContent = 'AF probe: edit-reference modal (no spend)';
  btn.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'left:660px',
    'z-index:2147483647',
    'background:#0f766e',
    'color:#fff',
    'padding:12px 16px',
    'border:0',
    'border-radius:10px',
    'font:700 13px/1.3 system-ui,-apple-system,sans-serif',
    'box-shadow:0 4px 16px rgba(0,0,0,.35)',
    'cursor:pointer',
    'user-select:none',
  ].join(';');
  const reset = () => {
    btn.disabled = false;
    btn.textContent = 'AF probe: edit-reference modal (no spend)';
    btn.style.background = '#0f766e';
  };
  btn.addEventListener('click', async () => {
    if (__afEditRefProbeRunning) return;
    __afEditRefProbeRunning = true;
    btn.disabled = true;
    btn.textContent = 'AF probe: dumping… see [editref] console';
    btn.style.background = '#1d4ed8';
    try {
      dumpEditRefDom('BEFORE click');
      const editBtn = document.querySelector('[data-cy="edit-reference-button"]');
      if (!editBtn) {
        erLog(
          'edit-reference-button NOT found. Make sure a reference card is on the generator (hover it so its overlay shows). The BEFORE dump above lists every reference/style hook present — paste it back.',
        );
        btn.textContent = 'AF probe: no edit-ref btn — see [editref]';
        btn.style.background = '#b91c1c';
        return;
      }
      erLog('clicking [data-cy="edit-reference-button"] …');
      editBtn.click();
      // The picker mounts async; poll briefly for a modal/dialog, then dump.
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 250));
        if (
          document.querySelector('[data-cy="advanced-selection-modal"]') ||
          document.querySelector('[role="dialog"]')
        ) {
          break;
        }
      }
      dumpEditRefDom('AFTER click (~picker open)');
      erLog(
        'DONE. Copy every [editref] line above (especially "picker outerHTML" + file inputs + the upload/confirm hooks) and paste it back so Task 7 can be wired.',
      );
      btn.textContent = 'AF probe: DONE ✓ — copy [editref] console';
      btn.style.background = '#15803d';
    } catch (e) {
      erLog('probe ERROR:', String(e));
      btn.textContent = 'AF probe: ERROR — see [editref] console';
      btn.style.background = '#b91c1c';
    } finally {
      __afEditRefProbeRunning = false;
      btn.disabled = false;
      setTimeout(reset, 8000);
    }
  });
  document.body.appendChild(btn);
  erLog('probe button injected (bottom-left, left:660px)');
}

// The End frame requires a REAL file upload. Operator-confirmed 2026-05-17:
// there is NO pre-selection (the handoff's assumption was wrong). The manual
// flow is: click the End-image slot → a picker opens → "Upload an image" →
// pick the file from disk → "Add". A content script cannot drive the native
// OS file dialog or set a file input (browser security), so we mirror the
// distrokid-runner: open the picker, then have the background SW set the
// picker's <input type=file> via CDP DOM.setFileInputFiles, then click "Add".
// `uploadFilePath` is an ABSOLUTE path on this machine (the start image /
// source.jpg). Returns true once the End image is set.
async function ensureEndFrameMatchesStart(uploadFilePath, force) {
  dumpEndFrameDom('pre-open');
  // Idempotency skip — but `force` (smoke test / re-run) always exercises the
  // real CDP path so a previously-set End image can't yield a false positive.
  if (!force && document.querySelector('img[alt="End image "], img[alt="End image"]')) {
    efLog('early-return: End image already present (alt match)');
    return true;
  }
  if (force) efLog('force=true — running the full upload flow even if an End image is already set');
  if (!uploadFilePath || typeof uploadFilePath !== 'string') {
    efLog('FAIL: no uploadFilePath — cannot CDP-upload the end frame');
    return false;
  }

  // 1. Open the End-image picker. The slot wraps the #cdn-video-end-frame
  //    icon + an "End image" label (NOT [data-cy=video-end-frame-input] —
  //    that selector was wrong). Must not match the symmetric Start slot.
  const slot = findEndImageSlot();
  if (!slot) {
    efLog('FAIL: End image slot not found (#cdn-video-end-frame icon / "End image" label)');
    dumpEndFrameDom('no-end-slot');
    return false;
  }
  efLog('clicking End image slot…');
  slot.click();

  // 2. Wait for the picker modal.
  const modal = await waitForSelector('[data-cy="advanced-selection-modal"]', 10000);
  if (!modal) {
    efLog('FAIL: advanced-selection-modal did not open after clicking the End slot');
    dumpEndFrameDom('post-open-no-modal');
    return false;
  }
  efLog('picker modal open');

  // 3. Find the picker's <input type=file> WITHOUT clicking "Upload an image"
  //    (that opens the un-driveable native OS dialog). Tag it so the SW's CDP
  //    querySelector targets exactly this element.
  const fileInput = findFileInputForEndFrame(modal);
  if (!fileInput) {
    efLog('FAIL: no <input type=file> in the picker modal');
    dumpFileInputs('modal-open-no-fileinput');
    return false;
  }
  const HOOK = 'af-endframe-fileinput';
  fileInput.setAttribute('data-af-hook', HOOK);
  efLog('file input tagged; asking background to CDP-set:', uploadFilePath);

  // 4. CDP set the file via the background SW (mirrors distrokid-runner).
  let cdp;
  try {
    cdp = await chrome.runtime.sendMessage({
      type: 'freepik:set-file-input-files',
      selector: `input[data-af-hook="${HOOK}"]`,
      files: [uploadFilePath],
    });
  } catch (e) {
    efLog('FAIL: set-file-input-files message threw:', String(e));
    return false;
  }
  if (!cdp || !cdp.ok) {
    efLog('FAIL: CDP setFileInputFiles error:', cdp && cdp.error);
    return false;
  }
  efLog('CDP file set OK; waiting for "Add" to enable…');

  // 5. Click "Add" once it enables (the trusted change event from CDP should
  //    flip it). upload-use-selected-button operator-confirmed 2026-05-17.
  const addBtn = await waitForEnabled('[data-cy="upload-use-selected-button"]', 20000);
  if (!addBtn) {
    efLog('FAIL: Add (upload-use-selected-button) never enabled after upload');
    dumpEndFrameDom('add-never-enabled');
    return false;
  }
  efLog('clicking Add…');
  addBtn.click();
  await sleep(1500);

  const modalClosed = document.querySelector('[data-cy="advanced-selection-modal"]') == null;
  const endThumb =
    document.querySelector('img[alt="End image "], img[alt="End image"]') != null;
  efLog(`result: modalClosed=${modalClosed} endThumb=${endThumb} → success=${modalClosed || endThumb}`);
  return modalClosed || endThumb;
}

// Find the clickable element that opens the End-image picker: whatever wraps
// the #cdn-video-end-frame icon (preferred) or the "End image" text label.
function findEndImageSlot() {
  for (const u of document.querySelectorAll('use')) {
    const href = u.getAttribute('xlink:href') || u.getAttribute('href') || '';
    if (href === '#cdn-video-end-frame') {
      const c = climbToClickable(u);
      if (c) return c;
    }
  }
  for (const s of document.querySelectorAll('span')) {
    if ((s.textContent || '').trim() === 'End image') {
      const c = climbToClickable(s);
      if (c) return c;
    }
  }
  return null;
}

function climbToClickable(el) {
  let cur = el;
  for (let i = 0; i < 8 && cur; i++) {
    if (cur instanceof HTMLElement) {
      if (cur.tagName === 'BUTTON' || cur.getAttribute('role') === 'button') return cur;
      const cls = typeof cur.className === 'string' ? cur.className : '';
      if (/cursor-pointer/.test(cls)) return cur;
      const cy = cur.getAttribute && cur.getAttribute('data-cy');
      if (cy && /end|frame|reference|card|slot|drop/i.test(cy)) return cur;
    }
    cur = cur.parentElement;
  }
  // Fallback: a few levels up (the slot is a small nested box).
  let up = el;
  for (let i = 0; i < 4 && up && up.parentElement; i++) up = up.parentElement;
  return up instanceof HTMLElement ? up : null;
}

function findFileInputForEndFrame(modal) {
  return (
    modal.querySelector('input[type="file"]') ||
    document.querySelector('[data-cy="advanced-selection-modal"] input[type="file"]') ||
    document.querySelector('input[type="file"][accept*="image" i]') ||
    document.querySelector('input[type="file"]') ||
    null
  );
}

function dumpFileInputs(phase) {
  try {
    efLog(`---- file-input dump @ ${phase} ----`);
    const all = document.querySelectorAll('input[type="file"]');
    efLog(`input[type=file] count = ${all.length}`);
    all.forEach((el, i) => {
      efLog(
        `  [${i}] accept=${JSON.stringify(el.getAttribute('accept'))} ` +
          `data-cy=${JSON.stringify(el.getAttribute('data-cy'))} ` +
          `outerHTML=${boundedOuterHTML(el, 400)}`,
      );
    });
  } catch (e) {
    efLog('file-input dump error:', String(e));
  }
}

async function waitForEnabled(selector, timeoutMs = 15000, intervalMs = 400) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector);
    if (
      el instanceof HTMLElement &&
      !el.disabled &&
      el.getAttribute('aria-disabled') !== 'true'
    ) {
      return el;
    }
    await sleep(intervalMs);
  }
  return null;
}

// Auto-add the end frame via CDP. On SUCCESS, proceed straight to Generate
// with NO operator interaction — the CDP mechanism is proven and
// ensureEndFrameMatchesStart self-verifies (modal closed / End thumbnail
// present). Only on a MISS do we fall back to the red operator-confirm
// banner: a missing/wrong end frame would silently waste a Seedance render
// and break the loop, so that path stays gated (operator adds the End image
// by hand = the START image, then clicks to proceed). The step-05a image
// pick is the one remaining human gate; everything after it is unattended.
async function confirmEndFrameWithOperator(uploadFilePath) {
  const auto = await ensureEndFrameMatchesStart(uploadFilePath).catch((e) => {
    efLog('ensureEndFrameMatchesStart threw (treated as miss):', String(e));
    return false;
  });
  if (auto) {
    efLog('end-frame CDP add succeeded — auto-proceeding to Generate (no operator gate)');
    return true;
  }
  efLog('end-frame CDP add MISSED — falling back to the operator-confirm banner');
  return await new Promise((resolve) => {
    const banner = document.createElement('div');
    banner.id = 'ambientforge-endframe-gate';
    banner.style.cssText = [
      'position:fixed',
      'top:12px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'background:#b91c1c',
      'color:#fff',
      'padding:14px 18px',
      'border-radius:10px',
      'font:600 14px/1.45 system-ui,-apple-system,sans-serif',
      'box-shadow:0 6px 24px rgba(0,0,0,.35)',
      'max-width:520px',
      'text-align:center',
      'cursor:pointer',
      'pointer-events:auto',
      'user-select:none',
    ].join(';');
    banner.textContent =
      'AmbientForge: CDP end-image upload FAILED. Add the END image by hand ' +
      '(= your START image), then CLICK THIS BANNER to Generate.';
    const done = () => {
      clearTimeout(timer);
      banner.remove();
      resolve(true);
    };
    banner.addEventListener('click', done, { once: true });
    const timer = setTimeout(done, 10 * 60_000); // 10 min for the human
    document.body.appendChild(banner);
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
