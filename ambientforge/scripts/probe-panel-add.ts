/**
 * Task-7 decisive test: upload via upload-button → filechooser, then click
 * the upload-use-selected-button that is INSIDE individual-upload-panel
 * (NOT the feed-grid footer one). Confirm references 0/8 → 1/8.
 * Untracked dev tooling. Zero generation spend.
 */

import path from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'freepik-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'freepik-profile');
const SOURCE = path
  .resolve(process.cwd(), 'projects/01KRNX8PRFD4MNF5T20P0GXV0C/01KRQR5NKGC1JWNMANQJAHPNEC/source.jpg')
  .replace(/\\/g, '/');

async function main(): Promise<void> {
  const hard = setTimeout(() => process.exit(0), 130_000);
  hard.unref?.();
  // @ts-ignore optional dep
  const playwright: any = await import('playwright');
  const context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());
  page.on('filechooser', async (fc: any) => {
    await fc.setFiles(SOURCE).catch(() => {});
  });

  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-cy="image-prompt-input"]', { timeout: 20_000 });
  } catch {
    console.log('not on generator');
    await context.close();
    process.exit(1);
  }
  await page.waitForTimeout(3500);
  await page
    .evaluate(() =>
      (
        document.querySelector('#accept-recommended-btn-handler') ||
        document.querySelector('#onetrust-accept-btn-handler')
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    .catch(() => {});
  await page.waitForTimeout(1200);

  const counter = async () =>
    page
      .evaluate(() => {
        const i = document.querySelector('[data-cy="image-references-input"]');
        return i ? ((i.textContent || '').match(/(\d)\s*\/\s*8/) || ['?', '?'])[1] : '?';
      })
      .catch(() => '?');

  await page.locator('[data-cy="upload-image-button"]').first().click({ timeout: 8000 });
  await page.waitForSelector('[data-cy="advanced-selection-modal"]', { timeout: 10_000 });
  await page
    .locator('[data-cy="reference-sidebar-upload"]')
    .first()
    .click({ timeout: 6000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  console.log(`pre counter=${await counter()}/8`);
  await page.locator('[data-cy="upload-button"]').first().click({ timeout: 6000 });

  // Wait for the blob preview to land inside the panel.
  await page
    .waitForFunction(
      () => {
        const p = document.querySelector('[data-cy="individual-upload-panel"]');
        return !!p && [...p.querySelectorAll('img')].some((i) => /^blob:/.test((i as HTMLImageElement).src || ''));
      },
      { timeout: 20_000 },
    )
    .then(() => console.log('blob preview present in panel'))
    .catch(() => console.log('blob preview NOT detected (continuing)'));
  await page.waitForTimeout(1500);

  // Click the Add button that is a DESCENDANT of individual-upload-panel.
  const clicked = await page
    .evaluate(() => {
      const panel = document.querySelector('[data-cy="individual-upload-panel"]');
      if (!panel) return 'no-panel';
      const add = panel.querySelector('[data-cy="upload-use-selected-button"]') as HTMLElement | null;
      if (!add) return 'no-panel-add';
      add.click();
      return 'clicked-panel-add';
    })
    .catch((e: any) => 'ERR' + e);
  console.log('panel-Add:', clicked);
  await page.waitForTimeout(3500);
  const fin = await counter();
  console.log(`FINAL counter=${fin}/8  →  ${fin === '1' || (fin !== '0' && fin !== '?') ? 'SUCCESS ✓' : 'still not applied ✗'}`);

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
