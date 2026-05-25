/**
 * One-shot tool to spawn Chrome with the AmbientForge Suno profile when
 * port 9333 is dead. Mirrors what extensions/suno-runner/chrome-manager.ts
 * does on bridge startup, but standalone — useful when the bridge is
 * already running but Chrome was closed (or before bridge.ts changes have
 * taken effect via a `npm run dev` restart).
 *
 * Idempotent: no-op when Chrome is already alive on port 9333.
 *
 * Usage: npx tsx scripts/ensure-chrome.ts
 */
import {
  ensureChromeRunning,
  refreshCookieFromChrome,
  ensureSunoCreatePage,
} from '../extensions/suno-runner/chrome-manager';

async function main() {
  const ok = await ensureChromeRunning();
  if (!ok) {
    console.error('failed to bring Chrome up — install Chrome or set CHROME_PATH');
    process.exit(1);
  }
  // Refresh cookie file from Chrome's persisted profile so the sidecar's
  // next read picks up whatever Clerk has rotated to. No-op when unchanged.
  await refreshCookieFromChrome();
  // Captcha solver expects /create. Navigate idempotently.
  await ensureSunoCreatePage();
}

main().catch((err) => {
  console.error('ensure-chrome failed:', err);
  process.exit(1);
});
