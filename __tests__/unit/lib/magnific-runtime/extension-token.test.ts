import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import type { BrowserContext } from "playwright";

// Hoisted: build a fresh vi.fn() for readFileSync. Default impl in
// beforeEach delegates to the real fs so test 1 (live manifest) works;
// tests 2/3 override per-call with mockReturnValueOnce.
const { mockReadFileSync, realReadFileSync } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const realFs = require("node:fs") as typeof import("node:fs");
  return {
    mockReadFileSync: vi.fn(),
    realReadFileSync: realFs.readFileSync,
  };
});

// Override BOTH the top-level named export AND `default.readFileSync` —
// esbuild's CJS interop binds `import { readFileSync } from "node:fs"` to
// the default export's property on this codebase's TS compile target, so
// mocking only the top-level export silently doesn't intercept the SUT.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    default: { ...actual, readFileSync: mockReadFileSync },
    readFileSync: mockReadFileSync,
  };
});

import {
  resolveExtensionId,
  injectToken,
  ExtensionIdResolutionError,
  TokenInjectionError,
} from "@/lib/magnific-runtime/extension-token";

// Hard-coded fixture: the deterministic extension ID that S1's manifest
// "key" must produce. If `resolveExtensionId` returns anything else
// against the live manifest, EITHER:
//   (a) the manifest "key" changed since S1 (re-check
//       docs/magnific-ext-key-rotation.md "Current extension ID"), OR
//   (b) `resolveExtensionId` is broken (or its DER decode / SHA-256 /
//       nibble-remap step is wrong).
// The failure message below surfaces both possibilities.
const EXPECTED_EXT_ID = "blkhajpjohgopchihlaeeagamopdpfmd";

const MANIFEST_PATH = path.resolve(
  process.cwd(),
  "extensions/magnific-ext/manifest.json",
);

type MockedSW = { url: () => string };

function mockContext(opts: {
  serviceWorkers?: MockedSW[];
  pageFactory?: () => unknown;
}): BrowserContext {
  return {
    serviceWorkers: () => opts.serviceWorkers ?? [],
    newPage: opts.pageFactory ?? (async () => ({})),
  } as unknown as BrowserContext;
}

beforeEach(() => {
  // Default: delegate to real fs so test 1's live-manifest read works.
  mockReadFileSync.mockImplementation((p: Parameters<typeof realReadFileSync>[0], e: Parameters<typeof realReadFileSync>[1]) =>
    realReadFileSync(p, e),
  );
});

afterEach(() => {
  mockReadFileSync.mockReset();
});

describe("resolveExtensionId", () => {
  it("derives the documented ID from the live manifest \"key\"", async () => {
    // Sanity: the test fixture's expectation references the real shipped key.
    // If this read fails the test environment is misconfigured, not the code.
    const liveManifest = JSON.parse(realReadFileSync(MANIFEST_PATH, "utf-8") as string);
    expect(typeof liveManifest.key).toBe("string");

    const ctx = mockContext({ serviceWorkers: [] });
    const id = await resolveExtensionId(ctx);

    if (id !== EXPECTED_EXT_ID) {
      throw new Error(
        `extension ID mismatch:\n` +
          `  computed = ${id}\n` +
          `  expected = ${EXPECTED_EXT_ID}\n` +
          `EITHER resolveExtensionId is broken OR the manifest "key" changed since S1.\n` +
          `Re-check docs/magnific-ext-key-rotation.md "Current extension ID".`,
      );
    }
    expect(id).toBe(EXPECTED_EXT_ID);
  });

  it("falls back to scanning service workers when the manifest has no \"key\"", async () => {
    const fakeId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const manifestWithoutKey = JSON.stringify({ manifest_version: 3, name: "x" });
    mockReadFileSync.mockReturnValueOnce(manifestWithoutKey);

    const ctx = mockContext({
      serviceWorkers: [{ url: () => `chrome-extension://${fakeId}/background.js` }],
    });
    const id = await resolveExtensionId(ctx);
    expect(id).toBe(fakeId);
  });

  it("throws ExtensionIdResolutionError when both paths fail", async () => {
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({}));

    const ctx = mockContext({ serviceWorkers: [] });
    await expect(resolveExtensionId(ctx)).rejects.toBeInstanceOf(
      ExtensionIdResolutionError,
    );
  });
});

describe("injectToken", () => {
  it("opens the bridge page at the right URL, evaluates the storage write, and closes the page", async () => {
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const pageFactory = (): unknown => ({ goto, evaluate, close });
    const ctx = mockContext({ serviceWorkers: [], pageFactory });

    const result = await injectToken(ctx, "my-token");

    expect(result).toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith(
      `chrome-extension://${EXPECTED_EXT_ID}/blank.html`,
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(typeof evaluate.mock.calls[0][0]).toBe("function");
    expect(evaluate.mock.calls[0][1]).toBe("my-token");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps a page.goto failure in TokenInjectionError and still closes the page", async () => {
    const gotoErr = new Error("nav failed");
    const goto = vi.fn(async () => {
      throw gotoErr;
    });
    const evaluate = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    let caught: unknown;
    try {
      await injectToken(ctx, "tok");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TokenInjectionError);
    expect((caught as TokenInjectionError).cause).toBe(gotoErr);
    expect(evaluate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps a page.evaluate failure in TokenInjectionError and still closes the page", async () => {
    const evalErr = new Error("eval blew up");
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => {
      throw evalErr;
    });
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    let caught: unknown;
    try {
      await injectToken(ctx, "tok");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TokenInjectionError);
    expect((caught as TokenInjectionError).cause).toBe(evalErr);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
