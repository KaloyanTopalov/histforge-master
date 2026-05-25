import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type Logger = {
  safeLog: (...args: unknown[]) => void;
  _rawLog: (...args: unknown[]) => void;
  forTask: (correlationId: string) => { safeLog: (...args: unknown[]) => void };
  verboseLog: (...args: unknown[]) => void;
};

function loadLoggerWithVerbose(
  consoleLog: (...args: unknown[]) => void,
  getVerboseLogging: () => boolean,
) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/logger.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: consoleLog },
    getVerboseLogging,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as Logger;
}

function loadLoggerWithConsole(
  consoleLog: (...args: unknown[]) => void,
  accountToken?: string,
) {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/logger.js"),
    "utf8",
  );
  const sandbox: Record<string, unknown> = {
    console: { log: consoleLog },
  };
  if (accountToken !== undefined) sandbox.ACCOUNT_TOKEN = accountToken;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox as unknown as Logger;
}

describe("safeLog", () => {
  let captured: unknown[][];
  let consoleLog: (...args: unknown[]) => void;

  beforeEach(() => {
    captured = [];
    consoleLog = (...args: unknown[]) => captured.push(args);
  });

  it("prefixes output with [YouForge Flow]", () => {
    const { safeLog } = loadLoggerWithConsole(consoleLog);
    safeLog("hello");
    expect(captured).toHaveLength(1);
    expect(captured[0][0]).toBe("[YouForge Flow]");
    expect(captured[0][1]).toBe("hello");
  });

  it("redacts Bearer tokens in string args", () => {
    const { safeLog } = loadLoggerWithConsole(consoleLog);
    safeLog("auth: Bearer abc.def-ghi_jkl+mno=");
    expect(captured[0][1]).toBe("auth: Bearer <redacted>");
  });

  it("redacts long token: / token= values", () => {
    const { safeLog } = loadLoggerWithConsole(consoleLog);
    const longVal = "a".repeat(50);
    safeLog(`token: ${longVal}`);
    expect(captured[0][1]).toBe("token: <redacted>");
    captured = [];
    safeLog(`token="${longVal}"`);
    expect(captured[0][1]).toBe('token="<redacted>"');
  });

  it("redacts ACCOUNT_TOKEN when present in strings", () => {
    const { safeLog } = loadLoggerWithConsole(consoleLog, "secret-account-token");
    safeLog("request for secret-account-token was sent");
    expect(captured[0][1]).toBe("request for <redacted> was sent");
  });

  it("passes non-string args through unchanged", () => {
    const { safeLog } = loadLoggerWithConsole(consoleLog);
    const obj = { foo: 1 };
    safeLog("prefix", obj, 42, null);
    expect(captured[0][1]).toBe("prefix");
    expect(captured[0][2]).toBe(obj);
    expect(captured[0][3]).toBe(42);
    expect(captured[0][4]).toBe(null);
  });

  it("does nothing special when ACCOUNT_TOKEN is undefined", () => {
    const { safeLog } = loadLoggerWithConsole(consoleLog);
    expect(() => safeLog("plain message")).not.toThrow();
    expect(captured[0][1]).toBe("plain message");
  });

  describe("verboseLog", () => {
    it("is a no-op when getVerboseLogging returns false", () => {
      const { verboseLog } = loadLoggerWithVerbose(consoleLog, () => false);
      verboseLog("verbose detail");
      expect(captured).toHaveLength(0);
    });

    it("writes through safeLog when getVerboseLogging returns true", () => {
      const { verboseLog } = loadLoggerWithVerbose(consoleLog, () => true);
      verboseLog("verbose detail");
      expect(captured).toHaveLength(1);
      expect(captured[0][0]).toBe("[YouForge Flow]");
    });

    it("redacts Bearer tokens in verbose mode", () => {
      const { verboseLog } = loadLoggerWithVerbose(consoleLog, () => true);
      verboseLog("auth: Bearer abc.def-ghi");
      // Find the actual message arg (skip prefix args)
      const msgArg = captured[0].find(
        (a) => typeof a === "string" && a.startsWith("auth:"),
      );
      expect(msgArg).toBe("auth: Bearer <redacted>");
    });
  });

  describe("forTask", () => {
    it("returns a logger that prefixes the first 8 chars of cid", () => {
      const { forTask } = loadLoggerWithConsole(consoleLog);
      const taskLog = forTask("abcdef1234567890");
      taskLog.safeLog("hello");
      expect(captured).toHaveLength(1);
      expect(captured[0][0]).toBe("[YouForge Flow]");
      // prefix appears as a separate arg before the message
      expect(captured[0][1]).toBe("[cid=abcdef12]");
      expect(captured[0][2]).toBe("hello");
    });

    it("still scrubs Bearer tokens through the wrapped logger", () => {
      const { forTask } = loadLoggerWithConsole(consoleLog);
      const taskLog = forTask("abcdef1234567890");
      taskLog.safeLog("auth: Bearer abc.def-ghi");
      expect(captured[0][2]).toBe("auth: Bearer <redacted>");
    });

    it("handles cid shorter than 8 chars (uses full id)", () => {
      const { forTask } = loadLoggerWithConsole(consoleLog);
      const taskLog = forTask("ab12");
      taskLog.safeLog("hello");
      expect(captured[0][1]).toBe("[cid=ab12]");
    });

    it("handles missing cid gracefully (no prefix)", () => {
      const { forTask } = loadLoggerWithConsole(consoleLog);
      const taskLog = forTask("");
      taskLog.safeLog("hello");
      expect(captured[0][1]).toBe("hello");
    });
  });
});
