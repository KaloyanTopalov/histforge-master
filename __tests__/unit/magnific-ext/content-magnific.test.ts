import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Listener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (r: unknown) => void
) => boolean | void;

interface LoadOpts {
  document?: Partial<Document> | Document;
  window?: Partial<Window> | Window;
}

// Test isolation: the content script registers a MutationObserver per
// fillAndGenerate call. Across tests the observers accumulate and all
// fire on the next test's DOM mutations — see Task 2.4 dedup test, where
// 12 leaked observers each added a redundant overlay. Track all observers
// the loader creates so beforeEach can disconnect them.
const trackedObservers: MutationObserver[] = [];

// jsdom doesn't load images, so img.naturalWidth defaults to 0. Force a
// realistic size on test fixtures so they pass the script's 200px floor.
function setImageDimensions(img: HTMLImageElement, w: number, h: number): void {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
}

function loadContentScript(opts: LoadOpts = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/content-magnific.js"
    ),
    "utf8"
  );
  const listeners: Listener[] = [];
  const sendMessage = vi.fn((_msg: unknown, _cb?: (r: unknown) => void) => {
    if (typeof _cb === "function") _cb({ success: true, matched: true });
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
    document: opts.document ?? globalThis.document,
    window: opts.window ?? globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    MutationObserver: function (cb: MutationCallback) {
      const obs = new globalThis.MutationObserver(cb);
      trackedObservers.push(obs);
      return obs;
    },
    chrome,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { listeners, sendMessage, logs, chrome };
}

describe("magnific-ext content-magnific.js", () => {
  beforeEach(() => {
    for (const obs of trackedObservers) obs.disconnect();
    trackedObservers.length = 0;
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("registers a chrome.runtime.onMessage listener on load", () => {
    const { listeners } = loadContentScript();
    expect(listeners.length).toBeGreaterThan(0);
  });

  it("returns true (async response signal) for the magnificFillAndGenerate action", async () => {
    // Provide enough DOM that the async work completes quickly. Without
    // this the background promise chain polls for up to 10s and races
    // against the next test's DOM mutations — see vitest jsdom share.
    document.body.innerHTML = `
      <div data-cy="image-prompt-input"><textarea></textarea></div>
      <button data-cy="generate-button">Generate</button>
    `;
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0](
      { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
      null,
      sendResponse,
    );
    expect(ret).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 2000 });
  });

  it("does NOT respond to unknown actions", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0](
      { action: "unrelated" },
      null,
      sendResponse,
    );
    expect(ret).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  // The SW's executor pings the content script before dispatching the
  // real magnificFillAndGenerate message — otherwise sendMessage races
  // chrome's content-script injection on a freshly-created tab and is
  // dropped with "Could not establish connection. Receiving end does
  // not exist." (observed during /generate_loop_image testing).
  it("responds synchronously to `ping` with {ready:true} so the SW handshake can detect readiness", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0]({ action: "ping" }, null, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ready: true });
    // false (or undefined) signals a synchronous response — the channel
    // closes immediately; returning true would leave it open for an
    // async reply that never comes and waste the SW's wakelock.
    expect(ret).not.toBe(true);
  });

  describe("Task 2.1: prompt fill via [data-cy=image-prompt-input]", () => {
    it("fills a textarea inside [data-cy=image-prompt-input] using the native setter + input/change events", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input">
          <textarea></textarea>
        </div>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      const events: string[] = [];
      textarea.addEventListener("input", () => events.push("input"));
      textarea.addEventListener("change", () => events.push("change"));

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot of mountains", model: "" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(textarea.value).toBe("shot of mountains");
      expect(events).toContain("input");
      expect(events).toContain("change");
    });

    it("fills a contenteditable inside [data-cy=image-prompt-input] using textContent + InputEvent", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input">
          <div contenteditable="true"></div>
        </div>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const editable = document.querySelector('[contenteditable="true"]') as HTMLElement;
      const inputEvents: InputEvent[] = [];
      editable.addEventListener("input", (e) => inputEvents.push(e as InputEvent));

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "a cinematic loop", model: "" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(editable.textContent).toBe("a cinematic loop");
      expect(inputEvents.length).toBeGreaterThan(0);
      expect(inputEvents[0]).toBeInstanceOf(InputEvent);
    });

    it("falls back to textarea[placeholder*=Describe] when the data-cy wrapper is missing", async () => {
      document.body.innerHTML = `
        <textarea placeholder="Describe what you want to see"></textarea>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "fallback ok", model: "" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      expect(textarea.value).toBe("fallback ok");
    });
  });

  describe("Task 2.2: model picker via [data-cy=tti-mode-selector-v3-trigger]", () => {
    it("skips the model picker entirely when model arg is empty (does not click the trigger)", async () => {
      document.body.innerHTML = `
        <button data-cy="tti-mode-selector-v3-trigger">Seedream 5 Lite</button>
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const trigger = document.querySelector('[data-cy="tti-mode-selector-v3-trigger"]') as HTMLElement;
      const triggerClicks = vi.fn();
      trigger.addEventListener("click", triggerClicks);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(triggerClicks).not.toHaveBeenCalled();
    });

    it("does NOT click the trigger when its text already matches the requested model", async () => {
      document.body.innerHTML = `
        <button data-cy="tti-mode-selector-v3-trigger">Seedream 5 Lite</button>
        <button id="opt-flux">Flux 1.1 Pro</button>
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const trigger = document.querySelector('[data-cy="tti-mode-selector-v3-trigger"]') as HTMLElement;
      const optFlux = document.getElementById("opt-flux") as HTMLElement;
      const triggerClicks = vi.fn();
      const fluxClicks = vi.fn();
      trigger.addEventListener("click", triggerClicks);
      optFlux.addEventListener("click", fluxClicks);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "Seedream 5 Lite" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(triggerClicks).not.toHaveBeenCalled();
      expect(fluxClicks).not.toHaveBeenCalled();
    });

    it("tolerant prefix-match: picks 'Seedream 5 Lite Fast' when asked for 'Seedream 5 Lite'", async () => {
      document.body.innerHTML = `
        <button data-cy="tti-mode-selector-v3-trigger">Imagen 3</button>
        <button id="opt-seedream-fast">Seedream 5 Lite Fast 50 credits</button>
        <button id="opt-flux">Flux 1.1 Pro</button>
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const optSeedreamFast = document.getElementById("opt-seedream-fast") as HTMLElement;
      const optFlux = document.getElementById("opt-flux") as HTMLElement;
      const fastClicks = vi.fn();
      const fluxClicks = vi.fn();
      optSeedreamFast.addEventListener("click", fastClicks);
      optFlux.addEventListener("click", fluxClicks);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "Seedream 5 Lite" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(fastClicks).toHaveBeenCalled();
      expect(fluxClicks).not.toHaveBeenCalled();
    });

    it("clicks the trigger then a matching model option button when current differs", async () => {
      document.body.innerHTML = `
        <button data-cy="tti-mode-selector-v3-trigger">Imagen 3</button>
        <button id="opt-seedream">Seedream 5 Lite</button>
        <button id="opt-flux">Flux 1.1 Pro</button>
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button type="submit" data-cy="generate-button">Generate</button>
      `;
      const trigger = document.querySelector('[data-cy="tti-mode-selector-v3-trigger"]') as HTMLElement;
      const optSeedream = document.getElementById("opt-seedream") as HTMLElement;
      const optFlux = document.getElementById("opt-flux") as HTMLElement;
      const triggerClicks = vi.fn();
      const seedreamClicks = vi.fn();
      const fluxClicks = vi.fn();
      trigger.addEventListener("click", triggerClicks);
      optSeedream.addEventListener("click", seedreamClicks);
      optFlux.addEventListener("click", fluxClicks);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "Seedream 5 Lite" },
        null,
        sendResponse,
      );

      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(triggerClicks).toHaveBeenCalled();
      expect(seedreamClicks).toHaveBeenCalled();
      expect(fluxClicks).not.toHaveBeenCalled();
    });
  });

  describe("Task 2.3: Generate-button click via [data-cy=generate-button]", () => {
    it("clicks Generate when enabled (positive case)", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
      `;
      const btn = document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement;
      const clickSpy = vi.fn();
      btn.addEventListener("click", clickSpy);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(clickSpy).toHaveBeenCalled();
    });

    it("does NOT click Generate when btn.disabled is true; logs 'disabled' (not 'not found')", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button" disabled>Generate</button>
      `;
      const btn = document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement;
      const clickSpy = vi.fn();
      btn.addEventListener("click", clickSpy);

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(clickSpy).not.toHaveBeenCalled();
      const flat = logs.flat().map(String).join(" ").toLowerCase();
      expect(flat).toContain("disabled");
      expect(flat).not.toContain("not found");
    });

    it("does NOT click Generate when aria-disabled='true'; logs 'disabled'", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button" aria-disabled="true">Generate</button>
      `;
      const btn = document.querySelector('[data-cy="generate-button"]') as HTMLButtonElement;
      const clickSpy = vi.fn();
      btn.addEventListener("click", clickSpy);

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      expect(clickSpy).not.toHaveBeenCalled();
      const flat = logs.flat().map(String).join(" ").toLowerCase();
      expect(flat).toContain("disabled");
    });

    it("logs 'not found' (not 'disabled') when the Generate button is missing entirely", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
      `;

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 7000 });

      const flat = logs.flat().map(String).join(" ").toLowerCase();
      expect(flat).toContain("not found");
      // The 'disabled' substring must NOT appear in the not-found path —
      // the operator must be able to distinguish "missing prerequisite"
      // from "selector broke / signed-out tab".
      expect(flat).not.toContain("is disabled");
    });
  });

  describe("Task 2.4: variation detection via img[src*=cdnpk.net] + size floor", () => {
    it("decorates img[src*=cdnpk.net] images that pass the 200px size floor", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div id="wrap-result"><img id="img-result" src="https://cdn.cdnpk.net/result.png"></div>
      `;
      const img = document.getElementById("img-result") as HTMLImageElement;
      setImageDimensions(img, 1024, 1024);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      // Brief tick so the startVariationWatcher initial pass runs.
      await new Promise((r) => setTimeout(r, 100));

      const overlay = document.getElementById("wrap-result")!.querySelector("[data-magnific-ext-overlay]");
      expect(overlay).not.toBeNull();
    });

    it("filters out small images (naturalWidth/Height < 200) and non-cdnpk.net imgs", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div id="wrap-large"><img id="img-large" src="https://cdn.cdnpk.net/result.png"></div>
        <div id="wrap-tiny"><img id="img-tiny" src="https://cdn.cdnpk.net/1x1.gif"></div>
        <div id="wrap-stale"><img id="img-stale" src="https://cdn.magnific.ai/old.png"></div>
      `;
      setImageDimensions(document.getElementById("img-large") as HTMLImageElement, 1024, 1024);
      setImageDimensions(document.getElementById("img-tiny") as HTMLImageElement, 1, 1);
      setImageDimensions(document.getElementById("img-stale") as HTMLImageElement, 1024, 1024);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));

      expect(document.getElementById("wrap-large")!.querySelector("[data-magnific-ext-overlay]")).not.toBeNull();
      expect(document.getElementById("wrap-tiny")!.querySelector("[data-magnific-ext-overlay]")).toBeNull();
      expect(document.getElementById("wrap-stale")!.querySelector("[data-magnific-ext-overlay]")).toBeNull();
    });

    it("dedupes by URL — two img elements with the same src get only one overlay", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div id="wrap-a"><img id="img-a" src="https://cdn.cdnpk.net/same.png"></div>
        <div id="wrap-b"><img id="img-b" src="https://cdn.cdnpk.net/same.png"></div>
      `;
      setImageDimensions(document.getElementById("img-a") as HTMLImageElement, 1024, 1024);
      setImageDimensions(document.getElementById("img-b") as HTMLImageElement, 1024, 1024);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));

      expect(document.querySelectorAll("[data-magnific-ext-overlay]").length).toBe(1);
    });
  });

  describe("Task 2.6: diagnostic logging on selector misses", () => {
    it("on prompt-input miss, logs the selectors tried + a dump of [data-cy] attrs present in the page", async () => {
      document.body.innerHTML = `
        <div data-cy="diag-anchor-aaa">x</div>
        <div data-cy="diag-anchor-bbb">y</div>
      `;

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 12000 });

      const flat = logs.flat().map(String).join(" ");
      expect(flat).toContain("image-prompt-input");
      expect(flat).toContain("diag-anchor-aaa");
      expect(flat).toContain("diag-anchor-bbb");
    });

    it("on model-trigger miss (with non-empty model), dumps [data-cy] attrs", async () => {
      // No [data-cy="tti-mode-selector-v3-trigger"] in DOM; model is set;
      // prompt + generate are present so the listener completes after the
      // model-trigger waitFor times out.
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div data-cy="diag-model-marker">z</div>
      `;

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "Some Model" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 8000 });

      const flat = logs.flat().map(String).join(" ");
      expect(flat).toContain("tti-mode-selector-v3-trigger");
      expect(flat).toContain("diag-model-marker");
    });

    it("on Generate-button miss, dumps [data-cy] attrs", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <div data-cy="diag-gen-marker">w</div>
      `;

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 8000 });

      const flat = logs.flat().map(String).join(" ");
      expect(flat).toContain("generate-button");
      expect(flat).toContain("diag-gen-marker");
    });

    it("caps the [data-cy] attribute dump (does not flood with all attrs on a heavy page)", async () => {
      let html = "";
      for (let i = 1; i <= 100; i++) {
        html += `<div data-cy="diag-cap-${String(i).padStart(3, "0")}"></div>`;
      }
      document.body.innerHTML = html;

      const { listeners, logs } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 12000 });

      const flat = logs.flat().map(String).join(" ");
      // The first attrs should appear (proves the dump happened).
      expect(flat).toContain("diag-cap-001");
      // The 100th must NOT appear — that proves capping is in place.
      expect(flat).not.toContain("diag-cap-100");
    });
  });

  describe("Task 2.5: overlay anchored to [data-cy^=feed-image-item-] tile", () => {
    it("anchors the overlay to the closest [data-cy^=feed-image-item-] ancestor (not the img's immediate parent)", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div data-cy="feed-image-item-abc">
          <div class="inner-wrap">
            <img id="img-tile" src="https://cdn.cdnpk.net/result.png">
          </div>
        </div>
      `;
      const img = document.getElementById("img-tile") as HTMLImageElement;
      const tile = document.querySelector('[data-cy="feed-image-item-abc"]') as HTMLElement;
      const innerWrap = document.querySelector(".inner-wrap") as HTMLElement;
      setImageDimensions(img, 1024, 1024);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));

      const overlay = document.querySelector("[data-magnific-ext-overlay]") as HTMLElement;
      expect(overlay).not.toBeNull();
      expect(overlay.parentElement).toBe(tile);
      expect(innerWrap.contains(overlay)).toBe(false);
    });

    it("falls back to the img's parentElement when no [data-cy^=feed-image-item-] ancestor exists", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div class="bare-wrap">
          <img id="img-bare" src="https://cdn.cdnpk.net/result.png">
        </div>
      `;
      const img = document.getElementById("img-bare") as HTMLImageElement;
      const bareWrap = document.querySelector(".bare-wrap") as HTMLElement;
      setImageDimensions(img, 1024, 1024);

      const { listeners } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 100));

      const overlay = document.querySelector("[data-magnific-ext-overlay]") as HTMLElement;
      expect(overlay).not.toBeNull();
      expect(overlay.parentElement).toBe(bareWrap);
    });
  });

  // SOLID audit #2 (docs/refactoring/solid-audit-2026-05-22.md): the
  // image-hitl content script must report a magnificVariationFailed
  // message on every silent-bail path, mirroring content-magnific-i2v.js's
  // reportFailure pattern. Without these, runImageHitl's pending promise
  // stays unresolved and the executor slot stays held until the operator
  // clicks Stop — the runner stops polling for image-hitl rows even
  // though the reaper has requeued the server-side row.
  describe("Finding #2: reportFailure on silent-bail paths (executor slot must release)", () => {
    it("emits magnificVariationFailed with reason=prompt_input_not_found when the prompt field never renders", async () => {
      // No [data-cy=image-prompt-input], no fallback textarea — the
      // waitForFill poll exhausts its 10s budget.
      document.body.innerHTML = `<div data-cy="diag-anchor">x</div>`;

      const { listeners, chrome } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t-prompt-miss", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 12000 });

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "magnificVariationFailed",
          taskId: "t-prompt-miss",
          reason: "prompt_input_not_found",
        }),
        expect.any(Function),
      );
    });

    it("emits magnificVariationFailed with reason=generate_button_not_found when the Generate button is missing", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
      `;

      const { listeners, chrome } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t-gen-miss", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 8000 });

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "magnificVariationFailed",
          taskId: "t-gen-miss",
          reason: "generate_button_not_found",
        }),
        expect.any(Function),
      );
    });

    it("emits magnificVariationFailed with reason=generate_button_disabled when the Generate button is disabled", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button" disabled>Generate</button>
      `;

      const { listeners, chrome } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t-gen-disabled", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "magnificVariationFailed",
          taskId: "t-gen-disabled",
          reason: "generate_button_disabled",
        }),
        expect.any(Function),
      );
    });

    it("does NOT emit magnificVariationFailed on the happy path (generate clicked successfully)", async () => {
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
      `;

      const { listeners, chrome } = loadContentScript();
      const sendResponse = vi.fn();
      listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t-happy", prompt: "x", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });

      const failedCall = (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mock.calls.find(
        (c) => (c[0] as { action?: string })?.action === "magnificVariationFailed",
      );
      expect(failedCall).toBeUndefined();
    });
  });

  describe("overlay click feedback (immediate state transitions during SW round-trip)", () => {
    // Render the prompt/generate scaffolding plus one or more cdnpk.net
    // result images, fire magnificFillAndGenerate, wait for the watcher to
    // overlay them. Returns the loaded sandbox so tests can drive the
    // sendMessage callback timing + chrome.runtime.lastError.
    async function setupOverlays(extraImages: { id: string; src: string }[] = []) {
      const extra = extraImages
        .map(({ id, src }) => `<div id="wrap-${id}"><img id="${id}" src="${src}"></div>`)
        .join("");
      document.body.innerHTML = `
        <div data-cy="image-prompt-input"><textarea></textarea></div>
        <button data-cy="generate-button">Generate</button>
        <div id="wrap-result"><img id="img-result" src="https://cdn.cdnpk.net/result.png"></div>
        ${extra}
      `;
      setImageDimensions(document.getElementById("img-result") as HTMLImageElement, 1024, 1024);
      for (const { id } of extraImages) {
        setImageDimensions(document.getElementById(id) as HTMLImageElement, 1024, 1024);
      }
      const loaded = loadContentScript();
      const sendResponse = vi.fn();
      loaded.listeners[0](
        { action: "magnificFillAndGenerate", taskId: "t1", prompt: "shot", model: "" },
        null,
        sendResponse,
      );
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 50));
      return loaded;
    }

    it("synchronously enters the submitting state (text + disabled) before the sendMessage callback runs", async () => {
      const loaded = await setupOverlays();
      // Hold the callback so we can assert the pre-callback state.
      let _pending: ((r: unknown) => void) | undefined;
      loaded.sendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
        _pending = cb;
      });
      const overlay = document.querySelector("[data-magnific-ext-overlay]") as HTMLButtonElement;
      expect(overlay).not.toBeNull();

      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(overlay.textContent || "").toMatch(/submitting/i);
      expect(overlay.disabled).toBe(true);
      // Sanity: sendMessage was invoked but its callback hasn't fired yet.
      expect(loaded.sendMessage).toHaveBeenCalled();
      expect(_pending).toBeTypeOf("function");
    });

    it("synchronously disables every other overlay on the page so a worried double-click can't race the first against a stale taskId", async () => {
      const loaded = await setupOverlays([
        { id: "img-2", src: "https://cdn.cdnpk.net/result-2.png" },
        { id: "img-3", src: "https://cdn.cdnpk.net/result-3.png" },
      ]);
      loaded.sendMessage.mockImplementation((_msg: unknown, _cb?: (r: unknown) => void) => {
        // hold the callback — we only care about pre-callback state
      });
      const overlays = Array.from(
        document.querySelectorAll("[data-magnific-ext-overlay]"),
      ) as HTMLButtonElement[];
      expect(overlays.length).toBe(3);

      overlays[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));

      expect(overlays[0].disabled).toBe(true);
      expect(overlays[1].disabled).toBe(true);
      expect(overlays[2].disabled).toBe(true);
    });

    it("on {matched:true}, the clicked overlay shows a success state (/sent|✓/) and remains disabled", async () => {
      let pending: ((r: unknown) => void) | undefined;
      const loaded = await setupOverlays();
      loaded.sendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
        pending = cb;
      });
      const overlay = document.querySelector("[data-magnific-ext-overlay]") as HTMLButtonElement;

      overlay.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      pending?.({ success: true, matched: true });

      expect(overlay.textContent || "").toMatch(/sent|✓/i);
      expect(overlay.disabled).toBe(true);
    });

    it("on {matched:false} (stale or already-resolved), all overlays re-enable and the clicked one reverts to idle text", async () => {
      let pending: ((r: unknown) => void) | undefined;
      const loaded = await setupOverlays([{ id: "img-2", src: "https://cdn.cdnpk.net/result-2.png" }]);
      loaded.sendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
        pending = cb;
      });
      const overlays = Array.from(
        document.querySelectorAll("[data-magnific-ext-overlay]"),
      ) as HTMLButtonElement[];

      overlays[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      pending?.({ success: true, matched: false });

      expect(overlays[0].disabled).toBe(false);
      expect(overlays[1].disabled).toBe(false);
      expect(overlays[0].textContent || "").toMatch(/use this image/i);
    });

    it("on chrome.runtime.lastError (transient SW unload), the clicked overlay shows a failure state (/failed|retry/) and re-enables — including siblings", async () => {
      let pending: ((r: unknown) => void) | undefined;
      const loaded = await setupOverlays([{ id: "img-2", src: "https://cdn.cdnpk.net/result-2.png" }]);
      loaded.sendMessage.mockImplementation((_msg: unknown, cb?: (r: unknown) => void) => {
        pending = cb;
      });
      const overlays = Array.from(
        document.querySelectorAll("[data-magnific-ext-overlay]"),
      ) as HTMLButtonElement[];

      overlays[0].dispatchEvent(new MouseEvent("click", { bubbles: true }));
      // Chrome surfaces SW errors via lastError, which is only valid for
      // the duration of the callback. Set it, invoke, clear — same shape
      // as the real runtime.
      loaded.chrome.runtime.lastError = { message: "Receiving end does not exist." };
      pending?.(undefined);
      loaded.chrome.runtime.lastError = null;

      expect(overlays[0].textContent || "").toMatch(/failed|retry/i);
      expect(overlays[0].disabled).toBe(false);
      expect(overlays[1].disabled).toBe(false);
    });
  });
});
