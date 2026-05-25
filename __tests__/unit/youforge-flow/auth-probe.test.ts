import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// auth-probe.js is loaded via importScripts after webhook.js + runner.js;
// it forward-refs `isSessionExpiredReported` / `clearSessionExpiredReport`
// (webhook.js) and `startPolling` (runner.js). The sandbox below stands
// those refs in as injectable fakes so the probe is exercisable in isolation.
type AuthProbe = {
  scheduleAuthProbe: () => void;
  clearAuthProbe: () => void;
  probeAuth: () => Promise<void>;
};

interface AlarmsApi {
  clear: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  onAlarm: {
    addListener: ReturnType<typeof vi.fn>;
    fire: (alarm: { name: string }) => void;
  };
}

interface TabsApi {
  query: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function loadAuthProbe(opts: {
  sessionExpiredReported?: boolean;
  startPolling?: ReturnType<typeof vi.fn>;
  clearSessionExpiredReport?: ReturnType<typeof vi.fn>;
  tabsQueryImpl?: (q: unknown) => Promise<unknown>;
  sendMessageImpl?: (tabId: number, msg: unknown) => Promise<unknown>;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/auth-probe.js"),
    "utf8",
  );

  let listenerFn: ((alarm: { name: string }) => void) | null = null;
  const alarms: AlarmsApi = {
    clear: vi.fn((_name: string, cb?: () => void) => {
      if (typeof cb === "function") cb();
    }) as unknown as AlarmsApi["clear"],
    create: vi.fn(),
    onAlarm: {
      addListener: vi.fn((fn: (a: { name: string }) => void) => {
        listenerFn = fn;
      }),
      fire: (alarm) => {
        if (!listenerFn) throw new Error("listener not registered");
        listenerFn(alarm);
      },
    },
  };
  const tabs: TabsApi = {
    query: vi.fn(
      opts.tabsQueryImpl ?? (async () => [{ id: 42 }]),
    ) as unknown as TabsApi["query"],
    sendMessage: vi.fn(
      opts.sendMessageImpl ??
        (async () => ({ session: { accessToken: "fresh-token" } })),
    ) as unknown as TabsApi["sendMessage"],
  };
  const startPolling = opts.startPolling ?? vi.fn(async () => {});
  const clearSessionExpiredReport =
    opts.clearSessionExpiredReport ?? vi.fn();
  const sessionExpiredReported = opts.sessionExpiredReported ?? true;
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: { alarms, tabs },
    startPolling,
    clearSessionExpiredReport,
    isSessionExpiredReported: () => sessionExpiredReported,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as AuthProbe,
    alarms,
    tabs,
    startPolling,
    clearSessionExpiredReport,
  };
}

describe("auth-probe", () => {
  describe("scheduleAuthProbe", () => {
    it("clears any prior alarm then arms a periodic 1-minute alarm named authProbe", () => {
      const ctx = loadAuthProbe();
      ctx.mod.scheduleAuthProbe();
      expect(ctx.alarms.clear).toHaveBeenCalledWith(
        "authProbe",
        expect.any(Function),
      );
      expect(ctx.alarms.create).toHaveBeenCalledWith("authProbe", {
        delayInMinutes: 1,
        periodInMinutes: 1,
      });
    });
  });

  describe("clearAuthProbe", () => {
    it("clears the authProbe alarm by name", () => {
      const ctx = loadAuthProbe();
      ctx.mod.clearAuthProbe();
      expect(ctx.alarms.clear).toHaveBeenCalledWith("authProbe");
    });
  });

  describe("probeAuth", () => {
    it("short-circuits and clears the alarm when no expiry is reported", async () => {
      const ctx = loadAuthProbe({ sessionExpiredReported: false });
      await ctx.mod.probeAuth();
      expect(ctx.alarms.clear).toHaveBeenCalledWith("authProbe");
      expect(ctx.tabs.query).not.toHaveBeenCalled();
      expect(ctx.startPolling).not.toHaveBeenCalled();
    });

    it("returns early without polling when no labs.google tab is open", async () => {
      const ctx = loadAuthProbe({
        tabsQueryImpl: async () => [],
      });
      await ctx.mod.probeAuth();
      expect(ctx.tabs.sendMessage).not.toHaveBeenCalled();
      expect(ctx.startPolling).not.toHaveBeenCalled();
      expect(ctx.clearSessionExpiredReport).not.toHaveBeenCalled();
    });

    it("returns early when the bridge throws (tab present but unreachable)", async () => {
      const ctx = loadAuthProbe({
        sendMessageImpl: async () => {
          throw new Error("disconnected");
        },
      });
      await ctx.mod.probeAuth();
      expect(ctx.startPolling).not.toHaveBeenCalled();
      expect(ctx.clearSessionExpiredReport).not.toHaveBeenCalled();
    });

    it("returns early when the bridge replies without a token", async () => {
      const ctx = loadAuthProbe({
        sendMessageImpl: async () => ({ session: null }),
      });
      await ctx.mod.probeAuth();
      expect(ctx.startPolling).not.toHaveBeenCalled();
      expect(ctx.clearSessionExpiredReport).not.toHaveBeenCalled();
    });

    it("accepts session.accessToken from the bridge and resumes polling", async () => {
      const ctx = loadAuthProbe();
      await ctx.mod.probeAuth();
      expect(ctx.clearSessionExpiredReport).toHaveBeenCalledTimes(1);
      expect(ctx.alarms.clear).toHaveBeenCalledWith("authProbe");
      expect(ctx.startPolling).toHaveBeenCalledTimes(1);
    });

    it("accepts a legacy flat `token` field from the bridge", async () => {
      const ctx = loadAuthProbe({
        sendMessageImpl: async () => ({ token: "legacy-flat-token" }),
      });
      await ctx.mod.probeAuth();
      expect(ctx.startPolling).toHaveBeenCalledTimes(1);
    });

    it("swallows a startPolling throw without surfacing it to the alarm runtime", async () => {
      const ctx = loadAuthProbe({
        startPolling: vi.fn(async () => {
          throw new Error("polling refused to start");
        }),
      });
      await expect(ctx.mod.probeAuth()).resolves.toBeUndefined();
    });
  });

  describe("chrome.alarms.onAlarm listener", () => {
    it("invokes probeAuth when the fired alarm name matches", async () => {
      const ctx = loadAuthProbe();
      ctx.alarms.onAlarm.fire({ name: "authProbe" });
      // Give the async probe a tick to run.
      await Promise.resolve();
      await Promise.resolve();
      expect(ctx.tabs.query).toHaveBeenCalled();
    });

    it("ignores alarms whose name does not match authProbe", async () => {
      const ctx = loadAuthProbe();
      ctx.alarms.onAlarm.fire({ name: "pollTasks" });
      await Promise.resolve();
      expect(ctx.tabs.query).not.toHaveBeenCalled();
    });
  });
});
