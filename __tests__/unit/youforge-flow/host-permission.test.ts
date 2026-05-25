import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type HostPermission = {
  pathsStartsWithOrigin: (origins: string[] | null, origin?: string) => boolean;
  halt_onHostRemoved: (origins: string[]) => Promise<void>;
  noteHostAdded: (origins: string[]) => Promise<void>;
  isHostPermissionRevoked: () => boolean;
};

type Sandbox = {
  storage: { grantedOrigin?: string | null };
  setStopFlagCalls: number;
  stopPollingCalls: number;
  permissionListeners: {
    onRemoved: Array<(p: { origins?: string[] }) => void>;
    onAdded: Array<(p: { origins?: string[] }) => void>;
  };
};

function loadHostPermission({
  grantedOrigin,
}: { grantedOrigin?: string | null } = {}): HostPermission & Sandbox {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/host-permission.js"),
    "utf8",
  );
  const permissionListeners = {
    onRemoved: [] as Array<(p: { origins?: string[] }) => void>,
    onAdded: [] as Array<(p: { origins?: string[] }) => void>,
  };
  const storage: { grantedOrigin?: string | null } = { grantedOrigin };
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    setStopFlag: vi.fn(),
    stopPolling: vi.fn().mockResolvedValue(undefined),
    // state.js stubs — host-permission.js reads/clears grantedOrigin via these.
    getGrantedOrigin: () => storage.grantedOrigin ?? null,
    clearGrantedOrigin: async () => { storage.grantedOrigin = null; },
    chrome: {
      storage: {
        local: {
          get: async (key: string) => ({ [key]: storage[key as keyof typeof storage] }),
          set: async (patch: { grantedOrigin?: string | null }) => {
            Object.assign(storage, patch);
          },
        },
      },
      permissions: {
        onRemoved: {
          addListener: (fn: (p: { origins?: string[] }) => void) =>
            permissionListeners.onRemoved.push(fn),
        },
        onAdded: {
          addListener: (fn: (p: { origins?: string[] }) => void) =>
            permissionListeners.onAdded.push(fn),
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const s = sandbox as unknown as HostPermission & Sandbox;
  s.storage = storage;
  s.permissionListeners = permissionListeners;
  return s;
}

describe("host-permission", () => {
  describe("pathsStartsWithOrigin", () => {
    let mod: ReturnType<typeof loadHostPermission>;
    beforeEach(() => {
      mod = loadHostPermission();
    });

    it("matches `${origin}/*` in the origins list", () => {
      expect(
        mod.pathsStartsWithOrigin(
          ["https://histforge.dev/*"],
          "https://histforge.dev",
        ),
      ).toBe(true);
    });

    it("returns false when origin is missing", () => {
      expect(mod.pathsStartsWithOrigin(["https://x/*"], undefined)).toBe(false);
    });

    it("returns false when origins list is null", () => {
      expect(mod.pathsStartsWithOrigin(null, "https://x")).toBe(false);
    });
  });

  describe("halt_onHostRemoved", () => {
    it("revokes + stops when the removed origin matches grantedOrigin", async () => {
      const mod = loadHostPermission({ grantedOrigin: "https://histforge.dev" });
      expect(mod.isHostPermissionRevoked()).toBe(false);

      await mod.halt_onHostRemoved(["https://histforge.dev/*"]);

      expect(mod.isHostPermissionRevoked()).toBe(true);
      expect((mod as unknown as { setStopFlag: ReturnType<typeof vi.fn> }).setStopFlag)
        .toHaveBeenCalled();
      expect((mod as unknown as { stopPolling: ReturnType<typeof vi.fn> }).stopPolling)
        .toHaveBeenCalled();
      expect(mod.storage.grantedOrigin).toBeNull();
    });

    it("does nothing when the removed origin doesn't match grantedOrigin", async () => {
      const mod = loadHostPermission({ grantedOrigin: "https://histforge.dev" });
      await mod.halt_onHostRemoved(["https://other.example/*"]);

      expect(mod.isHostPermissionRevoked()).toBe(false);
      expect((mod as unknown as { setStopFlag: ReturnType<typeof vi.fn> }).setStopFlag)
        .not.toHaveBeenCalled();
      expect(mod.storage.grantedOrigin).toBe("https://histforge.dev");
    });
  });

  describe("noteHostAdded", () => {
    it("re-arms when the added origin matches grantedOrigin", async () => {
      const mod = loadHostPermission({ grantedOrigin: "https://histforge.dev" });
      await mod.halt_onHostRemoved(["https://histforge.dev/*"]);
      // Simulate re-grant: user stored origin back in storage before we observe
      mod.storage.grantedOrigin = "https://histforge.dev";
      expect(mod.isHostPermissionRevoked()).toBe(true);

      await mod.noteHostAdded(["https://histforge.dev/*"]);

      expect(mod.isHostPermissionRevoked()).toBe(false);
    });
  });

  describe("chrome.permissions listeners", () => {
    it("registers onRemoved and onAdded listeners at load", () => {
      const mod = loadHostPermission();
      expect(mod.permissionListeners.onRemoved).toHaveLength(1);
      expect(mod.permissionListeners.onAdded).toHaveLength(1);
    });
  });
});
