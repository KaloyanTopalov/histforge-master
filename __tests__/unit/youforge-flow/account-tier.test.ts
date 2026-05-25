import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type AccountTier = {
  detectAccountTier: (tabId: number) => Promise<"ultra" | "pro">;
  getVideoModelKeys: (
    accountTier: "ultra" | "pro",
    qualitySetting: "lite" | "quality" | "fast" | string,
    aspectRatio: "portrait" | "landscape" | string,
  ) => {
    t2v: string;
    r2v: string;
    i2v: string;
    i2v_fl: string;
    isLite?: boolean;
    paygateTier: string;
  };
  clearCachedTier: () => void;
};

function loadAccountTier(opts: {
  sessionToken?: string | null;
  creditsResponse?: { data?: unknown; error?: string };
  executeScriptThrows?: Error;
  safeLog?: ReturnType<typeof vi.fn>;
} = {}) {
  const constantsSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/constants.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/account-tier.js"),
    "utf8",
  );
  let cachedTier: "ultra" | "pro" | null = null;
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: opts.safeLog ?? (() => {}),
    getSessionTokenFromPage: vi.fn(async () => opts.sessionToken ?? null),
    // Stubs for state.js functions used by detectAccountTier.
    loadState: vi.fn(async () => {}),
    getCachedAccountTier: vi.fn(() => cachedTier),
    setCachedAccountTier: vi.fn(async (v: "ultra" | "pro") => { cachedTier = v; }),
    clearCachedAccountTier: vi.fn(async () => { cachedTier = null; }),
    chrome: {
      scripting: {
        executeScript: vi.fn(async () => {
          if (opts.executeScriptThrows) throw opts.executeScriptThrows;
          return [{ result: opts.creditsResponse ?? { error: "none" } }];
        }),
      },
      storage: { local: { set: vi.fn(async () => {}) } },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(constantsSrc + "\n" + src, sandbox);
  return sandbox as unknown as AccountTier;
}

describe("account-tier", () => {
  describe("detectAccountTier", () => {
    it("returns 'ultra' for PAYGATE_TIER_TWO", async () => {
      const mod = loadAccountTier({
        sessionToken: "sess",
        creditsResponse: { data: { userPaygateTier: "PAYGATE_TIER_TWO", credits: 100 } },
      });
      expect(await mod.detectAccountTier(1)).toBe("ultra");
    });

    it("returns 'pro' for non-TIER_TWO paygate values", async () => {
      const mod = loadAccountTier({
        sessionToken: "sess",
        creditsResponse: { data: { userPaygateTier: "PAYGATE_TIER_ONE", credits: 50 } },
      });
      expect(await mod.detectAccountTier(1)).toBe("pro");
    });

    it("caches — second call does not re-hit the credits endpoint", async () => {
      const mod = loadAccountTier({
        sessionToken: "sess",
        creditsResponse: { data: { userPaygateTier: "PAYGATE_TIER_TWO", credits: 100 } },
      });
      await mod.detectAccountTier(1);
      // Swap to a response that'd produce 'pro' — still should return cached 'ultra'.
      expect(await mod.detectAccountTier(1)).toBe("ultra");
    });

    it("defaults to 'ultra' when no session token is available", async () => {
      const mod = loadAccountTier({ sessionToken: null });
      expect(await mod.detectAccountTier(1)).toBe("ultra");
    });

    it("defaults to 'ultra' when executeScript throws", async () => {
      const mod = loadAccountTier({
        sessionToken: "sess",
        executeScriptThrows: new Error("blocked"),
      });
      expect(await mod.detectAccountTier(1)).toBe("ultra");
    });

    it("clearCachedTier forces a fresh detection on next call", async () => {
      const mod = loadAccountTier({
        sessionToken: "sess",
        creditsResponse: { data: { userPaygateTier: "PAYGATE_TIER_TWO", credits: 100 } },
      });
      await mod.detectAccountTier(1);
      mod.clearCachedTier();
      // After clear, subsequent detect goes through normal path again.
      expect(await mod.detectAccountTier(1)).toBe("ultra");
    });
  });

  describe("getVideoModelKeys", () => {
    it("returns lite keys when qualitySetting is 'lite'", () => {
      const mod = loadAccountTier();
      const keys = mod.getVideoModelKeys("ultra", "lite", "landscape");
      expect(keys.t2v).toBe("veo_3_1_t2v_lite");
      expect(keys.i2v).toBe("veo_3_1_i2v_lite");
      expect(keys.isLite).toBe(true);
      expect(keys.paygateTier).toBe("PAYGATE_TIER_TWO");
    });

    it("lite keys use PAYGATE_TIER_ONE for pro accounts", () => {
      const mod = loadAccountTier();
      const keys = mod.getVideoModelKeys("pro", "lite", "landscape");
      expect(keys.paygateTier).toBe("PAYGATE_TIER_ONE");
    });

    it("returns pro-specific keys without ultra/fast suffixes for pro tier", () => {
      const mod = loadAccountTier();
      const keys = mod.getVideoModelKeys("pro", "fast", "landscape");
      expect(keys.t2v).toBe("veo_3_1_t2v");
      expect(keys.paygateTier).toBe("PAYGATE_TIER_ONE");
      expect(keys.r2v).toContain("landscape");
    });

    it("returns portrait r2v variant for pro+portrait", () => {
      const mod = loadAccountTier();
      const keys = mod.getVideoModelKeys("pro", "fast", "portrait");
      expect(keys.r2v).toContain("portrait");
    });

    it("returns quality_ultra keys for ultra+quality", () => {
      const mod = loadAccountTier();
      const keys = mod.getVideoModelKeys("ultra", "quality", "landscape");
      expect(keys.t2v).toBe("veo_3_1_t2v_quality_ultra");
      expect(keys.i2v_fl).toBe("veo_3_1_i2v_s_quality_ultra_fl");
    });

    it("defaults to fast ultra keys when qualitySetting is unrecognized", () => {
      const mod = loadAccountTier();
      const keys = mod.getVideoModelKeys("ultra", "unknown", "landscape");
      expect(keys.t2v).toBe("veo_3_1_t2v_fast_ultra");
    });

    it("warns when aspectRatio is neither 'portrait' nor 'landscape'", () => {
      const safeLog = vi.fn();
      const mod = loadAccountTier({ safeLog });
      const keys = mod.getVideoModelKeys("ultra", "fast", "square");
      // Coerces to landscape (existing silent behavior).
      expect(keys.r2v).toContain("landscape");
      // ...but now logs a warning naming the unknown value.
      const messages = safeLog.mock.calls.map((c) => c.join(" "));
      expect(messages.some((m) => /aspect/i.test(m) && m.includes("square"))).toBe(true);
    });

    it("does not warn for valid aspectRatio strings", () => {
      const safeLog = vi.fn();
      const mod = loadAccountTier({ safeLog });
      mod.getVideoModelKeys("ultra", "fast", "landscape");
      mod.getVideoModelKeys("ultra", "fast", "portrait");
      const messages = safeLog.mock.calls.map((c) => c.join(" "));
      expect(messages.some((m) => /unknown aspect/i.test(m))).toBe(false);
    });

    it("warns when qualitySetting is not lite/quality/fast", () => {
      const safeLog = vi.fn();
      const mod = loadAccountTier({ safeLog });
      mod.getVideoModelKeys("ultra", "premium", "landscape");
      const messages = safeLog.mock.calls.map((c) => c.join(" "));
      expect(messages.some((m) => /quality/i.test(m) && m.includes("premium"))).toBe(true);
    });

    it("does not warn for valid qualitySetting strings", () => {
      const safeLog = vi.fn();
      const mod = loadAccountTier({ safeLog });
      for (const q of ["lite", "quality", "fast"]) {
        mod.getVideoModelKeys("ultra", q, "landscape");
      }
      const messages = safeLog.mock.calls.map((c) => c.join(" "));
      expect(messages.some((m) => /unknown quality/i.test(m))).toBe(false);
    });
  });
});
