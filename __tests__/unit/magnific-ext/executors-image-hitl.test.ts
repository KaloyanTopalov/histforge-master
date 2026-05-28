import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type ImageHitlMod = {
  runImageHitl: (task: Record<string, unknown>) => Promise<unknown>;
  notifyVariationSelected: (
    taskId: string,
    resultUrl: string
  ) => boolean;
  notifyVariationFailed: (taskId: string, reason: string) => boolean;
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
  getMagnificImageGenUrl?: () => string;
  claimExecutorSlot?: ReturnType<typeof vi.fn>;
  releaseExecutorSlot?: ReturnType<typeof vi.fn>;
  // Readiness-handshake knobs. Tight defaults keep the suite fast; the
  // timeout-path test sets these explicitly so a missed ping fails
  // quickly instead of waiting the production 10s.
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

function loadExecutor(opts: LoadOpts = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/executors/image-hitl.js"
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
    vi.fn(async () => ({ id: 42, url: "https://magnific.ai/" }));
  const tabsUpdate =
    opts.tabsUpdate ??
    vi.fn(async (id: number) => ({ id, url: "https://magnific.ai/" }));
  // Default fake: a ready content script. Returns {ready:true} for the
  // readiness ping so the handshake passes; returns undefined for every
  // other action (the existing tests don't read the response).
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
      windows: {
        update: windowsUpdate,
      },
    },
    fetchWithTimeout,
    getSubmitResultUrl:
      opts.getSubmitResultUrl ??
      (() => "https://histforge.example/api/magnific/submit-result/T"),
    MAGNIFIC_IMAGE_GEN_URL: "https://magnific.ai/",
    claimExecutorSlot,
    releaseExecutorSlot,
    // Sandbox-exposed handshake knobs. Real production values are 200ms
    // and 10s; tests use much tighter ones so the timeout-path doesn't
    // burn 10s of wall time.
    MAGNIFIC_PING_INTERVAL_MS: opts.pingIntervalMs ?? 5,
    MAGNIFIC_PING_TIMEOUT_MS: opts.pingTimeoutMs ?? 1000,
  };
  vm.createContext(sandbox);
  vm.runInContext(handshakeSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as ImageHitlMod,
    tabsQuery,
    tabsCreate,
    tabsUpdate,
    tabsSendMessage,
    fetchWithTimeout,
    claimExecutorSlot,
    releaseExecutorSlot,
  };
}

describe("magnific-ext runImageHitl: tab dispatch", () => {
  it("creates a Magnific tab when none is open", async () => {
    const { mod, tabsQuery, tabsCreate, tabsSendMessage } = loadExecutor({
      tabsQuery: vi.fn(async () => []),
    });
    const task = {
      id: "ext_123",
      mode: "image-hitl",
      prompt: "alpine peak",
      model: "mystic",
    };
    const promise = mod.runImageHitl(task);
    // Yield so the tab open + sendMessage chain runs
    await new Promise((r) => setTimeout(r, 0));
    expect(tabsQuery).toHaveBeenCalled();
    expect(tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining("magnific.ai") })
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      42,
      expect.objectContaining({
        action: "magnificFillAndGenerate",
        taskId: "ext_123",
        prompt: "alpine peak",
        model: "mystic",
      })
    );
    // Resolve the pending promise so we don't leak it across tests
    mod.notifyVariationSelected("ext_123", "https://cdn.magnific.ai/v.png");
    await promise;
  });

  it("focuses an existing Magnific tab instead of opening a new one", async () => {
    const existing: FakeTab = { id: 99, url: "https://magnific.ai/foo" };
    const { mod, tabsCreate, tabsUpdate, tabsSendMessage } = loadExecutor({
      tabsQuery: vi.fn(async () => [existing]),
    });
    const promise = mod.runImageHitl({
      id: "ext_777",
      mode: "image-hitl",
      prompt: "x",
      model: "",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(tabsCreate).not.toHaveBeenCalled();
    expect(tabsUpdate).toHaveBeenCalledWith(99, { active: true });
    expect(tabsSendMessage).toHaveBeenCalledWith(99, expect.any(Object));
    mod.notifyVariationSelected("ext_777", "https://cdn.magnific.ai/v.png");
    await promise;
  });
});

describe("magnific-ext runImageHitl: submit-result POST", () => {
  it("POSTs submit-result when notifyVariationSelected resolves the task", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageHitl({
      id: "ext_42",
      mode: "image-hitl",
      prompt: "x",
      model: "mystic",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
    mod.notifyVariationSelected("ext_42", "https://cdn.magnific.ai/v.png");
    await promise;
    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchWithTimeout as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://histforge.example/api/magnific/submit-result/T");
    const body = JSON.parse((init as { body: string }).body);
    expect(body).toMatchObject({
      id: "ext_42",
      external_task_id: "ext_42",
      status: "done",
      resultUrl: "https://cdn.magnific.ai/v.png",
    });
    expect((init as { method: string }).method).toBe("POST");
  });

  it("ignores notifyVariationSelected calls for unknown taskIds (no submit)", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const handled = mod.notifyVariationSelected(
      "never-dispatched",
      "https://cdn.magnific.ai/v.png"
    );
    expect(handled).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("magnific-ext runImageHitl: content-script readiness handshake", () => {
  it("pings the tab before dispatching magnificFillAndGenerate", async () => {
    const calls: Array<{ tabId: number; action: string }> = [];
    const tabsSendMessage = vi.fn(
      async (tabId: number, msg: { action: string }) => {
        calls.push({ tabId, action: msg.action });
        if (msg.action === "ping") return { ready: true };
        return undefined;
      }
    );
    const { mod } = loadExecutor({ tabsSendMessage });
    const promise = mod.runImageHitl({
      id: "ext_ping_1",
      mode: "image-hitl",
      prompt: "x",
      model: "",
    });
    // Wait one tick + handshake interval so the ping → dispatch chain runs.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls[0]).toEqual({ tabId: 42, action: "ping" });
    expect(calls.slice(1)).toEqual(
      expect.arrayContaining([{ tabId: 42, action: "magnificFillAndGenerate" }])
    );
    mod.notifyVariationSelected("ext_ping_1", "https://cdn.magnific.ai/v.png");
    await promise;
  });

  it("retries the ping until the content script responds (drops initial 'Receiving end does not exist' errors)", async () => {
    let pingAttempts = 0;
    const tabsSendMessage = vi.fn(
      async (_tabId: number, msg: { action: string }) => {
        if (msg.action === "ping") {
          pingAttempts++;
          if (pingAttempts < 3) {
            // Mirror the real Chrome rejection so the executor exercises
            // the catch-and-retry path it'd hit in production.
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
    const promise = mod.runImageHitl({
      id: "ext_ping_retry",
      mode: "image-hitl",
      prompt: "x",
      model: "",
    });
    await new Promise((r) => setTimeout(r, 100));
    expect(pingAttempts).toBe(3);
    expect(
      (tabsSendMessage as ReturnType<typeof vi.fn>).mock.calls.some(
        (c) => (c[1] as { action: string }).action === "magnificFillAndGenerate"
      )
    ).toBe(true);
    mod.notifyVariationSelected(
      "ext_ping_retry",
      "https://cdn.magnific.ai/v.png"
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
      mod.runImageHitl({
        id: "ext_ping_timeout",
        mode: "image-hitl",
        prompt: "x",
        model: "",
      })
    ).rejects.toThrow(/content script/i);
    // The dispatch must NOT have been sent — only ping attempts.
    const dispatched = (
      tabsSendMessage as ReturnType<typeof vi.fn>
    ).mock.calls.some(
      (c) => (c[1] as { action: string }).action === "magnificFillAndGenerate"
    );
    expect(dispatched).toBe(false);
  });
});

describe("magnific-ext runImageHitl: active-slot accounting", () => {
  it("claims the executor slot on dispatch and releases on submit", async () => {
    const { mod, claimExecutorSlot, releaseExecutorSlot } = loadExecutor();
    const promise = mod.runImageHitl({
      id: "ext_55",
      mode: "image-hitl",
      prompt: "x",
      model: "",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(claimExecutorSlot).toHaveBeenCalledOnce();
    expect(releaseExecutorSlot).not.toHaveBeenCalled();
    mod.notifyVariationSelected("ext_55", "https://cdn.magnific.ai/v.png");
    await promise;
    expect(releaseExecutorSlot).toHaveBeenCalledOnce();
  });

  // SOLID audit #2: a content-script silent bail must release the slot.
  // Without notifyVariationFailed wired end-to-end, the pending promise
  // never settles, the finally block never runs, the slot stays held,
  // and the runner skips image-hitl polls forever. Symmetric with the
  // image-to-video executor's "releases the slot even when the executor
  // rejects" test.
  it("releases the slot when notifyVariationFailed is called (no submit-result POST)", async () => {
    const { mod, claimExecutorSlot, releaseExecutorSlot, fetchWithTimeout } =
      loadExecutor();
    const promise = mod.runImageHitl({
      id: "ext_fail_1",
      mode: "image-hitl",
      prompt: "x",
      model: "",
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(claimExecutorSlot).toHaveBeenCalledOnce();
    const handled = mod.notifyVariationFailed(
      "ext_fail_1",
      "generate_button_disabled",
    );
    expect(handled).toBe(true);
    await expect(promise).rejects.toThrow(/generate_button_disabled/);
    expect(releaseExecutorSlot).toHaveBeenCalledOnce();
    // The dispatch_timeout reaper requeues the row server-side, so the
    // executor must NOT POST submit-result on failure (would mark the
    // row done with no resultUrl).
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("notifyVariationFailed returns false for unknown taskIds (does not throw)", async () => {
    const { mod } = loadExecutor();
    const handled = mod.notifyVariationFailed("never-dispatched", "boom");
    expect(handled).toBe(false);
  });
});
