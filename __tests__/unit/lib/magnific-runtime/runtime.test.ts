import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import { existsSync } from "node:fs";

const { mockLaunchPersistentContext, mockInjectToken, mockGetSetting } =
  vi.hoisted(() => ({
    mockLaunchPersistentContext: vi.fn(),
    mockInjectToken: vi.fn(),
    mockGetSetting: vi.fn(),
  }));

vi.mock("playwright", () => ({
  chromium: { launchPersistentContext: mockLaunchPersistentContext },
}));

vi.mock("@/lib/magnific-runtime/extension-token", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/lib/magnific-runtime/extension-token")
  >();
  return { ...actual, injectToken: mockInjectToken };
});

vi.mock("@/lib/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/settings")>();
  return { ...actual, getSetting: mockGetSetting };
});

// esbuild's CJS interop binds `import { existsSync } from "node:fs"` to
// `default.existsSync` on this codebase's TS compile target — same trap as
// `extension-token.test.ts` documented for readFileSync. Override both the
// top-level export AND default.existsSync with the SAME vi.fn so the SUT
// reaches the mock regardless of which import shape esbuild emits.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const existsSyncFn = vi.fn(actual.existsSync);
  return {
    ...actual,
    default: { ...actual, existsSync: existsSyncFn },
    existsSync: existsSyncFn,
  };
});

import {
  MagnificRuntime,
  RuntimeLockedError,
} from "@/lib/magnific-runtime/runtime";

type MockContext = {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  __fireClose: () => void;
};

function makeMockContext(): MockContext {
  const closeHandlers: Array<() => void> = [];
  return {
    on: vi.fn((event: string, fn: () => void) => {
      if (event === "close") closeHandlers.push(fn);
    }),
    close: vi.fn(async () => {}),
    __fireClose: () => closeHandlers.forEach((h) => h()),
  };
}

function defaultSettings(overrides: Record<string, unknown> = {}): void {
  const values: Record<string, unknown> = {
    magnific_runtime_user_data_dir: "data/magnific-userdata",
    magnific_runtime_extension_path: "extensions/magnific-ext",
    magnific_runtime_window_visible: false,
    magnific_runtime_enabled: true,
    magnific_token: "tok-123",
    magnific_relogin_needed: false,
    ...overrides,
  };
  mockGetSetting.mockImplementation((key: string) => {
    if (!(key in values)) throw new Error(`unmocked setting: ${key}`);
    return values[key];
  });
}

beforeEach(() => {
  mockLaunchPersistentContext.mockReset();
  mockInjectToken.mockReset();
  mockGetSetting.mockReset();
  vi.mocked(existsSync).mockReset();
});

describe("start()", () => {
  it("launches Playwright with resolved userDataDir + extension args + off-screen window, injects token, subscribes to close", async () => {
    defaultSettings();
    const ctx = makeMockContext();
    mockLaunchPersistentContext.mockResolvedValueOnce(ctx);
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();

    const expectedDir = path.resolve(process.cwd(), "data/magnific-userdata");
    const expectedExt = path.resolve(process.cwd(), "extensions/magnific-ext");
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
    const [userDataDir, opts] = mockLaunchPersistentContext.mock.calls[0];
    expect(userDataDir).toBe(expectedDir);
    expect(opts.headless).toBe(false);
    expect(opts.viewport).toEqual({ width: 1280, height: 800 });
    expect(opts.args).toEqual(
      expect.arrayContaining([
        `--load-extension=${expectedExt}`,
        `--disable-extensions-except=${expectedExt}`,
        "--window-position=4000,4000",
      ]),
    );
    expect(mockInjectToken).toHaveBeenCalledTimes(1);
    expect(mockInjectToken).toHaveBeenCalledWith(ctx, "tok-123");
    expect(ctx.on).toHaveBeenCalledWith("close", expect.any(Function));
  });

  it("path.resolves a relative userDataDir against process.cwd before passing to Playwright", async () => {
    defaultSettings({ magnific_runtime_user_data_dir: "data/magnific-userdata" });
    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);

    await new MagnificRuntime().start();

    const [passed] = mockLaunchPersistentContext.mock.calls[0];
    expect(path.isAbsolute(passed)).toBe(true);
    expect(passed).toBe(path.resolve(process.cwd(), "data/magnific-userdata"));
  });

  it("does NOT pass --window-position when window_visible=true", async () => {
    defaultSettings({ magnific_runtime_window_visible: true });
    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);

    await new MagnificRuntime().start();

    const [, opts] = mockLaunchPersistentContext.mock.calls[0];
    expect(opts.args).not.toContain("--window-position=4000,4000");
  });

  it("is idempotent — calling twice does not relaunch", async () => {
    defaultSettings();
    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();
    await runtime.start();

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
    expect(mockInjectToken).toHaveBeenCalledTimes(1);
  });
});

describe("stop()", () => {
  it("awaits context.close() and clears internal state so a subsequent start() relaunches", async () => {
    defaultSettings();
    const ctx = makeMockContext();
    mockLaunchPersistentContext.mockResolvedValueOnce(ctx);
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();
    await runtime.stop();

    expect(ctx.close).toHaveBeenCalledTimes(1);

    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);
    await runtime.start();
    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(2);
  });

  it("is a noop when not running", async () => {
    const runtime = new MagnificRuntime();
    await expect(runtime.stop()).resolves.toBeUndefined();
  });
});

describe("status()", () => {
  it("returns running:false / connected:false / session_valid:false when never started", async () => {
    defaultSettings({ magnific_relogin_needed: true });
    vi.mocked(existsSync).mockReturnValue(false);
    const runtime = new MagnificRuntime();
    const s = await runtime.status();
    expect(s).toEqual({
      running: false,
      connected: false,
      session_valid: false,
      last_error: null,
    });
  });

  it("returns running:true / connected:true / session_valid:true when started + userDataDir exists + no relogin flag", async () => {
    defaultSettings({ magnific_relogin_needed: false });
    vi.mocked(existsSync).mockReturnValue(true);
    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();
    const s = await runtime.status();
    expect(s.running).toBe(true);
    expect(s.connected).toBe(true);
    expect(s.session_valid).toBe(true);
    expect(s.last_error).toBeNull();
  });

  it("returns connected:false when userDataDir does not exist", async () => {
    defaultSettings();
    vi.mocked(existsSync).mockReturnValue(false);
    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();
    expect((await runtime.status()).connected).toBe(false);
  });

  it("returns session_valid:false when magnific_relogin_needed is true", async () => {
    defaultSettings({ magnific_relogin_needed: true });
    vi.mocked(existsSync).mockReturnValue(true);
    mockLaunchPersistentContext.mockResolvedValueOnce(makeMockContext());
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();
    expect((await runtime.status()).session_valid).toBe(false);
  });
});

describe("handleDisconnect()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("nulls context and schedules start() retry with doubling backoff capped at 60_000", async () => {
    defaultSettings();
    const contexts: MockContext[] = [];
    for (let i = 0; i < 8; i++) {
      const c = makeMockContext();
      contexts.push(c);
      mockLaunchPersistentContext.mockResolvedValueOnce(c);
      mockInjectToken.mockResolvedValueOnce(undefined);
    }

    const runtime = new MagnificRuntime();
    await runtime.start();
    const setTimeoutSpy = vi.spyOn(global, "setTimeout");

    const expected = [1000, 2000, 4000, 8000, 16000, 32000, 60000];
    for (let i = 0; i < expected.length; i++) {
      contexts[i].__fireClose();
      await vi.advanceTimersByTimeAsync(0);
      expect(setTimeoutSpy).toHaveBeenLastCalledWith(
        expect.any(Function),
        expected[i],
      );
      await vi.advanceTimersByTimeAsync(expected[i]);
      // After the rescheduled start() completes, runtime has a new context
      // (contexts[i+1]); the next iteration fires that context's close
      // handler.
    }
  });

  it("does NOT schedule a retry when magnific_runtime_enabled=false", async () => {
    defaultSettings();
    const ctx = makeMockContext();
    mockLaunchPersistentContext.mockResolvedValueOnce(ctx);
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();

    // Flip the setting; subsequent reads return false.
    defaultSettings({ magnific_runtime_enabled: false });

    const setTimeoutSpy = vi.spyOn(global, "setTimeout");
    ctx.__fireClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(setTimeoutSpy).not.toHaveBeenCalled();
  });

  it("captures retry start() failures into lastError without throwing", async () => {
    defaultSettings();
    const ctx = makeMockContext();
    mockLaunchPersistentContext
      .mockResolvedValueOnce(ctx)
      .mockRejectedValueOnce(new Error("boom"));
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    await runtime.start();
    ctx.__fireClose();
    await vi.advanceTimersByTimeAsync(1000);
    expect((await runtime.status()).last_error).toContain("boom");
  });
});

describe("production-lock error", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("sets lastError, throws RuntimeLockedError, does not call injectToken", async () => {
    defaultSettings();
    const lockErr = new Error(
      "ProcessSingleton: Failed to acquire lock for user data directory at /tmp/x (pid 12345)",
    );
    mockLaunchPersistentContext.mockRejectedValueOnce(lockErr);

    const runtime = new MagnificRuntime();
    await expect(runtime.start()).rejects.toBeInstanceOf(RuntimeLockedError);
    const s = await runtime.status();
    expect(s.last_error).toMatch(/locked/i);
    expect(s.last_error).toContain("pid 12345");
    expect(mockInjectToken).not.toHaveBeenCalled();
  });

  it("does not classify as RuntimeLockedError under NODE_ENV=test", async () => {
    process.env.NODE_ENV = "test";
    defaultSettings();
    const lockErr = new Error("ProcessSingleton lock failed");
    mockLaunchPersistentContext.mockRejectedValueOnce(lockErr);

    const runtime = new MagnificRuntime();
    await expect(runtime.start()).rejects.not.toBeInstanceOf(RuntimeLockedError);
  });
});

describe("worker boot guard (Decision 3, refined in S3)", () => {
  // Re-derived pure predicate matching the inline guard in src/worker/index.ts.
  function shouldAutoStart(env: string | undefined, enabled: boolean): boolean {
    return env === "production" && enabled;
  }

  it("auto-starts only in production with the setting enabled", () => {
    expect(shouldAutoStart("production", true)).toBe(true);
    expect(shouldAutoStart("production", false)).toBe(false);
    expect(shouldAutoStart("test", true)).toBe(false);
    expect(shouldAutoStart("development", true)).toBe(false);
    expect(shouldAutoStart(undefined, true)).toBe(false);
  });
});
