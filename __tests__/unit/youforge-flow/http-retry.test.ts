import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type RetryModule = {
  computeBackoff: (
    attempt: number,
    opts?: { baseMs?: number; capMs?: number; jitter?: boolean },
  ) => number;
  retryWithBackoff: <T>(
    fn: (attempt: number) => Promise<T>,
    opts?: {
      retries?: number;
      baseMs?: number;
      capMs?: number;
      jitter?: boolean;
      shouldRetry?: (err: Error & Record<string, unknown>) => boolean;
      sleep?: (ms: number) => Promise<void>;
    },
  ) => Promise<T>;
};

function loadHttp(opts: { random?: () => number } = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const setTimeoutFn = (fn: () => void, _ms: number) => { fn(); return 0; };
  const sandbox: Record<string, unknown> = {
    fetch: () => Promise.resolve({} as Response),
    setTimeout: setTimeoutFn,
    clearTimeout: () => {},
    AbortController,
    AbortSignal,
    Promise,
    Error,
    Math: { ...Math, random: opts.random ?? Math.random.bind(Math), min: Math.min, pow: Math.pow },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as RetryModule;
}

describe("computeBackoff", () => {
  it("returns baseMs * 2^attempt when no jitter", () => {
    const { computeBackoff } = loadHttp({ random: () => 0 });
    expect(computeBackoff(0, { baseMs: 1000, capMs: 15000, jitter: false })).toBe(1000);
    expect(computeBackoff(1, { baseMs: 1000, capMs: 15000, jitter: false })).toBe(2000);
    expect(computeBackoff(2, { baseMs: 1000, capMs: 15000, jitter: false })).toBe(4000);
  });

  it("caps the delay at capMs", () => {
    const { computeBackoff } = loadHttp({ random: () => 0 });
    expect(computeBackoff(20, { baseMs: 1000, capMs: 5000, jitter: false })).toBe(5000);
  });

  it("applies multiplicative jitter in [0.5, 1.5) when jitter:true", () => {
    const { computeBackoff } = loadHttp({ random: () => 0.5 });
    // base * 2^1 * (0.5 + 0.5) = 2000
    expect(computeBackoff(1, { baseMs: 1000, capMs: 15000, jitter: true })).toBe(2000);
  });

  it("uses default base/cap when opts omitted", () => {
    const { computeBackoff } = loadHttp({ random: () => 0 });
    // With jitter:true defaults, attempt 0 → 1000 * (0.5 + 0) = 500
    const v = computeBackoff(0);
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(15000);
  });
});

describe("retryWithBackoff", () => {
  it("returns the result of the first successful attempt without sleeping", async () => {
    const { retryWithBackoff } = loadHttp();
    const fn = vi.fn().mockResolvedValueOnce("ok");
    const sleep = vi.fn(async () => {});
    const result = await retryWithBackoff(fn, { retries: 3, sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries up to N times on retryable errors and eventually succeeds", async () => {
    const { retryWithBackoff } = loadHttp();
    const err = Object.assign(new Error("boom"), { retryable: true });
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce("ok");
    const sleep = vi.fn(async () => {});
    const result = await retryWithBackoff(fn, { retries: 3, sleep });
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("rethrows the last error after exhausting retries", async () => {
    const { retryWithBackoff } = loadHttp();
    const err = Object.assign(new Error("boom"), { retryable: true });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, { retries: 2, sleep: async () => {} }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does NOT retry when shouldRetry returns false", async () => {
    const { retryWithBackoff } = loadHttp();
    const err = Object.assign(new Error("nope"), { retryable: false });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, { retries: 3, sleep: async () => {} }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never retries STOP_REQUESTED errors", async () => {
    const { retryWithBackoff } = loadHttp();
    const err = new Error("STOP_REQUESTED");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, { retries: 3, sleep: async () => {} }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("never retries when err.isSessionExpired is true", async () => {
    const { retryWithBackoff } = loadHttp();
    const err = Object.assign(new Error("auth"), {
      retryable: true,
      isSessionExpired: true,
    });
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      retryWithBackoff(fn, { retries: 3, sleep: async () => {} }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("uses a custom shouldRetry when provided", async () => {
    const { retryWithBackoff } = loadHttp();
    const err1 = new Error("TIMEOUT: https://x");
    const err2 = new Error("HTTP 500: oops");
    const err3 = new Error("HTTP 400: bad");
    const fn = vi.fn()
      .mockRejectedValueOnce(err1)
      .mockRejectedValueOnce(err2)
      .mockRejectedValueOnce(err3);
    const shouldRetry = (e: Error) =>
      e.message.startsWith("TIMEOUT:") || /HTTP (5\d\d|429)/.test(e.message);
    await expect(
      retryWithBackoff(fn, { retries: 5, sleep: async () => {}, shouldRetry }),
    ).rejects.toBe(err3);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("passes attempt index into fn (0-based)", async () => {
    const { retryWithBackoff } = loadHttp();
    const seen: number[] = [];
    const fn = vi.fn(async (attempt: number) => {
      seen.push(attempt);
      if (attempt < 2) throw Object.assign(new Error("retry"), { retryable: true });
      return "done";
    });
    const result = await retryWithBackoff(fn, { retries: 3, sleep: async () => {} });
    expect(result).toBe("done");
    expect(seen).toEqual([0, 1, 2]);
  });
});
