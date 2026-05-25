import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Status = {
  getStatus: () => Promise<Record<string, unknown>>;
};

function loadStatus(opts: {
  storage?: Record<string, unknown>;
  activeImage?: number;
  activeVideo?: number;
  currentMode?: string;
  sessionExpired?: boolean;
  hostPermissionRevoked?: boolean;
  pauseReason?: string | null;
  cooldownUntil?: number | null;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/status.js"),
    "utf8",
  );
  const storage = opts.storage ?? {
    isEnabled: true,
    lastPoll: "2026-04-22T00:00:00Z",
    stats: { processed: 2, failed: 1 },
    processedJobIds: ["a", "b", "c"],
    generationMode: "image",
  };
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      storage: {
        local: {
          get: vi.fn(async () => storage),
        },
      },
    },
    getActiveCount: (bucket: "image" | "video") =>
      bucket === "image" ? (opts.activeImage ?? 0) : (opts.activeVideo ?? 0),
    getCurrentMode: () => opts.currentMode ?? "image",
    isSessionExpiredReported: () => opts.sessionExpired ?? false,
    isHostPermissionRevoked: () => opts.hostPermissionRevoked ?? false,
    // Bridges that the production module reads from sibling files.
    loadSettings: vi.fn(async () => {}),
    loadState: vi.fn(async () => {}),
    getIsEnabled: () => !!storage.isEnabled,
    getLastPoll: () => storage.lastPoll ?? null,
    getProcessedJobIds: () => storage.processedJobIds ?? [],
    getStats: vi.fn(async () => storage.stats ?? {}),
    getPauseReason: () => opts.pauseReason ?? null,
    getCooldownUntil: () => opts.cooldownUntil ?? null,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { mod: sandbox as unknown as Status };
}

describe("getStatus", () => {
  it("aggregates storage + runner + webhook + host-permission state", async () => {
    const ctx = loadStatus({
      activeImage: 1,
      activeVideo: 1,
      sessionExpired: false,
      hostPermissionRevoked: false,
    });
    const out = await ctx.mod.getStatus();
    expect(out).toMatchObject({
      isPolling: true,
      isProcessing: true,
      lastPoll: "2026-04-22T00:00:00Z",
      processedCount: 3,
      mode: "image",
      sessionExpired: false,
      hostPermissionRevoked: false,
    });
    // Lifetime + today* defaults merged with stored counters
    const stats = out.stats as Record<string, number>;
    expect(stats.processed).toBe(2);
    expect(stats.failed).toBe(1);
    expect(stats.todayProcessed).toBe(0);
    expect(stats.todayFailed).toBe(0);
    expect(stats.todayRateLimited).toBe(0);
    expect(stats.todayContentPolicy).toBe(0);
  });

  it("reports isProcessing false when active count is 0", async () => {
    const ctx = loadStatus({ activeImage: 0, activeVideo: 0 });
    const out = await ctx.mod.getStatus();
    expect(out.isProcessing).toBe(false);
  });

  it("propagates sessionExpired/hostPermissionRevoked flags", async () => {
    const ctx = loadStatus({
      sessionExpired: true,
      hostPermissionRevoked: true,
    });
    const out = await ctx.mod.getStatus();
    expect(out.sessionExpired).toBe(true);
    expect(out.hostPermissionRevoked).toBe(true);
  });

  it("defaults stats when missing — includes today* defaults", async () => {
    const ctx = loadStatus({
      storage: {
        isEnabled: false,
        lastPoll: null,
        processedJobIds: [],
        generationMode: "image",
      },
    });
    const out = await ctx.mod.getStatus();
    expect(out.stats).toEqual({
      processed: 0,
      failed: 0,
      todayProcessed: 0,
      todayFailed: 0,
      todayRateLimited: 0,
      todayContentPolicy: 0,
    });
  });

  it("preserves stored today* counters when present", async () => {
    const ctx = loadStatus({
      storage: {
        isEnabled: true,
        lastPoll: "2026-04-25T00:00:00Z",
        stats: {
          processed: 50,
          failed: 5,
          todayProcessed: 12,
          todayFailed: 2,
          todayRateLimited: 1,
          todayContentPolicy: 3,
          todayDate: "2026-04-25",
        },
        processedJobIds: [],
        generationMode: "image",
      },
    });
    const out = await ctx.mod.getStatus();
    const stats = out.stats as Record<string, number | string>;
    expect(stats.todayProcessed).toBe(12);
    expect(stats.todayFailed).toBe(2);
    expect(stats.todayRateLimited).toBe(1);
    expect(stats.todayContentPolicy).toBe(3);
    expect(stats.todayDate).toBe("2026-04-25");
  });

  describe("pause state (Phase 3 fix #4)", () => {
    it("includes pauseReason and cooldownUntil in the payload", async () => {
      const cooldownUntil = Date.now() + 600_000;
      const ctx = loadStatus({
        pauseReason: "rate_limited",
        cooldownUntil,
      });
      const out = await ctx.mod.getStatus();
      expect(out.pauseReason).toBe("rate_limited");
      expect(out.cooldownUntil).toBe(cooldownUntil);
    });

    it("defaults pauseReason to null and cooldownUntil to null when not paused", async () => {
      const ctx = loadStatus();
      const out = await ctx.mod.getStatus();
      expect(out.pauseReason).toBe(null);
      expect(out.cooldownUntil).toBe(null);
    });
  });
});
