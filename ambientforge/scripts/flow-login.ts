/**
 * Launches a headed Chromium with the AmbientForge flow-runner extension
 * loaded against a persistent profile at data/flow-profile/. The operator
 * logs into Google at https://labs.google/fx manually, then closes the
 * window — credentials persist for subsequent worker runs (FLOW_MODE unset).
 *
 * After login, open the extension popup and paste:
 *   pollUrl=http://localhost:7343/poll
 *   resultUrl=http://localhost:7343/result
 *   statusUrl=http://localhost:7343/status
 *   accountToken=ambientforge-dev   (any non-empty string in dev)
 * Then click "Grant access to http://localhost:7343" and Start.
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

const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'flow-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'flow-profile');

async function main(): Promise<void> {
  if (!fs.existsSync(EXT_DIR)) {
    console.error(`[flow-login] extension directory not found: ${EXT_DIR}`);
    process.exit(1);
  }
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  let playwright: { chromium: { launchPersistentContext: (...args: unknown[]) => Promise<PwContext> } };
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — optional dependency, install with: npm i -D playwright
    playwright = await import('playwright');
  } catch (err) {
    console.error('[flow-login] playwright is not installed.');
    console.error('  Install it with:  npm install --save-dev playwright');
    console.error('  Then download Chromium:  npx playwright install chromium');
    process.exit(1);
    return;
  }

  console.log(`[flow-login] launching Chromium`);
  console.log(`[flow-login]   profile:   ${PROFILE_DIR}`);
  console.log(`[flow-login]   extension: ${EXT_DIR}`);

  const context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
    ],
  });

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://labs.google/fx/tools/flow');

  console.log('[flow-login] window open. Sign in to Google, then close the window.');
  console.log('[flow-login] After sign-in, open the AmbientForge Flow Runner popup');
  console.log('[flow-login] and paste the localhost URLs (see scripts/flow-login.ts header).');

  await new Promise<void>((resolve) => {
    context.on('close', () => resolve());
  });

  console.log('[flow-login] window closed. Profile saved.');
}

main().catch((err) => {
  console.error('[flow-login] error:', err);
  process.exit(1);
});
