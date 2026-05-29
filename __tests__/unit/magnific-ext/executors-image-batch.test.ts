import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type ImageBatchMod = {
  runImageBatch: (task: Record<string, unknown>) => Promise<unknown>;
  notifyImageBatchCompleted: (
    taskId: string,
    resultUrl: string,
    magnificProjectId: string | null
  ) => boolean;
  notifyImageBatchFailed: (
    taskId: string,
    reason: string,
    clearProjectId?: boolean
  ) => boolean;
};

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
  pingIntervalMs?: number;
  pingTimeoutMs?: number;
}

const SUBMIT_URL = "https://histforge.example/api/magnific/submit-result/T";

function loadExecutor(opts: LoadOpts = {}) {
  const src = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/executors/image-batch.js"
    ),
    "utf8"
  );
  const handshakeSrc = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/magnific-ext/src/executors/content-script-handshake.js"
    ),
    "utf8"
  );
  const tabsQuery = opts.tabsQuery ?? vi.fn(async () => [] as FakeTab[]);
  const tabsCreate =
    opts.tabsCreate ??
    vi.fn(async (args: { url: string }) => ({ id: 17, url: args.url }));
  const tabsUpdate =
    opts.tabsUpdate ?? vi.fn(async (id: number) => ({ id }));
  const tabsSendMessage =
    opts.tabsSendMessage ??
    vi.fn(async (_id: number, msg: { action?: string }) => {
      if (msg && msg.action === "ping") return { ready: true };
      return undefined;
    });
  const windowsUpdate = opts.windowsUpdate ?? vi.fn();
  const fetchWithTimeout =
    opts.fetchWithTimeout ?? vi.fn(async () => ({ ok: true }));
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
    getSubmitResultUrl: opts.getSubmitResultUrl ?? (() => SUBMIT_URL),
    MAGNIFIC_PROJECTS_URL: "https://www.magnific.com/app/projects",
    claimExecutorSlot,
    releaseExecutorSlot,
    MAGNIFIC_PING_INTERVAL_MS: opts.pingIntervalMs ?? 5,
    MAGNIFIC_PING_TIMEOUT_MS: opts.pingTimeoutMs ?? 1000,
  };
  vm.createContext(sandbox);
  vm.runInContext(handshakeSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as ImageBatchMod,
    tabsCreate,
    tabsUpdate,
    tabsSendMessage,
    fetchWithTimeout,
    claimExecutorSlot,
    releaseExecutorSlot,
  };
}

function bodyOf(fetchWithTimeout: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const init = fetchWithTimeout.mock.calls[0][1] as { body: string };
  return JSON.parse(init.body);
}

describe("magnific-ext runImageBatch: tab dispatch", () => {
  it("opens the projects /work tab when no Project is cached and dispatches start with the video-level facts", async () => {
    const { mod, tabsCreate, tabsSendMessage } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_1",
      mode: "image-batch",
      prompt: "a senator in the forum",
      model: "nano-banana-2",
      video_title: "The Fall of Rome",
      magnific_project_id: null,
    });
    await new Promise((r) => setTimeout(r, 30));

    expect(tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/app/projects/work"),
      })
    );
    expect(tabsSendMessage).toHaveBeenCalledWith(
      17,
      expect.objectContaining({
        action: "magnificStartImageBatch",
        taskId: "ib_1",
        prompt: "a senator in the forum",
        model: "nano-banana-2",
        videoTitle: "The Fall of Rome",
        magnificProjectId: null,
      })
    );

    mod.notifyImageBatchCompleted(
      "ib_1",
      "https://pikaso.cdnpk.net/media/1/render.png",
      "proj-x"
    );
    await promise;
  });

  it("opens the projects /<uuid> tab when a Project is already cached", async () => {
    const { mod, tabsCreate } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_2",
      mode: "image-batch",
      prompt: "x",
      model: "",
      video_title: "T",
      magnific_project_id: "uuid-9",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(tabsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/app/projects/uuid-9"),
      })
    );
    mod.notifyImageBatchCompleted(
      "ib_2",
      "https://pikaso.cdnpk.net/media/2/render.png",
      null
    );
    await promise;
  });
});

describe("magnific-ext runImageBatch: submit-result POST (terminal outcomes)", () => {
  it("POSTs done with resultUrl + magnific_project_id when the content script created a Project", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_3",
      mode: "image-batch",
      prompt: "x",
      model: "",
      video_title: "T",
      magnific_project_id: null,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(fetchWithTimeout).not.toHaveBeenCalled();

    mod.notifyImageBatchCompleted(
      "ib_3",
      "https://pikaso.cdnpk.net/media/3/render.png",
      "proj-new"
    );
    await promise;

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    expect(fetchWithTimeout.mock.calls[0][0]).toBe(SUBMIT_URL);
    expect(bodyOf(fetchWithTimeout)).toMatchObject({
      id: "ib_3",
      external_task_id: "ib_3",
      status: "done",
      resultUrl: "https://pikaso.cdnpk.net/media/3/render.png",
      magnific_project_id: "proj-new",
    });
  });

  it("POSTs done WITHOUT magnific_project_id when the Project was reused (null)", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_4",
      mode: "image-batch",
      prompt: "x",
      model: "",
      video_title: "T",
      magnific_project_id: "uuid-9",
    });
    await new Promise((r) => setTimeout(r, 30));
    mod.notifyImageBatchCompleted(
      "ib_4",
      "https://pikaso.cdnpk.net/media/4/render.png",
      null
    );
    await promise;

    const body = bodyOf(fetchWithTimeout);
    expect(body).toMatchObject({ status: "done" });
    expect("magnific_project_id" in body).toBe(false);
  });

  it("TERMINAL failure (wrong_project_active) → POSTs submit-result failed with the reason", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_5",
      mode: "image-batch",
      prompt: "x",
      model: "",
      video_title: "T",
      magnific_project_id: "uuid-9",
    });
    await new Promise((r) => setTimeout(r, 30));
    mod.notifyImageBatchFailed("ib_5", "wrong_project_active", false);
    await promise;

    expect(fetchWithTimeout).toHaveBeenCalledTimes(1);
    const body = bodyOf(fetchWithTimeout);
    expect(body).toMatchObject({
      external_task_id: "ib_5",
      status: "failed",
      error: "wrong_project_active",
    });
    expect("magnific_project_id" in body).toBe(false);
  });

  it("project_missing (clearProjectId) → POSTs failed with magnific_project_id:null", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_6",
      mode: "image-batch",
      prompt: "x",
      model: "",
      video_title: "T",
      magnific_project_id: "stale",
    });
    await new Promise((r) => setTimeout(r, 30));
    mod.notifyImageBatchFailed("ib_6", "project_missing", true);
    await promise;

    const body = bodyOf(fetchWithTimeout);
    expect(body).toMatchObject({
      status: "failed",
      error: "project_missing",
      magnific_project_id: null,
    });
  });
});

describe("magnific-ext runImageBatch: transient failures do NOT post (reaper requeues)", () => {
  it("does NOT POST submit-result when the readiness handshake times out (died before concluding)", async () => {
    const tabsSendMessage = vi.fn(async (_id: number, msg: { action: string }) => {
      if (msg.action === "ping") {
        throw new Error(
          "Could not establish connection. Receiving end does not exist."
        );
      }
      return undefined;
    });
    const { mod, fetchWithTimeout } = loadExecutor({
      tabsSendMessage,
      pingIntervalMs: 5,
      pingTimeoutMs: 30,
    });
    await expect(
      mod.runImageBatch({
        id: "ib_7",
        mode: "image-batch",
        prompt: "x",
        model: "",
        video_title: "T",
        magnific_project_id: null,
      })
    ).rejects.toThrow(/content script/i);
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it("ignores notify calls for unknown taskIds (no POST)", async () => {
    const { mod, fetchWithTimeout } = loadExecutor();
    expect(
      mod.notifyImageBatchCompleted("never", "https://pikaso.cdnpk.net/x/1/render.png", null)
    ).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });
});

describe("magnific-ext runImageBatch: slot accounting", () => {
  it("claims on dispatch and releases on a done outcome", async () => {
    const { mod, claimExecutorSlot, releaseExecutorSlot } = loadExecutor();
    const promise = mod.runImageBatch({
      id: "ib_8",
      mode: "image-batch",
      prompt: "x",
      model: "",
      video_title: "T",
      magnific_project_id: "uuid-9",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(claimExecutorSlot).toHaveBeenCalledOnce();
    expect(releaseExecutorSlot).not.toHaveBeenCalled();
    mod.notifyImageBatchCompleted("ib_8", "https://pikaso.cdnpk.net/media/8/render.png", null);
    await promise;
    expect(releaseExecutorSlot).toHaveBeenCalledOnce();
  });

  it("releases the slot even on a transient throw (no POST)", async () => {
    const tabsSendMessage = vi.fn(async (_id: number, msg: { action: string }) => {
      if (msg.action === "ping") throw new Error("Receiving end does not exist.");
      return undefined;
    });
    const { mod, claimExecutorSlot, releaseExecutorSlot } = loadExecutor({
      tabsSendMessage,
      pingIntervalMs: 5,
      pingTimeoutMs: 30,
    });
    await expect(
      mod.runImageBatch({
        id: "ib_9",
        mode: "image-batch",
        prompt: "x",
        model: "",
        video_title: "T",
        magnific_project_id: null,
      })
    ).rejects.toThrow();
    expect(claimExecutorSlot).toHaveBeenCalledOnce();
    expect(releaseExecutorSlot).toHaveBeenCalledOnce();
  });
});
