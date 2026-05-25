import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type SelfTest = {
  runSelfTest: () => Promise<{
    ok: boolean;
    checks: Array<{
      name: string;
      status: "pass" | "fail" | "skip";
      detail?: string;
    }>;
  }>;
};

function loadSelfTest(opts: {
  tabsQuery?: Array<{ id: number }>;
  sessionToken?: string | null;
  credits?: { credits: number; tier?: string } | null;
  creditsThrows?: Error;
  bridgePingThrows?: Error;
  POLL_URL?: string;
  RESULT_URL?: string;
  STATUS_URL?: string;
  PROJECT_URL?: string;
  ACCOUNT_TOKEN?: string;
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>;
} = {}) {
  const httpSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/http.js"),
    "utf8",
  );
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/self-test.js"),
    "utf8",
  );
  const fetchFn = vi.fn(
    opts.fetchImpl ?? (async () => ({
      ok: true,
      status: 200,
      text: async () => "{}",
    } as unknown as Response)),
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    fetch: fetchFn,
    AbortController,
    setTimeout: (fn: () => void) => { fn(); return 0; },
    clearTimeout: () => {},
    Math,
    Promise,
    JSON,
    Date,
    chrome: {
      tabs: {
        query: vi.fn(async () => opts.tabsQuery ?? [{ id: 1 }]),
        sendMessage: vi.fn(async (_id: number, msg: { action: string }) => {
          if (msg.action === "ping") {
            if (opts.bridgePingThrows) throw opts.bridgePingThrows;
            return { pong: true };
          }
          return undefined;
        }),
      },
    },
    getSessionTokenFromPage: vi.fn(async () =>
      "sessionToken" in opts ? opts.sessionToken : "sess-tok",
    ),
    getCredits: vi.fn(async () => {
      if (opts.creditsThrows) throw opts.creditsThrows;
      return opts.credits ?? { credits: 100, tier: "ultra" };
    }),
    getPollUrl: () => opts.POLL_URL ?? "https://hf.example/poll",
    getResultUrl: () => opts.RESULT_URL ?? "https://hf.example/result",
    getStatusUrl: () => opts.STATUS_URL ?? "https://hf.example/status",
    getProjectUrl: () => opts.PROJECT_URL ?? "https://hf.example/project",
    getAccountToken: () => opts.ACCOUNT_TOKEN ?? "acct-tok",
  };
  vm.createContext(sandbox);
  vm.runInContext(httpSrc + "\n" + src, sandbox);
  return { mod: sandbox as unknown as SelfTest, fetchFn };
}

describe("runSelfTest", () => {
  it("returns pass for every check on the happy path", async () => {
    const { mod } = loadSelfTest();
    const result = await mod.runSelfTest();
    expect(result.ok).toBe(true);
    const names = result.checks.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["tab", "session", "credits", "bridge", "pollUrl", "resultUrl", "statusUrl", "projectUrl"]),
    );
    for (const c of result.checks) {
      expect(c.status).toBe("pass");
    }
  });

  it("fails the tab check when no labs.google tab is open", async () => {
    const { mod } = loadSelfTest({ tabsQuery: [] });
    const result = await mod.runSelfTest();
    expect(result.ok).toBe(false);
    const tab = result.checks.find((c) => c.name === "tab");
    expect(tab?.status).toBe("fail");
    // session/credits/bridge can't run without a tab — they skip.
    for (const name of ["session", "credits", "bridge"]) {
      expect(result.checks.find((c) => c.name === name)?.status).toBe("skip");
    }
  });

  it("fails session when getSessionTokenFromPage returns null", async () => {
    const { mod } = loadSelfTest({ sessionToken: null });
    const result = await mod.runSelfTest();
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name === "session")?.status).toBe("fail");
    // Credits depends on a session token — skip.
    expect(result.checks.find((c) => c.name === "credits")?.status).toBe("skip");
  });

  it("fails credits when getCredits throws", async () => {
    const { mod } = loadSelfTest({ creditsThrows: new Error("blocked") });
    const result = await mod.runSelfTest();
    expect(result.checks.find((c) => c.name === "credits")?.status).toBe("fail");
  });

  it("fails bridge when ping throws", async () => {
    const { mod } = loadSelfTest({ bridgePingThrows: new Error("Could not establish connection") });
    const result = await mod.runSelfTest();
    expect(result.checks.find((c) => c.name === "bridge")?.status).toBe("fail");
  });

  it("HistForge endpoint pings count as pass on any HTTP response (even 4xx)", async () => {
    const { mod } = loadSelfTest({
      fetchImpl: async () => ({
        ok: false,
        status: 404,
        text: async () => "not found",
      } as unknown as Response),
    });
    const result = await mod.runSelfTest();
    // 404 still means the endpoint is reachable.
    for (const name of ["pollUrl", "resultUrl", "statusUrl", "projectUrl"]) {
      expect(result.checks.find((c) => c.name === name)?.status).toBe("pass");
    }
  });

  it("HistForge endpoint pings fail on network error", async () => {
    const { mod } = loadSelfTest({
      fetchImpl: async () => { throw new Error("connection refused"); },
    });
    const result = await mod.runSelfTest();
    for (const name of ["pollUrl", "resultUrl", "statusUrl", "projectUrl"]) {
      expect(result.checks.find((c) => c.name === name)?.status).toBe("fail");
    }
  });

  it("HistForge ping body uses { type: 'Ping' } + accountToken", async () => {
    const { mod, fetchFn } = loadSelfTest();
    await mod.runSelfTest();
    const pollPing = fetchFn.mock.calls.find(
      (c) => (c[0] as string).includes("/poll"),
    );
    expect(pollPing).toBeDefined();
    const body = JSON.parse((pollPing![1] as RequestInit).body as string);
    expect(body.type).toBe("Ping");
    expect(body.accountToken).toBe("acct-tok");
  });

  it("skips a HistForge endpoint check when its URL is not configured", async () => {
    const { mod } = loadSelfTest({ POLL_URL: "" });
    const result = await mod.runSelfTest();
    expect(result.checks.find((c) => c.name === "pollUrl")?.status).toBe("skip");
  });

  it("skips the projectUrl check when not configured", async () => {
    const { mod } = loadSelfTest({ PROJECT_URL: "" });
    const result = await mod.runSelfTest();
    expect(result.checks.find((c) => c.name === "projectUrl")?.status).toBe("skip");
  });

  it("ok=false when any check fails", async () => {
    const { mod } = loadSelfTest({ tabsQuery: [] });
    const result = await mod.runSelfTest();
    expect(result.ok).toBe(false);
  });
});
