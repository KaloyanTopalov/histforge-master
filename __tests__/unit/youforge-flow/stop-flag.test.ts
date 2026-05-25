import { describe, it, expect, beforeEach } from "vitest";
import { loadClassicScript } from "../../helpers/load-classic-script";

type StopFlag = {
  getStopFlag: () => boolean;
  setStopFlag: () => void;
  clearStopFlag: () => void;
  assertNotStopped: () => void;
};

const mod = loadClassicScript<StopFlag>(
  "extensions/youforge-flow/src/stop-flag.js",
);

describe("stop-flag", () => {
  beforeEach(() => {
    mod.clearStopFlag();
  });

  it("reports unset by default and assertNotStopped passes through", () => {
    expect(mod.getStopFlag()).toBe(false);
    expect(() => mod.assertNotStopped()).not.toThrow();
  });

  it("setStopFlag flips the flag and makes assertNotStopped throw STOP_REQUESTED", () => {
    mod.setStopFlag();
    expect(mod.getStopFlag()).toBe(true);
    expect(() => mod.assertNotStopped()).toThrow("STOP_REQUESTED");
  });

  it("clearStopFlag restores the flag to false", () => {
    mod.setStopFlag();
    mod.clearStopFlag();
    expect(mod.getStopFlag()).toBe(false);
    expect(() => mod.assertNotStopped()).not.toThrow();
  });
});
