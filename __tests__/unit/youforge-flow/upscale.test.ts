import { describe, it, expect, vi } from "vitest";
import { loadClassicScript } from "../../helpers/load-classic-script";

type Upscale = {
  upscaleWithFallback: (opts: {
    attempt: () => Promise<boolean>;
    on403Fallback?: () => boolean;
    maxAttempts?: number;
    baseMs?: number;
    capMs?: number;
    logLabel?: string;
    log?: (...args: unknown[]) => void;
    sleep?: (ms: number) => Promise<void>;
  }) => Promise<boolean>;
  computeBackoff?: (
    attempt: number,
    opts?: { baseMs?: number; capMs?: number; jitter?: boolean },
  ) => number;
};

// upscale.js uses computeBackoff (loaded from src/http.js in prod). Tests
// concatenate http.js's source so the symbol is available.
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

function loadUpscale(opts: { upscaleMaxAttempts?: number } = {}) {
  const httpSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const upscaleSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/executors/upscale.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    Math,
    Promise,
    fetch: () => Promise.resolve({} as Response),
    AbortController,
    getUpscaleMaxAttempts: () => opts.upscaleMaxAttempts ?? 3,
  };
  vm.createContext(sandbox);
  vm.runInContext(httpSrc + "\n" + upscaleSrc, sandbox);
  return sandbox as unknown as Upscale;
}

const { upscaleWithFallback } = loadUpscale();
// Silence unused-import warning while keeping the helper available.
void loadClassicScript;

describe("upscaleWithFallback", () => {
  it("returns true when the first attempt succeeds", async () => {
    const attempt = vi.fn().mockResolvedValue(true);
    const result = await upscaleWithFallback({
      attempt,
      maxAttempts: 3,
      baseMs: 100,
      capMs: 1000,
      logLabel: "Image",
      sleep: vi.fn().mockResolvedValue(undefined),
    });
    expect(result).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("returns false after maxAttempts non-throwing false results", async () => {
    const attempt = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await upscaleWithFallback({
      attempt,
      maxAttempts: 3,
      baseMs: 100,
      capMs: 1000,
      logLabel: "Image",
      sleep,
    });
    expect(result).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    // Sleep between attempts 1→2 and 2→3, but not after the final attempt.
    expect(sleep).toHaveBeenCalledTimes(2);
    // Delay comes from computeBackoff(attempt, {baseMs, capMs, jitter:true});
    // jitter ranges in [0.5, 1.5) so values are positive and capped at capMs.
    for (const call of sleep.mock.calls) {
      const ms = call[0] as number;
      expect(ms).toBeGreaterThan(0);
      expect(ms).toBeLessThanOrEqual(1000);
    }
  });

  it("retries without consuming an attempt when a 403 triggers a fallback", async () => {
    // Attempt 1 throws 403 → fallback applied → retry at same counter.
    // Attempt 2 (still counter 1) succeeds.
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 403 forbidden"))
      .mockResolvedValueOnce(true);
    const on403Fallback = vi.fn().mockReturnValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await upscaleWithFallback({
      attempt,
      on403Fallback,
      maxAttempts: 3,
      baseMs: 100,
      capMs: 1000,
      logLabel: "Video",
      sleep,
    });

    expect(result).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(on403Fallback).toHaveBeenCalledTimes(1);
    // No sleep between 403 fallback and immediate retry.
    expect(sleep).not.toHaveBeenCalled();
  });

  it("counts 403 as a normal failed attempt when no fallback is available", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValue(new Error("HTTP 403 forbidden"));
    const on403Fallback = vi.fn().mockReturnValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await upscaleWithFallback({
      attempt,
      on403Fallback,
      maxAttempts: 3,
      baseMs: 100,
      capMs: 1000,
      logLabel: "Video",
      sleep,
    });

    expect(result).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(on403Fallback).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("uses getUpscaleMaxAttempts() default when caller omits maxAttempts", async () => {
    const { upscaleWithFallback: upscaleConfigurable } = loadUpscale({ upscaleMaxAttempts: 5 });
    const attempt = vi.fn().mockResolvedValue(false);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await upscaleConfigurable({
      attempt,
      baseMs: 100,
      capMs: 1000,
      logLabel: "Image",
      sleep,
    });
    expect(result).toBe(false);
    expect(attempt).toHaveBeenCalledTimes(5);
  });

  it("counts non-403 errors as a failed attempt", async () => {
    const attempt = vi
      .fn()
      .mockRejectedValueOnce(new Error("HTTP 500 server error"))
      .mockResolvedValueOnce(true);
    const on403Fallback = vi.fn().mockReturnValue(true);
    const log = vi.fn();
    const sleep = vi.fn().mockResolvedValue(undefined);

    const result = await upscaleWithFallback({
      attempt,
      on403Fallback,
      maxAttempts: 3,
      baseMs: 100,
      capMs: 1000,
      logLabel: "Image",
      log,
      sleep,
    });

    expect(result).toBe(true);
    // 500 is logged but not treated as a fallback trigger.
    expect(on403Fallback).not.toHaveBeenCalled();
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalled();
  });
});
