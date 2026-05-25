import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Runner = {
  startPolling: () => Promise<void>;
  stopPolling: () => Promise<void>;
  pollForTasks: () => Promise<Record<string, unknown>>;
  hasActiveExecutor: () => boolean;
  claimExecutorSlot: () => void;
  releaseExecutorSlot: () => void;
};

function loadRunner(opts: {
  stopped?: boolean;
  nextTaskUrl?: string;
  magnificToken?: string;
  pollIntervalSec?: number;
  taskResponse?: unknown;
  pauseReason?: string | null;
  fetchImpl?: typeof fetch;
  executeTaskViaExtension?: (task: unknown) => Promise<unknown>;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/runner.js"),
    "utf8",
  );
  const alarmListeners: Array<(alarm: { name: string }) => void> = [];
  const alarmCreate = vi.fn();
  const alarmClear = vi.fn();
  const setIsEnabled = vi.fn(async (_v: boolean) => {});
  const setLastPoll = vi.fn(async (_v: string) => {});
  const clearStopFlag = vi.fn();
  const setStopFlag = vi.fn();
  const getStopFlag = vi.fn(() => opts.stopped ?? false);
  const getPauseReason = vi.fn(() => opts.pauseReason ?? null);
  const clearPauseReason = vi.fn();
  const resetConsecutiveFailures = vi.fn();
  const bumpConsecutiveFailures = vi.fn(() => 1);

  const defaultResponse =
    opts.taskResponse !== undefined ? opts.taskResponse : {};
  const fetchSpy = vi.fn(
    opts.fetchImpl ??
      (async () =>
        ({
          ok: true,
          text: async () => JSON.stringify(defaultResponse),
        } as unknown as Response)),
  );

  const fetchWithTimeout = vi.fn(async (url: string, init: RequestInit, _ms: number) => {
    return fetchSpy(url, init);
  });

  const executeTaskViaExtension =
    opts.executeTaskViaExtension ?? vi.fn(async () => ({ dispatched: true }));

  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      alarms: {
        create: alarmCreate,
        clear: alarmClear,
        onAlarm: { addListener: (fn: (a: { name: string }) => void) => alarmListeners.push(fn) },
      },
    },
    fetchWithTimeout,
    fetch: fetchSpy,
    setIsEnabled,
    setLastPoll,
    clearStopFlag,
    setStopFlag,
    getStopFlag,
    getPauseReason,
    clearPauseReason,
    resetConsecutiveFailures,
    bumpConsecutiveFailures,
    getNextTaskUrl: () =>
      opts.nextTaskUrl ?? "https://histforge.example/api/magnific/next-task/T",
    getMagnificToken: () => opts.magnificToken ?? "T",
    getPollIntervalSec: () => opts.pollIntervalSec ?? 10,
    executeTaskViaExtension,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    r: sandbox as unknown as Runner,
    alarmCreate,
    alarmClear,
    setIsEnabled,
    fetchSpy,
    fetchWithTimeout,
    clearStopFlag,
    alarmListeners,
    executeTaskViaExtension,
  };
}

describe("magnific-ext startPolling", () => {
  it("arms the pollTasks alarm using pollIntervalSec and sets isEnabled=true", async () => {
    const { r, alarmCreate, setIsEnabled, clearStopFlag } = loadRunner({
      pollIntervalSec: 15,
    });
    await r.startPolling();
    expect(setIsEnabled).toHaveBeenCalledWith(true);
    expect(clearStopFlag).toHaveBeenCalled();
    expect(alarmCreate).toHaveBeenCalledWith(
      "pollTasks",
      expect.objectContaining({
        delayInMinutes: expect.any(Number),
        periodInMinutes: expect.any(Number),
      }),
    );
    const call = alarmCreate.mock.calls[0]?.[1] as {
      periodInMinutes: number;
    };
    // 15 seconds → 0.25 minutes
    expect(call.periodInMinutes).toBeCloseTo(15 / 60, 5);
  });
});

describe("magnific-ext stopPolling", () => {
  it("clears the pollTasks alarm and sets isEnabled=false", async () => {
    const { r, alarmClear, setIsEnabled } = loadRunner();
    await r.stopPolling();
    expect(alarmClear).toHaveBeenCalledWith("pollTasks");
    expect(setIsEnabled).toHaveBeenCalledWith(false);
  });
});

describe("magnific-ext pollForTasks", () => {
  it("returns {noConfig:true} when nextTaskUrl is empty", async () => {
    const { r } = loadRunner({ nextTaskUrl: "" });
    const result = await r.pollForTasks();
    expect(result).toEqual(expect.objectContaining({ noConfig: true }));
  });

  it("returns {stopped:true} when stop flag is set", async () => {
    const { r } = loadRunner({ stopped: true });
    const result = await r.pollForTasks();
    expect(result).toEqual(expect.objectContaining({ stopped: true }));
  });

  it("returns {paused:true} when pauseReason is set", async () => {
    const { r } = loadRunner({ pauseReason: "session_expired" });
    const result = await r.pollForTasks();
    expect(result).toEqual(
      expect.objectContaining({ paused: true, reason: "session_expired" }),
    );
  });

  it("POSTs to nextTaskUrl with empty body, returns {noTasks:true} when response is {}", async () => {
    const { r, fetchSpy } = loadRunner({
      nextTaskUrl: "https://histforge.example/api/magnific/next-task/T",
      taskResponse: {},
    });
    const result = await r.pollForTasks();
    expect(fetchSpy).toHaveBeenCalledWith(
      "https://histforge.example/api/magnific/next-task/T",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
      }),
    );
    expect(result).toEqual(expect.objectContaining({ noTasks: true }));
  });

  it("dispatches a shaped task through executeTaskViaExtension (Phase 2.3+)", async () => {
    const task = {
      id: "magnific_42_1700000000",
      mode: "image-hitl",
      prompt: "alpine peak at dawn",
      output_path: "loop_image.png",
    };
    const executeTaskViaExtension = vi.fn(async () => ({ dispatched: true }));
    const { r } = loadRunner({ taskResponse: task, executeTaskViaExtension });
    const result = await r.pollForTasks();
    // The dispatch is fire-and-forget — yield once so the executor call lands.
    await new Promise((res) => setTimeout(res, 0));
    expect(executeTaskViaExtension).toHaveBeenCalledWith(task);
    expect(result).toEqual(expect.objectContaining({ received: true, task }));
  });

  it("treats empty/malformed response body as no tasks", async () => {
    const { r } = loadRunner({
      fetchImpl: vi.fn(async () =>
        ({ ok: true, text: async () => "" } as unknown as Response),
      ) as unknown as typeof fetch,
    });
    const result = await r.pollForTasks();
    expect(result).toEqual(expect.objectContaining({ noTasks: true }));
  });
});

describe("magnific-ext executor slot gate", () => {
  it("hasActiveExecutor() starts false and reflects claim/release", () => {
    const { r } = loadRunner();
    expect(r.hasActiveExecutor()).toBe(false);
    r.claimExecutorSlot();
    expect(r.hasActiveExecutor()).toBe(true);
    r.releaseExecutorSlot();
    expect(r.hasActiveExecutor()).toBe(false);
  });

  it("release clamps at 0 (defensive — never goes negative)", () => {
    const { r } = loadRunner();
    r.releaseExecutorSlot();
    r.releaseExecutorSlot();
    expect(r.hasActiveExecutor()).toBe(false);
  });

  it("skips polling while any executor task is in flight (image-hitl)", async () => {
    const task = {
      id: "in_flight",
      mode: "image-hitl",
      prompt: "x",
      output_path: "loop_image.png",
    };
    const { r, fetchSpy } = loadRunner({ taskResponse: task });
    r.claimExecutorSlot();
    const result = await r.pollForTasks();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ skipped: true, reason: expect.stringMatching(/in.?flight/i) }),
    );
  });

  it("skips polling while any executor task is in flight (image-to-video)", async () => {
    const task = {
      id: "in_flight_i2v",
      mode: "image-to-video",
      prompt: "x",
      output_path: "loop_clip.mp4",
    };
    const { r, fetchSpy } = loadRunner({ taskResponse: task });
    r.claimExecutorSlot();
    const result = await r.pollForTasks();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual(
      expect.objectContaining({ skipped: true, reason: expect.stringMatching(/in.?flight/i) }),
    );
  });
});

describe("magnific-ext pollTasks alarm listener", () => {
  it("invokes pollForTasks when the pollTasks alarm fires", async () => {
    const { alarmListeners, fetchSpy } = loadRunner();
    expect(alarmListeners.length).toBeGreaterThan(0);
    // Fire the listener manually
    await alarmListeners[0]({ name: "pollTasks" });
    // Wait a tick for any deferred work
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("ignores other alarm names", async () => {
    const { alarmListeners, fetchSpy } = loadRunner();
    await alarmListeners[0]({ name: "someOtherAlarm" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
