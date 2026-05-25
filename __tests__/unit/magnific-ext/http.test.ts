import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Http = {
  fetchWithTimeout: (
    url: string,
    options: RequestInit,
    timeoutMs: number,
  ) => Promise<Response>;
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
      sleep?: (ms: number) => Promise<void>;
      shouldRetry?: (e: unknown) => boolean;
    },
  ) => Promise<T>;
};

function loadHttp(sandbox: Record<string, unknown> = {}): Http {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/http.js"),
    "utf8",
  );
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as Http;
}

describe("magnific-ext fetchWithTimeout", () => {
  it("returns the fetch response when it resolves before the timeout", async () => {
    const fakeRes = { ok: true } as Response;
    const sandbox: Record<string, unknown> = {
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn(async () => fakeRes),
    };
    const { fetchWithTimeout } = loadHttp(sandbox);
    const res = await fetchWithTimeout("https://example.com", {}, 1000);
    expect(res).toBe(fakeRes);
  });

  it("rewraps AbortError as TIMEOUT: <url>", async () => {
    const sandbox: Record<string, unknown> = {
      AbortController,
      setTimeout,
      clearTimeout,
      fetch: vi.fn(async () => {
        const err = new Error("aborted");
        (err as { name: string }).name = "AbortError";
        throw err;
      }),
    };
    const { fetchWithTimeout } = loadHttp(sandbox);
    await expect(
      fetchWithTimeout("https://magnific.example/poll", {}, 100),
    ).rejects.toThrow(/^TIMEOUT: https:\/\/magnific\.example\/poll$/);
  });
});

describe("magnific-ext retryWithBackoff", () => {
  it("returns on first success", async () => {
    const fn = vi.fn(async () => "ok");
    const { retryWithBackoff } = loadHttp({ setTimeout });
    const out = await retryWithBackoff(fn, { retries: 2, sleep: async () => {} });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries when shouldRetry says so, gives up after `retries`", async () => {
    const fn = vi.fn(async () => {
      throw new Error("temporary");
    });
    const { retryWithBackoff } = loadHttp({ setTimeout });
    await expect(
      retryWithBackoff(fn, {
        retries: 2,
        sleep: async () => {},
        shouldRetry: () => true,
      }),
    ).rejects.toThrow("temporary");
    expect(fn).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("never retries STOP_REQUESTED", async () => {
    const fn = vi.fn(async () => {
      throw new Error("STOP_REQUESTED");
    });
    const { retryWithBackoff } = loadHttp({ setTimeout });
    await expect(
      retryWithBackoff(fn, { retries: 3, sleep: async () => {}, shouldRetry: () => true }),
    ).rejects.toThrow("STOP_REQUESTED");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
