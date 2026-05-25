import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Auth = {
  getRecaptchaTokenFromPage: (tabId: number, action: string) => Promise<string | null>;
  getSessionTokenFromPage: (tabId: number) => Promise<string | null>;
};

function loadAuth(opts: {
  tabsQuery?: Array<{ id: number }>;
  sendMessageResponses?: Record<string, unknown>;
  sendMessageThrows?: Error;
  tabUrl?: string;
  executeScriptResults?: Array<unknown>;
  executeScriptThrows?: Error;
  assertNotStopped?: () => void;
  now?: () => number;
} = {}) {
  const httpSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/auth.js"),
    "utf8",
  );
  const clearSessionExpiredReport = vi.fn();
  const notifySessionExpired = vi.fn(async (_: string) => {});
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    assertNotStopped: opts.assertNotStopped ?? (() => {}),
    clearSessionExpiredReport,
    notifySessionExpired,
    getSessionReFetchRetries: () => 2,
    // retryWithBackoff comes from the real http.js source concatenated below.
    AbortController,
    AbortSignal,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    Math,
    Promise,
    Number,
    Error,
    Date: { now: opts.now ?? Date.now, parse: Date.parse.bind(Date) },
    chrome: {
      tabs: {
        query: vi.fn(async () => opts.tabsQuery ?? []),
        sendMessage: vi.fn(async (_id: number, msg: { action: string }) => {
          if (opts.sendMessageThrows) throw opts.sendMessageThrows;
          return opts.sendMessageResponses?.[msg.action];
        }),
        get: vi.fn(async (_id: number) => ({ url: opts.tabUrl ?? "" })),
      },
      scripting: {
        executeScript: vi.fn(async () => {
          if (opts.executeScriptThrows) throw opts.executeScriptThrows;
          return opts.executeScriptResults ?? [{ result: null }];
        }),
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(httpSrc + "\n" + src, sandbox);
  return {
    mod: sandbox as unknown as Auth,
    clearSessionExpiredReport,
    notifySessionExpired,
    chromeStub: sandbox.chrome as {
      tabs: {
        sendMessage: ReturnType<typeof vi.fn>;
        get: ReturnType<typeof vi.fn>;
        query: ReturnType<typeof vi.fn>;
      };
      scripting: { executeScript: ReturnType<typeof vi.fn> };
    },
  };
}

describe("auth", () => {
  describe("getRecaptchaTokenFromPage", () => {
    it("returns the token from the content-bridge response", async () => {
      const { mod } = loadAuth({
        sendMessageResponses: { getRecaptchaToken: { token: "rc-abc" } },
      });
      expect(await mod.getRecaptchaTokenFromPage(1, "generate")).toBe("rc-abc");
    });

    it("returns null when response has no token", async () => {
      const { mod } = loadAuth({ sendMessageResponses: { getRecaptchaToken: {} } });
      expect(await mod.getRecaptchaTokenFromPage(1, "generate")).toBeNull();
    });

    it("calls assertNotStopped before sending the message", async () => {
      const assertNotStopped = vi.fn(() => {
        throw new Error("STOP_REQUESTED");
      });
      const { mod } = loadAuth({ assertNotStopped });
      await expect(mod.getRecaptchaTokenFromPage(1, "generate")).rejects.toThrow(
        "STOP_REQUESTED",
      );
      expect(assertNotStopped).toHaveBeenCalled();
    });

    it("returns null when sendMessage throws", async () => {
      const { mod } = loadAuth({ sendMessageThrows: new Error("tab gone") });
      expect(await mod.getRecaptchaTokenFromPage(1, "generate")).toBeNull();
    });
  });

  describe("getSessionTokenFromPage", () => {
    it("returns the token from response.session.accessToken and caches it", async () => {
      let currentTime = 1000;
      const ctx = loadAuth({
        sendMessageResponses: {
          getSessionToken: { session: { accessToken: "sess-xyz" } },
        },
        now: () => currentTime,
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("sess-xyz");
      expect(ctx.clearSessionExpiredReport).toHaveBeenCalled();

      // Within the 5-minute TTL, should return cached without re-calling sendMessage.
      currentTime += 4 * 60 * 1000;
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear();
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("sess-xyz");
      expect(ctx.chromeStub.tabs.sendMessage).not.toHaveBeenCalled();
    });

    it("re-fetches after 5-minute TTL elapses", async () => {
      let currentTime = 1000;
      const responses: Record<string, unknown> = {
        getSessionToken: { session: { accessToken: "first" } },
      };
      const ctx = loadAuth({
        sendMessageResponses: responses,
        now: () => currentTime,
      });
      await ctx.mod.getSessionTokenFromPage(1);

      currentTime += 6 * 60 * 1000;
      responses.getSessionToken = { session: { accessToken: "second" } };
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("second");
    });

    it("calls notifySessionExpired when response has no token", async () => {
      const ctx = loadAuth({
        sendMessageResponses: { getSessionToken: { session: {} } },
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBeNull();
      expect(ctx.notifySessionExpired).toHaveBeenCalled();
    });

    it("calls notifySessionExpired on 401-style errors", async () => {
      const ctx = loadAuth({
        sendMessageThrows: new Error("Session fetch failed: 401"),
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBeNull();
      expect(ctx.notifySessionExpired).toHaveBeenCalled();
    });

    it("does not call notifySessionExpired on unrelated errors", async () => {
      const ctx = loadAuth({
        sendMessageThrows: new Error("network flake"),
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBeNull();
      expect(ctx.notifySessionExpired).not.toHaveBeenCalled();
    });

    it("uses response.session.expires (ISO string) to set TTL minus 60s safety margin", async () => {
      let now = 1_700_000_000_000;
      // Token expires 30 minutes in the future.
      const expires = new Date(now + 30 * 60 * 1000).toISOString();
      const ctx = loadAuth({
        sendMessageResponses: {
          getSessionToken: { session: { accessToken: "tok-iso", expires } },
        },
        now: () => now,
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("tok-iso");
      // Advance 25 minutes — still within (expires - 60s), cached.
      now += 25 * 60 * 1000;
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear();
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("tok-iso");
      expect(ctx.chromeStub.tabs.sendMessage).not.toHaveBeenCalled();
      // Advance past expires - 60s — should re-fetch.
      now += 5 * 60 * 1000;
      await ctx.mod.getSessionTokenFromPage(1);
      expect(ctx.chromeStub.tabs.sendMessage).toHaveBeenCalled();
    });

    it("caps cache at 60 minutes even when expires says further ahead", async () => {
      let now = 1_700_000_000_000;
      // Token "expires" 3 hours from now — but we cap cache at 60 minutes.
      const expires = new Date(now + 3 * 60 * 60 * 1000).toISOString();
      const ctx = loadAuth({
        sendMessageResponses: {
          getSessionToken: { session: { accessToken: "tok-cap", expires } },
        },
        now: () => now,
      });
      await ctx.mod.getSessionTokenFromPage(1);
      // 65 minutes later — past the 60-min cap, must re-fetch.
      now += 65 * 60 * 1000;
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockClear();
      await ctx.mod.getSessionTokenFromPage(1);
      expect(ctx.chromeStub.tabs.sendMessage).toHaveBeenCalled();
    });

    it("retries sendMessage on transient bridge errors before declaring expired", async () => {
      let calls = 0;
      const ctx = loadAuth({});
      // Inject a sendMessage that throws twice, then succeeds.
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: number, msg: { action: string }) => {
          if (msg.action !== "getSessionToken") return undefined;
          calls += 1;
          if (calls < 3) throw new Error("Could not establish connection");
          return { session: { accessToken: "tok-retried" } };
        },
      );
      const tok = await ctx.mod.getSessionTokenFromPage(1);
      expect(tok).toBe("tok-retried");
      expect(calls).toBe(3);
      expect(ctx.notifySessionExpired).not.toHaveBeenCalled();
    });

    it("does NOT retry on session-expired error pattern", async () => {
      let calls = 0;
      const ctx = loadAuth({});
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async (_id: number, _msg: { action: string }) => {
          calls += 1;
          throw new Error("Session fetch failed: 401");
        },
      );
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBeNull();
      expect(calls).toBe(1);
      expect(ctx.notifySessionExpired).toHaveBeenCalled();
    });

    it("invalidates the cache on session-expired error so the next call re-fetches", async () => {
      let now = 1_700_000_000_000;
      const expires = new Date(now + 30 * 60 * 1000).toISOString();
      const ctx = loadAuth({
        sendMessageResponses: {
          getSessionToken: { session: { accessToken: "tok-fresh", expires } },
        },
        now: () => now,
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("tok-fresh");

      // Within TTL the cache would normally serve. Simulate the session
      // becoming invalid: next sendMessage throws a 401-style error.
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async () => { throw new Error("Session fetch failed: 401"); },
      );
      // Force a re-fetch by advancing past TTL.
      now += 31 * 60 * 1000;
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBeNull();

      // Cache must be cleared — a third call (still within the original
      // 60min window) must hit sendMessage again, not return the stale token.
      const sendMessageStub = ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>;
      sendMessageStub.mockReset();
      sendMessageStub.mockImplementation(
        async () => ({ session: { accessToken: "tok-after-invalidate", expires } }),
      );
      now += 1000;
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("tok-after-invalidate");
      expect(sendMessageStub).toHaveBeenCalled();
    });

    it("invalidates the cache when response has no access token", async () => {
      let now = 1_700_000_000_000;
      const ctx = loadAuth({
        sendMessageResponses: {
          getSessionToken: { session: { accessToken: "first" } },
        },
        now: () => now,
      });
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("first");

      // Subsequent call (after TTL) returns no token — cache should be cleared.
      now += 6 * 60 * 1000;
      (ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>).mockImplementation(
        async () => ({ session: {} }),
      );
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBeNull();

      // Next call must re-fetch (cache cleared).
      const sendMessageStub = ctx.chromeStub.tabs.sendMessage as ReturnType<typeof vi.fn>;
      sendMessageStub.mockReset();
      sendMessageStub.mockImplementation(
        async () => ({ session: { accessToken: "second" } }),
      );
      expect(await ctx.mod.getSessionTokenFromPage(1)).toBe("second");
      expect(sendMessageStub).toHaveBeenCalled();
    });
  });

});
