import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type CreditsPoller = {
  startCreditsPolling: () => void;
  stopCreditsPolling: () => void;
  pollCreditsOnce: () => Promise<void>;
};

function loadCreditsPoller(opts: {
  tabs?: Array<{ id: number }>;
  sessionToken?: string | null;
  credits?: { credits: number; tier: string; serviceTier?: string; sku?: string } | null;
  threshold?: number;
  pauseReason?: string | null;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/credits-poller.js"),
    "utf8",
  );
  const getSessionTokenFromPage = vi.fn(async () =>
    opts.sessionToken === undefined ? "bearer-abc" : opts.sessionToken,
  );
  const getCredits = vi.fn(async () =>
    opts.credits === undefined
      ? { credits: 100, tier: "ultra", serviceTier: "T2", sku: "sku-a" }
      : opts.credits,
  );
  const postStatusEvent = vi.fn(async () => true);
  const safeLog = vi.fn();
  const alarmsCreate = vi.fn();
  const alarmsClear = vi.fn();
  const addAlarmListener = vi.fn();
  let _pauseReason = opts.pauseReason ?? null;
  const getPauseReason = vi.fn(() => _pauseReason);
  const pauseGenerationOnly = vi.fn((r: string) => {
    if (_pauseReason === null) _pauseReason = r;
  });
  const resumeGenerationOnly = vi.fn((expected: string) => {
    if (_pauseReason === expected) _pauseReason = null;
  });
  const getCreditsMinThreshold = vi.fn(() => opts.threshold ?? 0);
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog,
    CREDITS_POLL_MINUTES: 1,
    getSessionTokenFromPage,
    getCredits,
    postStatusEvent,
    getPauseReason,
    pauseGenerationOnly,
    resumeGenerationOnly,
    getCreditsMinThreshold,
    chrome: {
      tabs: {
        query: vi.fn(async () => opts.tabs ?? [{ id: 1 }]),
      },
      alarms: {
        create: alarmsCreate,
        clear: alarmsClear,
        onAlarm: { addListener: addAlarmListener },
      },
    },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as CreditsPoller,
    getSessionTokenFromPage,
    getCredits,
    postStatusEvent,
    safeLog,
    alarmsCreate,
    alarmsClear,
    addAlarmListener,
    getPauseReason,
    pauseGenerationOnly,
    resumeGenerationOnly,
  };
}

describe("credits-poller", () => {
  describe("pollCreditsOnce", () => {
    it("posts a credits StatusEvent when the credits endpoint returns data", async () => {
      const ctx = loadCreditsPoller();
      await ctx.mod.pollCreditsOnce();
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "StatusEvent",
          event: "credits",
          credits: 100,
          tier: "ultra",
        }),
      );
    });

    it("logs the credit count on the success path", async () => {
      const ctx = loadCreditsPoller();
      await ctx.mod.pollCreditsOnce();
      expect(ctx.safeLog).toHaveBeenCalledWith(
        expect.stringContaining("[credits] ok"),
        100,
        "credits",
      );
    });

    it("no-ops and logs when no Flow tab is open", async () => {
      const ctx = loadCreditsPoller({ tabs: [] });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.postStatusEvent).not.toHaveBeenCalled();
      expect(ctx.safeLog).toHaveBeenCalledWith(
        expect.stringContaining("[credits] no Flow tab"),
      );
    });

    it("no-ops and logs when no session token", async () => {
      const ctx = loadCreditsPoller({ sessionToken: null });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.postStatusEvent).not.toHaveBeenCalled();
      expect(ctx.safeLog).toHaveBeenCalledWith(
        expect.stringContaining("[credits] no session token"),
      );
    });

    it("no-ops and logs when credits endpoint returns null", async () => {
      const ctx = loadCreditsPoller({ credits: null });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.postStatusEvent).not.toHaveBeenCalled();
      expect(ctx.safeLog).toHaveBeenCalledWith(
        expect.stringContaining("[credits] Google non-2xx"),
      );
    });

    it("logs — does not silently swallow — unexpected errors", async () => {
      const ctx = loadCreditsPoller();
      ctx.getCredits.mockRejectedValueOnce(new Error("boom"));
      await expect(ctx.mod.pollCreditsOnce()).resolves.toBeUndefined();
      expect(ctx.safeLog).toHaveBeenCalledWith(
        expect.stringContaining("[credits] poll failed"),
        "boom",
      );
    });
  });

  describe("start/stopCreditsPolling", () => {
    it("creates the recurring alarm and fires one immediate poll", async () => {
      const ctx = loadCreditsPoller();
      ctx.mod.startCreditsPolling();
      expect(ctx.alarmsCreate).toHaveBeenCalledWith("credits", {
        periodInMinutes: 1,
      });
      // Immediate poll is async; flush microtasks before asserting.
      await new Promise((r) => setImmediate(r));
      expect(ctx.getSessionTokenFromPage).toHaveBeenCalled();
    });

    it("clears the credits alarm on stop", () => {
      const ctx = loadCreditsPoller();
      ctx.mod.startCreditsPolling();
      ctx.mod.stopCreditsPolling();
      expect(ctx.alarmsClear).toHaveBeenCalledWith("credits");
    });

    it("re-entry replaces (not stacks) the alarm", () => {
      const ctx = loadCreditsPoller();
      ctx.mod.startCreditsPolling();
      ctx.mod.startCreditsPolling();
      // chrome.alarms.create replaces an existing alarm with the same
      // name — two calls are harmless and expected, but only one alarm
      // exists at a time (MV3 contract).
      expect(ctx.alarmsCreate).toHaveBeenCalledTimes(2);
      expect(ctx.alarmsCreate).toHaveBeenNthCalledWith(1, "credits", {
        periodInMinutes: 1,
      });
      expect(ctx.alarmsCreate).toHaveBeenNthCalledWith(2, "credits", {
        periodInMinutes: 1,
      });
    });
  });

  describe("onAlarm listener", () => {
    it("registers a listener at module load", () => {
      const ctx = loadCreditsPoller();
      expect(ctx.addAlarmListener).toHaveBeenCalledTimes(1);
    });

    it("runs pollCreditsOnce only when alarm name matches 'credits'", async () => {
      const ctx = loadCreditsPoller();
      const handler = ctx.addAlarmListener.mock.calls[0][0] as (
        a: { name: string },
      ) => void;
      handler({ name: "unrelated" });
      await new Promise((r) => setImmediate(r));
      expect(ctx.getSessionTokenFromPage).not.toHaveBeenCalled();
      handler({ name: "credits" });
      await new Promise((r) => setImmediate(r));
      expect(ctx.getSessionTokenFromPage).toHaveBeenCalledTimes(1);
    });
  });

  describe("credits-threshold pause (Task 3.3)", () => {
    it("pauses generation when credits ≤ threshold and not already paused", async () => {
      const ctx = loadCreditsPoller({
        credits: { credits: 0, tier: "ultra" },
        threshold: 0,
      });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.pauseGenerationOnly).toHaveBeenCalledWith("credits_exhausted");
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "StatusEvent",
          event: "credits",
          credits: 0,
          paused: true,
          reason: "credits_exhausted",
        }),
      );
    });

    it("does NOT pause when credits > threshold", async () => {
      const ctx = loadCreditsPoller({
        credits: { credits: 50, tier: "ultra" },
        threshold: 0,
      });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.pauseGenerationOnly).not.toHaveBeenCalled();
    });

    it("does NOT pause when already paused for any reason (first pauser wins)", async () => {
      const ctx = loadCreditsPoller({
        credits: { credits: 0, tier: "ultra" },
        threshold: 0,
        pauseReason: "rate_limited",
      });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.pauseGenerationOnly).not.toHaveBeenCalled();
    });

    it("resumes generation when credits recover and current pause is credits_exhausted", async () => {
      const ctx = loadCreditsPoller({
        credits: { credits: 25, tier: "ultra" },
        threshold: 0,
        pauseReason: "credits_exhausted",
      });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.resumeGenerationOnly).toHaveBeenCalledWith("credits_exhausted");
      expect(ctx.postStatusEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "StatusEvent",
          event: "credits",
          credits: 25,
          resumed: true,
          reason: "credits_recovered",
        }),
      );
    });

    it("does NOT resume when credits recover but pause is rate_limited (different reason)", async () => {
      const ctx = loadCreditsPoller({
        credits: { credits: 25, tier: "ultra" },
        threshold: 0,
        pauseReason: "rate_limited",
      });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.resumeGenerationOnly).not.toHaveBeenCalled();
    });

    it("respects a non-zero threshold (e.g., pause at ≤5)", async () => {
      const ctx = loadCreditsPoller({
        credits: { credits: 5, tier: "ultra" },
        threshold: 5,
      });
      await ctx.mod.pollCreditsOnce();
      expect(ctx.pauseGenerationOnly).toHaveBeenCalledWith("credits_exhausted");
    });
  });
});
