import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Listener = (
  message: Record<string, unknown>,
  sender: unknown,
  sendResponse: (r: unknown) => void,
) => boolean | void;

function loadMessages(deps: Record<string, unknown> = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/messages.js"),
    "utf8",
  );
  const listeners: Listener[] = [];
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn: Listener) => listeners.push(fn),
        },
      },
    },
    ...deps,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return listeners[0];
}

describe("magnific-ext messages router", () => {
  it("routes startPolling to startPolling()", () => {
    const startPolling = vi.fn();
    const listener = loadMessages({ startPolling });
    const sendResponse = vi.fn();
    listener({ action: "startPolling" }, null, sendResponse);
    expect(startPolling).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it("routes stopPolling to stopPolling()", () => {
    const stopPolling = vi.fn();
    const listener = loadMessages({ stopPolling });
    const sendResponse = vi.fn();
    listener({ action: "stopPolling" }, null, sendResponse);
    expect(stopPolling).toHaveBeenCalledOnce();
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it("routes getStatus to getStatus() (async)", async () => {
    const status = { isPolling: false, lastPoll: null };
    const getStatus = vi.fn(async () => status);
    const listener = loadMessages({ getStatus });
    const sendResponse = vi.fn();
    const ret = listener({ action: "getStatus" }, null, sendResponse);
    expect(ret).toBe(true); // signal async response
    // Wait for the microtask
    await new Promise((r) => setTimeout(r, 0));
    expect(sendResponse).toHaveBeenCalledWith(status);
  });

  it("routes updateWebhooks to updateWebhooks(message)", async () => {
    // The router chains `updateWebhooks(message).then(() => sendResponse(...))`,
    // so the mock must return a promise (settings.updateWebhooks is async — it
    // awaits chrome.storage.local.set) and sendResponse fires on a microtask
    // after the listener returns — await a tick before asserting it.
    const updateWebhooks = vi.fn(async () => {});
    const listener = loadMessages({ updateWebhooks });
    const sendResponse = vi.fn();
    const msg = {
      action: "updateWebhooks",
      nextTaskUrl: "u1",
      submitResultUrl: "u2",
      statusUrl: "u3",
      queueSummaryUrl: "u4",
      magnificToken: "t",
    };
    listener(msg, null, sendResponse);
    expect(updateWebhooks).toHaveBeenCalledWith(msg);
    await new Promise((r) => setTimeout(r, 0));
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it("routes setVerboseLogging passing the boolean value", () => {
    // Router chains `setVerboseLogging(value).then(...).catch(...)`; the mock
    // must return a promise (it's async — persists via chrome.storage.local.set).
    const setVerboseLogging = vi.fn(async () => {});
    const listener = loadMessages({ setVerboseLogging });
    const sendResponse = vi.fn();
    listener({ action: "setVerboseLogging", value: true }, null, sendResponse);
    expect(setVerboseLogging).toHaveBeenCalledWith(true);
  });

  it("routes setGrantedOrigin null→clear / string→set", async () => {
    const setGrantedOrigin = vi.fn(async () => {});
    const clearGrantedOrigin = vi.fn(async () => {});
    const listener = loadMessages({ setGrantedOrigin, clearGrantedOrigin });
    const r1 = vi.fn();
    listener(
      { action: "setGrantedOrigin", origin: "http://localhost:3000" },
      null,
      r1,
    );
    await new Promise((res) => setTimeout(res, 0));
    expect(setGrantedOrigin).toHaveBeenCalledWith("http://localhost:3000");

    const r2 = vi.fn();
    listener({ action: "setGrantedOrigin", origin: null }, null, r2);
    await new Promise((res) => setTimeout(res, 0));
    expect(clearGrantedOrigin).toHaveBeenCalledOnce();
  });

  it("ignores unknown actions silently", () => {
    const listener = loadMessages();
    const sendResponse = vi.fn();
    expect(() =>
      listener({ action: "totallyUnknown" }, null, sendResponse),
    ).not.toThrow();
  });

  it("routes magnificVariationSelected to notifyVariationSelected(taskId, resultUrl)", () => {
    const notifyVariationSelected = vi.fn(() => true);
    const listener = loadMessages({ notifyVariationSelected });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificVariationSelected",
        taskId: "abc_1",
        resultUrl: "https://cdn.magnific.ai/x.png",
      },
      null,
      sendResponse,
    );
    expect(notifyVariationSelected).toHaveBeenCalledWith(
      "abc_1",
      "https://cdn.magnific.ai/x.png",
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: true });
  });

  it("magnificVariationSelected reports matched:false when no task is awaiting", () => {
    const notifyVariationSelected = vi.fn(() => false);
    const listener = loadMessages({ notifyVariationSelected });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificVariationSelected",
        taskId: "stale",
        resultUrl: "https://cdn.magnific.ai/x.png",
      },
      null,
      sendResponse,
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: false });
  });

  // SOLID audit #2: the image-hitl executor must release its slot when a
  // content-script silent-bail is reported. The router translates the
  // magnificVariationFailed inbound into a notifyVariationFailed call;
  // shape-symmetric with magnificImageToVideoFailed.
  it("routes magnificVariationFailed to notifyVariationFailed(taskId, reason)", () => {
    const notifyVariationFailed = vi.fn(() => true);
    const listener = loadMessages({ notifyVariationFailed });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificVariationFailed",
        taskId: "hitl_1",
        reason: "generate_button_disabled",
      },
      null,
      sendResponse,
    );
    expect(notifyVariationFailed).toHaveBeenCalledWith(
      "hitl_1",
      "generate_button_disabled",
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: true });
  });

  it("magnificVariationFailed reports matched:false when no task is awaiting (stale)", () => {
    const notifyVariationFailed = vi.fn(() => false);
    const listener = loadMessages({ notifyVariationFailed });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificVariationFailed",
        taskId: "stale",
        reason: "prompt_input_not_found",
      },
      null,
      sendResponse,
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: false });
  });

  it("routes magnificImageToVideoCompleted to notifyImageToVideoCompleted(taskId, resultUrl)", () => {
    const notifyImageToVideoCompleted = vi.fn(() => true);
    const listener = loadMessages({ notifyImageToVideoCompleted });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificImageToVideoCompleted",
        taskId: "i2v_1",
        resultUrl: "https://cdn.magnific.ai/clip.mp4",
      },
      null,
      sendResponse,
    );
    expect(notifyImageToVideoCompleted).toHaveBeenCalledWith(
      "i2v_1",
      "https://cdn.magnific.ai/clip.mp4",
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: true });
  });

  it("routes magnificImageToVideoFailed to notifyImageToVideoFailed(taskId, reason)", () => {
    const notifyImageToVideoFailed = vi.fn(() => true);
    const listener = loadMessages({ notifyImageToVideoFailed });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificImageToVideoFailed",
        taskId: "i2v_2",
        reason: "upload_failed",
      },
      null,
      sendResponse,
    );
    expect(notifyImageToVideoFailed).toHaveBeenCalledWith(
      "i2v_2",
      "upload_failed",
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: true });
  });

  it("magnificImageToVideoCompleted reports matched:false when no task is awaiting (stale)", () => {
    const notifyImageToVideoCompleted = vi.fn(() => false);
    const listener = loadMessages({ notifyImageToVideoCompleted });
    const sendResponse = vi.fn();
    listener(
      {
        action: "magnificImageToVideoCompleted",
        taskId: "stale",
        resultUrl: "https://cdn.magnific.ai/clip.mp4",
      },
      null,
      sendResponse,
    );
    expect(sendResponse).toHaveBeenCalledWith({ success: true, matched: false });
  });

  // The i2v content script can't fetch the HistForge artifact URL directly
  // (mixed-content blocking + no CORS), so the SW proxies it. Verifies the
  // success path returns ok:true + a data URL the content script can decode.
  it("routes fetchReference: SW fetches the url and returns {ok:true, dataUrl}", async () => {
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic
    const blob = new Blob([bytes], { type: "image/png" });
    const fetch = vi.fn(async () => ({ ok: true, blob: async () => blob }));
    const listener = loadMessages({
      fetch,
      FileReader: globalThis.FileReader,
    });
    const sendResponse = vi.fn();
    const ret = listener(
      { action: "fetchReference", url: "http://hf.local/api/magnific/artifact/T?path=loop.png" },
      null,
      sendResponse,
    );
    expect(ret).toBe(true); // async response signal
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(fetch).toHaveBeenCalledWith(
      "http://hf.local/api/magnific/artifact/T?path=loop.png",
    );
    const resp = sendResponse.mock.calls[0][0] as {
      ok: boolean;
      dataUrl: string;
    };
    expect(resp.ok).toBe(true);
    expect(resp.dataUrl).toMatch(/^data:image\/png;base64,/);
  });

  it("fetchReference: surfaces HTTP status as {ok:false, error:'HTTP N'}", async () => {
    const fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const listener = loadMessages({
      fetch,
      FileReader: globalThis.FileReader,
    });
    const sendResponse = vi.fn();
    listener(
      { action: "fetchReference", url: "http://hf.local/missing" },
      null,
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: "HTTP 404" });
  });

  it("fetchReference: surfaces network failure as {ok:false, error:<message>}", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const listener = loadMessages({
      fetch,
      FileReader: globalThis.FileReader,
    });
    const sendResponse = vi.fn();
    listener(
      { action: "fetchReference", url: "http://offline" },
      null,
      sendResponse,
    );
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(sendResponse).toHaveBeenCalledWith({
      ok: false,
      error: "Failed to fetch",
    });
  });
});
