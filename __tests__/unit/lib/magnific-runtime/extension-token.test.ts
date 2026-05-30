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
  configureAndStartExtension,
  sendStopPolling,
  ExtensionIdResolutionError,
  ExtensionConfigurationError,
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

describe("configureAndStartExtension", () => {
  it("sends updateWebhooks (camelCase magnificToken + URLs derived from baseUrl) then startPolling, in that order", async () => {
    // Two evaluate calls — first updateWebhooks, then startPolling — so the
    // ordering pin is observable from outside the page boundary. The recover
    // route used one evaluate with both sendMessage's inline; splitting them
    // is the test-visible structural form.
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn();
    evaluate.mockResolvedValueOnce({ success: true }); // updateWebhooks
    evaluate.mockResolvedValueOnce({ success: true }); // startPolling
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    await configureAndStartExtension(ctx, "http://example.test", "tok-xyz");

    expect(goto).toHaveBeenCalledTimes(1);
    expect(goto).toHaveBeenCalledWith(
      `chrome-extension://${EXPECTED_EXT_ID}/blank.html`,
    );
    expect(evaluate).toHaveBeenCalledTimes(2);

    // First call: updateWebhooks. CamelCase magnificToken (matches what the
    // extension's settings cache reads on settings.js:111-112) and the four
    // URLs recomputed from baseUrl + token.
    const updateArgs = evaluate.mock.calls[0][1] as Record<string, unknown>;
    expect(updateArgs).toEqual({
      action: "updateWebhooks",
      magnificToken: "tok-xyz",
      histforgeDomain: "http://example.test",
      nextTaskUrl: "http://example.test/api/magnific/next-task/tok-xyz",
      submitResultUrl: "http://example.test/api/magnific/submit-result/tok-xyz",
      statusUrl: "http://example.test/api/magnific/status/tok-xyz",
      queueSummaryUrl: "http://example.test/api/magnific/queue-summary",
    });

    // Second call: startPolling, no payload.
    const startArgs = evaluate.mock.calls[1][1] as Record<string, unknown>;
    expect(startArgs).toEqual({ action: "startPolling" });

    expect(close).toHaveBeenCalledTimes(1);
  });

  it("throws ExtensionConfigurationError when updateWebhooks returns {success:false} and does NOT send startPolling", async () => {
    // Failure-loud: a router-side updateWebhooks failure must surface as a
    // hard error, NOT silently fall back to unconfigured polling. The
    // startPolling message must not be sent after a failed configure.
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn();
    evaluate.mockResolvedValueOnce({
      success: false,
      error: "router boom",
    }); // updateWebhooks fails
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    let caught: unknown;
    try {
      await configureAndStartExtension(ctx, "http://example.test", "tok-xyz");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtensionConfigurationError);
    expect((caught as Error).message).toContain("router boom");
    // startPolling was NEVER sent — the helper returned at the failure check.
    expect(evaluate).toHaveBeenCalledTimes(1);
    // Page still closes on the failure path.
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("wraps a transport-level evaluate failure in ExtensionConfigurationError and still closes the page", async () => {
    // Distinct from router-failure: if page.evaluate itself throws (e.g.
    // the page navigated away mid-call), the helper still surfaces a
    // single error class to the caller so runtime.start has one catch.
    const transportErr = new Error("evaluate transport boom");
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => {
      throw transportErr;
    });
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    let caught: unknown;
    try {
      await configureAndStartExtension(ctx, "http://example.test", "tok-xyz");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExtensionConfigurationError);
    expect((caught as ExtensionConfigurationError).cause).toBe(transportErr);
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("sendStopPolling", () => {
  it("opens blank.html and posts stopPolling to the SW", async () => {
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => ({ success: true }));
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    await sendStopPolling(ctx);

    expect(goto).toHaveBeenCalledWith(
      `chrome-extension://${EXPECTED_EXT_ID}/blank.html`,
    );
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][1]).toEqual({ action: "stopPolling" });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows transport failures and still closes the page", async () => {
    // The runtime.stop() path uses sendStopPolling as a soft signal — if
    // the SW is already dead or the page navigation fails, the caller
    // proceeds to ctx.close() regardless. Swallowing here keeps that
    // contract self-contained in this helper.
    const goto = vi.fn(async () => undefined);
    const evaluate = vi.fn(async () => {
      throw new Error("sw dead");
    });
    const close = vi.fn(async () => undefined);
    const ctx = mockContext({
      serviceWorkers: [],
      pageFactory: () => ({ goto, evaluate, close }),
    });

    await expect(sendStopPolling(ctx)).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows resolveExtensionId failures and returns undefined", async () => {
    // Both manifest read and SW scan return nothing — resolveExtensionId
    // throws. sendStopPolling must not propagate; the caller (stop) needs
    // to keep going to ctx.close().
    mockReadFileSync.mockReturnValueOnce(JSON.stringify({}));
    const ctx = mockContext({ serviceWorkers: [] });

    await expect(sendStopPolling(ctx)).resolves.toBeUndefined();
  });
});
