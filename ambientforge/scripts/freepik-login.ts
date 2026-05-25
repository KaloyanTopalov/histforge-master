/**
 * Launches a headed Chromium with the AmbientForge freepik-runner extension
 * loaded against a persistent profile at data/freepik-profile/. The operator
 * signs in to Freepik manually at https://www.freepik.com/login, then closes
 * the window — credentials persist for subsequent worker runs.
 *
 * After login, navigate to https://www.freepik.com/ai/image-generator, open
 * the extension popup, and click "Enable polling". The bridge must be
 * running separately (`npm run freepik:bridge`).
 *
 * Playwright is an optional dev dependency:
 *   npm install --save-dev playwright
 *   npx playwright install chromium
 */

import path from 'node:path';
import fs from 'node:fs';

type PwLocator = {
  first: () => { click: (opts?: Record<string, unknown>) => Promise<unknown> };
};
type PwPage = {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (sel: string, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown>;
  locator: (sel: string) => PwLocator;
  close: () => Promise<unknown>;
};
type PwWorker = { url: () => string; evaluate: (fn: string) => Promise<unknown> };
type PwContext = {
  pages: () => PwPage[];
  newPage: () => Promise<PwPage>;
  on: (event: string, handler: () => void) => void;
  serviceWorkers: () => PwWorker[];
  waitForEvent: (event: string, opts?: Record<string, unknown>) => Promise<PwWorker>;
};

const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'freepik-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'freepik-profile');

async function main(): Promise<void> {
  if (!fs.existsSync(EXT_DIR)) {
    console.error(`[freepik-login] extension directory not found: ${EXT_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let playwright: {
    chromium: { launchPersistentContext: (...args: unknown[]) => Promise<PwContext> };
  };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional dependency, install with: npm i -D playwright
    playwright = await import('playwright');
  } catch {
    console.error('[freepik-login] playwright is not installed.');
    console.error('  Install it with:  npm install --save-dev playwright');
    console.error('  Then download Chromium:  npx playwright install chromium');
    process.exit(1);
    return;
  }

  console.log(`[freepik-login] launching Chromium`);
  console.log(`[freepik-login]   profile:   ${PROFILE_DIR}`);
  console.log(`[freepik-login]   extension: ${EXT_DIR}`);

  const context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  // --- Force the extension to (re)load from disk --------------------------
  // MV3 + a persistent profile PINS the previously-registered service worker.
  // A fresh `--load-extension` re-injects content.js but Chrome can keep
  // running a STALE background.js out of data/freepik-profile, silently
  // breaking any SW message handler added after the pinned version. That is
  // exactly why the cover-pick relay never received `/pick-offer` and the
  // popup sat on "Waiting..." (the stale SW had no `bridgeJson`/`fetchAsThumb`
  // -> handler threw -> "message port closed"). One chrome.runtime.reload()
  // re-registers the SW from disk; verified stale->hardened by
  // scripts/debug-pick-probe3.ts. (Also un-breaks the SW keepalive below,
  // whose self.startPollLoop call was a no-op against the stale SW.)
  const swHasBg = (w: PwWorker) => w.url().includes('background');
  try {
    const stale =
      context.serviceWorkers().find(swHasBg) ??
      ((await context
        .waitForEvent('serviceworker', { timeout: 20_000 })
        .catch(() => undefined)) as PwWorker | undefined);
    if (stale) {
      await stale.evaluate('chrome.runtime.reload()').catch(() => {});
      const deadline = Date.now() + 20_000;
      let fresh: PwWorker | undefined;
      while (Date.now() < deadline) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1000));
        fresh = context.serviceWorkers().find(swHasBg);
        if (fresh && fresh !== stale) break;
      }
      console.log(
        `[freepik-login] extension reloaded from disk — SW ${fresh ? 'refreshed (hardened)' : 'pending'}.`,
      );
    } else {
      console.log('[freepik-login] no SW found to reload (keepalive will recover).');
    }
  } catch (err) {
    console.log('[freepik-login] extension reload step skipped:', String(err));
  }

  const page = context.pages()[0] ?? (await context.newPage());
  // Land on the SIGNED-IN app image generator. NOTE: `/ai/image-generator` is
  // the PUBLIC MARKETING page (different picker — caused MODEL_NOT_FOUND); the
  // real authed generator is `/app/ai-image-generator`. A hard deep-link to it
  // can render blank (SPA hydration), so: try the deep link, and if the prompt
  // box isn't there, enter via the hub + the stable pinned-tool sidebar link.
  const PROMPT_SEL = '[data-cy="image-prompt-input"]';
  const gotoGenerator = async (): Promise<boolean> => {
    try {
      await page.goto('https://www.magnific.com/app/ai-image-generator', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
    } catch {
      /* fall through to hub route */
    }
    try {
      await page.waitForSelector(PROMPT_SEL, { timeout: 12_000 });
      return true;
    } catch {
      /* deep link blank — try the hub route */
    }
    try {
      await page.goto('https://www.magnific.com/app', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      const link = page
        .locator(
          '[data-cy="sidebar-pinned-text-to-image"], [data-cy="registered-tool-ai-image-generator"]',
        )
        .first();
      await link.click({ timeout: 15_000 });
      await page.waitForSelector(PROMPT_SEL, { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  };
  const onGenerator = await gotoGenerator();

  if (onGenerator) {
    console.log('[freepik-login] on the signed-in app image generator (prompt box found).');
  } else {
    console.log('[freepik-login] could NOT confirm the generator — if logged out, sign');
    console.log('[freepik-login] in, then open Image Generator from the left sidebar.');
  }
  console.log('[freepik-login] Sign in if prompted, then just leave the window open.');
  console.log('[freepik-login] Extension polling is always-on (no popup click needed).');
  console.log('[freepik-login] Bridge must be running separately: npm run freepik:bridge');

  // --- Deterministic extension keepalive ----------------------------------
  // MV3 service workers do NOT reliably self-wake under launched Chrome, so
  // the extension sits "idle / not enabled" and never polls the bridge. This
  // script controls the browser, so WE keep the worker polling: every few
  // seconds ensure the SW exists (opening any extension page restarts it)
  // and run its always-on poll loop. No popup clicks, ever.
  const findSw = (): PwWorker | undefined =>
    context.serviceWorkers().find((w) => w.url().includes('background'));
  let extId = '';
  try {
    const sw0 =
      findSw() ??
      (await context
        .waitForEvent('serviceworker', { timeout: 20_000 })
        .catch(() => undefined));
    if (sw0) extId = new URL(sw0.url()).host;
  } catch {
    /* retry inside the interval */
  }
  console.log(`[freepik-login] extension id: ${extId || '(unknown — retrying)'}`);

  const keepAlive = setInterval(() => {
    void (async () => {
      try {
        let sw = findSw();
        if (!sw) {
          if (!extId) {
            const any = context.serviceWorkers()[0];
            if (any) extId = new URL(any.url()).host;
          }
          if (extId) {
            const p = await context.newPage();
            await p
              .goto(`chrome-extension://${extId}/popup.html`, { timeout: 8000 })
              .catch(() => {});
            await p.waitForTimeout(600);
            await p.close().catch(() => {});
            sw = findSw();
          }
        }
        if (sw) {
          await sw
            .evaluate(
              '(()=>{try{self.ensureAlarm&&self.ensureAlarm();self.startPollLoop&&self.startPollLoop();self.pollOnce&&self.pollOnce();}catch(e){}})()',
            )
            .catch(() => {});
        }
      } catch {
        /* never let keepalive throw */
      }
    })();
  }, 7000);

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });
  clearInterval(keepAlive);

  console.log('[freepik-login] window closed. Profile saved.');
}

main().catch((err) => {
  console.error('[freepik-login] error:', err);
  process.exit(1);
});
