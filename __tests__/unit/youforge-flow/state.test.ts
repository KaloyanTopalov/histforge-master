import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type State = {
  getConsecutiveFailures: () => number;
  bumpConsecutiveFailures: () => number;
  resetConsecutiveFailures: () => void;
  getPauseReason: () => string | null;
  setPauseReason: (r: string) => void;
  clearPauseReason: () => void;
  getCooldownUntil: () => number | null;
  setCooldownUntil: (ms: number | null) => void;
};

function loadState() {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/state.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    safeLog: () => {},
    chrome: {
      storage: {
        local: {
          get: async () => ({}),
          set: async () => {},
        },
      },
    },
    Promise,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as State;
}

describe("state — circuit breaker counter (Task 3.1)", () => {
  it("getConsecutiveFailures starts at 0", () => {
    const s = loadState();
    expect(s.getConsecutiveFailures()).toBe(0);
  });

  it("bumpConsecutiveFailures increments and returns the new value", () => {
    const s = loadState();
    expect(s.bumpConsecutiveFailures()).toBe(1);
    expect(s.bumpConsecutiveFailures()).toBe(2);
    expect(s.getConsecutiveFailures()).toBe(2);
  });

  it("resetConsecutiveFailures zeroes the counter", () => {
    const s = loadState();
    s.bumpConsecutiveFailures();
    s.bumpConsecutiveFailures();
    s.bumpConsecutiveFailures();
    s.resetConsecutiveFailures();
    expect(s.getConsecutiveFailures()).toBe(0);
  });
});

describe("state — pause reason (Task 3.2)", () => {
  it("getPauseReason starts null", () => {
    const s = loadState();
    expect(s.getPauseReason()).toBe(null);
  });

  it("setPauseReason sets the field; clearPauseReason resets it to null", () => {
    const s = loadState();
    s.setPauseReason("rate_limited");
    expect(s.getPauseReason()).toBe("rate_limited");
    s.clearPauseReason();
    expect(s.getPauseReason()).toBe(null);
  });

  it("getCooldownUntil starts null; setCooldownUntil persists the value", () => {
    const s = loadState();
    expect(s.getCooldownUntil()).toBe(null);
    s.setCooldownUntil(123_456_789);
    expect(s.getCooldownUntil()).toBe(123_456_789);
    s.setCooldownUntil(null);
    expect(s.getCooldownUntil()).toBe(null);
  });
});
