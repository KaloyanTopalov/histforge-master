import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Status = {
  isPolling: boolean;
  lastPoll: string | null;
  hostPermissionRevoked: boolean;
  pauseReason: string | null;
  domain: string;
  processedCount: number;
};

function loadStatus(opts: {
  isEnabled?: boolean;
  lastPoll?: string | null;
  hostRevoked?: boolean;
  pauseReason?: string | null;
  domain?: string;
  processedJobIds?: string[];
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/status.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    loadSettings: vi.fn(async () => {}),
    loadState: vi.fn(async () => {}),
    getIsEnabled: () => opts.isEnabled ?? false,
    getLastPoll: () => opts.lastPoll ?? null,
    getPauseReason: () => opts.pauseReason ?? null,
    getProcessedJobIds: () => opts.processedJobIds ?? [],
    getHistforgeDomain: () => opts.domain ?? "",
    isHostPermissionRevoked: () => opts.hostRevoked ?? false,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox.getStatus as () => Promise<Status>;
}

describe("magnific-ext getStatus", () => {
  it("reports defaults when nothing is enabled", async () => {
    const getStatus = loadStatus();
    const s = await getStatus();
    expect(s.isPolling).toBe(false);
    expect(s.lastPoll).toBe(null);
    expect(s.hostPermissionRevoked).toBe(false);
    expect(s.pauseReason).toBe(null);
    expect(s.processedCount).toBe(0);
  });

  it("reflects live state when polling is running", async () => {
    const getStatus = loadStatus({
      isEnabled: true,
      lastPoll: "2026-05-21T00:00:00Z",
      domain: "http://localhost:3000",
      processedJobIds: ["a", "b", "c"],
    });
    const s = await getStatus();
    expect(s.isPolling).toBe(true);
    expect(s.lastPoll).toBe("2026-05-21T00:00:00Z");
    expect(s.domain).toBe("http://localhost:3000");
    expect(s.processedCount).toBe(3);
  });

  it("surfaces hostPermissionRevoked + pauseReason overrides", async () => {
    const getStatus = loadStatus({
      hostRevoked: true,
      pauseReason: "session_expired",
    });
    const s = await getStatus();
    expect(s.hostPermissionRevoked).toBe(true);
    expect(s.pauseReason).toBe("session_expired");
  });
});
