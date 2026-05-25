import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type State = {
  loadState: () => Promise<void>;
  getIsEnabled: () => boolean;
  setIsEnabled: (v: boolean) => Promise<void>;
  getLastPoll: () => string | null;
  setLastPoll: (v: string) => Promise<void>;
  getProcessedJobIds: () => string[];
  addProcessedJobId: (id: string) => Promise<number>;
  getGrantedOrigin: () => string | null;
  setGrantedOrigin: (o: string) => Promise<void>;
  clearGrantedOrigin: () => Promise<void>;
  getConsecutiveFailures: () => number;
  bumpConsecutiveFailures: () => number;
  resetConsecutiveFailures: () => void;
  getPauseReason: () => string | null;
  setPauseReason: (r: string) => void;
  clearPauseReason: () => void;
};

function loadState(storage: Record<string, unknown> = {}) {
  const constants = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/constants.js"),
    "utf8",
  );
  const stateSrc = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/state.js"),
    "utf8",
  );
  const setSpy = vi.fn(async (_x: Record<string, unknown>) => {});
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      storage: {
        local: {
          get: async () => storage,
          set: setSpy,
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(constants + "\n" + stateSrc, sandbox);
  return { s: sandbox as unknown as State, setSpy };
}

describe("magnific-ext state", () => {
  it("returns defaults before loadState runs", () => {
    const { s } = loadState();
    expect(s.getIsEnabled()).toBe(false);
    expect(s.getLastPoll()).toBe(null);
    expect(s.getProcessedJobIds()).toEqual([]);
    expect(s.getGrantedOrigin()).toBe(null);
    expect(s.getConsecutiveFailures()).toBe(0);
    expect(s.getPauseReason()).toBe(null);
  });

  it("loadState populates the cache from chrome.storage.local", async () => {
    const { s } = loadState({
      isEnabled: true,
      lastPoll: "2026-05-21T00:00:00Z",
      processedJobIds: ["a", "b"],
      grantedOrigin: "http://localhost:3000",
    });
    await s.loadState();
    expect(s.getIsEnabled()).toBe(true);
    expect(s.getLastPoll()).toBe("2026-05-21T00:00:00Z");
    expect(s.getProcessedJobIds()).toEqual(["a", "b"]);
    expect(s.getGrantedOrigin()).toBe("http://localhost:3000");
  });

  it("setIsEnabled persists through chrome.storage.local", async () => {
    const { s, setSpy } = loadState();
    await s.setIsEnabled(true);
    expect(s.getIsEnabled()).toBe(true);
    expect(setSpy).toHaveBeenCalledWith({ isEnabled: true });
  });

  it("addProcessedJobId trims to the bounded cap", async () => {
    const { s } = loadState();
    // PROCESSED_JOB_IDS_CAP is 100 per constants.js; push 105 IDs.
    for (let i = 0; i < 105; i++) {
      await s.addProcessedJobId(`id-${i}`);
    }
    const ids = s.getProcessedJobIds();
    expect(ids.length).toBe(100);
    expect(ids[0]).toBe("id-5"); // first five trimmed
    expect(ids[99]).toBe("id-104");
  });

  it("bumpConsecutiveFailures + reset", () => {
    const { s } = loadState();
    expect(s.bumpConsecutiveFailures()).toBe(1);
    expect(s.bumpConsecutiveFailures()).toBe(2);
    s.resetConsecutiveFailures();
    expect(s.getConsecutiveFailures()).toBe(0);
  });

  it("pauseReason set / get / clear", () => {
    const { s } = loadState();
    s.setPauseReason("session_expired");
    expect(s.getPauseReason()).toBe("session_expired");
    s.clearPauseReason();
    expect(s.getPauseReason()).toBe(null);
  });

  it("setGrantedOrigin + clearGrantedOrigin", async () => {
    const { s, setSpy } = loadState();
    await s.setGrantedOrigin("http://localhost:3000");
    expect(s.getGrantedOrigin()).toBe("http://localhost:3000");
    await s.clearGrantedOrigin();
    expect(s.getGrantedOrigin()).toBe(null);
    expect(setSpy).toHaveBeenCalledWith({ grantedOrigin: null });
  });
});
