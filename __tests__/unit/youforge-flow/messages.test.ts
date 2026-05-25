import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Listener = (
  message: Record<string, unknown>,
  sender: { tab?: { id?: number } },
  sendResponse: (resp: unknown) => void,
) => void | boolean;

function loadMessages() {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/messages.js"),
    "utf8",
  );
  let listener: Listener | null = null;
  const spies = {
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
    setStopFlag: vi.fn(),
    clearStopFlag: vi.fn(),
    clearCachedTier: vi.fn(),
    clearInFlight: vi.fn(),
    resetActiveCounts: vi.fn(),
    forceStopAllTabs: vi.fn(async () => {}),
    getStatus: vi.fn(async () => ({ isPolling: false })),
    handleTaskCompletedFIFO: vi.fn(async () => {}),
    handleTaskFailedFIFO: vi.fn(async () => {}),
    handleVideoFoundFIFO: vi.fn(async () => {}),
    handleContentReady: vi.fn(async () => ({ hasTask: false })),
    pollBothBuckets: vi.fn(async () => ({ image: { success: true }, video: { success: true } })),
    openControlPanel: vi.fn(),
    fetchImageAsBase64: vi.fn(async () => ({ success: true, base64: "x" })),
    updateWebhooks: vi.fn(),
    updateConcurrency: vi.fn(),
    setMode: vi.fn(),
    setVerboseLogging: vi.fn(),
    reloadSettings: vi.fn(async () => {}),
    runSelfTest: vi.fn(async () => ({ ok: true, checks: [] })),
    setGrantedOrigin: vi.fn(async () => {}),
    clearGrantedOrigin: vi.fn(async () => {}),
    bumpStat: vi.fn(async () => {}),
    getStopFlag: vi.fn(() => false),
    sendMessage: vi.fn(async () => {}),
    query: vi.fn(async () => [{ id: 1 }]),
    storageGet: vi.fn(async () => ({ stats: { retries: 0 } })),
    storageSet: vi.fn(async () => {}),
  };
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    ...spies,
    chrome: {
      runtime: {
        onMessage: {
          addListener: (fn: Listener) => {
            listener = fn;
          },
        },
      },
      tabs: {
        query: spies.query,
        sendMessage: spies.sendMessage,
      },
      storage: {
        local: {
          get: spies.storageGet,
          set: spies.storageSet,
        },
      },
    },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    dispatch: (message: Record<string, unknown>, senderTabId = 99) => {
      const sendResponse = vi.fn();
      const returned = listener!(message, { tab: { id: senderTabId } }, sendResponse);
      return { sendResponse, returned };
    },
    spies,
  };
}

describe("messages router", () => {
  it("startPolling → runner.startPolling", () => {
    const ctx = loadMessages();
    const { sendResponse } = ctx.dispatch({ action: "startPolling" });
    expect(ctx.spies.startPolling).toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({ success: true });
  });

  it("stopPolling → runner.stopPolling", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "stopPolling" });
    expect(ctx.spies.stopPolling).toHaveBeenCalled();
  });

  it("stopAllProcessing → setStopFlag + stopPolling + clearCachedTier + clearInFlight + forceStopAllTabs", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "stopAllProcessing" });
    expect(ctx.spies.setStopFlag).toHaveBeenCalled();
    expect(ctx.spies.stopPolling).toHaveBeenCalled();
    expect(ctx.spies.clearCachedTier).toHaveBeenCalled();
    expect(ctx.spies.clearInFlight).toHaveBeenCalled();
    expect(ctx.spies.forceStopAllTabs).toHaveBeenCalled();
  });

  it("getStatus → returns true (async) and calls getStatus", () => {
    const ctx = loadMessages();
    const { returned } = ctx.dispatch({ action: "getStatus" });
    expect(returned).toBe(true);
    expect(ctx.spies.getStatus).toHaveBeenCalled();
  });

  it("taskCompleted → handlers.handleTaskCompletedFIFO", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "taskCompleted", data: { taskId: "t1" } });
    expect(ctx.spies.handleTaskCompletedFIFO).toHaveBeenCalledWith({ taskId: "t1" });
  });

  it("videoFound → handlers.handleVideoFoundFIFO with the full message", () => {
    const ctx = loadMessages();
    const message = {
      action: "videoFound",
      data: { task: { id: "t1" }, videoUrl: "u", isGeneratedImage: true },
    };
    ctx.dispatch(message);
    expect(ctx.spies.handleVideoFoundFIFO).toHaveBeenCalledWith(message);
  });

  it("taskFailed → handleTaskFailedFIFO", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "taskFailed", data: { error: "x" } });
    expect(ctx.spies.handleTaskFailedFIFO).toHaveBeenCalledWith({ error: "x" });
  });

  it("autoStopped → setStopFlag + stopPolling + resetActiveCounts + clearInFlight", () => {
    const ctx = loadMessages();
    ctx.dispatch({
      action: "autoStopped",
      data: { reason: "errors", lastError: "boom" },
    });
    expect(ctx.spies.setStopFlag).toHaveBeenCalled();
    expect(ctx.spies.stopPolling).toHaveBeenCalled();
    expect(ctx.spies.resetActiveCounts).toHaveBeenCalled();
    expect(ctx.spies.clearInFlight).toHaveBeenCalled();
  });

  it("manualPoll → clearStopFlag + pollBothBuckets (returns true)", () => {
    const ctx = loadMessages();
    const { returned } = ctx.dispatch({ action: "manualPoll" });
    expect(returned).toBe(true);
    expect(ctx.spies.clearStopFlag).toHaveBeenCalled();
    expect(ctx.spies.pollBothBuckets).toHaveBeenCalled();
  });

  it("requestNextTask respects stop flag", () => {
    const ctx = loadMessages();
    ctx.spies.getStopFlag.mockReturnValue(true);
    const { sendResponse, returned } = ctx.dispatch({ action: "requestNextTask" });
    expect(returned).toBe(true);
    expect(sendResponse).toHaveBeenCalledWith({ stopped: true });
    expect(ctx.spies.pollBothBuckets).not.toHaveBeenCalled();
  });

  it("requestNextTask polls both buckets when not stopped", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "requestNextTask" });
    expect(ctx.spies.pollBothBuckets).toHaveBeenCalled();
  });

  it("openControlPanel → openControlPanel", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "openControlPanel" });
    expect(ctx.spies.openControlPanel).toHaveBeenCalled();
  });

  it("fetchImage → fetchImageAsBase64 (returns true)", () => {
    const ctx = loadMessages();
    const { returned } = ctx.dispatch({
      action: "fetchImage",
      imageUrl: "https://x/y.png",
    });
    expect(returned).toBe(true);
    expect(ctx.spies.fetchImageAsBase64).toHaveBeenCalledWith("https://x/y.png");
  });

  it("contentReady → handleContentReady() (no-arg stub)", () => {
    const ctx = loadMessages();
    const { returned } = ctx.dispatch({ action: "contentReady" }, 55);
    expect(returned).toBe(true);
    expect(ctx.spies.handleContentReady).toHaveBeenCalledWith();
  });

  it("updateWebhooks → settings.updateWebhooks", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "updateWebhooks", pollUrl: "http://a" });
    expect(ctx.spies.updateWebhooks).toHaveBeenCalledWith(
      expect.objectContaining({ pollUrl: "http://a" }),
    );
  });

  it("updateConcurrency fans out to two settings.updateConcurrency calls", () => {
    const ctx = loadMessages();
    ctx.dispatch({
      action: "updateConcurrency",
      imageConcurrency: 7,
      videoConcurrency: 2,
    });
    expect(ctx.spies.updateConcurrency).toHaveBeenCalledTimes(2);
    expect(ctx.spies.updateConcurrency).toHaveBeenCalledWith("image", 7);
    expect(ctx.spies.updateConcurrency).toHaveBeenCalledWith("video", 2);
  });

  it("setMode → settings.setMode", () => {
    const ctx = loadMessages();
    ctx.dispatch({ action: "setMode", mode: "image" });
    expect(ctx.spies.setMode).toHaveBeenCalledWith("image");
  });

  it("reloadSettings → settings.reloadSettings (returns true for async response)", () => {
    const ctx = loadMessages();
    const { returned } = ctx.dispatch({ action: "reloadSettings" });
    expect(returned).toBe(true);
    expect(ctx.spies.reloadSettings).toHaveBeenCalled();
  });

  it("runSelfTest → self-test.runSelfTest (returns true for async response)", () => {
    const ctx = loadMessages();
    const { returned } = ctx.dispatch({ action: "runSelfTest" });
    expect(returned).toBe(true);
    expect(ctx.spies.runSelfTest).toHaveBeenCalled();
  });
});
