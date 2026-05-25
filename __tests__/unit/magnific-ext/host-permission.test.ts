import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

function loadHostPermission(opts: {
  grantedOrigin?: string | null;
} = {}) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/host-permission.js"),
    "utf8",
  );
  const addedListeners = { onRemoved: [] as Array<(p: { origins: string[] }) => void>, onAdded: [] as Array<(p: { origins: string[] }) => void> };
  const setStopFlag = vi.fn();
  const stopPolling = vi.fn(async () => {});
  const getGrantedOrigin = vi.fn(() => opts.grantedOrigin ?? null);
  const clearGrantedOrigin = vi.fn(async () => {});
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      permissions: {
        onRemoved: {
          addListener: (fn: (p: { origins: string[] }) => void) =>
            addedListeners.onRemoved.push(fn),
        },
        onAdded: {
          addListener: (fn: (p: { origins: string[] }) => void) =>
            addedListeners.onAdded.push(fn),
        },
      },
    },
    setStopFlag,
    stopPolling,
    getGrantedOrigin,
    clearGrantedOrigin,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    isHostPermissionRevoked: sandbox.isHostPermissionRevoked as () => boolean,
    addedListeners,
    setStopFlag,
    stopPolling,
    clearGrantedOrigin,
  };
}

describe("magnific-ext host-permission revoke", () => {
  it("starts in non-revoked state", () => {
    const { isHostPermissionRevoked } = loadHostPermission();
    expect(isHostPermissionRevoked()).toBe(false);
  });

  it("does nothing when the removed origins do not include the granted one", async () => {
    const { addedListeners, setStopFlag, stopPolling, isHostPermissionRevoked } =
      loadHostPermission({ grantedOrigin: "http://localhost:3000" });
    await addedListeners.onRemoved[0]({ origins: ["http://other/*"] });
    expect(setStopFlag).not.toHaveBeenCalled();
    expect(stopPolling).not.toHaveBeenCalled();
    expect(isHostPermissionRevoked()).toBe(false);
  });

  it("halts polling and flips revoked flag when the granted origin is removed", async () => {
    const {
      addedListeners,
      setStopFlag,
      stopPolling,
      clearGrantedOrigin,
      isHostPermissionRevoked,
    } = loadHostPermission({ grantedOrigin: "http://localhost:3000" });
    await addedListeners.onRemoved[0]({ origins: ["http://localhost:3000/*"] });
    expect(setStopFlag).toHaveBeenCalledOnce();
    expect(stopPolling).toHaveBeenCalledOnce();
    expect(clearGrantedOrigin).toHaveBeenCalledOnce();
    expect(isHostPermissionRevoked()).toBe(true);
  });

  it("clears the revoked flag when the granted origin is re-added", async () => {
    const { addedListeners, isHostPermissionRevoked } = loadHostPermission({
      grantedOrigin: "http://localhost:3000",
    });
    // Trip the flag first
    await addedListeners.onRemoved[0]({ origins: ["http://localhost:3000/*"] });
    expect(isHostPermissionRevoked()).toBe(true);
    // Re-add — should clear
    await addedListeners.onAdded[0]({ origins: ["http://localhost:3000/*"] });
    expect(isHostPermissionRevoked()).toBe(false);
  });
});
