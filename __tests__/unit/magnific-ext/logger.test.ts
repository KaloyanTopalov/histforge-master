import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Logger = {
  safeLog: (...args: unknown[]) => void;
  verboseLog: (...args: unknown[]) => void;
};

function loadLogger(
  consoleLog: (...args: unknown[]) => void,
  opts: { token?: string; verbose?: () => boolean } = {},
) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/magnific-ext/src/logger.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: consoleLog },
  };
  if (opts.token !== undefined) sandbox.MAGNIFIC_TOKEN = opts.token;
  if (opts.verbose) sandbox.getVerboseLogging = opts.verbose;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as Logger;
}

describe("magnific-ext safeLog", () => {
  let captured: unknown[][];
  let consoleLog: (...args: unknown[]) => void;

  beforeEach(() => {
    captured = [];
    consoleLog = (...args: unknown[]) => captured.push(args);
  });

  it("prefixes output with [Magnific HITL]", () => {
    const { safeLog } = loadLogger(consoleLog);
    safeLog("hello");
    expect(captured[0][0]).toBe("[Magnific HITL]");
    expect(captured[0][1]).toBe("hello");
  });

  it("redacts Bearer tokens in string args", () => {
    const { safeLog } = loadLogger(consoleLog);
    safeLog("auth: Bearer abc.def-ghi_jkl+mno=");
    expect(captured[0][1]).toBe("auth: Bearer <redacted>");
  });

  it("redacts long token: / token= values", () => {
    const { safeLog } = loadLogger(consoleLog);
    const longVal = "a".repeat(50);
    safeLog(`token: ${longVal}`);
    expect(captured[0][1]).toBe("token: <redacted>");
  });

  it("redacts MAGNIFIC_TOKEN when present in strings", () => {
    const { safeLog } = loadLogger(consoleLog, { token: "secret-magnific-token" });
    safeLog("request for secret-magnific-token was sent");
    expect(captured[0][1]).toBe("request for <redacted> was sent");
  });

  it("passes non-string args through unchanged", () => {
    const { safeLog } = loadLogger(consoleLog);
    const obj = { foo: 1 };
    safeLog("prefix", obj, 42, null);
    expect(captured[0][2]).toBe(obj);
    expect(captured[0][3]).toBe(42);
    expect(captured[0][4]).toBe(null);
  });
});

describe("magnific-ext verboseLog", () => {
  it("is a no-op when getVerboseLogging returns false", () => {
    const captured: unknown[][] = [];
    const { verboseLog } = loadLogger((...a) => captured.push(a), {
      verbose: () => false,
    });
    verboseLog("verbose detail");
    expect(captured).toHaveLength(0);
  });

  it("writes through safeLog when getVerboseLogging returns true", () => {
    const captured: unknown[][] = [];
    const { verboseLog } = loadLogger((...a) => captured.push(a), {
      verbose: () => true,
    });
    verboseLog("verbose detail");
    expect(captured).toHaveLength(1);
    expect(captured[0][0]).toBe("[Magnific HITL]");
  });
});
