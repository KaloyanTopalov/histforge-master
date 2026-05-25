import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

// constants.js uses top-level `const` which doesn't attach to the vm
// sandbox's global object. Use a probe snippet in the same context to
// copy the bindings onto `__probe` before reading them back.
function loadConstants() {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/constants.js"),
    "utf8",
  );
  const probe = `
    __probe.GOOGLE_LABS_API_KEY = GOOGLE_LABS_API_KEY;
    __probe.FLOW_URL = FLOW_URL;
    __probe.POLL_INTERVAL_MINUTES = POLL_INTERVAL_MINUTES;
    __probe.CREDITS_POLL_MINUTES = CREDITS_POLL_MINUTES;
    __probe.MAX_CONCURRENT_MAX = MAX_CONCURRENT_MAX;
  `;
  const sandbox: Record<string, unknown> = { __probe: {} };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n" + probe, sandbox);
  return sandbox.__probe as Record<string, unknown>;
}

describe("constants", () => {
  const c = loadConstants();

  it("exposes GOOGLE_LABS_API_KEY (labs.google's public client key)", () => {
    expect(c.GOOGLE_LABS_API_KEY).toBe(
      "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY",
    );
  });

  it("exposes FLOW_URL pointing at labs.google's Flow tool", () => {
    expect(c.FLOW_URL).toBe("https://labs.google/fx/de/tools/flow");
  });

  it("exposes POLL_INTERVAL_MINUTES ≈ 10 seconds", () => {
    expect(c.POLL_INTERVAL_MINUTES).toBeCloseTo(0.1667);
  });

  it("exposes CREDITS_POLL_MINUTES at 1 (MV3 alarms minimum)", () => {
    expect(c.CREDITS_POLL_MINUTES).toBe(1);
  });

  it("exposes MAX_CONCURRENT_MAX = 10", () => {
    expect(c.MAX_CONCURRENT_MAX).toBe(10);
  });
});
