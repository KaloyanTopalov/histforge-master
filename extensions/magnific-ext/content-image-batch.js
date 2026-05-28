// Magnific HITL - image-batch content script (narrative Magnific image gen)
// Drives Magnific's per-video Project + text-to-image UI from a HistForge-
// dispatched task: ensure/verify the Project, launch the image generator,
// turn off the AI-prompt rewrite, fill the prompt, select Nano Banana 2,
// click Generate, harvest the newly-rendered image, and report it back.
//
// Unattended (mirrors content-magnific-i2v.js, NOT the operator-overlay
// content-magnific.js): on a reached conclusion the script emits a structured
// message — magnificImageBatchCompleted on success, magnificImageBatchFailed
// on a concluded failure (selector miss, wrong_project_active, project_missing,
// model-not-found, generation-never-appeared). The executor turns those into a
// submit-result POST. If the script dies WITHOUT emitting either (crash, tab
// closed), no message is sent and HistForge's reaper requeues the dispatched
// row — see image-batch.js's terminal-vs-transient contract.
//
// Runs in the ISOLATED world declared by the manifest content_scripts entry,
// alongside content-magnific.js / content-magnific-i2v.js; the three
// self-filter by message action. Shared DOM helpers (setNativeValue,
// editableFrom, waitFor, escapeRegex, dumpDataCyAttributes, fillPrompt) come
// from content-shared.js, loaded first per the manifest.

(function () {
  'use strict';

  const LOG_PREFIX = '[magnific-ext content-image-batch]';

  // Selectors confirmed live on 2026-05-28 (S0 probe). The two NON-data-cy
  // matches below — the text-based "Create" button and the placeholder-matched
  // project-name input — are the most likely to drift, so the create-project
  // step logs each sub-step and dumps [data-cy] loudly on any miss.
  // v3 DOM (confirmed live 2026-05-28 via the live-smoke [data-cy] dump): the
  // current-project indicator is the URL (/app/projects/<uuid>), NOT the
  // breadcrumb. header-work-breadcrumb-link points at the WORKSPACE ("Work"),
  // so it never matches a specific project — do not reintroduce it as the
  // current-project signal (a prior rev did, and every verify failed
  // wrong_project_active). Projects show as v3-project-row entries; clicking
  // "Create" lands back on the list rather than auto-navigating in.
  const PROJECT_TREE_DROPDOWN_DATA_CY = '[data-cy="project-tree-dropdown-trigger"]';
  const V3_CREATE_PROJECT_BTN_DATA_CY = '[data-cy="v3-create-project-button"]';
  const NEW_PROJECT_CARD_DATA_CY = '[data-cy="new-project-card"]';
  const V3_PROJECT_ROW_DATA_CY = '[data-cy="v3-project-row"]';
  const PROJECT_NAME_INPUT_SELECTOR = 'input[placeholder*="Enter a name" i]';
  const HEADER_CREATE_BUTTON_DATA_CY = 'projects-work-header-create-button';
  const TOPBAR_START_CREATING_DATA_CY = '[data-cy="topbar-start-creating-button"]';
  const AI_IMAGE_GENERATOR_TOOL_DATA_CY = '[data-cy="registered-tool-ai-image-generator"]';
  const SMART_PROMPT_TOGGLE_DATA_CY = '[data-cy="smart-prompt-toggle"]';
  const PROMPT_INPUT_DATA_CY = '[data-cy="image-prompt-input"]';
  const MODEL_TRIGGER_DATA_CY = '[data-cy="tti-mode-selector-v3-trigger"]';
  const MODEL_ITEM_DATA_CY = '[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]';
  const MODEL_SEARCH_DATA_CY = '[data-cy="ai-model-selector-search-input"]';
  const GENERATE_BUTTON_SELECTOR = 'button[data-cy="generate-button"]';
  const RESULT_IMG_SELECTOR = 'img[src*="cdnpk.net"]';
  const RESULT_MIN_DIMENSION = 200;

  // Magnific serves results from pikaso.cdnpk.net/.../<numericId>/render.png —
  // every result shares the `render.png` basename, so the harvester diffs on
  // the NUMERIC path segment, not the filename/URL string.
  const HARVEST_TIMEOUT_MS =
    typeof MAGNIFIC_HARVEST_TIMEOUT_MS !== 'undefined'
      ? MAGNIFIC_HARVEST_TIMEOUT_MS
      : 30 * 60 * 1000;
  const HARVEST_INTERVAL_MS =
    typeof MAGNIFIC_HARVEST_INTERVAL_MS !== 'undefined'
      ? MAGNIFIC_HARVEST_INTERVAL_MS
      : 2000;

  // Per-step waitFor budgets for the create-Project flow. Overridable (like
  // the harvest budgets above) so the create-diagnostics unit test can fail
  // fast on an absent selector instead of burning the full production 8s.
  const CREATE_STEP_TIMEOUT_MS =
    typeof MAGNIFIC_CREATE_STEP_TIMEOUT_MS !== 'undefined'
      ? MAGNIFIC_CREATE_STEP_TIMEOUT_MS
      : 8000;
  const CREATE_UUID_TIMEOUT_MS =
    typeof MAGNIFIC_CREATE_UUID_TIMEOUT_MS !== 'undefined'
      ? MAGNIFIC_CREATE_UUID_TIMEOUT_MS
      : 10000;
  // A freshly-opened /work tab (the row-1 first dispatch) can still be blank
  // when the content script fires. Wait for the projects view to render before
  // driving the create flow — overridable so the cold-tab unit test runs fast.
  const PROJECTS_VIEW_READY_TIMEOUT_MS =
    typeof MAGNIFIC_PROJECTS_VIEW_READY_TIMEOUT_MS !== 'undefined'
      ? MAGNIFIC_PROJECTS_VIEW_READY_TIMEOUT_MS
      : 8000;

  function log(...args) {
    try { console.log(LOG_PREFIX, ...args); } catch (_e) { /* ignore */ }
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function reportCompletion(taskId, resultUrl, magnificProjectId) {
    chrome.runtime.sendMessage(
      {
        action: 'magnificImageBatchCompleted',
        taskId,
        resultUrl,
        magnificProjectId: magnificProjectId || null,
      },
      () => {
        if (chrome.runtime.lastError) {
          log('sendMessage(completed) failed:', chrome.runtime.lastError.message);
        }
      },
    );
  }

  function reportFailure(taskId, reason, clearProjectId) {
    chrome.runtime.sendMessage(
      {
        action: 'magnificImageBatchFailed',
        taskId,
        reason,
        clearProjectId: clearProjectId === true,
      },
      () => {
        if (chrome.runtime.lastError) {
          log('sendMessage(failed) failed:', chrome.runtime.lastError.message);
        }
      },
    );
  }

  // A data-cy node may be a non-interactive wrapper whose handler lives on an
  // ancestor button; prefer the closest <button>, else the node itself.
  function clickClickable(el) {
    const target = (el.closest && el.closest('button')) || el;
    target.click();
  }

  function typeIntoInput(el, text) {
    el.focus();
    setNativeValue(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function extractProjectUuid(s) {
    const m = String(s || '').match(/\/app\/projects\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function isRealProjectUuid(v) {
    return !!v && v !== 'work';
  }

  function locationPathname() {
    try {
      return (typeof location !== 'undefined' && location.pathname) || '';
    } catch (_e) {
      return '';
    }
  }

  function locationProjectUuid() {
    return extractProjectUuid(locationPathname());
  }

  // v3 current-project indicator: the active Project lives in the URL as a full
  // 36-char UUID. The strict match means the projects list (/app/projects,
  // /work, /all-assets) and the generator (/app/ai-image-generator) yield null
  // instead of a false positive — only an actual /app/projects/<uuid> matches.
  function urlProjectUuid() {
    const m = locationPathname().match(/\/app\/projects\/([a-f0-9-]{36})/i);
    return m ? m[1] : null;
  }

  function dismissCookieBanner() {
    const sels = [
      '[data-cy="cookie-consent-accept"]',
      'button[aria-label*="accept" i]',
    ];
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el instanceof HTMLElement) {
        try { el.click(); } catch (_e) { /* advisory */ }
        return;
      }
    }
  }

  // Find the modal's primary "Create" button. It is text-based with NO
  // data-cy — distinct from the header [data-cy=projects-work-header-create-button],
  // which we explicitly exclude so we don't click the wrong one.
  function findCreateModalButton() {
    const els = document.querySelectorAll('button, [role="button"]');
    for (const el of els) {
      const txt = (el.textContent || '').trim();
      if (
        /^create$/i.test(txt) &&
        el.getAttribute('data-cy') !== HEADER_CREATE_BUTTON_DATA_CY
      ) {
        return el;
      }
    }
    return null;
  }

  async function waitForLocationUuid(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const uuid = locationProjectUuid();
      if (isRealProjectUuid(uuid)) return uuid;
      await sleep(250);
    }
    return null;
  }

  // Find the just-created project's row by name. DOM order; v3 lists newest at
  // the top, so the first textContent match wins.
  function findMatchingProjectRow(name) {
    for (const row of document.querySelectorAll(V3_PROJECT_ROW_DATA_CY)) {
      if ((row.textContent || '').includes(name)) return row;
    }
    return null;
  }

  async function waitForMatchingProjectRow(name, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const row = findMatchingProjectRow(name);
      if (row instanceof HTMLElement) return row;
      await sleep(250);
    }
    return null;
  }

  // Positive "projects view rendered" signal: a create entry (button or card)
  // or any existing project row means the SPA has painted, so the create flow
  // won't run against a blank cold tab.
  function projectsViewRendered() {
    return !!(
      document.querySelector(V3_CREATE_PROJECT_BTN_DATA_CY) ||
      document.querySelector(NEW_PROJECT_CARD_DATA_CY) ||
      document.querySelector(V3_PROJECT_ROW_DATA_CY)
    );
  }

  async function waitForProjectsViewReady(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (projectsViewRendered()) return true;
      await sleep(150);
    }
    return false;
  }

  // Create a fresh Magnific Project named after the video. Returns its UUID, or
  // null on a selector miss (each sub-step logged + [data-cy] dumped loudly).
  async function createProject(videoTitle) {
    dismissCookieBanner();
    // Cold-tab guard: don't drive the create flow until the projects view has
    // actually rendered. A miss here is "view never rendered" — distinct from a
    // create-button / name-input drift below — so a cold-tab regression reads
    // legibly in the logs rather than masquerading as a selector miss.
    if (!(await waitForProjectsViewReady(PROJECTS_VIEW_READY_TIMEOUT_MS))) {
      log(
        `step=create-project sub=view-ready status=error reason=projects-view-never-rendered ` +
          `tried=${V3_CREATE_PROJECT_BTN_DATA_CY}, ${NEW_PROJECT_CARD_DATA_CY}, ${V3_PROJECT_ROW_DATA_CY}`,
      );
      dumpDataCyAttributes();
      return null;
    }
    log('step=create-project sub=view-ready status=ok');
    let entry = await waitFor(V3_CREATE_PROJECT_BTN_DATA_CY, CREATE_STEP_TIMEOUT_MS);
    if (!(entry instanceof HTMLElement)) {
      entry = document.querySelector(NEW_PROJECT_CARD_DATA_CY);
    }
    if (!(entry instanceof HTMLElement)) {
      log(
        `step=create-project sub=entry status=error reason=not-found tried=${V3_CREATE_PROJECT_BTN_DATA_CY}, ${NEW_PROJECT_CARD_DATA_CY}`,
      );
      dumpDataCyAttributes();
      return null;
    }
    log('step=create-project sub=entry status=ok');
    clickClickable(entry);

    const nameInput = await waitFor(PROJECT_NAME_INPUT_SELECTOR, CREATE_STEP_TIMEOUT_MS);
    if (!(nameInput instanceof HTMLElement)) {
      log(
        `step=create-project sub=name-input status=error reason=not-found ` +
          `tried=${PROJECT_NAME_INPUT_SELECTOR} ` +
          `(NON-data-cy placeholder match — most likely selector to drift)`,
      );
      dumpDataCyAttributes();
      return null;
    }
    typeIntoInput(nameInput, videoTitle);
    log('step=create-project sub=name-input status=ok');

    const createBtn = findCreateModalButton();
    if (!(createBtn instanceof HTMLElement)) {
      log(
        'step=create-project sub=create-button status=error reason=not-found ' +
          'tried=text "Create" (NON-data-cy text match — most likely selector to drift)',
      );
      dumpDataCyAttributes();
      return null;
    }
    log('step=create-project sub=create-button status=ok');
    clickClickable(createBtn);

    // v3 does NOT auto-navigate into the new project; it lands back on the
    // projects list. Find the new project's row by name and click into it.
    const row = await waitForMatchingProjectRow(videoTitle, CREATE_STEP_TIMEOUT_MS);
    if (!(row instanceof HTMLElement)) {
      const rows = document.querySelectorAll(V3_PROJECT_ROW_DATA_CY);
      const names = Array.from(rows).map((r) =>
        (r.textContent || '').trim().slice(0, 60),
      );
      log(
        `step=create-project sub=await-row status=error reason=no-matching-row ` +
          `name="${videoTitle}" rows=${rows.length} names=${JSON.stringify(names)}`,
      );
      dumpDataCyAttributes();
      return null;
    }
    log('step=create-project sub=await-row status=ok');
    clickClickable(row);

    // Clicking the row navigates into the project — harvest the UUID from the URL.
    const uuid = await waitForLocationUuid(CREATE_UUID_TIMEOUT_MS);
    if (!uuid) {
      log('step=create-project sub=await-uuid status=error reason=no-project-uuid-in-url');
      dumpDataCyAttributes();
      return null;
    }
    log(`step=create-project sub=await-uuid status=ok id=${uuid}`);
    return uuid;
  }

  // Load-bearing correctness gate: generation is scoped to the active Project,
  // so a mismatch would dump one video's images into another's. The URL is the
  // source of truth for the active Project. `phase` governs strictness:
  //   'pre-launch'  → HARD: inside the Project the URL carries the UUID; on a
  //      mismatch try one switch via the project-tree dropdown, re-read, and if
  //      it still doesn't match the caller refuses to generate (fails the row).
  //   'post-launch' → BEST-EFFORT: launching the generator navigates to
  //      /app/ai-image-generator, which has NO project UUID in the URL, so a
  //      missing UUID is LOGGED and treated as OK. This is a DELIBERATE
  //      weakening (not an oversight): the generator page exposes no reliable
  //      current-Project signal, and the pre-launch gate + launching from
  //      inside the Project already scope generation.
  async function verifyCurrentProject(targetUuid, phase) {
    if (urlProjectUuid() === targetUuid) return true;
    if (phase === 'post-launch') {
      log('step=verify-project sub=post-launch status=skipped reason=no-uuid-on-generator-page');
      return true;
    }
    const dd = document.querySelector(PROJECT_TREE_DROPDOWN_DATA_CY);
    if (dd instanceof HTMLElement) {
      clickClickable(dd);
      await sleep(300);
      for (const el of document.querySelectorAll('a[href], [data-cy]')) {
        const href = el.getAttribute('href') || '';
        const cy = el.getAttribute('data-cy') || '';
        if (
          extractProjectUuid(href) === targetUuid ||
          extractProjectUuid(cy) === targetUuid
        ) {
          clickClickable(el);
          await sleep(300);
          break;
        }
      }
    }
    return urlProjectUuid() === targetUuid;
  }

  // Launch the image generator from inside the Project (SPA clicks, no reload
  // so this content script survives). Returns true on success.
  async function launchGenerator() {
    const start = await waitFor(TOPBAR_START_CREATING_DATA_CY, 8000);
    if (!(start instanceof HTMLElement)) {
      log(`step=launch-generator sub=start status=error reason=not-found tried=${TOPBAR_START_CREATING_DATA_CY}`);
      dumpDataCyAttributes();
      return false;
    }
    clickClickable(start);
    const tool = await waitFor(AI_IMAGE_GENERATOR_TOOL_DATA_CY, 8000);
    if (!(tool instanceof HTMLElement)) {
      log(`step=launch-generator sub=tool status=error reason=not-found tried=${AI_IMAGE_GENERATOR_TOOL_DATA_CY}`);
      dumpDataCyAttributes();
      return false;
    }
    clickClickable(tool);
    await sleep(300);
    log('step=launch-generator status=ok');
    return true;
  }

  async function setSmartPromptOff() {
    const toggle = document.querySelector(SMART_PROMPT_TOGGLE_DATA_CY);
    if (!(toggle instanceof HTMLElement)) {
      log('step=smart-prompt-off status=skipped reason=toggle-not-found');
      return;
    }
    const on =
      toggle.getAttribute('aria-checked') === 'true' ||
      toggle.getAttribute('data-state') === 'checked' ||
      toggle.checked === true;
    if (on) {
      clickClickable(toggle);
      log('step=smart-prompt-off status=ok');
    } else {
      log('step=smart-prompt-off status=already-off');
    }
  }

  async function waitForPromptFill(text, timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (
        fillPrompt(text, PROMPT_INPUT_DATA_CY, [
          'textarea[placeholder*="Describe" i]',
          'textarea[aria-label*="prompt" i]',
        ])
      ) {
        return true;
      }
      await sleep(250);
    }
    return false;
  }

  // Returns 'ok' | 'skipped' | 'not-found'. Empty model → skip (Magnific
  // default). Otherwise open the picker and click the Nano Banana 2 item,
  // narrowing via the search box and falling back to a text prefix match.
  async function selectModel(model) {
    if (!model) {
      log('step=select-model status=skipped reason=empty-model');
      return 'skipped';
    }
    const trigger = await waitFor(MODEL_TRIGGER_DATA_CY, 8000);
    if (!(trigger instanceof HTMLElement)) {
      log(`step=select-model status=error reason=trigger-not-found tried=${MODEL_TRIGGER_DATA_CY}`);
      dumpDataCyAttributes();
      return 'not-found';
    }
    clickClickable(trigger);
    await sleep(300);

    let item = await waitFor(MODEL_ITEM_DATA_CY, 4000);
    if (!(item instanceof HTMLElement)) {
      const search = document.querySelector(MODEL_SEARCH_DATA_CY);
      if (search instanceof HTMLElement) {
        typeIntoInput(search, model);
        item = await waitFor(MODEL_ITEM_DATA_CY, 4000);
      }
    }
    if (item instanceof HTMLElement) {
      clickClickable(item);
      log('step=select-model status=ok');
      return 'ok';
    }

    const re = new RegExp(`^${escapeRegex(model)}`, 'i');
    for (const row of document.querySelectorAll('[data-cy^="ai-model-item-"]')) {
      if (re.test((row.textContent || '').trim())) {
        clickClickable(row);
        log('step=select-model status=ok match=prefix');
        return 'ok';
      }
    }
    log(`step=select-model status=error reason=not-found model=${model}`);
    dumpDataCyAttributes();
    return 'not-found';
  }

  async function clickGenerate() {
    const btn = await waitFor(GENERATE_BUTTON_SELECTOR, 5000);
    if (!(btn instanceof HTMLElement)) {
      log(`step=generate status=error reason=not-found tried=${GENERATE_BUTTON_SELECTOR}`);
      dumpDataCyAttributes();
      return 'not-found';
    }
    await sleep(400); // settle so Vue/React reconciles disabled state
    if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') {
      log('step=generate status=error reason=disabled');
      return 'disabled';
    }
    btn.click();
    log('step=generate status=ok');
    return 'ok';
  }

  function numericRenderId(src) {
    const m = String(src).match(/\/(\d+)\/render\.png(?:[?#]|$)/i);
    if (m) return m[1];
    const m2 = String(src).match(/\/(\d+)\/[^/]+$/);
    return m2 ? m2[1] : null;
  }

  function collectResultImages() {
    const out = [];
    document.querySelectorAll(RESULT_IMG_SELECTOR).forEach((img) => {
      if (!(img instanceof HTMLImageElement) || !img.src) return;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w < RESULT_MIN_DIMENSION || h < RESULT_MIN_DIMENSION) return;
      out.push(img);
    });
    return out;
  }

  function snapshotRenderIds() {
    const ids = new Set();
    for (const img of collectResultImages()) {
      const id = numericRenderId(img.src);
      if (id) ids.add(id);
    }
    return ids;
  }

  async function harvestNewImage(snapshotIds) {
    const start = Date.now();
    while (Date.now() - start < HARVEST_TIMEOUT_MS) {
      for (const img of collectResultImages()) {
        const id = numericRenderId(img.src);
        if (id && !snapshotIds.has(id)) return img.src;
      }
      await sleep(HARVEST_INTERVAL_MS);
    }
    return null;
  }

  async function startImageBatch(taskId, prompt, model, videoTitle, projectId) {
    log(`start taskId=${taskId} project=${projectId || '(create)'}`);

    // 1. Ensure the Project. Cached id → executor already opened it; else
    //    create one and harvest its UUID (reported on completion).
    let targetUuid;
    let createdUuid = null;
    if (projectId) {
      targetUuid = projectId;
      log(`step=ensure-project status=cached id=${projectId}`);
    } else {
      const created = await createProject(videoTitle);
      if (!created) {
        reportFailure(taskId, 'project_create_failed');
        return;
      }
      targetUuid = created;
      createdUuid = created;
      log(`step=ensure-project status=created id=${created}`);
    }

    // 2. Verify the active Project BEFORE doing anything (wrong-project guard).
    if (!(await verifyCurrentProject(targetUuid, 'pre-launch'))) {
      log('step=verify-project status=error reason=wrong_project_active phase=pre-launch');
      dumpDataCyAttributes();
      reportFailure(taskId, 'wrong_project_active');
      return;
    }

    // 3. Launch the generator, then RE-VERIFY (best-effort post-launch — the
    //    generator page has no project UUID in the URL, so this logs+skips
    //    rather than refusing; see verifyCurrentProject).
    if (!(await launchGenerator())) {
      reportFailure(taskId, 'launch_generator_failed');
      return;
    }
    if (!(await verifyCurrentProject(targetUuid, 'post-launch'))) {
      log('step=verify-project status=error reason=wrong_project_active phase=post-launch');
      dumpDataCyAttributes();
      reportFailure(taskId, 'wrong_project_active');
      return;
    }

    // 4. Turn off the AI-prompt rewrite so the literal storyboard prompt sticks.
    await setSmartPromptOff();

    // 5. Fill the prompt (contenteditable → fillPrompt's textContent branch).
    if (!(await waitForPromptFill(prompt, 10000))) {
      log(`step=fill-prompt status=error reason=input-not-found tried=${PROMPT_INPUT_DATA_CY}`);
      dumpDataCyAttributes();
      reportFailure(taskId, 'prompt_input_not_found');
      return;
    }
    log('step=fill-prompt status=ok');

    // 6. Select Nano Banana 2.
    const modelResult = await selectModel(model);
    if (modelResult === 'not-found') {
      reportFailure(taskId, 'model_not_found');
      return;
    }

    // 7. Snapshot existing render ids, then Generate.
    const snapshot = snapshotRenderIds();
    const gen = await clickGenerate();
    if (gen !== 'ok') {
      reportFailure(
        taskId,
        gen === 'not-found' ? 'generate_button_not_found' : 'generate_button_disabled',
      );
      return;
    }

    // 8. Harvest the new render (diff on numeric id), then report.
    const resultUrl = await harvestNewImage(snapshot);
    if (!resultUrl) {
      log('step=harvest status=error reason=generation_never_appeared');
      dumpDataCyAttributes();
      reportFailure(taskId, 'generation_never_appeared');
      return;
    }
    log(`step=harvest status=ok url=${resultUrl}`);
    reportCompletion(taskId, resultUrl, createdUuid);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return;
    if (message.action === 'ping') {
      sendResponse({ ready: true });
      return; // synchronous reply
    }
    if (message.action === 'magnificStartImageBatch') {
      startImageBatch(
        message.taskId,
        message.prompt,
        message.model,
        message.videoTitle,
        message.magnificProjectId,
      )
        .then(() => sendResponse({ success: true }))
        .catch((e) => {
          const msg = e && e.message ? e.message : String(e);
          log('startImageBatch threw:', msg);
          sendResponse({ success: false, error: msg });
        });
      return true; // async response
    }
  });

  log('loaded');
})();
