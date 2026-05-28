import { existsSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext } from "playwright";
import { getSetting } from "@/lib/settings";
import { injectToken } from "./extension-token";

export interface RuntimeStatus {
  running: boolean;
  connected: boolean;
  session_valid: boolean;
  last_error: string | null;
}

export interface ConnectResult {
  success: boolean;
  reason?: string;
}

// Production-only signal that the userDataDir is held by another Chromium
// process. handleDisconnect refuses to reschedule a retry on this error class
// — looping at 1-60s on a lock that needs operator intervention would just
// pin a CPU. The thrown message includes the underlying Playwright text so
// the dashboard banner can surface the PID Playwright reported.
export class RuntimeLockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeLockedError";
  }
}

// Playwright surfaces the user-data-dir lock as one of several phrasings
// depending on platform and Chromium version. The patterns are intentionally
// permissive — a false positive that classifies a transient launch failure
// as "locked" only suppresses one retry, which the next disconnect re-arms.
const LOCK_PATTERNS = [
  /ProcessSingleton/i,
  /user data directory.*(is\s+(already\s+)?(in\s+use|locked))/i,
  /userDataDir.*lock/i,
];

function isLockError(message: string): boolean {
  return LOCK_PATTERNS.some((re) => re.test(message));
}

export class MagnificRuntime {
  private context: BrowserContext | null = null;
  private lastError: string | null = null;
  private backoffMs = 1000;
  // Re-entrancy guard for connect(). Fast-fail (option a): a second concurrent
  // connect() returns {success:false, reason:"connect_in_progress"} without
  // touching the BrowserContext, matching the dashboard UX where the
  // "Connect Magnific" button disables itself while a connect is in flight.
  private connecting = false;

  async start(): Promise<void> {
    if (this.context) return;
    const userDataDir = path.resolve(
      getSetting("magnific_runtime_user_data_dir"),
    );
    const extensionPath = path.resolve(
      getSetting("magnific_runtime_extension_path"),
    );
    const visible = getSetting("magnific_runtime_window_visible");

    let ctx: BrowserContext;
    try {
      ctx = await chromium.launchPersistentContext(userDataDir, {
        headless: false,
        viewport: { width: 1280, height: 800 },
        args: [
          `--load-extension=${extensionPath}`,
          `--disable-extensions-except=${extensionPath}`,
          ...(visible ? [] : ["--window-position=4000,4000"]),
        ],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isLockError(msg) && process.env.NODE_ENV === "production") {
        this.lastError = `magnific-runtime: userDataDir is locked by another process — ${msg}`;
        throw new RuntimeLockedError(this.lastError);
      }
      this.lastError = msg;
      throw err;
    }
    this.context = ctx;

    try {
      await injectToken(ctx, getSetting("magnific_token"));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      // Best-effort: tear down the half-initialized browser so the next
      // start() begins clean. The original error wins; swallow close fails.
      try {
        await ctx.close();
      } catch {
        // ignore
      }
      this.context = null;
      throw err;
    }

    ctx.on("close", () => {
      void this.handleDisconnect();
    });
  }

  async stop(): Promise<void> {
    if (!this.context) return;
    await this.context.close();
    this.context = null;
    this.backoffMs = 1000;
  }

  async connect(timeoutMs = 5 * 60 * 1000): Promise<ConnectResult> {
    if (this.connecting) {
      return { success: false, reason: "connect_in_progress" };
    }
    this.connecting = true;
    try {
      if (!this.context) await this.start();
      const ctx = this.context!;
      const page = await ctx.newPage();
      try {
        const cdp = await ctx.newCDPSession(page);
        const { windowId } = (await cdp.send(
          "Browser.getWindowForTarget",
        )) as { windowId: number };
        // Slide the off-screen window onto a visible monitor so the operator
        // can see the login flow; spec Decision 4.
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: {
            left: 100,
            top: 100,
            width: 1280,
            height: 800,
            windowState: "normal",
          },
        });
        await page.bringToFront();
        await page.goto("https://www.magnific.com/log-in");
        try {
          await page.waitForURL(/\/app\//, { timeout: timeoutMs });
        } catch {
          // Leave the window visible so the operator can see what stalled —
          // skip the return-to-hidden reposition. The dashboard surfaces the
          // timeout reason; once they finish or cancel, /stop tears down.
          return { success: false, reason: "timeout" };
        }
        await cdp.send("Browser.setWindowBounds", {
          windowId,
          bounds: { left: 4000, top: 4000 },
        });
        return { success: true };
      } finally {
        try {
          await page.close();
        } catch {
          // best-effort: a dangling tab on close failure isn't worth masking
          // the real connect result.
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  async status(): Promise<RuntimeStatus> {
    if (!this.context) {
      return {
        running: false,
        connected: false,
        session_valid: false,
        last_error: this.lastError,
      };
    }
    const userDataDir = path.resolve(
      getSetting("magnific_runtime_user_data_dir"),
    );
    return {
      running: true,
      connected: existsSync(userDataDir),
      session_valid: !getSetting("magnific_relogin_needed"),
      last_error: this.lastError,
    };
  }

  private async handleDisconnect(): Promise<void> {
    this.context = null;
    if (!getSetting("magnific_runtime_enabled")) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 60_000);
    setTimeout(() => {
      void this.start().catch((err) => {
        if (err instanceof RuntimeLockedError) {
          // lastError was already set inside start(); don't reschedule.
          return;
        }
        this.lastError = err instanceof Error ? err.message : String(err);
      });
    }, delay);
  }
}

// Next.js bundles each App Router route handler independently in production,
// so a bare `export const x = new X()` can be instantiated once PER route
// bundle rather than once per process. The route handlers must share ONE
// runtime (the browser /connect launches has to be the one /stop closes), so
// pin the instance on globalThis — the standard Next pattern for a true
// process-wide singleton across route bundles and the worker.
// (Note: the dashboard pill staleness was a separate issue — GET /status was
// statically prerendered; that is fixed by `force-dynamic` on that route.)
const globalForRuntime = globalThis as unknown as {
  __magnificRuntime?: MagnificRuntime;
};

export const magnificRuntime: MagnificRuntime =
  globalForRuntime.__magnificRuntime ??
  (globalForRuntime.__magnificRuntime = new MagnificRuntime());
