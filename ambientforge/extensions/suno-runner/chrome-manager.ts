/**
 * Chrome lifecycle manager for the Suno bridge. Spawns Chrome with the saved
 * AmbientForge profile (data/suno-profile/chrome/) on demand, monitors the
 * CDP port (9333) for liveness, and respawns the browser when it crashes or
 * the operator closes the window. After each respawn the manager re-extracts
 * the long-lived `__client` cookie via CDP and writes it to
 * data/suno-profile/.env so the Python sidecar's next read picks up a fresh
 * value (in case Clerk has rotated it across the gap).
 *
 * Chrome runs detached. We deliberately do NOT track its PID and kill it on
 * bridge shutdown — Chrome is shared infrastructure that survives `tsx watch`
 * reloads and operator-driven dev restarts. Restart-safe: re-running ensure
 * is a noop when 9333 already responds.
 *
 * The first-time login flow (`npm run suno:login`) is unchanged. This module
 * only handles ongoing maintenance: keep Chrome alive between runs without a
 * human re-launching it. After the first cookie capture, the persisted
 * profile keeps the operator logged in across Chrome restarts.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'suno-profile', 'chrome');
const ENV_FILE = path.resolve(process.cwd(), 'data', 'suno-profile', '.env');
const CDP_PORT = Number(process.env.SUNO_CDP_PORT ?? 9333);
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;

const HEALTH_TIMEOUT_MS = 2_000;
const SPAWN_WAIT_TIMEOUT_MS = 60_000;
const SPAWN_WAIT_INTERVAL_MS = 1_000;
// Two consecutive failed health checks before declaring Chrome dead — gives
// a single transient blip room to recover before we respawn.
const FAILURE_THRESHOLD = 2;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function findChromeExecutable(): string | null {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (os.platform() === 'win32') {
    const candidates = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(
        os.homedir(),
        'AppData',
        'Local',
        'Google',
        'Chrome',
        'Application',
        'chrome.exe',
      ),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } else if (os.platform() === 'darwin') {
    const c = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    if (fs.existsSync(c)) return c;
  } else {
    for (const c of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chrome']) {
      if (fs.existsSync(c)) return c;
    }
  }
  return null;
}

export async function isChromeAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_BASE}/json/version`, {
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function spawnChrome(): Promise<void> {
  const exe = findChromeExecutable();
  if (!exe) {
    throw new Error(
      'Chrome executable not found. Set CHROME_PATH or install Chrome at the standard location.',
    );
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.error(`[chrome-manager] spawning Chrome (${exe}) on port ${CDP_PORT}`);
  const child = spawn(
    exe,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      // Chrome 110+ rejects CDP WebSocket handshakes from any Origin by
      // default. The sidecar's BrowserCaptchaSolver opens a WS that always
      // sends an Origin header. Allow any.
      '--remote-allow-origins=*',
      `--user-data-dir=${PROFILE_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Land directly on /create — the captcha-solver fill_js expects the
      // Advanced tab to be present in the DOM and does NOT navigate itself.
      // The default suno.com/ → /discover redirect would trigger
      // "advanced_tab_not_found" on the next submit.
      'https://suno.com/create',
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();

  // Poll until CDP responds. Don't trust the spawn — Chrome may take a few
  // seconds to wire up the debugger port even after the process is up.
  const deadline = Date.now() + SPAWN_WAIT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isChromeAlive()) {
      console.error(`[chrome-manager] Chrome ready on port ${CDP_PORT}`);
      // Even after Chrome reports alive, the SPA may take an additional
      // moment to render the Advanced-tab DOM. The captcha-solver retries
      // its own waits so we don't add explicit polling here — but if the
      // landing URL drifts past redirects, ensureSunoCreatePage corrects it.
      await ensureSunoCreatePage();
      return;
    }
    await sleep(SPAWN_WAIT_INTERVAL_MS);
  }
  throw new Error(
    `Chrome did not respond on port ${CDP_PORT} within ${SPAWN_WAIT_TIMEOUT_MS}ms`,
  );
}

/**
 * If a Suno tab exists but is not on /create, drive it there via CDP. Idempotent.
 * Used after a fresh spawn (in case the redirect chain moved the tab) and could
 * be called proactively if a future submit returns "advanced_tab_not_found".
 */
export async function ensureSunoCreatePage(): Promise<void> {
  let tabs: CdpTab[] = [];
  try {
    tabs = await fetchTabs();
  } catch {
    return; // Chrome not actually up — caller will retry
  }
  const sunoTabs = tabs.filter(
    (t) => (t as { type?: string }).type === 'page' && t.url.includes('suno.com'),
  );
  if (sunoTabs.length === 0) return; // nothing to navigate
  const target = sunoTabs[0];
  if (target.url.includes('/create')) return; // already there
  console.error(`[chrome-manager] navigating Suno tab ${target.url} -> /create`);
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new Error('CDP navigate timeout'));
    }, 10_000);
    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          id: 1,
          method: 'Page.navigate',
          params: { url: 'https://suno.com/create' },
        }),
      );
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as { id?: number; error?: { message: string } };
        if (msg.id === 1) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve();
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  }).catch((err) => {
    console.error(`[chrome-manager] navigate to /create failed: ${(err as Error).message}`);
  });
}

/**
 * Idempotent: starts Chrome only when not already responding. Safe to call on
 * every bridge boot. Returns true when Chrome is alive afterwards (whether
 * it was already running or we spawned it).
 *
 * Always calls ensureSunoCreatePage afterwards: when Chrome was already alive
 * from a prior `npm run suno:login` it would typically be sitting on /discover,
 * and the captcha-solver fill_js needs the Advanced tab on /create. Without
 * this nudge, the first submit after `npm run dev` would fail with
 * "advanced_tab_not_found" and the Phase-3 auto-resume would loop.
 */
export async function ensureChromeRunning(): Promise<boolean> {
  if (await isChromeAlive()) {
    console.error(`[chrome-manager] Chrome already alive on port ${CDP_PORT}`);
    await ensureSunoCreatePage();
    return true;
  }
  try {
    await spawnChrome();
    return true;
  } catch (err) {
    console.error(`[chrome-manager] failed to ensure Chrome: ${(err as Error).message}`);
    return false;
  }
}

type CdpTab = { webSocketDebuggerUrl: string; url: string };

async function fetchTabs(): Promise<CdpTab[]> {
  const r = await fetch(`${CDP_BASE}/json/list`, {
    signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`CDP /json/list -> ${r.status}`);
  return (await r.json()) as CdpTab[];
}

async function getSunoCookies(): Promise<Array<{ name: string; value: string; domain: string }>> {
  const tabs = await fetchTabs();
  // Network.getAllCookies returns the universal jar regardless of which tab
  // we open the WS against, so the fallback to tabs[0] is purely about having
  // *some* debuggable target — not about which jar we're sampling.
  const tab = tabs.find((t) => t.url.includes('suno.com')) ?? tabs[0];
  if (!tab?.webSocketDebuggerUrl) {
    throw new Error('no debuggable tab found');
  }
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(new Error('CDP WS timeout'));
    }, 10_000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ id, method: 'Network.getAllCookies' }));
    });
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as {
          id?: number;
          result?: { cookies: Array<{ name: string; value: string; domain: string }> };
          error?: { message: string };
        };
        if (msg.id === id) {
          clearTimeout(timer);
          ws.close();
          if (msg.error) reject(new Error(msg.error.message));
          else resolve(msg.result?.cookies ?? []);
        }
      } catch {
        /* ignore */
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`CDP WS error: ${err.message}`));
    });
  });
}

/**
 * Re-extract the `__client` cookie via CDP and write it to data/suno-profile/.env.
 * Returns true on success. Caller is expected to restart the sidecar so it
 * picks up the new cookie (the sidecar reads .env on startup).
 *
 * No-op safe: if the new cookie matches the existing one byte-for-byte (which
 * is common when nothing actually rotated), the file isn't touched.
 */
export async function refreshCookieFromChrome(): Promise<boolean> {
  try {
    const cookies = await getSunoCookies();
    const client = cookies.find(
      (c) => c.name === '__client' && c.domain.includes('suno.com'),
    );
    if (!client || !client.value || client.value.length < 50) {
      console.error('[chrome-manager] __client cookie not present in Chrome jar (operator may need to re-login)');
      return false;
    }
    let existing = '';
    try {
      existing = fs.readFileSync(ENV_FILE, 'utf-8');
    } catch {
      /* file may not exist yet */
    }
    const newLine = `SUNO_COOKIE=${client.value}\n`;
    if (existing === newLine) {
      console.error('[chrome-manager] cookie unchanged, no .env write needed');
      return true;
    }
    fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
    const tmp = `${ENV_FILE}.tmp`;
    fs.writeFileSync(tmp, newLine, { encoding: 'utf-8' });
    fs.renameSync(tmp, ENV_FILE);
    console.error(
      `[chrome-manager] refreshed __client cookie (length=${client.value.length}) -> ${ENV_FILE}`,
    );
    return true;
  } catch (err) {
    console.error(`[chrome-manager] cookie refresh failed: ${(err as Error).message}`);
    return false;
  }
}

export type WatchdogOptions = {
  /** How often to ping CDP /json/version. Default 30s. */
  intervalMs?: number;
  /**
   * Called when Chrome was unreachable, then we successfully respawned it
   * and (if possible) refreshed the cookie. Bridge uses this to restart
   * the sidecar so it picks up the new cookie.
   */
  onChromeRecovered?: () => void;
};

let watchdogTimer: NodeJS.Timeout | null = null;
let consecutiveFailures = 0;
// Single in-flight spawn lock. The watchdog ticks every 30s but spawnChrome's
// polling loop can take up to SPAWN_WAIT_TIMEOUT_MS (60s) to time out. Without
// this guard, two ticks could race and call spawn() concurrently against the
// same --user-data-dir, wasting a 60s spawn cycle and littering logs.
let inFlightSpawn: Promise<void> | null = null;

async function watchdogTick(opts: WatchdogOptions): Promise<void> {
  // If a respawn is already in progress, skip — we'd just race the same
  // user-data-dir lock and waste another 60s spawn timeout.
  if (inFlightSpawn) return;
  if (await isChromeAlive()) {
    if (consecutiveFailures > 0) {
      console.error('[chrome-manager] watchdog: Chrome recovered on its own');
      consecutiveFailures = 0;
    }
    return;
  }
  consecutiveFailures++;
  if (consecutiveFailures < FAILURE_THRESHOLD) {
    console.error(
      `[chrome-manager] watchdog: Chrome unreachable (failure ${consecutiveFailures}/${FAILURE_THRESHOLD})`,
    );
    return;
  }
  console.error('[chrome-manager] watchdog: respawning Chrome');
  inFlightSpawn = (async () => {
    try {
      await spawnChrome();
      consecutiveFailures = 0;
      await refreshCookieFromChrome();
      if (opts.onChromeRecovered) opts.onChromeRecovered();
    } catch (err) {
      console.error(`[chrome-manager] watchdog respawn failed: ${(err as Error).message}`);
      // Stay in failure state; next tick will try again.
    }
  })();
  try {
    await inFlightSpawn;
  } finally {
    inFlightSpawn = null;
  }
}

export function startChromeWatchdog(opts: WatchdogOptions = {}): void {
  if (watchdogTimer) return;
  const interval = opts.intervalMs ?? 30_000;
  console.error(`[chrome-manager] watchdog started (interval=${interval}ms)`);
  watchdogTimer = setInterval(() => {
    watchdogTick(opts).catch((err) => {
      console.error(`[chrome-manager] watchdog tick error: ${(err as Error).message}`);
    });
  }, interval);
  // Don't keep the event loop alive on its own. The bridge's HTTP server
  // is what holds the process up; the watchdog tags along.
  watchdogTimer.unref?.();
}

export function stopChromeWatchdog(): void {
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
    consecutiveFailures = 0;
  }
}

/** Test-only seam: reset the watchdog state (consecutiveFailures + in-flight
 *  spawn). Mirror of `__resetBridgeRecoveryThrottle` for parity. */
export function __resetChromeWatchdogState(): void {
  consecutiveFailures = 0;
  inFlightSpawn = null;
}
