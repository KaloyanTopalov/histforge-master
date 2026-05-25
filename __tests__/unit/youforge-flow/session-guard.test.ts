import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Guard = {
  executeTaskWithSessionGuard: (
    task: Record<string, unknown>,
    tabId: number,
    correlationId?: string,
  ) => Promise<unknown>;
};

function loadGuard(opts: {
  executeTaskViaAPI?: (task: unknown, tabId: number) => Promise<unknown>;
  stopped?: boolean;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/session-guard.js"),
    "utf8",
  );
  const executeTaskViaAPI = vi.fn(
    opts.executeTaskViaAPI ?? (async () => ({ taskId: "t1", resultUrl: "u", mode: "text" })),
  );
  const notifySessionExpired = vi.fn(async () => {});
  const assertNotStopped = vi.fn(() => {
    if (opts.stopped) throw new Error("STOP_REQUESTED");
  });
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    assertNotStopped,
    executeTaskViaAPI,
    notifySessionExpired,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { mod: sandbox as unknown as Guard, executeTaskViaAPI, notifySessionExpired };
}

describe("executeTaskWithSessionGuard", () => {
  it("passes through the executor's result on success", async () => {
    const ctx = loadGuard();
    const out = await ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5);
    expect(out).toEqual({ taskId: "t1", resultUrl: "u", mode: "text" });
    expect(ctx.executeTaskViaAPI).toHaveBeenCalledWith({ id: "t1" }, 5, undefined);
  });

  it("throws STOP_REQUESTED immediately when the stop flag is set before call", async () => {
    const ctx = loadGuard({ stopped: true });
    await expect(
      ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5),
    ).rejects.toThrow("STOP_REQUESTED");
    expect(ctx.executeTaskViaAPI).not.toHaveBeenCalled();
  });

  it("rethrows STOP_REQUESTED without notifying session expiry", async () => {
    const ctx = loadGuard({
      executeTaskViaAPI: async () => {
        throw new Error("STOP_REQUESTED");
      },
    });
    await expect(
      ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5),
    ).rejects.toThrow("STOP_REQUESTED");
    expect(ctx.notifySessionExpired).not.toHaveBeenCalled();
  });

  it("calls notifySessionExpired then rethrows on session-expired errors", async () => {
    const ctx = loadGuard({
      executeTaskViaAPI: async () => {
        const err = new Error("SESSION_EXPIRED: checkVideoStatus");
        (err as unknown as { isSessionExpired: boolean }).isSessionExpired = true;
        throw err;
      },
    });
    await expect(
      ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5),
    ).rejects.toThrow(/SESSION_EXPIRED/);
    expect(ctx.notifySessionExpired).toHaveBeenCalledTimes(1);
  });

  it("rethrows generic errors without notifying", async () => {
    const ctx = loadGuard({
      executeTaskViaAPI: async () => {
        throw new Error("boom");
      },
    });
    await expect(
      ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5),
    ).rejects.toThrow("boom");
    expect(ctx.notifySessionExpired).not.toHaveBeenCalled();
  });

  it("forwards correlationId to executeTaskViaAPI", async () => {
    const ctx = loadGuard();
    await ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5, "abcd-1234");
    expect(ctx.executeTaskViaAPI).toHaveBeenCalledWith({ id: "t1" }, 5, "abcd-1234");
  });

  it("stashes correlationId on the rethrown Error", async () => {
    const ctx = loadGuard({
      executeTaskViaAPI: async () => {
        throw new Error("boom");
      },
    });
    try {
      await ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5, "cid-xyz");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { correlationId?: string };
      expect(err.correlationId).toBe("cid-xyz");
    }
  });

  it("does not overwrite an existing correlationId on the error", async () => {
    const ctx = loadGuard({
      executeTaskViaAPI: async () => {
        const err = Object.assign(new Error("boom"), {
          correlationId: "existing-cid",
        });
        throw err;
      },
    });
    try {
      await ctx.mod.executeTaskWithSessionGuard({ id: "t1" }, 5, "new-cid");
      throw new Error("should have thrown");
    } catch (e) {
      const err = e as { correlationId?: string };
      expect(err.correlationId).toBe("existing-cid");
    }
  });
});
