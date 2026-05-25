/**
 * Launches a headed Chromium with the AmbientForge distrokid-runner extension
 * loaded against a persistent profile at data/distrokid-profile/. The operator
 * logs into distrokid.com manually, then closes the window — credentials
 * persist for subsequent worker runs (`DISTROKID_MODE` unset).
 *
 * Playwright is an *optional* dependency to keep the default install fast.
 * Install it the first time you need this script:
 *
 *   npm install --save-dev playwright
 *   npx playwright install chromium
 */

import path from 'node:path';
import fs from 'node:fs';

type PwPage = { goto: (url: string) => Promise<unknown> };
type PwContext = {
  pages: () => PwPage[];
  newPage: () => Promise<PwPage>;
  on: (event: string, handler: () => void) => void;
};

const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'distrokid-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'distrokid-profile');

async function main(): Promise<void> {
  if (!fs.existsSync(EXT_DIR)) {
    console.error(`[distrokid-login] extension directory not found: ${EXT_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let playwright: { chromium: { launchPersistentContext: (...args: unknown[]) => Promise<PwContext> } };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional dependency, install with: npm i -D playwright
    playwright = await import('playwright');
  } catch (err) {
    console.error('[distrokid-login] playwright is not installed.');
    console.error('  Install it with:  npm install --save-dev playwright');
    console.error('  Then download Chromium:  npx playwright install chromium');
    process.exit(1);
    return;
  }

  console.log(`[distrokid-login] launching Chromium`);
  console.log(`[distrokid-login]   profile:   ${PROFILE_DIR}`);
  console.log(`[distrokid-login]   extension: ${EXT_DIR}`);

  const context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://distrokid.com/');

  console.log('[distrokid-login] window open. Sign in to distrokid.com, then close the window.');

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });

  console.log('[distrokid-login] window closed. Profile saved.');
}

main().catch((err) => {
  console.error('[distrokid-login] error:', err);
  process.exit(1);
});
