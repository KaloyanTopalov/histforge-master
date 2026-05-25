import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Handlers = {
  markJobAsCompleted: (jobId: string) => Promise<void>;
  handleTaskCompletedFIFO: (data: {
    taskId: string;
    resultUrl?: string;
    mode?: string;
    correlationId?: string;
    timings?: Record<string, unknown>;
  }) => Promise<void>;
  handleTaskFailedFIFO: (data: {
    task?: { id?: string; mode?: string };
    error?: string | Error;
  }) => Promise<void>;
};

function loadHandlers(opts: {
  processedJobIds?: string[];
  stats?: { processed?: number; failed?: number };
  stopped?: boolean;
  mediaFiles?: unknown[];
  submitResultReturn?: boolean;
  submitResultThrows?: Error;
  consecutiveFailuresStart?: number;
  circuitBreakerThreshold?: number;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/handlers.js"),
    "utf8",
  );
  const store: Record<string, unknown> = {
    processedJobIds: opts.processedJobIds ?? [],
    stats: opts.stats ?? { processed: 0, failed: 0 },
  };
  const storageGet = vi.fn(async (key: string | string[]) => {
    if (typeof key === "string") {
      return { [key]: store[key] };
    }
    const out: Record<string, unknown> = {};
    for (const k of key) out[k] = store[k];
    return out;
  });
  const storageSet = vi.fn(async (update: Record<string, unknown>) => {
    Object.assign(store, update);
  });
  const fetchMediaFiles = vi.fn(async () => opts.mediaFiles ?? []);
  const submitResult = vi.fn(async (_payload: unknown) => {
    if (opts.submitResultThrows) throw opts.submitResultThrows;
    return opts.submitResultReturn ?? true;
  });
  const submitFailure = vi.fn(async () => {});
  const getStopFlag = vi.fn(() => opts.stopped ?? false);
  const addProcessedJobId = vi.fn(async (jobId: string) => {
    const list = ((store.processedJobIds as string[]) || []).slice();
    list.push(jobId);
    while (list.length > 500) list.shift();
    store.processedJobIds = list;
    store.currentJobId = null;
    return list.length;
  });
  const bumpStat = vi.fn(async (key: string) => {
    const stats = (store.stats as Record<string, number>) || {};
    stats[key] = (stats[key] || 0) + 1;
    store.stats = stats;
  });
  // Circuit-breaker primitives — backed by a closure-local counter so the
  // test sandbox mirrors state.js semantics without loading state.js too.
  let consecutive = opts.consecutiveFailuresStart ?? 0;
  const getConsecutiveFailures = vi.fn(() => consecutive);
  const bumpConsecutiveFailures = vi.fn(() => {
    consecutive += 1;
    return consecutive;
  });
  const resetConsecutiveFailures = vi.fn(() => { consecutive = 0; });
  const setStopFlag = vi.fn();
  const stopPolling = vi.fn(async () => {});
  const postStatusEvent = vi.fn(async () => true);
  const getCircuitBreakerThreshold = vi.fn(
    () => opts.circuitBreakerThreshold ?? 5,
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    fetchMediaFiles,
    submitResult,
    submitFailure,
    getStopFlag,
    addProcessedJobId,
    bumpStat,
    getConsecutiveFailures,
    bumpConsecutiveFailures,
    resetConsecutiveFailures,
    setStopFlag,
    stopPolling,
    postStatusEvent,
    getCircuitBreakerThreshold,
    chrome: {
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as Handlers,
    store,
    storageGet,
    storageSet,
    fetchMediaFiles,
    submitResult,
    submitFailure,
    getConsecutiveFailures,
    bumpConsecutiveFailures,
    resetConsecutiveFailures,
    setStopFlag,
    stopPolling,
    postStatusEvent,
  };
}

describe("handlers", () => {
  describe("markJobAsCompleted", () => {
    it("appends to processedJobIds and clears currentJobId", async () => {
      const ctx = loadHandlers({ processedJobIds: ["a", "b"] });
      await ctx.mod.markJobAsCompleted("c");
      expect(ctx.store.processedJobIds).toEqual(["a", "b", "c"]);
      expect(ctx.store.currentJobId).toBe(null);
    });

    it("caps processedJobIds at 500 entries (FIFO)", async () => {
      const initial = Array.from({ length: 500 }, (_, i) => `id-${i}`);
      const ctx = loadHandlers({ processedJobIds: initial });
      await ctx.mod.markJobAsCompleted("new-id");
      expect((ctx.store.processedJobIds as string[]).length).toBe(500);
      expect((ctx.store.processedJobIds as string[])[0]).toBe("id-1"); // oldest evicted
      expect((ctx.store.processedJobIds as string[])[499]).toBe("new-id");
    });
  });

  describe("handleTaskCompletedFIFO", () => {
    it("fetches media, submits result, marks complete, increments stats on success", async () => {
      const ctx = loadHandlers({ mediaFiles: [{ base64: "x" }] });
      await ctx.mod.handleTaskCompletedFIFO({
        taskId: "t1",
        resultUrl: "u",
        mode: "text",
      });
      expect(ctx.fetchMediaFiles).toHaveBeenCalledWith("u");
      expect(ctx.submitResult).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "t1", resultUrl: "u", mode: "text" }),
        [{ base64: "x" }],
      );
      expect((ctx.store.processedJobIds as string[]).includes("t1")).toBe(true);
      expect((ctx.store.stats as { processed: number }).processed).toBe(1);
    });

    it("skips result submission when stop flag is set mid-flow", async () => {
      const ctx = loadHandlers({ stopped: true });
      await ctx.mod.handleTaskCompletedFIFO({ taskId: "t1", resultUrl: "u" });
      expect(ctx.submitResult).not.toHaveBeenCalled();
      expect((ctx.store.processedJobIds as string[]).includes("t1")).toBe(false);
    });

    it("does NOT mark complete when the webhook fails", async () => {
      const ctx = loadHandlers({ submitResultReturn: false });
      await ctx.mod.handleTaskCompletedFIFO({ taskId: "t1", resultUrl: "u" });
      expect((ctx.store.processedJobIds as string[]).includes("t1")).toBe(false);
      expect((ctx.store.stats as { processed: number }).processed).toBe(0);
    });

    it("does NOT mark complete when submitResult throws", async () => {
      const ctx = loadHandlers({
        submitResultThrows: new Error("network flake"),
      });
      await ctx.mod.handleTaskCompletedFIFO({ taskId: "t1", resultUrl: "u" });
      expect((ctx.store.processedJobIds as string[]).includes("t1")).toBe(false);
    });

    it("forwards correlationId and merges fetchMediaMs into timings", async () => {
      const SENTINEL = -1;
      const ctx = loadHandlers({ mediaFiles: [{ base64: "x" }] });
      await ctx.mod.handleTaskCompletedFIFO({
        taskId: "t1",
        resultUrl: "u",
        correlationId: "abcdef12-cid",
        timings: {
          submitMs: 100,
          uploadMs: [],
          pollCount: 5,
          pollMs: 800,
          upscaleMs: 0,
          fetchMediaMs: SENTINEL,
        },
      });
      const passed = (ctx.submitResult.mock.calls[0]![0]) as {
        correlationId: string;
        timings: { submitMs: number; pollCount: number; fetchMediaMs: number };
      };
      expect(passed.correlationId).toBe("abcdef12-cid");
      expect(passed.timings.submitMs).toBe(100);
      expect(passed.timings.pollCount).toBe(5);
      // fetchMediaMs must be overwritten by handlers (sentinel discarded)
      expect(passed.timings.fetchMediaMs).not.toBe(SENTINEL);
      expect(passed.timings.fetchMediaMs).toBeGreaterThanOrEqual(0);
    });

    it("creates a timings object with fetchMediaMs when caller passes none", async () => {
      const ctx = loadHandlers({ mediaFiles: [] });
      await ctx.mod.handleTaskCompletedFIFO({ taskId: "t1", resultUrl: "u" });
      const passed = (ctx.submitResult.mock.calls[0]![0]) as {
        timings?: { fetchMediaMs?: number };
      };
      expect(passed.timings).toBeDefined();
      expect(passed.timings!.fetchMediaMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe("handleTaskFailedFIFO", () => {
    it("forwards a string error verbatim (legacy)", async () => {
      const ctx = loadHandlers();
      await ctx.mod.handleTaskFailedFIFO({
        task: { id: "t1", mode: "frames" },
        error: "boom",
      });
      expect(ctx.submitFailure).toHaveBeenCalledWith(
        { id: "t1", mode: "frames" },
        "boom",
      );
      expect((ctx.store.processedJobIds as string[]).includes("t1")).toBe(true);
      expect((ctx.store.stats as { failed: number }).failed).toBe(1);
    });

    it("forwards an Error object to submitFailure unchanged", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("Quota exceeded"), {
        reason: "RESOURCE_EXHAUSTED",
        category: "rate_limit",
        httpStatus: 429,
      });
      await ctx.mod.handleTaskFailedFIFO({
        task: { id: "t1", mode: "video" },
        error: err,
      });
      expect(ctx.submitFailure).toHaveBeenCalledWith(
        { id: "t1", mode: "video" },
        err,
      );
    });

    it("defaults errorMessage to 'Unknown error' when missing", async () => {
      const ctx = loadHandlers();
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" } });
      expect(ctx.submitFailure).toHaveBeenCalledWith({ id: "t1" }, "Unknown error");
    });

    it("bumps todayContentPolicy when err.category is 'content_policy'", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("blocked"), {
        category: "content_policy",
      });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      const stats = ctx.store.stats as Record<string, number>;
      expect(stats.todayContentPolicy).toBe(1);
      expect(stats.todayRateLimited ?? 0).toBe(0);
    });

    it("bumps todayRateLimited when err.category is 'rate_limit'", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("429"), {
        category: "rate_limit",
      });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      const stats = ctx.store.stats as Record<string, number>;
      expect(stats.todayRateLimited).toBe(1);
      expect(stats.todayContentPolicy ?? 0).toBe(0);
    });

    it("does NOT bump category counters when err.category is 'transient'", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("5xx"), {
        category: "transient",
      });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      const stats = ctx.store.stats as Record<string, number>;
      expect(stats.todayContentPolicy ?? 0).toBe(0);
      expect(stats.todayRateLimited ?? 0).toBe(0);
    });
  });

  describe("circuit breaker (Task 3.1)", () => {
    it("handleTaskCompletedFIFO resets the consecutive-failures counter on success", async () => {
      const ctx = loadHandlers({ consecutiveFailuresStart: 3 });
      await ctx.mod.handleTaskCompletedFIFO({
        taskId: "t1",
        resultUrl: "u",
        mode: "text",
      });
      expect(ctx.resetConsecutiveFailures).toHaveBeenCalled();
    });

    it("does NOT reset the counter when the result submission fails", async () => {
      const ctx = loadHandlers({ submitResultReturn: false, consecutiveFailuresStart: 3 });
      await ctx.mod.handleTaskCompletedFIFO({ taskId: "t1", resultUrl: "u" });
      expect(ctx.resetConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("bumps the counter on a transient failure", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("5xx"), { category: "transient" });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.bumpConsecutiveFailures).toHaveBeenCalledTimes(1);
    });

    it("bumps the counter on quota / unknown / invalid_argument categories", async () => {
      const ctx = loadHandlers();
      for (const cat of ["quota", "unknown", "invalid_argument", "auth", "not_found"]) {
        const err = Object.assign(new Error(cat), { category: cat });
        await ctx.mod.handleTaskFailedFIFO({ task: { id: `t-${cat}` }, error: err });
      }
      expect(ctx.bumpConsecutiveFailures).toHaveBeenCalledTimes(5);
    });

    it("does NOT bump the counter for content_policy failures", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("blocked"), { category: "content_policy" });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.bumpConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("does NOT bump the counter for rate_limit failures", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("429"), { category: "rate_limit" });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.bumpConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("does NOT bump the counter when error.isSessionExpired is true", async () => {
      const ctx = loadHandlers();
      const err = Object.assign(new Error("auth"), {
        category: "auth",
        isSessionExpired: true,
      });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.bumpConsecutiveFailures).not.toHaveBeenCalled();
    });

    it("trips at the default threshold (5) — sets stop flag, stops polling, emits status event with lastError", async () => {
      const ctx = loadHandlers({ consecutiveFailuresStart: 4 });
      const err = Object.assign(new Error("backend exploded"), {
        category: "transient",
      });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.setStopFlag).toHaveBeenCalled();
      expect(ctx.stopPolling).toHaveBeenCalled();
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "StatusEvent",
          event: "circuit_breaker_tripped",
          consecutiveFailures: 5,
          lastError: "backend exploded",
        }),
      );
    });

    it("includes lastError as the raw string when error is a legacy string", async () => {
      const ctx = loadHandlers({ consecutiveFailuresStart: 4 });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: "raw fail" });
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "circuit_breaker_tripped",
          lastError: "raw fail",
        }),
      );
    });

    it("does NOT trip below the threshold", async () => {
      const ctx = loadHandlers({ consecutiveFailuresStart: 3 });
      const err = Object.assign(new Error("5xx"), { category: "transient" });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.setStopFlag).not.toHaveBeenCalled();
      expect(ctx.stopPolling).not.toHaveBeenCalled();
    });

    it("uses configured threshold when getCircuitBreakerThreshold is available", async () => {
      const ctx = loadHandlers({
        consecutiveFailuresStart: 2,
        circuitBreakerThreshold: 3,
      });
      const err = Object.assign(new Error("5xx"), { category: "transient" });
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: err });
      expect(ctx.setStopFlag).toHaveBeenCalled();
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({ consecutiveFailures: 3 }),
      );
    });

    it("counts a string error (legacy / pre-1.1) toward the breaker", async () => {
      const ctx = loadHandlers();
      await ctx.mod.handleTaskFailedFIFO({ task: { id: "t1" }, error: "raw boom" });
      expect(ctx.bumpConsecutiveFailures).toHaveBeenCalledTimes(1);
    });
  });

  // The rate-limit cool-off fallback was removed in Phase 5 / Task 5.2.
  // throwFlowApiError (Phase 1) is now the only sanctioned throw path;
  // it arms the cool-off before the throw, so by the time the handler
  // runs the cool-off is already armed at the throw site. Tests that
  // asserted the fallback fired were removed by design.
});
