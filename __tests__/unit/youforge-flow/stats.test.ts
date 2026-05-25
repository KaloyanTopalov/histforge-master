import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Stats = {
  bumpStat: (key: string) => Promise<void>;
  getStats: () => Promise<Record<string, number | string>>;
};

function loadStats(opts: {
  initial?: Record<string, unknown>;
  fixedDate?: string; // YYYY-MM-DDTHH:mm:ssZ
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/stats.js"),
    "utf8",
  );
  const store: Record<string, unknown> = { stats: opts.initial };
  const get = vi.fn(async (key: string) => ({ [key]: store[key] }));
  const set = vi.fn(async (update: Record<string, unknown>) => {
    Object.assign(store, update);
  });
  // Use a Date stub if a fixed date is provided; otherwise pass the real Date.
  let DateStub: typeof Date = Date;
  if (opts.fixedDate) {
    const fixed = opts.fixedDate;
    DateStub = class extends Date {
      constructor(...args: any[]) {
        if (args.length === 0) super(fixed);
        else super(...(args as [string | number]));
      }
      static now() { return new Date(fixed).getTime(); }
    } as unknown as typeof Date;
  }
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: { storage: { local: { get, set } } },
    Date: DateStub,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { mod: sandbox as unknown as Stats, store, get, set };
}

describe("stats.bumpStat", () => {
  it("increments the named counter", async () => {
    const ctx = loadStats({
      initial: { processed: 2 },
      fixedDate: "2026-04-25T12:00:00Z",
    });
    await ctx.mod.bumpStat("processed");
    expect((ctx.store.stats as Record<string, number>).processed).toBe(3);
  });

  it("mirrors processed → todayProcessed", async () => {
    const ctx = loadStats({
      initial: { processed: 0, todayProcessed: 0, todayDate: "2026-04-25" },
      fixedDate: "2026-04-25T12:00:00Z",
    });
    await ctx.mod.bumpStat("processed");
    const stats = ctx.store.stats as Record<string, number>;
    expect(stats.processed).toBe(1);
    expect(stats.todayProcessed).toBe(1);
  });

  it("mirrors failed → todayFailed", async () => {
    const ctx = loadStats({
      initial: { failed: 5, todayFailed: 5, todayDate: "2026-04-25" },
      fixedDate: "2026-04-25T12:00:00Z",
    });
    await ctx.mod.bumpStat("failed");
    const stats = ctx.store.stats as Record<string, number>;
    expect(stats.failed).toBe(6);
    expect(stats.todayFailed).toBe(6);
  });

  it("does not mirror keys outside the processed/failed pair", async () => {
    const ctx = loadStats({
      initial: { retries: 0, todayDate: "2026-04-25" },
      fixedDate: "2026-04-25T12:00:00Z",
    });
    await ctx.mod.bumpStat("retries");
    const stats = ctx.store.stats as Record<string, number>;
    expect(stats.retries).toBe(1);
    expect(stats.todayProcessed).toBeUndefined();
  });

  it("resets all today* counters when the date rolls over", async () => {
    const ctx = loadStats({
      initial: {
        processed: 100,
        failed: 5,
        todayProcessed: 30,
        todayFailed: 2,
        todayRateLimited: 1,
        todayContentPolicy: 1,
        todayDate: "2026-04-24",
      },
      fixedDate: "2026-04-25T00:00:01Z",
    });
    await ctx.mod.bumpStat("processed");
    const stats = ctx.store.stats as Record<string, number | string>;
    expect(stats.processed).toBe(101); // lifetime continues
    expect(stats.todayDate).toBe("2026-04-25");
    expect(stats.todayProcessed).toBe(1); // reset, then bumped
    expect(stats.todayFailed).toBe(0);
    expect(stats.todayRateLimited).toBe(0);
    expect(stats.todayContentPolicy).toBe(0);
  });

  it("sets todayDate on first bump when missing", async () => {
    const ctx = loadStats({
      initial: { processed: 0 },
      fixedDate: "2026-04-25T08:00:00Z",
    });
    await ctx.mod.bumpStat("processed");
    const stats = ctx.store.stats as Record<string, number | string>;
    expect(stats.todayDate).toBe("2026-04-25");
    expect(stats.todayProcessed).toBe(1);
  });

  it("supports the new today-only counters (todayContentPolicy, todayRateLimited)", async () => {
    const ctx = loadStats({
      initial: { todayDate: "2026-04-25" },
      fixedDate: "2026-04-25T12:00:00Z",
    });
    await ctx.mod.bumpStat("todayContentPolicy");
    await ctx.mod.bumpStat("todayRateLimited");
    const stats = ctx.store.stats as Record<string, number>;
    expect(stats.todayContentPolicy).toBe(1);
    expect(stats.todayRateLimited).toBe(1);
  });
});

describe("stats.getStats", () => {
  it("rolls over today* counters when read past midnight without a bump", async () => {
    const ctx = loadStats({
      initial: {
        processed: 100,
        todayProcessed: 30,
        todayFailed: 5,
        todayRateLimited: 2,
        todayContentPolicy: 1,
        todayDate: "2026-04-24",
      },
      fixedDate: "2026-04-25T00:00:30Z",
    });
    const stats = await ctx.mod.getStats();
    expect(stats.processed).toBe(100); // lifetime preserved
    expect(stats.todayDate).toBe("2026-04-25");
    expect(stats.todayProcessed).toBe(0);
    expect(stats.todayFailed).toBe(0);
    expect(stats.todayRateLimited).toBe(0);
    expect(stats.todayContentPolicy).toBe(0);
    // Persists the rollover so subsequent reads see fresh values without re-rolling.
    expect(ctx.set).toHaveBeenCalled();
  });

  it("does not roll over when todayDate matches today", async () => {
    const ctx = loadStats({
      initial: {
        todayProcessed: 7,
        todayDate: "2026-04-25",
      },
      fixedDate: "2026-04-25T12:00:00Z",
    });
    const stats = await ctx.mod.getStats();
    expect(stats.todayProcessed).toBe(7);
    expect(ctx.set).not.toHaveBeenCalled();
  });

  it("returns empty when no stats record exists", async () => {
    const ctx = loadStats({ fixedDate: "2026-04-25T12:00:00Z" });
    const stats = await ctx.mod.getStats();
    expect(stats).toEqual({});
    expect(ctx.set).not.toHaveBeenCalled();
  });
});
