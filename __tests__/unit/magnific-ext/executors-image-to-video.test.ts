import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type ImageToVideoMod = {
  runImageToVideo: (task: Record<string, unknown>) => Promise<unknown>;
  notifyImageToVideoCompleted: (
    taskId: string,
    resultUrl: string
  ) => boolean;
  notifyImageToVideoFailed: (taskId: string, reason: string) => boolean;
};

// Minimal shape of the chrome.tabs.Tab the executor reads from
// chrome.tabs.query results. The @types/chrome package isn't installed
// (the extension is loaded into a vm sandbox in these tests), so we
// declare just the fields the executor touches.
type FakeTab = { id: number; url?: string; windowId?: number };

interface LoadOpts {
  tabsQuery?: ReturnType<typeof vi.fn>;
  tabsCreate?: ReturnType<typeof vi.fn>;
  tabsUpdate?: ReturnType<typeof vi.fn>;
  tabsSendMessage?: ReturnType<typeof vi.fn>;
  windowsUpdate?: ReturnType<typeof vi.fn>;
  fetchWithTimeout?: ReturnType<typeof vi.fn>;
  getSubmitResultUrl?: () => string;
  claimExecutorSlot?: ReturnType<typeof vi.fn>;
  releaseExecutorSlot?: ReturnType<typeof vi.fn>;
  // Readiness-handshake knobs. Tight defaults so the suite stays fast;
  // the timeout-path test overrides to fail in tens of ms.
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

function loadExecutor(opts: LoadOpts = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/executors/image-to-video.js"
    ),
    "utf8"
  );
  // background.js importScripts content-script-handshake.js (which defines
  // waitForContentScriptReady) before the executors — replicate that load
  // order in the sandbox so the executor's call resolves.
  const handshakeSrc = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/executors/content-script-handshake.js"
    ),
    "utf8"
  );
  const tabsQuery =
    opts.tabsQuery ?? vi.fn(async () => [] as FakeTab[]);
  const tabsCreate =
    opts.tabsCreate ??
    vi.fn(async () => ({ id: 17, url: "https://magnific.ai/" }));
  const tabsUpdate =
    opts.tabsUpdate ??
    vi.fn(async (id: number) => ({ id, url: "https://magnific.ai/" }));
  // Default fake mirrors a ready content script — ping action returns
  // {ready:true}; everything else returns undefined so the existing
  // tests' call-shape assertions still hold.
  const tabsSendMessage =
    opts.tabsSendMessage ??
    vi.fn(async (_id: number, msg: { action?: string }) => {
      if (msg && msg.action === "ping") return { ready: true };
      return undefined;
    });
  const windowsUpdate = opts.windowsUpdate ?? vi.fn();
  const fetchWithTimeout =
    opts.fetchWithTimeout ??
    vi.fn(async () => ({ ok: true, text: async () => '{"success":true}' }));
  const claimExecutorSlot = opts.claimExecutorSlot ?? vi.fn();
  const releaseExecutorSlot = opts.releaseExecutorSlot ?? vi.fn();

  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    setTimeout,
    Promise,
    chrome: {
      tabs: {
        query: tabsQuery,
        create: tabsCreate,
        update: tabsUpdate,
        sendMessage: tabsSendMessage,
      },
      windows: { update: windowsUpdate },
    },
    fetchWithTimeout,
    getSubmitResultUrl:
      opts.getSubmitResultUrl ??
      (() => "https://histforge.example/api/magnific/submit-result/T"),
    MAGNIFIC_IMAGE_TO_VIDEO_URL: "https://magnific.ai/",
    claimExecutorSlot,
    releaseExecutorSlot,
    MAGNIFIC_PING_INTERVAL_MS: opts.pingIntervalMs ?? 5,
    MAGNIFIC_PING_TIMEOUT_MS: opts.pingTimeoutMs ?? 1000,
  };
  vm.createContext(sandbox);
  vm.runInContext(handshakeSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as ImageToVideoMod,
    tabsQuery,
    tabsCreate,
    tabsUpdate,
    tabsSendMessage,
    fetchWithTimeout,
    claimExecutorSlot,
    releaseExecutorSlot,
  };
}

describe("magnific-ext runImageToVideo: tab dispatch", () => {
  it("creates a Magnific image-to-video tab when none is open", async () => {
    const { mod, tabsQuery, tabsCreate, tabsSendMessage } = loadExecutor({
      tabsQuery: vi.fn(async () => []),
    });
    const task = {
      id: "ext_i2v_1",
      mode: "image-to-video",
      prompt: "slow zoom on alpine peak",
      model: "seedance",
      reference_image_url:
        "https://histforge.example/api/magnific/artifact/T?videoId=v1&path=loop_image.png",
    };
    const promise = mod.runImageToVideo(task);
    await new Promise((r) => setTimeout(r, 0));

    expect(tabsQuery).toHaveBeenCalled();
    expect(tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("magnific.ai"),
      })
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      17,
      expect.objectContaining({
        action: "magnificStartImageToVideo",
        taskId: "ext_i2v_1",
        prompt: "slow zoom on alpine peak",
        model: "seedance",
        referenceImageUrl: task.reference_image_url,
      })
    );

    mod.notifyImageToVideoCompleted(
      "ext_i2v_1",
      "https://cdn.magnific.ai/clip.mp4"
    );
    await promise;
  });

  it("focuses an existing Magnific tab instead of opening a new one", async () => {
    const existing: FakeTab = {
      id: 88,
      url: "https://magnific.ai/i2v",
    };
    const { mod, tabsCreate, tabsUpdate, tabsSendMessage } = loadExecutor({
      tabsQuery: vi.fn(async () => [existing]),
    });
    const promise = mod.runImageToVideo({
      id: "ext_i2v_2",
      mode: "image-to-video",
      prompt: "x",
      model: "",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(tabsUpdate).toHaveBeenCalledWith(88, { active: true });
    expect(tabsSendMessage).toHaveBeenCalledWith(88, expect.any(Object));
    mod.notifyImageToVideoCompleted(
      "ext_i2v_2",
      "https://cdn.magnific.ai/clip.mp4"
    );
    await promise;
  });
});

describe("magnific-ext runImageToVideo: content-script readiness handshake", () => {
  it("pings the tab before dispatching magnificStartImageToVideo", async () => {
    const calls: Array<{ tabId: number; action: string }> = [];
    const tabsSendMessage = vi.fn(
      async (tabId: number, msg: { action: string }) => {
        calls.push({ tabId, action: msg.action });
        if (msg.action === "ping") return { ready: true };
        return undefined;
      }
    );
    const { mod } = loadExecutor({ tabsSendMessage });
    const promise = mod.runImageToVideo({
      id: "ext_i2v_ping_1",
      mode: "image-to-video",
      prompt: "x",
      model: "",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0]).toEqual({ tabId: 17, action: "ping" });
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([
        { tabId: 17, action: "magnificStartImageToVideo" },
      ])
    );
    mod.notifyImageToVideoCompleted(
      "ext_i2v_ping_1",
      "https://cdn.magnific.ai/clip.mp4"
    );
    await promise;
  });

  it("retries the ping until the content script responds", async () => {
    let pingAttempts = 0;
    const tabsSendMessage = vi.fn(
      async (_tabId: number, msg: { action: string }) => {
        if (msg.action === "ping") {
          pingAttempts++;
          if (pingAttempts < 3) {
            throw new Error(
              "Could not establish connection. Receiving end does not exist."
            );
          }
          return { ready: true };
        }
        return undefined;
      }
    );
    const { mod } = loadExecutor({ tabsSendMessage });
    const promise = mod.runImageToVideo({
      id: "ext_i2v_ping_retry",
      mode: "image-to-video",
      prompt: "x",
      model: "",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(pingAttempts).toBe(3);
    expect(
      (tabsSendMessage as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) =>
          (c[1] as { action: string }).action === "magnificStartImageToVideo"
      )
    ).toBe(true);
    mod.notifyImageToVideoCompleted(
      "ext_i2v_ping_retry",
      "https://cdn.magnific.ai/clip.mp4"
    );
    await promise;
  });

  it("throws if the content script never responds within the readiness timeout", async () => {
    const tabsSendMessage = vi.fn(
      async (_tabId: number, msg: { action: string }) => {
        if (msg.action === "ping") {
          throw new Error(
            "Could not establish connection. Receiving end does not exist."
          );
        }
        return undefined;
      }
    );
    const { mod } = loadExecutor({
      tabsSendMessage,
      pingIntervalMs: 5,
      pingTimeoutMs: 30,
    });
    await expect(
      mod.runImageToVideo({
        id: "ext_i2v_ping_timeout",
        mode: "image-to-video",
        prompt: "x",
        model: "",
        reference_image_url: "https://histforge.example/img",
      })
    ).rejects.toThrow(/content script/i);
    const dispatched = (
      tabsSendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.some(
      (c) =>
        (c[1] as { action: string }).action === "magnificStartImageToVideo"
    );
    expect(dispatched).toBe(false);
  });
});

describe("magnific-ext runImageToVideo: submit-result POST", () => {
  it("POSTs submit-result with status=done and resultUrl when notifyImageToVideoCompleted resolves the task", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageToVideo({
      id: "ext_i2v_3",
      mode: "image-to-video",
      prompt: "x",
      model: "seedance",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    mod.notifyImageToVideoCompleted(
      "ext_i2v_3",
      "https://cdn.magnific.ai/clip.mp4"
    );
    await promise;
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchWithTimeout as ReturnType<typeof vi.fn>).mock
      .calls[0];
    expect(url).toBe(
      "https://histforge.example/api/magnific/submit-result/T"
    );
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({
      id: "ext_i2v_3",
      external_task_id: "ext_i2v_3",
      status: "done",
      resultUrl: "https://cdn.magnific.ai/clip.mp4",
    });
    expect((init as { method: string }).method).toBe("POST");
  });

  it("ignores notifyImageToVideoCompleted calls for unknown taskIds (no submit)", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const handled = mod.notifyImageToVideoCompleted(
      "never-dispatched",
      "https://cdn.magnific.ai/clip.mp4"
    );
    expect(handled).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("rejects on failure notification — does NOT POST submit-result (reaper handles requeue)", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageToVideo({
      id: "ext_i2v_4",
      mode: "image-to-video",
      prompt: "x",
      model: "",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 0));
    mod.notifyImageToVideoFailed("ext_i2v_4", "upload_failed");
    await expect(promise).rejects.toThrow(/upload_failed/);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("magnific-ext runImageToVideo: active-slot accounting", () => {
  it("claims the executor slot on dispatch and releases on submit", async () => {
    const { mod, claimExecutorSlot, releaseExecutorSlot } = loadExecutor();
    const promise = mod.runImageToVideo({
      id: "ext_i2v_5",
      mode: "image-to-video",
      prompt: "x",
      model: "",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(claimExecutorSlot).toHaveBeenCalledOnce();
    expect(releaseExecutorSlot).not.toHaveBeenCalled();
    mod.notifyImageToVideoCompleted(
      "ext_i2v_5",
      "https://cdn.magnific.ai/clip.mp4"
    );
    await promise;
    expect(releaseExecutorSlot).toHaveBeenCalledOnce();
  });

  it("releases the slot even when the executor rejects", async () => {
    const { mod, claimExecutorSlot, releaseExecutorSlot } = loadExecutor();
    const promise = mod.runImageToVideo({
      id: "ext_i2v_6",
      mode: "image-to-video",
      prompt: "x",
      model: "",
      reference_image_url: "https://histforge.example/img",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(claimExecutorSlot).toHaveBeenCalledOnce();
    mod.notifyImageToVideoFailed("ext_i2v_6", "boom");
    await expect(promise).rejects.toThrow();
    expect(releaseExecutorSlot).toHaveBeenCalledOnce();
  });
});
