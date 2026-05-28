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

type MockPage = {
  goto: ReturnType<typeof vi.fn>;
  waitForURL: ReturnType<typeof vi.fn>;
  bringToFront: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

type MockCDPSession = {
  send: ReturnType<typeof vi.fn>;
};

type MockContext = {
  on: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  newPage: ReturnType<typeof vi.fn>;
  newCDPSession: ReturnType<typeof vi.fn>;
  __fireClose: () => void;
};

function makeMockPage(): MockPage {
  return {
    goto: vi.fn(async () => {}),
    waitForURL: vi.fn(async () => {}),
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
}

function makeMockCDPSession(): MockCDPSession {
  return {
    send: vi.fn(async (method: string) => {
      if (method === "Browser.getWindowForTarget") return { windowId: 42 };
      return {};
    }),
  };
}

function makeMockContext(): MockContext {
  const closeHandlers: Array<() => void> = [];
  return {
    on: vi.fn((event: string, fn: () => void) => {
      if (event === "close") closeHandlers.push(fn);
    }),
    close: vi.fn(async () => {}),
    newPage: vi.fn(async () => makeMockPage()),
    newCDPSession: vi.fn(async () => makeMockCDPSession()),
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

describe("connect()", () => {
  async function startedRuntime(): Promise<{
    runtime: MagnificRuntime;
    ctx: MockContext;
  }> {
    defaultSettings();
    const ctx = makeMockContext();
    mockLaunchPersistentContext.mockResolvedValueOnce(ctx);
    mockInjectToken.mockResolvedValueOnce(undefined);
    const runtime = new MagnificRuntime();
    await runtime.start();
    return { runtime, ctx };
  }

  it("happy path: CDP reposition visible → goto /log-in → waitForURL /app/ → reposition off-screen", async () => {
    const { runtime, ctx } = await startedRuntime();
    const page = makeMockPage();
    const cdp = makeMockCDPSession();
    ctx.newPage.mockResolvedValueOnce(page);
    ctx.newCDPSession.mockResolvedValueOnce(cdp);

    const result = await runtime.connect();

    expect(result).toEqual({ success: true });
    expect(ctx.newPage).toHaveBeenCalledTimes(1);
    expect(ctx.newCDPSession).toHaveBeenCalledWith(page);

    // Order matters: reposition-visible THEN reposition-hidden, with goto/waitForURL between.
    const sendCalls = cdp.send.mock.calls;
    expect(sendCalls[0]).toEqual(["Browser.getWindowForTarget"]);
    expect(sendCalls[1]).toEqual([
      "Browser.setWindowBounds",
      {
        windowId: 42,
        bounds: { left: 100, top: 100, width: 1280, height: 800, windowState: "normal" },
      },
    ]);
    expect(sendCalls[2]).toEqual([
      "Browser.setWindowBounds",
      { windowId: 42, bounds: { left: 4000, top: 4000 } },
    ]);

    expect(page.bringToFront).toHaveBeenCalled();
    expect(page.goto).toHaveBeenCalledWith("https://www.magnific.com/log-in");
    expect(page.waitForURL).toHaveBeenCalledWith(/\/app(\/|$)/, { timeout: 5 * 60 * 1000 });
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("waits on a pattern that matches a bare /app redirect (no trailing slash) — the verification regression", async () => {
    // Magnific redirects an already-logged-in /log-in visit to bare
    // `https://www.magnific.com/app` (no trailing slash). The old pattern
    // `/\/app\//` required a slash after `app`, so connect() never saw the
    // transition and burned the full 5-min timeout reporting a false failure.
    // Guard the exact URL shapes the pattern must (and must not) match.
    const { runtime, ctx } = await startedRuntime();
    const page = makeMockPage();
    const cdp = makeMockCDPSession();
    ctx.newPage.mockResolvedValueOnce(page);
    ctx.newCDPSession.mockResolvedValueOnce(cdp);

    const result = await runtime.connect();
    expect(result).toEqual({ success: true });

    const [pattern] = page.waitForURL.mock.calls[0] as [RegExp, unknown];
    expect(pattern.test("https://www.magnific.com/app")).toBe(true); // bare /app
    expect(pattern.test("https://www.magnific.com/app/projects/work")).toBe(true);
    // Must not match the logged-out page, nor a coincidental /apps prefix.
    expect(pattern.test("https://www.magnific.com/log-in")).toBe(false);
    expect(pattern.test("https://www.magnific.com/apps")).toBe(false);
  });

  it("timeout: returns {success:false, reason:'timeout'} and does NOT reposition window back", async () => {
    const { runtime, ctx } = await startedRuntime();
    const page = makeMockPage();
    page.waitForURL.mockRejectedValueOnce(new Error("Timeout 5000ms exceeded"));
    const cdp = makeMockCDPSession();
    ctx.newPage.mockResolvedValueOnce(page);
    ctx.newCDPSession.mockResolvedValueOnce(cdp);

    const result = await runtime.connect(50);

    expect(result).toEqual({ success: false, reason: "timeout" });
    // Exactly two CDP calls: getWindowForTarget + setWindowBounds(visible).
    // The return-to-hidden setWindowBounds must NOT have been sent.
    expect(cdp.send).toHaveBeenCalledTimes(2);
    expect(cdp.send.mock.calls.find(
      ([m, args]) =>
        m === "Browser.setWindowBounds" &&
        (args as { bounds: { left: number } }).bounds.left === 4000,
    )).toBeUndefined();
    // Page still closed even on the timeout path.
    expect(page.close).toHaveBeenCalledTimes(1);
  });

  it("auto-starts the runtime when context is null", async () => {
    defaultSettings();
    const ctx = makeMockContext();
    mockLaunchPersistentContext.mockResolvedValueOnce(ctx);
    mockInjectToken.mockResolvedValueOnce(undefined);

    const runtime = new MagnificRuntime();
    // No prior .start() call.
    const result = await runtime.connect();

    expect(mockLaunchPersistentContext).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  it("re-entrancy (option a): second concurrent call returns connect_in_progress synchronously, never touches context", async () => {
    const { runtime, ctx } = await startedRuntime();

    // Hang the first connect()'s newPage on a controllable promise so the
    // re-entrancy flag is set while we fire the second call.
    let releaseFirstPage!: (p: MockPage) => void;
    const firstPagePromise = new Promise<MockPage>((res) => {
      releaseFirstPage = res;
    });
    ctx.newPage.mockReturnValueOnce(firstPagePromise);

    const firstConnect = runtime.connect();
    // Yield one microtask so the first call advances past `this.connecting = true`
    // and into the `await ctx.newPage()` await.
    await Promise.resolve();

    const second = await runtime.connect();
    expect(second).toEqual({ success: false, reason: "connect_in_progress" });
    // The second call must never touch the context.
    expect(ctx.newPage).toHaveBeenCalledTimes(1);
    expect(ctx.newCDPSession).not.toHaveBeenCalled();

    // Cleanup: release the first call so it doesn't leak a pending promise.
    releaseFirstPage(makeMockPage());
    await firstConnect;
  });

  it("releases the in-progress flag after a successful connect, allowing subsequent connects", async () => {
    const { runtime } = await startedRuntime();
    const first = await runtime.connect();
    expect(first).toEqual({ success: true });
    const second = await runtime.connect();
    expect(second).toEqual({ success: true });
  });

  it("releases the in-progress flag after a throw, allowing recovery", async () => {
    const { runtime, ctx } = await startedRuntime();
    ctx.newPage.mockRejectedValueOnce(new Error("page boom"));

    await expect(runtime.connect()).rejects.toThrow("page boom");

    // Flag must be cleared — a follow-up connect should proceed normally.
    const result = await runtime.connect();
    expect(result).toEqual({ success: true });
  });
});
