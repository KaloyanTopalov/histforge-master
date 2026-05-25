import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type FlowApi = {
  checkVideoStatus: (
    authToken: string,
    mediaIds: Array<{ name: string } | string>,
  ) => Promise<unknown[]>;
  getCredits: (authToken: string) => Promise<unknown>;
  sessionExpiredError: (endpoint: string) => Error & { isSessionExpired: true };
};

function makeHeaders(headers: Record<string, string> = {}) {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return { get: (name: string) => lower[name.toLowerCase()] ?? null };
}

function loadFlowApi(opts: {
  fetchImpl?: (url: string, init?: RequestInit) => Promise<unknown>;
  triggerRateLimitCooldown?: ReturnType<typeof vi.fn>;
}) {
  const errorSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/flow-error.js"),
    "utf8",
  );
  const apiSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/flow-api.js"),
    "utf8",
  );
  const fetchFn = vi.fn(opts.fetchImpl);
  const triggerRateLimitCooldown =
    opts.triggerRateLimitCooldown ?? vi.fn(async () => {});
  const sandbox: Record<string, unknown> = {
    console: { log: () => {}, error: () => {} },
    safeLog: () => {},
    verboseLog: () => {},
    fetch: fetchFn,
    fetchWithTimeout: (url: string, init: RequestInit) => fetchFn(url, init),
    triggerRateLimitCooldown,
    getVideoRequestTimeoutSec: () => 60,
    getImageRequestTimeoutSec: () => 30,
    Date,
    Math,
    JSON,
    String,
  };
  vm.createContext(sandbox);
  vm.runInContext(errorSrc + "\n" + apiSrc, sandbox);
  return { mod: sandbox as unknown as FlowApi, fetchFn, triggerRateLimitCooldown };
}

describe("flow-api stale-project-id detection", () => {
  it("categorizes 404 from /projects/<id>/... URL as stale_project_id", async () => {
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 404,
        ok: false,
        url: "https://aisandbox-pa.googleapis.com/v1/projects/abc-uuid/scenes/foo",
        headers: makeHeaders(),
        text: async () => "not found",
        json: async () => ({}),
      }),
    });
    await expect(
      mod.checkVideoStatus("bearer-x", ["m1"]),
    ).rejects.toMatchObject({
      category: "stale_project_id",
      httpStatus: 404,
    });
  });

  it("does NOT override category for 404 from a non-projects URL", async () => {
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 404,
        ok: false,
        url: "https://aisandbox-pa.googleapis.com/v1/credits",
        headers: makeHeaders(),
        text: async () => "not found",
        json: async () => ({}),
      }),
    });
    await expect(
      mod.checkVideoStatus("bearer-x", ["m1"]),
    ).rejects.toMatchObject({
      category: "not_found",
      httpStatus: 404,
    });
  });
});

describe("flow-api checkVideoStatus error mapping", () => {
  it("throws session-expired error on 401 with structured fields", async () => {
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 401,
        ok: false,
        headers: makeHeaders(),
        text: async () => "",
        json: async () => ({}),
      }),
    });
    await expect(
      mod.checkVideoStatus("bearer-x", ["m1"]),
    ).rejects.toMatchObject({
      isSessionExpired: true,
      httpStatus: 401,
      category: "auth",
    });
  });

  it("throws rate-limit categorized error on 429 with RESOURCE_EXHAUSTED", async () => {
    const body = {
      error: {
        message: "Quota exceeded",
        details: [{ reason: "RESOURCE_EXHAUSTED" }],
      },
    };
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 429,
        ok: false,
        headers: makeHeaders({ "retry-after": "30" }),
        text: async () => JSON.stringify(body),
        json: async () => body,
      }),
    });
    await expect(
      mod.checkVideoStatus("bearer-x", ["m1"]),
    ).rejects.toMatchObject({
      reason: "RESOURCE_EXHAUSTED",
      category: "rate_limit",
      httpStatus: 429,
      retryable: true,
      retryAfterMs: 30_000,
    });
  });

  it("throws transient categorized error on 5xx", async () => {
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 503,
        ok: false,
        headers: makeHeaders(),
        text: async () => "Service Unavailable",
        json: async () => ({}),
      }),
    });
    await expect(
      mod.checkVideoStatus("bearer-x", ["m1"]),
    ).rejects.toMatchObject({
      category: "transient",
      retryable: true,
      httpStatus: 503,
    });
  });

  it("triggers rate-limit cooldown at the throw site on 429 (Phase 3 fix)", async () => {
    const trigger = vi.fn(async (_arg: { retryAfterMs: number; category: string }) => {});
    const body = {
      error: { message: "Quota", details: [{ reason: "RESOURCE_EXHAUSTED" }] },
    };
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 429,
        ok: false,
        headers: makeHeaders({ "retry-after": "30" }),
        text: async () => JSON.stringify(body),
        json: async () => body,
      }),
      triggerRateLimitCooldown: trigger,
    });
    await expect(mod.checkVideoStatus("bearer-x", ["m1"])).rejects.toMatchObject({
      category: "rate_limit",
    });
    expect(trigger).toHaveBeenCalledTimes(1);
    const arg = trigger.mock.calls[0]![0] as {
      retryAfterMs: number;
      category: string;
    };
    expect(arg.category).toBe("rate_limit");
    expect(arg.retryAfterMs).toBe(30_000);
  });

  it("does NOT trigger cooldown on a non-rate-limit failure", async () => {
    const trigger = vi.fn(async () => {});
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 503,
        ok: false,
        headers: makeHeaders(),
        text: async () => "down",
        json: async () => ({}),
      }),
      triggerRateLimitCooldown: trigger,
    });
    await expect(mod.checkVideoStatus("bearer-x", ["m1"])).rejects.toMatchObject({
      category: "transient",
    });
    expect(trigger).not.toHaveBeenCalled();
  });

  it("returns parsed media list on success (operations-shape response)", async () => {
    const { mod } = loadFlowApi({
      fetchImpl: async () => ({
        status: 200,
        ok: true,
        headers: makeHeaders(),
        text: async () => "",
        json: async () => ({
          operations: [
            {
              operation: {
                name: "m1",
                metadata: {
                  video: { fifeUrl: "https://x/y" },
                  mediaGenerationStatus: "MEDIA_GENERATION_STATUS_SUCCESSFUL",
                },
              },
            },
          ],
        }),
      }),
    });
    const out = await mod.checkVideoStatus("bearer-x", [{ name: "m1" }]);
    expect(out).toHaveLength(1);
    expect((out[0] as { url: string }).url).toBe("https://x/y");
  });
});
