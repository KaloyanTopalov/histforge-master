import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type MediaFile = {
  base64: string;
  mimeType: string;
  size: number;
  originalUrl: string;
};

type MediaFetch = {
  fetchMediaFiles: (resultUrl: string) => Promise<MediaFile[]>;
  fetchImageAsBase64: (imageUrl: string) => Promise<{
    success: boolean;
    base64?: string;
    type?: string;
    size?: number;
    error?: string;
  }>;
};

function loadMediaFetch(opts: {
  tabs?: Array<{ id: number }>;
  executeResults?: Array<{ base64?: string; mimeType?: string; size?: number; error?: string }>;
  stopAfter?: number;
  fetchImpl?: (url: string) => Promise<Response | { ok: boolean; status?: number; blob?: () => Promise<Blob> }>;
} = {}) {
  const httpSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/media-fetch.js"),
    "utf8",
  );
  let callIdx = 0;
  const executeScript = vi.fn(async () => {
    const result = opts.executeResults?.[callIdx] ?? { base64: "b64data", mimeType: "image/png", size: 6 };
    callIdx += 1;
    return [{ result }];
  });
  let stopCalls = 0;
  const getStopFlag = vi.fn(() => {
    stopCalls += 1;
    return opts.stopAfter !== undefined && stopCalls > opts.stopAfter;
  });
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    getStopFlag,
    getMediaFetchTimeoutSec: () => 45,
    fetch: vi.fn(opts.fetchImpl),
    // fetchWithTimeout / retryWithBackoff come from real http.js below.
    AbortController,
    AbortSignal,
    clearTimeout: () => {},
    Error,
    FileReader: class {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(blob: { _base64: string; type: string }) {
        this.result = `data:${blob.type};base64,${blob._base64}`;
        if (this.onloadend) this.onloadend();
      }
    },
    chrome: {
      tabs: {
        query: vi.fn(async () => opts.tabs ?? [{ id: 1 }]),
      },
      scripting: { executeScript },
    },
    setTimeout: (fn: () => void) => {
      fn();
      return 0;
    },
    Math,
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(httpSrc + "\n" + src, sandbox);
  return { mod: sandbox as unknown as MediaFetch, executeScript, getStopFlag };
}

describe("fetchMediaFiles", () => {
  it("returns [] when no Flow tab is open", async () => {
    const ctx = loadMediaFetch({ tabs: [] });
    const files = await ctx.mod.fetchMediaFiles("https://image.com/a.png");
    expect(files).toEqual([]);
    expect(ctx.executeScript).not.toHaveBeenCalled();
  });

  it("fetches a single http URL via MAIN world", async () => {
    const ctx = loadMediaFetch({
      executeResults: [{ base64: "AAAA", mimeType: "image/png", size: 3 }],
    });
    const files = await ctx.mod.fetchMediaFiles("https://image.com/a.png");
    expect(files).toEqual([
      { base64: "AAAA", mimeType: "image/png", size: 3, originalUrl: "https://image.com/a.png" },
    ]);
    expect(ctx.executeScript).toHaveBeenCalledTimes(1);
  });

  it("handles comma-separated http URLs", async () => {
    const ctx = loadMediaFetch({
      executeResults: [
        { base64: "AAAA", mimeType: "image/png", size: 3 },
        { base64: "BBBB", mimeType: "image/png", size: 3 },
      ],
    });
    const files = await ctx.mod.fetchMediaFiles("https://a.com/x.png,https://b.com/y.png");
    expect(files.map((f) => f.originalUrl)).toEqual([
      "https://a.com/x.png",
      "https://b.com/y.png",
    ]);
  });

  it("extracts base64 from a data: URL without a MAIN-world fetch", async () => {
    const ctx = loadMediaFetch();
    const files = await ctx.mod.fetchMediaFiles("data:image/jpeg;base64,XYZDATA");
    expect(files).toEqual([
      { base64: "XYZDATA", mimeType: "image/jpeg", size: Math.round("XYZDATA".length * 3 / 4), originalUrl: "(upscaled-image)" },
    ]);
    expect(ctx.executeScript).not.toHaveBeenCalled();
  });

  it("rejoins a data: URL that was split on its internal comma", async () => {
    const ctx = loadMediaFetch();
    const files = await ctx.mod.fetchMediaFiles("data:image/jpeg;base64,XYZDATA");
    expect(files).toHaveLength(1);
    expect(files[0].base64).toBe("XYZDATA");
    expect(files[0].mimeType).toBe("image/jpeg");
  });

  it("retries up to 3 times on MAIN-world fetch failure", async () => {
    const ctx = loadMediaFetch({
      executeResults: [
        { error: "HTTP 500" },
        { error: "HTTP 500" },
        { error: "HTTP 500" },
        { base64: "C", mimeType: "image/png", size: 1 },
      ],
    });
    const files = await ctx.mod.fetchMediaFiles("https://image.com/a.png");
    expect(files).toHaveLength(1);
    // retries: 3 → initial + 3 retries = 4 attempts.
    expect(ctx.executeScript).toHaveBeenCalledTimes(4);
  });

  describe("fetchImageAsBase64", () => {
    it("returns base64 + size on success", async () => {
      const ctx = loadMediaFetch({
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          blob: async () => ({ _base64: "AAAA", type: "image/png", size: 3 } as unknown as Blob),
        }),
      });
      const out = await ctx.mod.fetchImageAsBase64("https://img.com/a.png");
      expect(out).toEqual({
        success: true,
        base64: "data:image/png;base64,AAAA",
        type: "image/png",
        size: 3,
      });
    });

    it("returns success:false when the fetch response is not ok", async () => {
      const ctx = loadMediaFetch({
        fetchImpl: async () => ({ ok: false, status: 404 }),
      });
      const out = await ctx.mod.fetchImageAsBase64("https://img.com/missing.png");
      expect(out.success).toBe(false);
      expect(out.error).toMatch(/404/);
    });

    it("returns success:false when fetch throws", async () => {
      const ctx = loadMediaFetch({
        fetchImpl: async () => {
          throw new Error("network flake");
        },
      });
      const out = await ctx.mod.fetchImageAsBase64("https://img.com/x.png");
      expect(out.success).toBe(false);
      expect(out.error).toBe("network flake");
    });
  });

  it("gives up after exhausting retries and continues with other URLs", async () => {
    const ctx = loadMediaFetch({
      executeResults: [
        { error: "HTTP 500" },
        { error: "HTTP 500" },
        { error: "HTTP 500" },
        { error: "HTTP 500" },
        { base64: "D", mimeType: "image/png", size: 1 },
      ],
    });
    const files = await ctx.mod.fetchMediaFiles(
      "https://fail.com/a.png,https://b.com/b.png",
    );
    expect(files).toHaveLength(1);
    expect(files[0].originalUrl).toBe("https://b.com/b.png");
  });
});
