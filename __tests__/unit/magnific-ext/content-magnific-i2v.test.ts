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
  fetch?: typeof fetch;
  // Overrides the SW's response to the cross-origin artifact proxy
  // (`chrome.runtime.sendMessage({action:'fetchReference', url})`). The
  // default mirrors the SW success path so the wider flow runs end-to-end;
  // failure-path tests inject `{ok:false, error:'...'}` to exercise the
  // content-script's error-to-reportFailure translation.
  fetchReferenceResponse?: unknown;
}

const trackedObservers: MutationObserver[] = [];

function setImageDimensions(img: HTMLImageElement, w: number, h: number): void {
  Object.defineProperty(img, "naturalWidth", { value: w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: h, configurable: true });
}

function loadContentScript(opts: LoadOpts = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/content-magnific-i2v.js"
    ),
    "utf8"
  );
  // The manifest loads content-shared.js first in the same isolated world
  // (content_scripts js: ["content-shared.js", ..., "content-magnific-i2v.js"]).
  // It declares the DOM helpers (fillPrompt, editableFrom, setNativeValue,
  // waitFor, dumpDataCyAttributes, ...) the orchestrator calls by bare name.
  // Replicate that load order in the sandbox.
  const sharedSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/content-shared.js"),
    "utf8"
  );
  const listeners: Listener[] = [];
  const messages: Record<string, unknown>[] = [];
  const sendMessage = vi.fn(
    (msg: Record<string, unknown>, cb?: (r: unknown) => void) => {
      messages.push(msg);
      // The script awaits `chrome.runtime.sendMessage({action:'fetchReference',...})`
      // (Promise form) for the cross-origin artifact proxy; production tests
      // need a useful response shape here. Other actions still callback /
      // resolve to {success:true} to preserve existing assertions.
      const action = (msg as { action?: string }).action;
      const response: unknown =
        action === "fetchReference"
          ? opts.fetchReferenceResponse ?? {
              ok: true,
              dataUrl: "data:image/png;base64,iVBOR",
            }
          : { success: true };
      if (typeof cb === "function") {
        cb(response);
        return undefined;
      }
      return Promise.resolve(response);
    }
  );
  const logs: unknown[][] = [];
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
    Blob: globalThis.Blob,
    File: globalThis.File,
    FileReader: globalThis.FileReader,
    DataTransfer: globalThis.DataTransfer ?? class {
      items = {
        add: (file: unknown) => {
          (this.files as unknown[]).push(file);
        },
      };
      files: unknown[] = [];
    },
    fetch:
      opts.fetch ??
      (vi.fn(async () => ({
        ok: true,
        blob: async () => new Blob([new Uint8Array([0])], { type: "image/png" }),
      })) as unknown as typeof fetch),
    document: globalThis.document,
    window: globalThis.window,
    HTMLElement: globalThis.HTMLElement,
    HTMLImageElement: globalThis.HTMLImageElement,
    HTMLInputElement: globalThis.HTMLInputElement,
    HTMLTextAreaElement: globalThis.HTMLTextAreaElement,
    HTMLVideoElement: globalThis.HTMLVideoElement,
    MutationObserver: function (cb: MutationCallback) {
      const obs = new globalThis.MutationObserver(cb);
      trackedObservers.push(obs);
      return obs;
    },
    chrome: {
      runtime: {
        onMessage: { addListener: (fn: Listener) => listeners.push(fn) },
        sendMessage,
        lastError: null,
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc + "\n" + src, sandbox);
  return { listeners, sendMessage, messages, logs };
}

async function dispatchStart(
  listeners: Listener[],
  overrides: Partial<{
    taskId: string;
    prompt: string;
    model: string;
    referenceImageUrl: string;
  }> = {}
) {
  const sendResponse = vi.fn();
  listeners[0](
    {
      action: "magnificStartImageToVideo",
      taskId: overrides.taskId ?? "t1",
      prompt: overrides.prompt ?? "loop motion",
      model: overrides.model ?? "",
      referenceImageUrl: overrides.referenceImageUrl ?? "https://hf.example/img",
    },
    null,
    sendResponse
  );
  return sendResponse;
}

// Append the happy-path tail (prompt + generate button + a click handler that
// synthesizes a result video) onto the provided body fragment. With this
// scaffold the i2v flow completes in ~1s: prompt fills, Generate clicks, a
// new cdnpk.net <video> appears and the result-poll harvests its URL.
//
// Tests that need to assert the absence of these elements (e.g. testing the
// disabled-generate case) can mutate the DOM after this call.
function setBodyWithHappyPath(headHtml: string): void {
  document.body.innerHTML =
    headHtml +
    `
    <div data-cy="video-prompt-input"><textarea></textarea></div>
    <button data-cy="generate-button" id="i2v-test-generate">Generate</button>
  `;
  const btn = document.getElementById("i2v-test-generate") as HTMLButtonElement;
  btn.addEventListener("click", () => {
    const video = document.createElement("video");
    video.src = "https://cdn.cdnpk.net/result-" + Date.now() + ".mp4";
    document.body.appendChild(video);
  });
}

describe("magnific-ext content-magnific-i2v.js", () => {
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

  it("returns true (async response signal) for the magnificStartImageToVideo action", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0](
      {
        action: "magnificStartImageToVideo",
        taskId: "t1",
        prompt: "x",
        model: "",
        referenceImageUrl: "https://hf.example/img",
      },
      null,
      sendResponse,
    );
    expect(ret).toBe(true);
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

  // Mirrors the readiness handshake added to content-magnific.js — the
  // i2v executor pings before dispatching magnificStartImageToVideo.
  it("responds synchronously to `ping` with {ready:true}", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0]({ action: "ping" }, null, sendResponse);
    expect(sendResponse).toHaveBeenCalledWith({ ready: true });
    expect(ret).not.toBe(true);
  });

  it("does NOT respond to magnificFillAndGenerate (that's content-magnific.js's job)", () => {
    const { listeners } = loadContentScript();
    const sendResponse = vi.fn();
    const ret = listeners[0](
      { action: "magnificFillAndGenerate", taskId: "t", prompt: "x", model: "" },
      null,
      sendResponse,
    );
    expect(ret).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  describe("Task 3.1: video-model picker via [data-cy=video-model-selector-trigger]", () => {
    it("skips the model picker entirely when model arg is empty (does not click the trigger)", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-model-selector-trigger">Some Model</button>
      `);
      const trigger = document.querySelector(
        '[data-cy="video-model-selector-trigger"]'
      ) as HTMLElement;
      const triggerClicks = vi.fn();
      trigger.addEventListener("click", triggerClicks);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, { model: "" });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(triggerClicks).not.toHaveBeenCalled();
    });

    it("known model key 'seedance 2.0 fast' clicks trigger then ai-model-item-bytedance-seedance-fast-2.0", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-model-selector-trigger">Pick a model</button>
        <div data-cy="ai-model-item-bytedance-seedance-fast-2.0">Seedance 2.0 Fast</div>
        <div data-cy="ai-model-item-bytedance-seedance-pro-2.0">Seedance 2.0 Pro</div>
      `);
      const trigger = document.querySelector(
        '[data-cy="video-model-selector-trigger"]'
      ) as HTMLElement;
      const fastRow = document.querySelector(
        '[data-cy="ai-model-item-bytedance-seedance-fast-2.0"]'
      ) as HTMLElement;
      const proRow = document.querySelector(
        '[data-cy="ai-model-item-bytedance-seedance-pro-2.0"]'
      ) as HTMLElement;
      const triggerClicks = vi.fn();
      const fastClicks = vi.fn();
      const proClicks = vi.fn();
      trigger.addEventListener("click", triggerClicks);
      fastRow.addEventListener("click", fastClicks);
      proRow.addEventListener("click", proClicks);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, { model: "Seedance 2.0 Fast" });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(triggerClicks).toHaveBeenCalled();
      expect(fastClicks).toHaveBeenCalled();
      expect(proClicks).not.toHaveBeenCalled();
    });

    it("clickClickable: clicks the closest <button> ancestor when the data-cy row is a non-interactive wrapper", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-model-selector-trigger">Pick a model</button>
        <button id="row-button">
          <div data-cy="ai-model-item-bytedance-seedance-fast-2.0">Seedance 2.0 Fast</div>
        </button>
      `);
      const rowButton = document.getElementById("row-button") as HTMLElement;
      const buttonClicks = vi.fn();
      rowButton.addEventListener("click", buttonClicks);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, { model: "Seedance 2.0 Fast" });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(buttonClicks).toHaveBeenCalled();
    });

    it("unknown model falls back to prefix-matching the visible [data-cy^=ai-model-item-] rows by text", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-model-selector-trigger">Pick a model</button>
        <div data-cy="ai-model-item-some-other">Other Model 1</div>
        <button data-cy="ai-model-item-kling-2-1-master">Kling 2.1 Master 50 credits</button>
      `);
      const klingRow = document.querySelector(
        '[data-cy="ai-model-item-kling-2-1-master"]'
      ) as HTMLElement;
      const otherRow = document.querySelector(
        '[data-cy="ai-model-item-some-other"]'
      ) as HTMLElement;
      const klingClicks = vi.fn();
      const otherClicks = vi.fn();
      klingRow.addEventListener("click", klingClicks);
      otherRow.addEventListener("click", otherClicks);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, { model: "Kling 2.1 Master" });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(klingClicks).toHaveBeenCalled();
      expect(otherClicks).not.toHaveBeenCalled();
    });
  });

  describe("Task 3.2: motion-prompt input via [data-cy=video-prompt-input]", () => {
    it("fills a textarea inside [data-cy=video-prompt-input] using the native setter + input/change events", async () => {
      // setBodyWithHappyPath includes a textarea inside [data-cy=video-prompt-input]
      // by default, so this test asserts on that exact shape.
      setBodyWithHappyPath("");
      const textarea = document.querySelector(
        '[data-cy="video-prompt-input"] textarea'
      ) as HTMLTextAreaElement;
      const events: string[] = [];
      textarea.addEventListener("input", () => events.push("input"));
      textarea.addEventListener("change", () => events.push("change"));

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "smooth zoom in",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(textarea.value).toBe("smooth zoom in");
      expect(events).toContain("input");
      expect(events).toContain("change");
    });

    it("fills a contenteditable inside [data-cy=video-prompt-input] using textContent + InputEvent", async () => {
      // Custom DOM: contenteditable inside the wrapper instead of the default
      // textarea. Generate button + result-video click handler stay so the
      // flow completes within the test budget.
      document.body.innerHTML = `
        <div data-cy="video-prompt-input">
          <div contenteditable="true"></div>
        </div>
        <button data-cy="generate-button" id="i2v-test-generate">Generate</button>
      `;
      const editable = document.querySelector('[contenteditable="true"]') as HTMLElement;
      const inputEvents: InputEvent[] = [];
      editable.addEventListener("input", (e) => inputEvents.push(e as InputEvent));
      const btn = document.getElementById("i2v-test-generate") as HTMLButtonElement;
      btn.addEventListener("click", () => {
        const video = document.createElement("video");
        video.src = "https://cdn.cdnpk.net/result-" + Date.now() + ".mp4";
        document.body.appendChild(video);
      });

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "panning slowly across the loop",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(editable.textContent).toBe("panning slowly across the loop");
      expect(inputEvents.length).toBeGreaterThan(0);
      expect(inputEvents[0]).toBeInstanceOf(InputEvent);
    });

    it("falls back to textarea[placeholder*=Describe] when the data-cy wrapper is missing", async () => {
      // No [data-cy="video-prompt-input"] wrapper. The flow's prompt-fill
      // helper should reach the `textarea[placeholder*="Describe" i]` fallback.
      document.body.innerHTML = `
        <textarea placeholder="Describe the motion"></textarea>
        <button data-cy="generate-button" id="i2v-test-generate">Generate</button>
      `;
      const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
      const btn = document.getElementById("i2v-test-generate") as HTMLButtonElement;
      btn.addEventListener("click", () => {
        const video = document.createElement("video");
        video.src = "https://cdn.cdnpk.net/result-" + Date.now() + ".mp4";
        document.body.appendChild(video);
      });

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "fallback motion",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), { timeout: 5000 });

      expect(textarea.value).toBe("fallback motion");
    });
  });

  // The content script runs on https://www.magnific.com so a direct fetch()
  // of the HistForge artifact URL is blocked (mixed content + no CORS).
  // The SW (messages.js) proxies it; this block asserts the script asks the
  // SW rather than fetching directly, and that an SW-side error surfaces as
  // a magnificImageToVideoFailed reason the server-side reaper can see.
  describe("cross-origin artifact proxy via SW (messages.js fetchReference)", () => {
    it("dispatches `fetchReference` to the SW with the artifact URL (no direct page-context fetch)", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-start-frame-input">Start image</button>
      `);
      const slot = document.querySelector(
        '[data-cy="video-start-frame-input"]',
      ) as HTMLElement;
      slot.addEventListener("click", () => {
        // Minimal modal so the wider flow can continue past the upload step.
        const modal = document.createElement("div");
        modal.setAttribute("data-cy", "advanced-selection-modal");
        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.setAttribute(
          "data-cy",
          "advanced-selection-upload-file-input",
        );
        fileInput.addEventListener("change", () => {
          const tile = document.createElement("div");
          tile.setAttribute("data-cy", "feed-image-item-uploaded-1");
          document.body.appendChild(tile);
        });
        const addImages = document.createElement("button");
        addImages.setAttribute(
          "data-cy",
          "advanced-selection-add-images-button",
        );
        modal.appendChild(fileInput);
        modal.appendChild(addImages);
        document.body.appendChild(modal);
      });

      const directFetch = vi.fn(async () => ({
        ok: true,
        blob: async () =>
          new Blob([new Uint8Array([0])], { type: "image/png" }),
      })) as unknown as typeof fetch;
      const { listeners, messages } = loadContentScript({ fetch: directFetch });
      const sendResponse = await dispatchStart(listeners, {
        referenceImageUrl:
          "http://hf.local/api/magnific/artifact/T?videoId=v1&path=loop.png",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      const proxyMsg = messages.find(
        (m) => (m as { action?: string }).action === "fetchReference",
      );
      expect(proxyMsg).toBeDefined();
      expect((proxyMsg as { url?: string }).url).toBe(
        "http://hf.local/api/magnific/artifact/T?videoId=v1&path=loop.png",
      );
      // The script must NOT call fetch() with the http://hf.local artifact
      // URL directly — that's the mixed-content path this proxy replaces.
      // (Fetching the returned data: URL is legal and unrelated.)
      for (const call of (directFetch as ReturnType<typeof vi.fn>).mock.calls) {
        const calledUrl = call[0] as string;
        expect(calledUrl).not.toMatch(/^http:\/\/hf\.local/);
      }
    });

    it("reports magnificImageToVideoFailed with reference_fetch_failed:<error> when the SW proxy returns ok:false", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-start-frame-input">Start image</button>
      `);

      const { listeners, messages } = loadContentScript({
        fetchReferenceResponse: { ok: false, error: "HTTP 404" },
      });
      const sendResponse = await dispatchStart(listeners);
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 5000,
      });

      const failure = messages.find(
        (m) =>
          (m as { action?: string }).action === "magnificImageToVideoFailed",
      );
      expect(failure).toBeDefined();
      expect((failure as { reason?: string }).reason).toMatch(
        /reference_fetch_failed.*HTTP 404/,
      );
    });
  });

  describe("Task 3.3: start-frame upload via advanced-selection-modal", () => {
    // Wire a start-frame slot whose click mounts the advanced-selection-modal
    // (the upload input, clear-all and add-images buttons) and whose upload
    // input mounts a fresh feed-image-item on `change`. Returns the spies the
    // happy-path test asserts against — and exposes the captured File so the
    // assignment test can verify name/type without re-wiring the modal.
    function wireStartFrameUploadFlow() {
      const slot = document.querySelector(
        '[data-cy="video-start-frame-input"]'
      ) as HTMLElement;
      const captured: { file: File | null } = { file: null };
      const clearAllClick = vi.fn();
      const tileClick = vi.fn();
      const addImagesClick = vi.fn();
      const callOrder: string[] = [];

      slot.addEventListener("click", () => {
        const modal = document.createElement("div");
        modal.setAttribute("data-cy", "advanced-selection-modal");

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.setAttribute(
          "data-cy",
          "advanced-selection-upload-file-input"
        );
        fileInput.addEventListener("change", () => {
          captured.file = (fileInput.files && fileInput.files[0]) || null;
          const tile = document.createElement("div");
          tile.setAttribute("data-cy", "feed-image-item-uploaded-1");
          tile.addEventListener("click", () => {
            callOrder.push("tile");
            tileClick();
          });
          document.body.appendChild(tile);
        });

        const clearAll = document.createElement("button");
        clearAll.setAttribute(
          "data-cy",
          "advanced-selection-clear-all-button"
        );
        clearAll.addEventListener("click", () => {
          callOrder.push("clear-all");
          clearAllClick();
        });

        const addImages = document.createElement("button");
        addImages.setAttribute(
          "data-cy",
          "advanced-selection-add-images-button"
        );
        addImages.addEventListener("click", () => {
          callOrder.push("add-images");
          addImagesClick();
        });

        modal.appendChild(fileInput);
        modal.appendChild(clearAll);
        modal.appendChild(addImages);
        document.body.appendChild(modal);
      });

      return { captured, clearAllClick, tileClick, addImagesClick, callOrder };
    }

    it("happy path: clicks slot, opens modal, assigns file, selects new tile, commits via add-images", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-start-frame-input">Start image</button>
      `);
      const { addImagesClick } = wireStartFrameUploadFlow();

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      expect(addImagesClick).toHaveBeenCalled();
    });

    it("assigns a File named loop_image.png with image/* type to the upload input", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-start-frame-input">Start image</button>
      `);
      const { captured } = wireStartFrameUploadFlow();

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      expect(captured.file).not.toBeNull();
      expect(captured.file!.name).toBe("loop_image.png");
      expect(captured.file!.type).toMatch(/^image\//);
    });

    it("clear-all and new-tile selection happen before add-images-button is clicked", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-start-frame-input">Start image</button>
      `);
      const { callOrder } = wireStartFrameUploadFlow();

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      const commit = callOrder.indexOf("add-images");
      const clear = callOrder.indexOf("clear-all");
      const tile = callOrder.indexOf("tile");
      expect(commit).toBeGreaterThan(-1);
      expect(clear).toBeGreaterThan(-1);
      expect(tile).toBeGreaterThan(-1);
      expect(clear).toBeLessThan(commit);
      expect(tile).toBeLessThan(commit);
    });

    it("missing slot does not abort the flow — sendResponse still completes (best-effort)", async () => {
      setBodyWithHappyPath(""); // no start-frame slot
      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      // Tighter timeout proves the slot lookup is fail-fast (single-shot
      // querySelector, not a 5s+ poll loop) — existing tests in Task 3.1 /
      // 3.2 also rely on the no-slot path being instant.
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 3000,
      });
    });
  });

  describe("Task 3.4: end-frame upload (same image, idempotent)", () => {
    // Variant of wireStartFrameUploadFlow scoped to whichever slot the test
    // sets up. Returns the spies the test asserts against. The DOM produced
    // by the slot's click matches Magnific's advanced-selection-modal shape
    // verified by ambientforge.
    function wireFrameUploadModalFor(slot: HTMLElement) {
      const captured: { file: File | null } = { file: null };
      const addImagesClick = vi.fn();
      slot.addEventListener("click", () => {
        const modal = document.createElement("div");
        modal.setAttribute("data-cy", "advanced-selection-modal");

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.setAttribute(
          "data-cy",
          "advanced-selection-upload-file-input"
        );
        fileInput.addEventListener("change", () => {
          captured.file = (fileInput.files && fileInput.files[0]) || null;
          const tile = document.createElement("div");
          tile.setAttribute("data-cy", "feed-image-item-uploaded-end");
          document.body.appendChild(tile);
        });

        const addImages = document.createElement("button");
        addImages.setAttribute(
          "data-cy",
          "advanced-selection-add-images-button"
        );
        addImages.addEventListener("click", () => addImagesClick());

        modal.appendChild(fileInput);
        modal.appendChild(addImages);
        document.body.appendChild(modal);
      });
      return { captured, addImagesClick };
    }

    it("happy path with [data-cy=video-end-frame-input]: drives the modal and commits via add-images", async () => {
      setBodyWithHappyPath(`
        <button data-cy="video-end-frame-input">End image</button>
      `);
      const slot = document.querySelector(
        '[data-cy="video-end-frame-input"]'
      ) as HTMLElement;
      const { addImagesClick } = wireFrameUploadModalFor(slot);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      expect(addImagesClick).toHaveBeenCalled();
    });

    it("idempotency: when img[alt='End image'] is already present, does NOT click the slot", async () => {
      setBodyWithHappyPath(`
        <img alt="End image" src="https://cdn.cdnpk.net/existing-end.png" />
        <button data-cy="video-end-frame-input">End image</button>
      `);
      const slot = document.querySelector(
        '[data-cy="video-end-frame-input"]'
      ) as HTMLElement;
      const slotClick = vi.fn();
      slot.addEventListener("click", slotClick);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 5000,
      });

      expect(slotClick).not.toHaveBeenCalled();
    });

    it("idempotency variant: img[alt='End image '] (trailing space) also short-circuits the upload", async () => {
      setBodyWithHappyPath(`
        <img alt="End image " src="https://cdn.cdnpk.net/existing-end.png" />
        <button data-cy="video-end-frame-input">End image</button>
      `);
      const slot = document.querySelector(
        '[data-cy="video-end-frame-input"]'
      ) as HTMLElement;
      const slotClick = vi.fn();
      slot.addEventListener("click", slotClick);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 5000,
      });

      expect(slotClick).not.toHaveBeenCalled();
    });

    it("label fallback: walks back from span 'End image' to a clickable ancestor when data-cy is missing", async () => {
      setBodyWithHappyPath(`
        <button id="end-frame-clickable">
          <span>End image</span>
        </button>
      `);
      const clickable = document.getElementById(
        "end-frame-clickable"
      ) as HTMLElement;
      const { addImagesClick } = wireFrameUploadModalFor(clickable);

      const { listeners } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      expect(addImagesClick).toHaveBeenCalled();
    });
  });

  describe("Task 3.6: step-level diagnostic logging", () => {
    function findLog(logs: unknown[][], needle: string): unknown[] | undefined {
      return logs.find((entry) =>
        entry.some((p) => typeof p === "string" && p.includes(needle)),
      );
    }

    it("emits step=result-poll status=waiting elapsed=0s before polling so operators see the wait phase begin", async () => {
      // The happy path returns a result on the first poll iteration. Without
      // a pre-iteration waiting log, the operator would jump straight from
      // `generate-click status=ok` to `result-poll status=ok url=...` with no
      // signal that "the poll is running and waiting" — that gap is exactly
      // what Task 3.6 closes.
      setBodyWithHappyPath("");

      const { listeners, logs } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      expect(findLog(logs, "step=result-poll status=waiting")).toBeDefined();
    });

    it("on commit-button-not-found (advanced-selection-modal missing the add-images button), dumps [data-cy] attrs", async () => {
      // The start-frame slot mounts a modal with file input + the uploaded
      // tile, but NO add-images button — so the post-upload commit lookup
      // fails. Task 3.6 says any step miss must surface a [data-cy] dump for
      // operator debugging; this miss path previously skipped the dump.
      //
      // The `<img alt="End image">` short-circuits the end-frame upload via
      // the idempotency path so we don't get a spurious dump from end-frame
      // slot-not-found — keeping this test focused on the commit-error dump.
      setBodyWithHappyPath(`
        <img alt="End image" src="https://cdn.cdnpk.net/existing-end.png" />
        <button data-cy="video-start-frame-input">Start image</button>
        <div data-cy="diagnostic-marker-A"></div>
      `);
      const slot = document.querySelector(
        '[data-cy="video-start-frame-input"]',
      ) as HTMLElement;
      slot.addEventListener("click", () => {
        const modal = document.createElement("div");
        modal.setAttribute("data-cy", "advanced-selection-modal");

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.setAttribute(
          "data-cy",
          "advanced-selection-upload-file-input",
        );
        fileInput.addEventListener("change", () => {
          const tile = document.createElement("div");
          tile.setAttribute("data-cy", "feed-image-item-uploaded-1");
          document.body.appendChild(tile);
        });
        // NOTE: no add-images button — the commit step will fail.
        modal.appendChild(fileInput);
        document.body.appendChild(modal);
      });

      const { listeners, logs } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      expect(
        findLog(logs, "step=start-frame-commit status=error"),
      ).toBeDefined();
      expect(findLog(logs, "[data-cy] attributes present")).toBeDefined();
    });
  });

  describe("Task 3.5: result-video harvester (snapshot-then-diff)", () => {
    it("snapshot-diff: ignores a pre-existing cdnpk.net <video> and reports only the NEW one from Generate", async () => {
      // Magnific keeps the previous run's <video> element in the DOM while
      // the new one renders. A naive querySelector returns the stale one;
      // the snapshot taken before Generate is what makes the diff work.
      setBodyWithHappyPath(`
        <video src="https://cdn.cdnpk.net/pre-existing-old.mp4"></video>
      `);

      const { listeners, messages } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      const completed = messages.find(
        (m) => m.action === "magnificImageToVideoCompleted",
      ) as
        | { action: string; taskId: string; resultUrl: string }
        | undefined;
      expect(completed).toBeDefined();
      expect(completed!.resultUrl).toContain("result-");
      expect(completed!.resultUrl).not.toContain("pre-existing-old");
    });

    it("snapshot-diff: captures ALL pre-existing cdnpk.net URLs so multiple stale videos are all ignored", async () => {
      setBodyWithHappyPath(`
        <video src="https://cdn.cdnpk.net/old-1.mp4"></video>
        <video src="https://cdn.cdnpk.net/old-2.mp4"></video>
      `);

      const { listeners, messages } = loadContentScript();
      const sendResponse = await dispatchStart(listeners, {
        prompt: "x",
        model: "",
      });
      await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled(), {
        timeout: 8000,
      });

      const completed = messages.find(
        (m) => m.action === "magnificImageToVideoCompleted",
      ) as
        | { action: string; taskId: string; resultUrl: string }
        | undefined;
      expect(completed).toBeDefined();
      expect(completed!.resultUrl).toMatch(/^https:\/\/cdn\.cdnpk\.net\/result-/);
    });
  });
});

