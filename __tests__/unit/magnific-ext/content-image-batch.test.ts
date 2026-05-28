import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

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
function loadContentScript() {
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
    location: globalThis.window.location,
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
  return { listeners, sendMessage, logs, chrome };
}

// DOM for the in-Project generator (post ensure/verify): header project link,
// launch buttons, smart-prompt toggle, prompt, model picker, Generate.
function generatorHtml(opts: { headerUuid: string; smartOn?: boolean }): string {
  return `
    <a data-cy="header-current-project-link" href="/app/projects/${opts.headerUuid}">Project</a>
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
    document.body.innerHTML = generatorHtml({ headerUuid: "want" });
    wireGenerateProducesImage("777");
    const editable = document.querySelector(
      '[contenteditable="true"]'
    ) as HTMLElement;
    const modelItem = document.querySelector(
      '[data-cy="ai-model-item-slim-imagen-nano-banana-2-flash"]'
    ) as HTMLElement;
    const modelClick = vi.fn();
    modelItem.addEventListener("click", modelClick);

    const { listeners, sendMessage } = loadContentScript();
    const { sendResponse } = dispatch(listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_1",
      prompt: "a senator in the forum",
      model: "Nano Banana 2",
      videoTitle: "Rome",
      magnificProjectId: "want",
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
    document.body.innerHTML = generatorHtml({ headerUuid: "want", smartOn: true });
    wireGenerateProducesImage("778");
    const toggle = document.querySelector(
      '[data-cy="smart-prompt-toggle"]'
    ) as HTMLButtonElement;
    const toggleClick = vi.fn();
    toggle.addEventListener("click", toggleClick);

    const { listeners, sendResponse } = (() => {
      const loaded = loadContentScript();
      return { ...loaded, ...dispatch(loaded.listeners, {
        action: "magnificStartImageBatch",
        taskId: "ib_t",
        prompt: "x",
        model: "",
        videoTitle: "Rome",
        magnificProjectId: "want",
      }) };
    })();
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });
    expect(listeners.length).toBeGreaterThan(0);
    expect(toggleClick).toHaveBeenCalled();
  });

  it("does NOT toggle smart-prompt when it is already off", async () => {
    document.body.innerHTML = generatorHtml({ headerUuid: "want", smartOn: false });
    wireGenerateProducesImage("779");
    const toggle = document.querySelector(
      '[data-cy="smart-prompt-toggle"]'
    ) as HTMLButtonElement;
    const toggleClick = vi.fn();
    toggle.addEventListener("click", toggleClick);

    const loaded = loadContentScript();
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_off",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: "want",
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });
    expect(toggleClick).not.toHaveBeenCalled();
  });

  it("harvests the NEW render by numeric path id, ignoring the stale render.png already present", async () => {
    document.body.innerHTML = generatorHtml({ headerUuid: "want" });
    // Stale prior render already in the DOM (same basename render.png).
    const stale = document.createElement("img");
    stale.src = "https://pikaso.cdnpk.net/media/abc/100/render.png";
    document.body.appendChild(stale);
    setImageDimensions(stale, 1024, 1024);
    wireGenerateProducesImage("101"); // new id appears on Generate

    const loaded = loadContentScript();
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_h",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: "want",
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    const completed = reportCalls(loaded.sendMessage, "magnificImageBatchCompleted");
    expect(completed[0][0]).toMatchObject({
      resultUrl: "https://pikaso.cdnpk.net/media/abc/101/render.png",
    });
  });

  it("creates a Project when none is cached, fills its name, and reports the harvested Project UUID on completion", async () => {
    document.body.innerHTML = `
      <button data-cy="new-project-card">New Project</button>
      <input placeholder="Enter a name for your project">
      <button id="create">Create</button>
      ${generatorHtml({ headerUuid: "work" })}
    `;
    const nameInput = document.querySelector("input") as HTMLInputElement;
    const createBtn = document.getElementById("create") as HTMLButtonElement;
    const headerLink = document.querySelector(
      '[data-cy="header-current-project-link"]'
    ) as HTMLAnchorElement;
    // Clicking Create "navigates" into the new Project (SPA): the header link
    // updates to the created UUID.
    createBtn.addEventListener("click", () => {
      headerLink.setAttribute("href", "/app/projects/created-uuid");
    });
    wireGenerateProducesImage("900");

    const loaded = loadContentScript();
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
      magnificProjectId: "created-uuid",
    });
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
    // Cached target "want", but the header shows "other" and there is no way
    // to switch — generation must be refused.
    document.body.innerHTML = generatorHtml({ headerUuid: "other" });
    const generateClick = vi.fn();
    (
      document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement
    ).addEventListener("click", generateClick);

    const loaded = loadContentScript();
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_wp1",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: "want",
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    expect(generateClick).not.toHaveBeenCalled();
    const failed = reportCalls(loaded.sendMessage, "magnificImageBatchFailed");
    expect(failed[0][0]).toMatchObject({
      taskId: "ib_wp1",
      reason: "wrong_project_active",
    });
  });

  it("verify gate (post-launch): refuses to generate when launching the generator changes the active Project", async () => {
    // Pre-launch the header matches "want" (step b passes). Launching the
    // generator flips the active Project to "other" — the post-launch
    // re-verify (step c) must catch it and refuse.
    document.body.innerHTML = generatorHtml({ headerUuid: "want" });
    const headerLink = document.querySelector(
      '[data-cy="header-current-project-link"]'
    ) as HTMLAnchorElement;
    const tool = document.querySelector(
      '[data-cy="registered-tool-ai-image-generator"]'
    ) as HTMLButtonElement;
    tool.addEventListener("click", () => {
      headerLink.setAttribute("href", "/app/projects/other");
    });
    const generateClick = vi.fn();
    (
      document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement
    ).addEventListener("click", generateClick);

    const loaded = loadContentScript();
    const { sendResponse } = dispatch(loaded.listeners, {
      action: "magnificStartImageBatch",
      taskId: "ib_wp2",
      prompt: "x",
      model: "",
      videoTitle: "Rome",
      magnificProjectId: "want",
    });
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 4000 });

    expect(generateClick).not.toHaveBeenCalled();
    const failed = reportCalls(loaded.sendMessage, "magnificImageBatchFailed");
    expect(failed[0][0]).toMatchObject({
      taskId: "ib_wp2",
      reason: "wrong_project_active",
    });
  });
});
