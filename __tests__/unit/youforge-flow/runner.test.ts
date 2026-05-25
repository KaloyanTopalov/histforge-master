import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Bucket = "image" | "video";

type Runner = {
  startPolling: () => Promise<void>;
  stopPolling: () => Promise<void>;
  pollForTasksFIFO: (bucket: Bucket) => Promise<Record<string, unknown>>;
  pollBothBuckets: () => Promise<{ image: unknown; video: unknown }>;
  handleContentReady: () => Promise<{ hasTask: boolean }>;
  getActiveCount: (bucket: Bucket) => number;
  incrementActiveCount: (bucket: Bucket) => void;
  decrementActiveCount: (bucket: Bucket) => void;
  resetActiveCounts: () => void;
  markVideoSlotFreedForUpscale: () => void;
  pauseGenerationOnly: (reason: string) => void;
  resumeGenerationOnly: (expected: string) => void;
  triggerRateLimitCooldown: (err: { retryAfterMs?: number | null }) => Promise<void>;
};

function loadRunner(opts: {
  stopped?: boolean;
  tabs?: Array<{ id: number }>;
  maxImage?: number;
  maxVideo?: number;
  pollUrl?: string;
  accountToken?: string;
  currentMode?: string;
  taskResponse?: unknown;
  processedJobIds?: string[];
  pingFails?: number;
  pauseReason?: string | null;
  cooldownMinutes?: number;
  launchStaggerMs?: number;
  executeTask?: (...args: any[]) => Promise<unknown>;
} = {}) {
  // cooldown.js owns the rate-limit / soft-pause subsystem extracted out
  // of runner.js (Phase 2 of the SOLID audit plan). Both files share the
  // service-worker global scope at runtime, so the test loads them into
  // the same vm sandbox in production load order (cooldown.js first,
  // because it defines _launchStaggerMs / _taskPollIntervalMinutes which
  // runner.js's dispatch + startPolling paths call as globals).
  const cooldownSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/cooldown.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/runner.js"),
    "utf8",
  );
  const listeners: Array<(alarm: { name: string }) => void> = [];
  const getStopFlag = vi.fn(() => opts.stopped ?? false);
  const clearStopFlag = vi.fn();
  const startCreditsPolling = vi.fn();
  const stopCreditsPolling = vi.fn();
  const handleTaskCompletedFIFO = vi.fn(async () => {});
  const handleTaskFailedFIFO = vi.fn(async () => {});
  const postStatusEvent = vi.fn(async (_payload?: unknown) => true);
  const executeTaskWithSessionGuard = vi.fn(
    opts.executeTask ?? (async (..._args: any[]) => ({ taskId: "t1", resultUrl: "u", mode: "text" })),
  );
  const alarmCreate = vi.fn();
  const alarmClear = vi.fn();
  let pingCalls = 0;
  const sendMessage = vi.fn(async (_id: number, msg: { action: string }) => {
    if (msg.action === "ping") {
      pingCalls += 1;
      if (opts.pingFails && pingCalls <= opts.pingFails) {
        throw new Error("no bridge");
      }
    }
  });
  const storageGet = vi.fn(async () => ({
    processedJobIds: opts.processedJobIds ?? [],
  }));
  const storageSet = vi.fn(async (_payload?: Record<string, unknown>) => {});
  const firstResponseText =
    opts.taskResponse !== undefined
      ? JSON.stringify(opts.taskResponse)
      : JSON.stringify({ id: "task-1", mode: "text", prompt: "hello" });
  let fetchCalls = 0;
  // First poll returns the configured task; subsequent polls return {} so
  // the fire-and-forget re-poll chain terminates after one iteration.
  const fetchFn = vi.fn(async (_url?: any, _init?: any) => {
    fetchCalls += 1;
    const body = fetchCalls === 1 ? firstResponseText : JSON.stringify({});
    return { ok: true, text: async () => body } as unknown as Response;
  });
  let _pauseReason = opts.pauseReason ?? null;
  const getPauseReason = vi.fn(() => _pauseReason);
  const setPauseReason = vi.fn((r: string) => { _pauseReason = r; });
  const clearPauseReason = vi.fn(() => { _pauseReason = null; });
  const setCooldownUntil = vi.fn();
  const getRateLimitCooldownMinutes = vi.fn(() => opts.cooldownMinutes ?? 10);
  const getLaunchStaggerMs = vi.fn(() => opts.launchStaggerMs ?? 500);
  const setTimeoutSpy = vi.fn(
    (fn: () => void, _ms?: number) => { fn(); return 0; },
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    getStopFlag,
    clearStopFlag,
    startCreditsPolling,
    stopCreditsPolling,
    handleTaskCompletedFIFO,
    handleTaskFailedFIFO,
    executeTaskWithSessionGuard,
    postStatusEvent,
    setIsEnabled: vi.fn(async (v: boolean) => storageSet({ isEnabled: v })),
    setLastPoll: vi.fn(async (v: string) => storageSet({ lastPoll: v })),
    getProcessedJobIds: vi.fn(() => opts.processedJobIds ?? []),
    getPollUrl: () => opts.pollUrl ?? "https://histforge.example/poll",
    getAccountToken: () => opts.accountToken ?? "acct-token",
    getCurrentMode: () => opts.currentMode ?? "image",
    getMaxConcurrent: (bucket: Bucket) =>
      bucket === "image" ? (opts.maxImage ?? 4) : (opts.maxVideo ?? 4),
    // EXECUTORS table snapshot — runner.js's post-fetch bucket assertion
    // + dispatchTask bucket capture both read it. Mirrors the production
    // executors/index.js shape (only the isImageGen flag matters here).
    EXECUTORS: {
      createimage: { isImageGen: true },
      imagegen: { isImageGen: true },
      text: {},
      image: {},
      ingredients: {},
      frames: {},
    },
    getPauseReason,
    setPauseReason,
    clearPauseReason,
    setCooldownUntil,
    getRateLimitCooldownMinutes,
    getLaunchStaggerMs,
    getTaskPollIntervalSec: () => 10,
    resetConsecutiveFailures: vi.fn(),
    // src/auth-probe.js forward-ref — runner.js's start/stopPolling both
    // call it to tear down a session-expired probe that may still be armed.
    clearAuthProbe: vi.fn(),
    POLL_INTERVAL_MINUTES: 0.1667,
    chrome: {
      alarms: {
        create: alarmCreate,
        clear: alarmClear,
        onAlarm: {
          addListener: (fn: (alarm: { name: string }) => void) => listeners.push(fn),
        },
      },
      tabs: {
        query: vi.fn(async () => opts.tabs ?? [{ id: 1 }]),
        sendMessage,
        reload: vi.fn(async () => {}),
      },
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    },
    fetch: fetchFn,
    fetchWithTimeout: (url: string, init: RequestInit) => fetchFn(url, init),
    setTimeout: setTimeoutSpy,
    Date,
    JSON,
    Promise,
    Math,
    crypto: globalThis.crypto,
  };
  vm.createContext(sandbox);
  vm.runInContext(cooldownSrc, sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as Runner,
    listeners,
    getStopFlag,
    clearStopFlag,
    startCreditsPolling,
    stopCreditsPolling,
    handleTaskCompletedFIFO,
    handleTaskFailedFIFO,
    executeTaskWithSessionGuard,
    postStatusEvent,
    alarmCreate,
    alarmClear,
    sendMessage,
    storageSet,
    storageGet,
    fetchFn,
    getPauseReason,
    setPauseReason,
    clearPauseReason,
    setCooldownUntil,
    getLaunchStaggerMs,
    setTimeoutSpy,
  };
}

describe("runner", () => {
  describe("accessors", () => {
    it("getActiveCount starts at 0 per bucket; decrement clamps at 0", () => {
      const ctx = loadRunner();
      expect(ctx.mod.getActiveCount("image")).toBe(0);
      expect(ctx.mod.getActiveCount("video")).toBe(0);
      ctx.mod.decrementActiveCount("image");
      ctx.mod.decrementActiveCount("video");
      expect(ctx.mod.getActiveCount("image")).toBe(0);
      expect(ctx.mod.getActiveCount("video")).toBe(0);
    });

    it("increment/decrement are per-bucket independent", () => {
      const ctx = loadRunner();
      ctx.mod.incrementActiveCount("image");
      ctx.mod.incrementActiveCount("image");
      ctx.mod.incrementActiveCount("video");
      expect(ctx.mod.getActiveCount("image")).toBe(2);
      expect(ctx.mod.getActiveCount("video")).toBe(1);
      ctx.mod.decrementActiveCount("image");
      expect(ctx.mod.getActiveCount("image")).toBe(1);
      expect(ctx.mod.getActiveCount("video")).toBe(1);
    });
  });

  describe("handleContentReady", () => {
    it("returns {hasTask: false} — trimmed per Task 1.3", async () => {
      const ctx = loadRunner();
      expect(await ctx.mod.handleContentReady()).toEqual({ hasTask: false });
    });
  });

  describe("startPolling / stopPolling", () => {
    it("startPolling sets isEnabled, clears stop flag, creates alarm, starts credits", async () => {
      const ctx = loadRunner({ tabs: [] });
      await ctx.mod.startPolling();
      expect(ctx.storageSet).toHaveBeenCalledWith({ isEnabled: true });
      expect(ctx.clearStopFlag).toHaveBeenCalled();
      expect(ctx.alarmCreate).toHaveBeenCalledWith(
        "pollTasks",
        expect.objectContaining({
          delayInMinutes: 10 / 60,
          periodInMinutes: 10 / 60,
        }),
      );
      expect(ctx.startCreditsPolling).toHaveBeenCalled();
    });

    it("stopPolling unsets isEnabled, clears alarm, stops credits", async () => {
      const ctx = loadRunner();
      await ctx.mod.stopPolling();
      expect(ctx.storageSet).toHaveBeenCalledWith({ isEnabled: false });
      expect(ctx.alarmClear).toHaveBeenCalledWith("pollTasks");
      expect(ctx.stopCreditsPolling).toHaveBeenCalled();
    });
  });

  describe("pollForTasksFIFO", () => {
    it("returns {stopped: true} when the stop flag is set", async () => {
      const ctx = loadRunner({ stopped: true });
      const out = await ctx.mod.pollForTasksFIFO("video");
      expect(out).toEqual({ stopped: true });
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("returns error when no Flow tab is open", async () => {
      const ctx = loadRunner({ tabs: [] });
      const out = await ctx.mod.pollForTasksFIFO("video");
      expect(out).toEqual({ error: "No Flow tab" });
    });

    it("returns noTasks when webhook responds with an invalid task", async () => {
      const ctx = loadRunner({ taskResponse: {} });
      const out = await ctx.mod.pollForTasksFIFO("video");
      expect(out).toEqual({ noTasks: true });
    });

    it("returns {skipped, already_processed} for a duplicate task id", async () => {
      const ctx = loadRunner({
        processedJobIds: ["task-1"],
      });
      const out = await ctx.mod.pollForTasksFIFO("video");
      expect(out).toEqual({ skipped: true, reason: "already_processed" });
    });

    it("launches executeTaskWithSessionGuard and increments the counter on a valid task", async () => {
      const ctx = loadRunner();
      const out = await ctx.mod.pollForTasksFIFO("video");
      expect(out).toMatchObject({ success: true });
      expect(ctx.executeTaskWithSessionGuard).toHaveBeenCalledTimes(1);
    });

    it("mints a correlationId and forwards it to executeTaskWithSessionGuard", async () => {
      const ctx = loadRunner();
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      const args = ctx.executeTaskWithSessionGuard.mock.calls[0]!;
      expect(args[2]).toMatch(/^[0-9a-f-]{36}$/);
    });

    it("calls handleTaskCompletedFIFO after a successful task", async () => {
      const ctx = loadRunner();
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      expect(ctx.handleTaskCompletedFIFO).toHaveBeenCalled();
    });

    it("calls handleTaskFailedFIFO with the Error object on a non-STOP error", async () => {
      const thrown = Object.assign(new Error("network down"), {
        reason: "HTTP_500",
        category: "transient",
        httpStatus: 500,
        retryable: true,
      });
      const ctx = loadRunner({
        executeTask: async () => {
          throw thrown;
        },
      });
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      expect(ctx.handleTaskFailedFIFO).toHaveBeenCalledWith(
        expect.objectContaining({
          task: expect.objectContaining({ id: "task-1" }),
          error: thrown,
        }),
      );
    });

    it("does NOT call handleTaskFailedFIFO when the executor throws STOP_REQUESTED", async () => {
      const ctx = loadRunner({
        executeTask: async () => {
          throw new Error("STOP_REQUESTED");
        },
      });
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      expect(ctx.handleTaskFailedFIFO).not.toHaveBeenCalled();
    });

    it("emits a bridge_reload status event when ping fails 3 times", async () => {
      const ctx = loadRunner({ pingFails: 3 });
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "StatusEvent",
          event: "bridge_reload",
          attempts: 3,
          lastError: expect.stringContaining("no bridge"),
        }),
      );
    });

    it("does NOT emit bridge_reload when the bridge is healthy", async () => {
      const ctx = loadRunner();
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      const calls = ctx.postStatusEvent.mock.calls.filter(
        ([arg]) => (arg as { event: string })?.event === "bridge_reload",
      );
      expect(calls).toHaveLength(0);
    });

    it("ignores pollTasks alarm when both buckets at capacity", async () => {
      const ctx = loadRunner({ maxImage: 0, maxVideo: 0 });
      // Two listeners exist after the Phase 2 cool-off extraction
      // (cooldown.js's rateLimitCooldown handler at index 0, runner.js's
      // pollTasks handler at index 1). Chrome dispatches each alarm to
      // every listener; mirror that here so the runner.js at-capacity
      // branch is the one that actually runs.
      for (const fn of ctx.listeners) fn({ name: "pollTasks" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("alarm with asymmetric fullness skips the full bucket, polls the idle one", async () => {
      // Image bucket already at capacity (1/1); video bucket idle (0/1).
      // Alarm should skip image and only poll video. Every wire fetch
      // the test sees should carry wantBucket='video' — no image fetch
      // ever occurs. Multiple fetches may happen because the dispatch
      // completion chain re-polls (same bucket), so the assertion is on
      // *which* bucket(s) the wire sees, not the count.
      const ctx = loadRunner({
        maxImage: 1,
        maxVideo: 1,
        taskResponse: { id: "task-1", mode: "text", prompt: "hello" },
      });
      ctx.mod.incrementActiveCount("image");
      expect(ctx.mod.getActiveCount("image")).toBe(1);
      for (const fn of ctx.listeners) fn({ name: "pollTasks" });
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const fetchBuckets = ctx.fetchFn.mock.calls.map((call) => {
        const body = JSON.parse((call[1] as { body: string }).body);
        return body.wantBucket;
      });
      expect(fetchBuckets.length).toBeGreaterThanOrEqual(1);
      expect(fetchBuckets).toContain("video");
      expect(fetchBuckets).not.toContain("image");
    });
  });

  describe("pauseGenerationOnly / resumeGenerationOnly (Task 3.2)", () => {
    it("pauseGenerationOnly clears the pollTasks alarm and sets pauseReason", () => {
      const ctx = loadRunner();
      ctx.mod.pauseGenerationOnly("rate_limited");
      expect(ctx.alarmClear).toHaveBeenCalledWith("pollTasks");
      expect(ctx.setPauseReason).toHaveBeenCalledWith("rate_limited");
    });

    it("pauseGenerationOnly is a no-op when already paused (first pauser wins)", () => {
      const ctx = loadRunner({ pauseReason: "credits_exhausted" });
      ctx.mod.pauseGenerationOnly("rate_limited");
      expect(ctx.setPauseReason).not.toHaveBeenCalled();
      expect(ctx.alarmClear).not.toHaveBeenCalled();
    });

    it("resumeGenerationOnly re-creates the pollTasks alarm and clears pauseReason when reasons match", () => {
      const ctx = loadRunner({ pauseReason: "rate_limited" });
      ctx.mod.resumeGenerationOnly("rate_limited");
      expect(ctx.alarmCreate).toHaveBeenCalledWith(
        "pollTasks",
        expect.objectContaining({ periodInMinutes: 10 / 60 }),
      );
      expect(ctx.clearPauseReason).toHaveBeenCalled();
    });

    it("resumeGenerationOnly is a no-op when reasons differ (cross-pauser guard)", () => {
      const ctx = loadRunner({ pauseReason: "credits_exhausted" });
      ctx.mod.resumeGenerationOnly("rate_limited");
      expect(ctx.alarmCreate).not.toHaveBeenCalled();
      expect(ctx.clearPauseReason).not.toHaveBeenCalled();
    });

    it("resumeGenerationOnly is a no-op when stop flag is set (hard stop wins)", () => {
      const ctx = loadRunner({ pauseReason: "rate_limited", stopped: true });
      ctx.mod.resumeGenerationOnly("rate_limited");
      expect(ctx.alarmCreate).not.toHaveBeenCalled();
      expect(ctx.clearPauseReason).not.toHaveBeenCalled();
    });
  });

  describe("triggerRateLimitCooldown (Task 3.2)", () => {
    it("pauses generation, sets cooldownUntil, emits rate_limited event, schedules cooldown alarm", async () => {
      const ctx = loadRunner();
      const before = Date.now();
      await ctx.mod.triggerRateLimitCooldown({ retryAfterMs: 30_000 });
      expect(ctx.setPauseReason).toHaveBeenCalledWith("rate_limited");
      expect(ctx.alarmClear).toHaveBeenCalledWith("pollTasks");
      expect(ctx.setCooldownUntil).toHaveBeenCalled();
      const cooldownArg = ctx.setCooldownUntil.mock.calls[0]![0] as number;
      expect(cooldownArg).toBeGreaterThanOrEqual(before + 30_000);
      expect(ctx.alarmCreate).toHaveBeenCalledWith(
        "rateLimitCooldown",
        expect.objectContaining({ delayInMinutes: expect.any(Number) }),
      );
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "StatusEvent",
          event: "rate_limited",
          retryAfterMs: 30_000,
        }),
      );
    });

    it("uses configured default when retryAfterMs is null", async () => {
      const ctx = loadRunner({ cooldownMinutes: 7 });
      await ctx.mod.triggerRateLimitCooldown({ retryAfterMs: null });
      const cooldownArg = ctx.setCooldownUntil.mock.calls[0]![0] as number;
      // 7 minutes = 420000 ms
      expect(cooldownArg).toBeGreaterThanOrEqual(Date.now() + 419_000);
      expect(cooldownArg).toBeLessThanOrEqual(Date.now() + 421_000);
    });

    it("is idempotent — second call while paused does not double-schedule", async () => {
      const ctx = loadRunner();
      await ctx.mod.triggerRateLimitCooldown({ retryAfterMs: 30_000 });
      // Simulate state mutation from first call
      ctx.alarmCreate.mockClear();
      ctx.setCooldownUntil.mockClear();
      ctx.postStatusEvent.mockClear();
      ctx.setPauseReason.mockClear();
      // Now pauseReason returns 'rate_limited' (set by first call)
      const ctx2 = loadRunner({ pauseReason: "rate_limited" });
      await ctx2.mod.triggerRateLimitCooldown({ retryAfterMs: 30_000 });
      expect(ctx2.setPauseReason).not.toHaveBeenCalled();
      expect(ctx2.alarmCreate).not.toHaveBeenCalledWith(
        "rateLimitCooldown",
        expect.anything(),
      );
    });
  });

  describe("rateLimitCooldown alarm handler (Task 3.2)", () => {
    it("calls resumeGenerationOnly('rate_limited') when alarm fires", async () => {
      const ctx = loadRunner({ pauseReason: "rate_limited" });
      // Dispatch to every listener (Chrome semantics) so the test does
      // not depend on which file registered first. cooldown.js's listener
      // handles rateLimitCooldown; runner.js's listener returns early.
      for (const fn of ctx.listeners) fn({ name: "rateLimitCooldown" });
      await new Promise((r) => setImmediate(r));
      expect(ctx.alarmCreate).toHaveBeenCalledWith(
        "pollTasks",
        expect.any(Object),
      );
      expect(ctx.clearPauseReason).toHaveBeenCalled();
    });
  });

  describe("stopPolling clears cooldown alarm (Task 3.2)", () => {
    it("stopPolling also clears the rateLimitCooldown alarm", async () => {
      const ctx = loadRunner();
      await ctx.mod.stopPolling();
      expect(ctx.alarmClear).toHaveBeenCalledWith("pollTasks");
      expect(ctx.alarmClear).toHaveBeenCalledWith("rateLimitCooldown");
    });
  });

  describe("pollForTasksFIFO respects pauseReason (Task 3.2)", () => {
    it("returns {paused, reason} when pauseReason is set", async () => {
      const ctx = loadRunner({ pauseReason: "rate_limited" });
      const out = await ctx.mod.pollForTasksFIFO("video");
      expect(out).toEqual({ paused: true, reason: "rate_limited" });
      expect(ctx.fetchFn).not.toHaveBeenCalled();
    });

    it("dispatchTask completion-chain refill is gated by pauseReason (Phase 3 fix #3)", async () => {
      // First poll succeeds and dispatches; the executor sets pauseReason
      // mid-flight (mimics a rate_limit thrown from a sibling task that
      // armed the cooldown). When the .then settles and calls
      // pollForTasksFIFO, the gate must short-circuit.
      let pauseReasonRef: string | null = null;
      const ctx = loadRunner({
        executeTask: async () => {
          pauseReasonRef = "rate_limited";
          return { taskId: "t1", resultUrl: "u", mode: "text" };
        },
      });
      // Patch getPauseReason to read the closure ref
      ctx.getPauseReason.mockImplementation(() => pauseReasonRef);
      ctx.fetchFn.mockClear();
      await ctx.mod.pollForTasksFIFO("video");
      // Settle the .then chain
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      // Initial fetch happened once; the chained refill should NOT have
      // re-fetched because pauseReason flipped during the first task.
      expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("launch-gate stagger (Task 3.4)", () => {
    it("markVideoSlotFreedForUpscale defers re-poll by launchStaggerMs (default 500)", () => {
      const ctx = loadRunner();
      ctx.mod.markVideoSlotFreedForUpscale();
      const stagger = ctx.setTimeoutSpy.mock.calls.find(
        (call) => call[1] === 500,
      );
      expect(stagger).toBeDefined();
    });

    it("markVideoSlotFreedForUpscale honors a configured launchStaggerMs", () => {
      const ctx = loadRunner({ launchStaggerMs: 750 });
      ctx.mod.markVideoSlotFreedForUpscale();
      const stagger = ctx.setTimeoutSpy.mock.calls.find(
        (call) => call[1] === 750,
      );
      expect(stagger).toBeDefined();
    });

    it("dispatchTask success path defers refill by launchStaggerMs", async () => {
      const ctx = loadRunner({ launchStaggerMs: 500 });
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      // Settle the .then chain
      await new Promise((r) => setImmediate(r));
      // Look for any setTimeout call with delay 500 — the refill stagger
      const refill = ctx.setTimeoutSpy.mock.calls.find(
        (call) => call[1] === 500,
      );
      expect(refill).toBeDefined();
    });

    it("dispatchTask failure path defers refill by launchStaggerMs", async () => {
      const thrown = Object.assign(new Error("boom"), {
        category: "transient",
      });
      const ctx = loadRunner({
        launchStaggerMs: 600,
        executeTask: async () => {
          throw thrown;
        },
      });
      await ctx.mod.pollForTasksFIFO("video");
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      const refill = ctx.setTimeoutSpy.mock.calls.find(
        (call) => call[1] === 600,
      );
      expect(refill).toBeDefined();
    });

    it("startPolling fillInitialSlots uses launchStaggerMs between fills", async () => {
      const ctx = loadRunner({ launchStaggerMs: 800, maxImage: 2, maxVideo: 2 });
      await ctx.mod.startPolling();
      await new Promise((r) => setImmediate(r));
      // Look for the inter-fill sleep (a Promise-wrapped setTimeout with 800ms delay)
      const fillStagger = ctx.setTimeoutSpy.mock.calls.find(
        (call) => call[1] === 800,
      );
      expect(fillStagger).toBeDefined();
    });
  });
});
