import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// Real-format 36-char UUIDs: the URL-based current-Project check matches
// /\/app\/projects\/([a-f0-9-]{36})/, so short labels like "want" do NOT
// match — the active Project is driven via location.pathname, not the
// breadcrumb (which is the WORKSPACE link, not the current project).
const WANT_UUID = "6615feee-905d-4a53-8f51-9daccbcec41f";
const OTHER_UUID = "21f4170c-bde5-4583-b55a-e501631370a0";
const CREATED_UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const NEW_UUID = "12345678-90ab-4cde-8f01-234567890abc";

type Listener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean | void;

const trackedObservers: MutationObserver[] = [];

function setImageDimensions(img: HTMLImageElement, w: number, h: number): void {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
}

// Repaired loader: concat content-shared.js BEFORE the orchestrator so the
// shared isolated-world helpers (fillPrompt, editableFrom, setNativeValue,
// waitFor, escapeRegex, dumpDataCyAttributes) are defined as globals the
// orchestrator references by bare name. Mirrors content-magnific.test.ts.
function loadContentScript(initialPathname = "/app/projects/work") {
  const sharedSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/content-shared.js"),
    "utf8"
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/content-image-batch.js"),
    "utf8"
  );
  const listeners: Listener[] = [];
  const sendMessage = vi.fn((_msg: unknown, cb?: (r: unknown) => void) => {
    if (typeof cb === "function") cb({ success: true, matched: true });
  });
  const logs: unknown[][] = [];
  // Mutable fake location so a row-click handler can simulate navigating into
  // the new project, and so the URL-based current-Project check sees the
  // active project (jsdom's real window.location isn't writable).
  const fakeLocation = {
    pathname: initialPathname,
    href: "https://www.magnific.com" + initialPathname,
  };
  const chrome = {
    runtime: {
      onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
      sendMessage,
      lastError: null as null | { message: string },
    },
  };
  const sandbox: Record<string, unknown> = {
    console: { log: (...args: unknown[]) => logs.push(args) },
    setTimeout,
    clearTimeout,
    Date,
    Math,
    Promise,
    Object,
    RegExp,
    Error,
    Array,
    Set,
    Map,
    JSON,
    Symbol,
    Event,
    InputEvent,
    document: globalThis.document,
    window: globalThis.window,
    location: fakeLocation,
    HTMLElement: globalThis.HTMLElement,
    HTMLAnchorElement: globalThis.HTMLAnchorElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    MutationObserver: function (cb: MutationCallback) {
      const obs = new globalThis.MutationObserver(cb);
      trackedObservers.push(obs);
      return obs;
    },
    chrome,
    // Keep the harvest poll fast in tests (prod default is 30min/2s).
    MAGNIFIC_HARVEST_TIMEOUT_MS: 1500,
    MAGNIFIC_HARVEST_INTERVAL_MS: 20,
    // Fail the create-step selector waits fast (prod default is 8s/10s) so the
    // create-diagnostics test doesn't burn the full production budget.
    MAGNIFIC_CREATE_STEP_TIMEOUT_MS: 150,
    MAGNIFIC_CREATE_UUID_TIMEOUT_MS: 150,
  };
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc + "\n" + src, sandbox);
  return { listeners, sendMessage, logs, chrome, location: fakeLocation };
}

// DOM for the in-Project generator (post ensure/verify): header project link,
// launch buttons, smart-prompt toggle, prompt, model picker, Generate.
function generatorHtml(opts: { headerUuid: string; smartOn?: boolean }): string {
  return `
    <a data-cy="header-work-breadcrumb-link" href="/app/projects/${opts.headerUuid}">Project</a>
    <button data-cy="topbar-start-creating-button">Start creating</button>
    <button data-cy="registered-tool-ai-image-generator">AI Image Generator</button>
    <button data-cy="smart-prompt-toggle" aria-checked="${opts.smartOn === false ? "false" : "true"}">AI prompt</button>
    <div data-cy="image-prompt-input"><div contenteditable="true"></div></div>
    <button data-cy="tti-mode-selector-v3-trigger">Auto</button>
    <button data-cy="ai-model-item-slim-imagen-nano-banana-2-flash">Google Nano Banana 2</button>
    <button data-cy="generate-button">Generate</button>
  `;
}

// Wire the Generate click to append a fresh cdnpk result image (Magnific
// renders it post-click). `numericId` is the per-render id the harvester
// diffs on. Returns nothing; the harvester picks the new id up.
function wireGenerateProducesImage(numericId: string): void {
  const btn = document.querySelector(
    '[data-cy="generate-button"]'
  ) as HTMLButtonElement;
  btn.addEventListener("click", () => {
    const img = document.createElement("img");
    img.src = `https://pikaso.cdnpk.net/media/abc/${numericId}/render.png`;
    document.body.appendChild(img);
    setImageDimensions(img, 1024, 1024);
  });
}

function dispatch(
  listeners: Listener[],
  message: Record<string, unknown>
): { sendResponse: ReturnType<typeof vi.fn> } {
  const sendResponse = vi.fn();
  listeners[0](message, null, sendResponse);
  return { sendResponse };
}

function reportCalls(sendMessage: ReturnType<typeof vi.fn>, action: string) {
  return sendMessage.mock.calls.filter(
    (c) => (c[0] as { action?: string })?.action === action
  );
}

describe("magnific-ext content-image-batch.js", () => {
  beforeEach(() => {
    for (const obs of trackedObservers) obs.disconnect();
    trackedObservers.length = 0;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("responds synchronously to ping with {ready:true}", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0]({ action: "ping" }, null, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ready: true });
    expect(ret).not.toBe(true);
  });

  it("does NOT respond to unknown actions", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0]({ action: "unrelated" }, null, sendResponse);
    expect(ret).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it("cached Project happy path: fills prompt, selects Nano Banana 2, generates, harvests, reports completion (project id null on reuse)", async () => {
    document.body.innerHTML = generatorHtml({ headerUuid: "work" });
    wireGenerateProducesImage("777");
    const editable = document.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement;
    const modelItem = document.querySelector(
      '[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]'
    ) as HTMLElement;
    const modelClick = vi.fn();
    modelItem.addEventListener("click", modelClick);

    const { listeners, sendMessage } = loadContentScript(
      "/app/projects/" + WANT_UUID
    );
    const { sendResponse } = dispatch(listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_1",
      prompt: "a senator in the forum",
      model: "Nano Banana 2",
      videoTitle: "Rome",
      magnificProjectId: WANT_UUID,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
      timeout: 4000,
    });

    expect(editable.textContent).toBe("a senator in the forum");
    expect(modelClick).toHaveBeenCalled();
    const completed = reportCalls(sendMessage, "magnificImageBatchCompleted");
    expect(completed.length).toBe(1);
    expect(completed[0][0]).toMatchObject({
      taskId: "ib_1",
      resultUrl: "https://pikaso.cdnpk.net/media/abc/777/render.png",
      magnificProjectId: null,
    });
  });

  it("turns the smart-prompt toggle OFF before filling when it is on", async () => {
    document.body.innerHTML = generatorHtml({ headerUuid: "work", smartOn: true });
    wireGenerateProducesImage("778");
    const toggle = document.querySelector(
      '[data-cy="smart-prompt-toggle"]'
    ) as HTMLButtonElement;
    const toggleClick = vi.fn();
    toggle.addEventListener("click", toggleClick);

    const { listeners, sendResponse } = (() => {
      const loaded = loadContentScript("/app/projects/" + WANT_UUID);
      return { ...loaded, ...dispatch(loaded.listeners, {
        action: "magnificStartImageBatch",
        taskId: "ib_t",
        prompt: "x",
        model: "",
        videoTitle: "Rome",
        magnificProjectId: WANT_UUID,
      }) };
    })();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });
    expect(listeners.length).toBeGreaterThan(0);
    expect(toggleClick).toHaveBeenCalled();
  });

  it("does NOT toggle smart-prompt when it is already off", async () => {
    document.body.innerHTML = generatorHtml({ headerUuid: "work", smartOn: false });
    wireGenerateProducesImage("779");
    const toggle = document.querySelector(
      '[data-cy="smart-prompt-toggle"]'
    ) as HTMLButtonElement;
    const toggleClick = vi.fn();
    toggle.addEventListener("click", toggleClick);

    const loaded = loadContentScript("/app/projects/" + WANT_UUID);
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_off",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: WANT_UUID,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });
    expect(toggleClick).not.toHaveBeenCalled();
  });

  it("harvests the NEW render by numeric path id, ignoring the stale render.png already present", async () => {
    document.body.innerHTML = generatorHtml({ headerUuid: "work" });
    // Stale prior render already in the DOM (same basename render.png).
    const stale = document.createElement("img");
    stale.src = "https://pikaso.cdnpk.net/media/abc/100/render.png";
    document.body.appendChild(stale);
    setImageDimensions(stale, 1024, 1024);
    wireGenerateProducesImage("101"); // new id appears on Generate

    const loaded = loadContentScript("/app/projects/" + WANT_UUID);
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_h",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: WANT_UUID,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    const completed = reportCalls(loaded.sendMessage, "magnificImageBatchCompleted");
    expect(completed[0][0]).toMatchObject({
      resultUrl: "https://pikaso.cdnpk.net/media/abc/101/render.png",
    });
  });

  it("creates a Project (v3): clicks create, fills name, clicks the matching project row, harvests the UUID from the URL, reports it", async () => {
    // v3 does NOT auto-navigate into the new project after Create — it lands on
    // the projects list, where the new project shows as a v3-project-row.
    document.body.innerHTML = `
      <button data-cy="v3-create-project-button">New Project</button>
      <input placeholder="Enter a name for your project">
      <button id="create">Create</button>
      <div data-cy="v3-project-row">The Fall of Rome</div>
      ${generatorHtml({ headerUuid: "work" })}
    `;
    const nameInput = document.querySelector("input") as HTMLInputElement;
    const row = document.querySelector(
      '[data-cy="v3-project-row"]'
    ) as HTMLElement;

    const loaded = loadContentScript();
    // Clicking the matching row navigates into the project: the URL updates to
    // the created UUID (the source of truth — the harvest + verify read it).
    row.addEventListener("click", () => {
      loaded.location.pathname = "/app/projects/" + CREATED_UUID;
    });
    wireGenerateProducesImage("900");

    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_c",
      prompt: "a forum",
      model: "",
      videoTitle: "The Fall of Rome",
      magnificProjectId: null,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    expect(nameInput.value).toBe("The Fall of Rome");
    const completed = reportCalls(loaded.sendMessage, "magnificImageBatchCompleted");
    expect(completed[0][0]).toMatchObject({
      taskId: "ib_c",
      magnificProjectId: CREATED_UUID,
    });
  });

  it("create (v3): with multiple rows matching the name, clicks the first (newest at top) and harvests its UUID", async () => {
    document.body.innerHTML = `
      <button data-cy="v3-create-project-button">New Project</button>
      <input placeholder="Enter a name for your project">
      <button id="create">Create</button>
      <div data-cy="v3-project-row" id="row-new">The Fall of Rome</div>
      <div data-cy="v3-project-row" id="row-old">The Fall of Rome</div>
      ${generatorHtml({ headerUuid: "work" })}
    `;
    const rowNew = document.getElementById("row-new") as HTMLElement;
    const rowOld = document.getElementById("row-old") as HTMLElement;
    const newClick = vi.fn();
    const oldClick = vi.fn();

    const loaded = loadContentScript();
    rowNew.addEventListener("click", () => {
      newClick();
      loaded.location.pathname = "/app/projects/" + NEW_UUID;
    });
    rowOld.addEventListener("click", oldClick);
    wireGenerateProducesImage("901");

    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_multi",
      prompt: "a forum",
      model: "",
      videoTitle: "The Fall of Rome",
      magnificProjectId: null,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    expect(newClick).toHaveBeenCalled();
    expect(oldClick).not.toHaveBeenCalled();
    const completed = reportCalls(loaded.sendMessage, "magnificImageBatchCompleted");
    expect(completed[0][0]).toMatchObject({ magnificProjectId: NEW_UUID });
  });

  it("create-project diagnostics: a missing name input dumps [data-cy] attrs loudly and fails project_create_failed", async () => {
    // new-project-card present but the placeholder name input is absent (the
    // least-stable selector drifted). Include a couple of [data-cy] anchors to
    // prove the dump fires.
    document.body.innerHTML = `
      <button data-cy="new-project-card">New Project</button>
      <div data-cy="diag-anchor-aaa">x</div>
      <div data-cy="diag-anchor-bbb">y</div>
    `;
    const loaded = loadContentScript();
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_diag",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: null,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 12000 });

    const flat = loaded.logs.flat().map(String).join(" ");
    expect(flat).toContain("create-project");
    expect(flat).toContain("diag-anchor-aaa");
    expect(flat).toContain("diag-anchor-bbb");
    const failed = reportCalls(loaded.sendMessage, "magnificImageBatchFailed");
    expect(failed[0][0]).toMatchObject({
      taskId: "ib_diag",
      reason: "project_create_failed",
    });
  });

  it("verify gate (pre-launch): refuses to generate and fails wrong_project_active when the active Project does not match", async () => {
    // Cached target WANT_UUID, but the URL shows a DIFFERENT project and there
    // is no project-tree dropdown to switch — generation must be refused.
    document.body.innerHTML = generatorHtml({ headerUuid: "work" });
    const generateClick = vi.fn();
    (
      document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement
    ).addEventListener("click", generateClick);

    const loaded = loadContentScript("/app/projects/" + OTHER_UUID);
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_wp1",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: WANT_UUID,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    expect(generateClick).not.toHaveBeenCalled();
    const failed = reportCalls(loaded.sendMessage, "magnificImageBatchFailed");
    expect(failed[0][0]).toMatchObject({
      taskId: "ib_wp1",
      reason: "wrong_project_active",
    });
  });

  it("verify gate (post-launch): best-effort — LOGS skipped and PROCEEDS when the generator page carries no project UUID in the URL", async () => {
    // Pre-launch the URL is the target Project (passes). Launching the
    // generator navigates to /app/ai-image-generator, which has NO project
    // UUID in the URL — the post-launch re-verify must LOG skipped and PROCEED
    // (a deliberate weakening: the generator page exposes no current-project
    // signal, and the pre-launch gate already scoped generation). It must NOT
    // refuse.
    document.body.innerHTML = generatorHtml({ headerUuid: "work" });
    wireGenerateProducesImage("903");
    const tool = document.querySelector(
      '[data-cy="registered-tool-ai-image-generator"]'
    ) as HTMLButtonElement;
    const generateClick = vi.fn();
    (
      document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement
    ).addEventListener("click", generateClick);

    const loaded = loadContentScript("/app/projects/" + WANT_UUID);
    // Launching the generator leaves the project URL for the global generator.
    tool.addEventListener("click", () => {
      loaded.location.pathname = "/app/ai-image-generator";
    });

    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_wp2",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: WANT_UUID,
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    // Proceeds: Generate fires and a completion is reported (NOT a failure).
    expect(generateClick).toHaveBeenCalled();
    const completed = reportCalls(loaded.sendMessage, "magnificImageBatchCompleted");
    expect(completed.length).toBe(1);
    const failed = reportCalls(loaded.sendMessage, "magnificImageBatchFailed");
    expect(failed.length).toBe(0);
    // The skip is documented loudly so it reads as deliberate, not an oversight.
    const flat = loaded.logs.flat().map(String).join(" ");
    expect(flat).toContain("sub=post-launch");
    expect(flat).toContain("status=skipped");
  });
});
