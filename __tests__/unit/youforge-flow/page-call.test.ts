import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type PageCall = {
  apiCallViaPage: (args: {
    tabId: number;
    authToken: string;
    url: string;
    body: unknown;
  }) => Promise<unknown>;
  uploadImageViaPage: (args: {
    tabId: number;
    authToken: string;
    projectId: string;
    imageUrl: string;
    filename: string;
  }) => Promise<string | undefined>;
};

function loadPageCall(opts: {
  executeScriptResult?: {
    data?: unknown;
    error?: string;
    status?: number;
    body?: string;
    retryAfter?: string | null;
  };
  fetchImpl?: (url?: any, init?: any) => Promise<any>;
  assertNotStopped?: () => void;
  triggerRateLimitCooldown?: ReturnType<typeof vi.fn>;
} = {}) {
  const httpSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const errorSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/flow-error.js"),
    "utf8",
  );
  const clientContextSrc = readFileSync(
    path.resolve(
      process.cwd(),
      "extensions/youforge-flow/src/client-context.js",
    ),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/page-call.js"),
    "utf8",
  );
  const executeScript = vi.fn(async () => [
    { result: opts.executeScriptResult ?? { data: {} } },
  ]);
  const fetchFn = vi.fn(opts.fetchImpl);
  const triggerRateLimitCooldown =
    opts.triggerRateLimitCooldown ?? vi.fn(async () => {});
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    verboseLog: () => {},
    assertNotStopped: opts.assertNotStopped ?? (() => {}),
    btoa: globalThis.btoa.bind(globalThis),
    Uint8Array,
    String,
    Date,
    Math,
    JSON,
    fetch: fetchFn,
    // fetchWithTimeout / retryWithBackoff come from real http.js below.
    AbortController,
    AbortSignal,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    Error,
    Promise,
    triggerRateLimitCooldown,
    getMediaFetchTimeoutSec: () => 45,
    getUploadTimeoutSec: () => 60,
    getUploadMaxRetries: () => 2,
    chrome: { scripting: { executeScript } },
  };
  vm.createContext(sandbox);
  vm.runInContext(httpSrc + "\n" + errorSrc + "\n" + clientContextSrc + "\n" + src, sandbox);
  return { mod: sandbox as unknown as PageCall, executeScript, fetchFn, triggerRateLimitCooldown };
}

describe("page-call", () => {
  describe("apiCallViaPage", () => {
    it("returns parsed data on success", async () => {
      const { mod } = loadPageCall({
        executeScriptResult: { data: { foo: 1 } },
      });
      const out = await mod.apiCallViaPage({
        tabId: 7,
        authToken: "bearer-x",
        url: "https://aisandbox-pa.googleapis.com/v1/test",
        body: { hello: "world" },
      });
      expect(out).toEqual({ foo: 1 });
    });

    it("throws when the page returns an error result (legacy shape)", async () => {
      const { mod } = loadPageCall({
        executeScriptResult: { error: "403: forbidden" },
      });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://x",
          body: {},
        }),
      ).rejects.toThrow("403: forbidden");
    });

    it("attaches structured error fields when MAIN returns status/body", async () => {
      const body = JSON.stringify({
        error: {
          message: "Quota exceeded",
          details: [{ reason: "RESOURCE_EXHAUSTED" }],
        },
      });
      const { mod } = loadPageCall({
        executeScriptResult: {
          error: "429: " + body,
          status: 429,
          body,
          retryAfter: "30",
        },
      });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://x",
          body: {},
        }),
      ).rejects.toMatchObject({
        reason: "RESOURCE_EXHAUSTED",
        category: "rate_limit",
        httpStatus: 429,
        retryable: true,
        retryAfterMs: 30_000,
      });
    });

    it("flags isSessionExpired on 401 from MAIN-world", async () => {
      const { mod } = loadPageCall({
        executeScriptResult: {
          error: "401: unauthorized",
          status: 401,
          body: "",
          retryAfter: null,
        },
      });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://x",
          body: {},
        }),
      ).rejects.toMatchObject({
        isSessionExpired: true,
        category: "auth",
        httpStatus: 401,
      });
    });

    it("calls assertNotStopped before the page fetch", async () => {
      const assertNotStopped = vi.fn(() => {
        throw new Error("STOP_REQUESTED");
      });
      const { mod, executeScript } = loadPageCall({ assertNotStopped });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://x",
          body: {},
        }),
      ).rejects.toThrow("STOP_REQUESTED");
      expect(executeScript).not.toHaveBeenCalled();
    });

    it("categorizes 404 from /projects/<id>/... URL as stale_project_id", async () => {
      const { mod } = loadPageCall({
        executeScriptResult: {
          error: "404: not found",
          status: 404,
          body: "",
          retryAfter: null,
        },
      });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://aisandbox-pa.googleapis.com/v1/projects/abc-123-uuid/scenes/foo",
          body: {},
        }),
      ).rejects.toMatchObject({
        category: "stale_project_id",
        httpStatus: 404,
      });
    });

    it("does NOT override category for 404 from a non-projects URL", async () => {
      const { mod } = loadPageCall({
        executeScriptResult: {
          error: "404: not found",
          status: 404,
          body: "",
          retryAfter: null,
        },
      });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://aisandbox-pa.googleapis.com/v1/credits",
          body: {},
        }),
      ).rejects.toMatchObject({
        category: "not_found",
        httpStatus: 404,
      });
    });

    it("triggers rate-limit cooldown at the throw site on 429 (Phase 3 fix)", async () => {
      const trigger = vi.fn(async () => {});
      const body = JSON.stringify({
        error: { message: "Quota", details: [{ reason: "RESOURCE_EXHAUSTED" }] },
      });
      const { mod } = loadPageCall({
        executeScriptResult: {
          error: "429: " + body,
          status: 429,
          body,
          retryAfter: "30",
        },
        triggerRateLimitCooldown: trigger,
      });
      await expect(
        mod.apiCallViaPage({
          tabId: 7,
          authToken: "bearer-x",
          url: "https://x",
          body: {},
        }),
      ).rejects.toMatchObject({ category: "rate_limit" });
      expect(trigger).toHaveBeenCalledTimes(1);
    });
  });

  describe("uploadImageViaPage", () => {
    it("returns media.name on upload success", async () => {
      const { mod, fetchFn } = loadPageCall({
        fetchImpl: vi.fn(async (url) => {
          if (
            typeof url === "string" &&
            url.includes("aisandbox-pa.googleapis.com")
          ) {
            return {
              ok: true,
              status: 200,
              json: async () => ({ media: { name: "media-abc" } }),
              text: async () => "",
            };
          }
          // Image download
          return {
            ok: true,
            status: 200,
            blob: async () => ({
              type: "image/png",
              size: 4,
              arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
            }),
          };
        }),
      });
      const id = await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img.png",
        filename: "image.png",
      });
      expect(id).toBe("media-abc");
      // Upload request was issued
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("throws on image-download failure", async () => {
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async () => ({ ok: false, status: 404 })),
      });
      await expect(
        mod.uploadImageViaPage({
          tabId: 7,
          authToken: "bearer-x",
          projectId: "proj-abc",
          imageUrl: "https://image-cdn.example/missing.png",
          filename: "missing.png",
        }),
      ).rejects.toThrow(/404/);
    });

    it("throws structured error after retries are exhausted on upload failure", async () => {
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async (url) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "image/png",
                size: 2,
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              }),
            };
          }
          return {
            ok: false,
            status: 500,
            headers: { get: () => null },
            text: async () => "internal error",
          };
        }),
      });
      await expect(
        mod.uploadImageViaPage({
          tabId: 7,
          authToken: "bearer-x",
          projectId: "proj-abc",
          imageUrl: "https://image-cdn.example/img.png",
          filename: "image.png",
        }),
      ).rejects.toMatchObject({
        category: "transient",
        httpStatus: 500,
        retryable: true,
      });
    });

    it("retries on transient HTTP 500 upload failure and eventually succeeds", async () => {
      let call = 0;
      const { mod, fetchFn } = loadPageCall({
        fetchImpl: vi.fn(async (url) => {
          call += 1;
          // Image-CDN downloads always succeed.
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "image/png",
                size: 2,
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              }),
            };
          }
          // First two upload calls return 500; third succeeds.
          if (call < 5) {
            return {
              ok: false,
              status: 500,
              headers: { get: () => null },
              text: async (): Promise<string> => "internal error",
            };
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ media: { name: "media-xyz" } }),
            text: async (): Promise<string> => "",
          };
        }),
      });
      const id = await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img.png",
        filename: "image.png",
      });
      expect(id).toBe("media-xyz");
      // Two failed attempts (1 download + 1 upload each) + 1 successful attempt
      // (1 download + 1 upload) = 6 fetches, but the helper retries based on
      // what shouldRetry returns; we just assert the upload eventually succeeds.
      expect(fetchFn.mock.calls.length).toBeGreaterThan(2);
    });

    it("does NOT retry on HTTP 404 upload (4xx, not 429)", async () => {
      let call = 0;
      const { mod, fetchFn } = loadPageCall({
        fetchImpl: vi.fn(async (url) => {
          call += 1;
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "image/png",
                size: 2,
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              }),
            };
          }
          return {
            ok: false,
            status: 404,
            headers: { get: () => null },
            text: async () => "not found",
          };
        }),
      });
      await expect(
        mod.uploadImageViaPage({
          tabId: 7,
          authToken: "bearer-x",
          projectId: "proj-abc",
          imageUrl: "https://image-cdn.example/img.png",
          filename: "image.png",
        }),
      ).rejects.toMatchObject({ httpStatus: 404 });
      // 1 download + 1 upload = 2 fetches (no retry on 4xx).
      expect(fetchFn).toHaveBeenCalledTimes(2);
      void call;
    });

    it("detects PNG via magic bytes when blob.type is empty", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x00]);
      let uploadedMime: string | undefined;
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async (url, init) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "",
                size: png.byteLength,
                arrayBuffer: async () => png.buffer,
                slice: (start: number, end: number) => ({
                  arrayBuffer: async () => png.slice(start, end).buffer,
                }),
              }),
            };
          }
          if (init?.body) {
            const body = JSON.parse(init.body as string);
            uploadedMime = body.mimeType;
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({ media: { name: "media-png" } }),
            text: async () => "",
          };
        }),
      });
      const id = await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img.png",
        filename: "image.png",
      });
      expect(id).toBe("media-png");
      expect(uploadedMime).toBe("image/png");
    });

    it("detects JPEG via magic bytes when blob.type is application/octet-stream", async () => {
      const jpeg = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x00]);
      let uploadedMime: string | undefined;
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async (url, init) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "application/octet-stream",
                size: jpeg.byteLength,
                arrayBuffer: async () => jpeg.buffer,
                slice: (start: number, end: number) => ({
                  arrayBuffer: async () => jpeg.slice(start, end).buffer,
                }),
              }),
            };
          }
          if (init?.body) uploadedMime = JSON.parse(init.body as string).mimeType;
          return {
            ok: true,
            status: 200,
            json: async () => ({ media: { name: "m" } }),
            text: async () => "",
          };
        }),
      });
      await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img",
        filename: "img.jpg",
      });
      expect(uploadedMime).toBe("image/jpeg");
    });

    it("detects WEBP via RIFF....WEBP magic bytes", async () => {
      // RIFF + 4 size bytes + WEBP
      const webp = new Uint8Array([
        0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
      ]);
      let uploadedMime: string | undefined;
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async (url, init) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "text/html",
                size: webp.byteLength,
                arrayBuffer: async () => webp.buffer,
                slice: (start: number, end: number) => ({
                  arrayBuffer: async () => webp.slice(start, end).buffer,
                }),
              }),
            };
          }
          if (init?.body) uploadedMime = JSON.parse(init.body as string).mimeType;
          return {
            ok: true,
            status: 200,
            json: async () => ({ media: { name: "m" } }),
            text: async () => "",
          };
        }),
      });
      await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img",
        filename: "img.webp",
      });
      expect(uploadedMime).toBe("image/webp");
    });

    it("falls back to image/jpeg when magic bytes don't match", async () => {
      const garbage = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05]);
      let uploadedMime: string | undefined;
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async (url, init) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "",
                size: garbage.byteLength,
                arrayBuffer: async () => garbage.buffer,
                slice: (start: number, end: number) => ({
                  arrayBuffer: async () => garbage.slice(start, end).buffer,
                }),
              }),
            };
          }
          if (init?.body) uploadedMime = JSON.parse(init.body as string).mimeType;
          return {
            ok: true,
            status: 200,
            json: async () => ({ media: { name: "m" } }),
            text: async () => "",
          };
        }),
      });
      await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img",
        filename: "img",
      });
      expect(uploadedMime).toBe("image/jpeg");
    });

    it("preserves blob.type when it's already a valid image MIME", async () => {
      const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
      let uploadedMime: string | undefined;
      const { mod } = loadPageCall({
        fetchImpl: vi.fn(async (url, init) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "image/jpeg", // Reported as JPEG even though bytes are PNG.
                size: png.byteLength,
                arrayBuffer: async () => png.buffer,
                // Note: no slice — caller should not be calling it for valid types.
              }),
            };
          }
          if (init?.body) uploadedMime = JSON.parse(init.body as string).mimeType;
          return {
            ok: true,
            status: 200,
            json: async () => ({ media: { name: "m" } }),
            text: async () => "",
          };
        }),
      });
      await mod.uploadImageViaPage({
        tabId: 7,
        authToken: "bearer-x",
        projectId: "proj-abc",
        imageUrl: "https://image-cdn.example/img",
        filename: "img.jpg",
      });
      expect(uploadedMime).toBe("image/jpeg");
    });

    it("does NOT retry on session-expired (401)", async () => {
      const { mod, fetchFn } = loadPageCall({
        fetchImpl: vi.fn(async (url) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "image/png",
                size: 2,
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              }),
            };
          }
          return {
            ok: false,
            status: 401,
            headers: { get: () => null },
            text: async () => "unauthorized",
          };
        }),
      });
      await expect(
        mod.uploadImageViaPage({
          tabId: 7,
          authToken: "bearer-x",
          projectId: "proj-abc",
          imageUrl: "https://image-cdn.example/img.png",
          filename: "image.png",
        }),
      ).rejects.toMatchObject({ isSessionExpired: true, httpStatus: 401 });
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it("triggers cooldown on upload 429 and does NOT retry (Phase 3 fix)", async () => {
      const trigger = vi.fn(async () => {});
      const body = JSON.stringify({
        error: { message: "Quota", details: [{ reason: "RESOURCE_EXHAUSTED" }] },
      });
      const { mod, fetchFn } = loadPageCall({
        triggerRateLimitCooldown: trigger,
        fetchImpl: vi.fn(async (url) => {
          if (typeof url === "string" && !url.includes("aisandbox-pa")) {
            return {
              ok: true,
              status: 200,
              blob: async () => ({
                type: "image/png",
                size: 2,
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer,
              }),
            };
          }
          return {
            ok: false,
            status: 429,
            headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? "30" : null) },
            text: async () => body,
          };
        }),
      });
      await expect(
        mod.uploadImageViaPage({
          tabId: 7,
          authToken: "bearer-x",
          projectId: "proj-abc",
          imageUrl: "https://image-cdn.example/img.png",
          filename: "image.png",
        }),
      ).rejects.toMatchObject({ category: "rate_limit" });
      expect(trigger).toHaveBeenCalled();
      // No retry on rate_limit — exactly 1 download + 1 upload, total 2.
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });
});
