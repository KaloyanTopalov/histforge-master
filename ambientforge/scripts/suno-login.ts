/**
 * Launches Chrome with --remote-debugging-port=9333 against a dedicated
 * AmbientForge profile (data/suno-profile/chrome/), then captures the
 * `__session` cookie from suno.com via CDP and writes it to
 * data/suno-profile/.env as SUNO_COOKIE=<value>.
 *
 * The Python sidecar reads that file on startup. The Chrome window also
 * doubles as the hCaptcha solver — leave it open during dev sessions.
 *
 * No Playwright, no extension load. Plain Chrome + DevTools Protocol.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';

const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'suno-profile', 'chrome');
const ENV_FILE = path.resolve(process.cwd(), 'data', 'suno-profile', '.env');
const CDP_PORT = Number(process.env.SUNO_CDP_PORT ?? 9333);
const COOKIE_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1500;

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
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
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

async function fetchTabs(): Promise<Array<{ webSocketDebuggerUrl: string; url: string }>> {
  const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  if (!r.ok) throw new Error(`CDP /json/list -> ${r.status}`);
  return (await r.json()) as Array<{ webSocketDebuggerUrl: string; url: string }>;
}

async function getSunoCookies(): Promise<Array<{ name: string; value: string; domain: string }>> {
  // Pick a tab WS — page-level Network.getAllCookies returns the whole jar
  // (Network domain is target-scoped but cookies are profile-wide), so any
  // page works.
  const tabs = await fetchTabs();
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
        /* ignore parse errors on unrelated frames */
      }
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`CDP WS error: ${err.message}`));
    });
  });
}

function writeEnv(cookieValue: string): void {
  fs.mkdirSync(path.dirname(ENV_FILE), { recursive: true });
  const tmp = `${ENV_FILE}.tmp`;
  fs.writeFileSync(tmp, `SUNO_COOKIE=${cookieValue}\n`, { encoding: 'utf-8' });
  fs.renameSync(tmp, ENV_FILE);
}

async function main(): Promise<void> {
  const chrome = findChromeExecutable();
  if (!chrome) {
    console.error('[suno-login] Could not find Chrome. Set CHROME_PATH.');
    process.exit(1);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  console.log(`[suno-login] Launching Chrome`);
  console.log(`[suno-login]   exe:        ${chrome}`);
  console.log(`[suno-login]   profile:    ${PROFILE_DIR}`);
  console.log(`[suno-login]   debug port: ${CDP_PORT}`);

  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    // Chrome 110+ rejects CDP WebSocket handshakes from any Origin by default.
    // The Python sidecar's BrowserCaptchaSolver opens a WS to drive suno.com
    // when API submission hits a 422 captcha-required response, and the
    // websocket-client library always sends an Origin header. Allow any.
    '--remote-allow-origins=*',
    `--user-data-dir=${PROFILE_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'https://suno.com/',
  ];
  const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
  child.unref();

  console.log(
    `[suno-login] Browser opened — log in to suno.com in the new window.`,
  );
  // We capture the long-lived `__client` cookie (lives on auth.suno.com),
  // NOT the short-lived `__session` JWT. SunoAuth in suno_bot.py treats a
  // non-eyJ-prefixed value as `__client` and uses Clerk's refresh endpoint
  // to mint fresh JWTs on demand. Capturing `__session` directly works for
  // ~5 minutes only, after which Clerk refresh fails (the request session
  // doesn't carry `__client`).
  console.log(
    `[suno-login] Waiting up to ${COOKIE_TIMEOUT_MS / 1000}s for __client cookie…`,
  );

  const deadline = Date.now() + COOKIE_TIMEOUT_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      const cookies = await getSunoCookies();
      const client = cookies.find(
        (c) => c.name === '__client' && c.domain.includes('suno.com'),
      );
      if (client && client.value && client.value.length > 50) {
        writeEnv(client.value);
        console.log(
          `[suno-login] __client cookie captured (length=${client.value.length}). Saved to ${ENV_FILE}`,
        );
        console.log(`[suno-login] Done. Leave this Chrome window open during dev sessions.`);
        return;
      }
    } catch (err) {
      // Surface every error; on the first attempt this is most likely a
      // misconfiguration (CDP not reachable, ws missing, etc) and the user
      // wants to see it immediately, not after the timeout.
      console.error(
        `[suno-login] poll error (attempt ${attempt}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  console.error(`[suno-login] Timed out waiting for __client cookie.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('[suno-login] error:', err);
  process.exit(1);
});
