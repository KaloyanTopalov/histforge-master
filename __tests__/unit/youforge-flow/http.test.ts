import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type HttpModule = {
  fetchWithTimeout: (
    url: string,
    options: RequestInit | undefined,
    timeoutMs: number,
  ) => Promise<Response>;
};

function loadHttp(opts: {
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const fetchFn = vi.fn(opts.fetchImpl ?? (async () => ({ ok: true } as Response)));
  // Track setTimeout/clearTimeout calls so we can assert cleanup.
  const timers: { id: number; fn: () => void; ms: number; cleared: boolean }[] = [];
  let nextId = 1;
  const setTimeoutFn = vi.fn((fn: () => void, ms: number) => {
    const id = nextId++;
    timers.push({ id, fn, ms, cleared: false });
    return id;
  });
  const clearTimeoutFn = vi.fn((id: number) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  });
  const sandbox: Record<string, unknown> = {
    fetch: fetchFn,
    setTimeout: setTimeoutFn,
    clearTimeout: clearTimeoutFn,
    AbortController,
    AbortSignal,
    Promise,
    Error,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as HttpModule,
    fetchFn,
    setTimeoutFn,
    clearTimeoutFn,
    timers,
    fireTimer: (id: number) => {
      const t = timers.find((x) => x.id === id);
      if (t && !t.cleared) t.fn();
    },
  };
}

describe("fetchWithTimeout", () => {
  it("forwards url and options to fetch and resolves with the response", async () => {
    const fakeResponse = { ok: true, status: 200 } as unknown as Response;
    const ctx = loadHttp({ fetchImpl: async () => fakeResponse });

    const result = await ctx.mod.fetchWithTimeout(
      "https://example.com/x",
      { method: "POST", body: "hi" },
      5000,
    );

    expect(result).toBe(fakeResponse);
    expect(ctx.fetchFn).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = ctx.fetchFn.mock.calls[0];
    expect(calledUrl).toBe("https://example.com/x");
    expect(calledOpts!.method).toBe("POST");
    expect(calledOpts!.body).toBe("hi");
    expect(calledOpts!.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts the underlying fetch when the timeout fires", async () => {
    let signalSeen: AbortSignal | undefined;
    let resolveFetch: (r: Response) => void = () => {};
    const ctx = loadHttp({
      fetchImpl: (_url, opts) => {
        signalSeen = opts.signal as AbortSignal;
        return new Promise<Response>((resolve, reject) => {
          resolveFetch = resolve;
          (signalSeen as AbortSignal).addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        });
      },
    });

    const promise = ctx.mod.fetchWithTimeout(
      "https://hung.example/",
      undefined,
      1000,
    );

    expect(signalSeen).toBeInstanceOf(AbortSignal);
    expect(signalSeen!.aborted).toBe(false);
    expect(ctx.setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 1000);

    const timerId = ctx.setTimeoutFn.mock.results[0].value as number;
    ctx.fireTimer(timerId);

    expect(signalSeen!.aborted).toBe(true);
    await expect(promise).rejects.toThrow(/^TIMEOUT: https:\/\/hung\.example/);
    void resolveFetch;
  });

  it("clears the timeout when the fetch resolves normally", async () => {
    const ctx = loadHttp();
    await ctx.mod.fetchWithTimeout("https://ok.example/", undefined, 5000);

    const timerId = ctx.setTimeoutFn.mock.results[0].value as number;
    expect(ctx.clearTimeoutFn).toHaveBeenCalledWith(timerId);
    expect(ctx.timers[0].cleared).toBe(true);
  });

  it("re-throws non-abort errors unchanged", async () => {
    const networkErr = new TypeError("network down");
    const ctx = loadHttp({ fetchImpl: async () => { throw networkErr; } });

    await expect(
      ctx.mod.fetchWithTimeout("https://x.example/", undefined, 1000),
    ).rejects.toBe(networkErr);
  });

  it("converts AbortError into a TIMEOUT error mentioning the URL", async () => {
    const ctx = loadHttp({
      fetchImpl: async () => {
        const err = new Error("The user aborted a request.");
        err.name = "AbortError";
        throw err;
      },
    });

    await expect(
      ctx.mod.fetchWithTimeout("https://abort.example/path", undefined, 1000),
    ).rejects.toThrow(/^TIMEOUT: https:\/\/abort\.example\/path/);
  });
});
