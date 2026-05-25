/**
 * Task-7 iteration (decisive): upload via upload-button → filechooser, then
 * dump the FULL individual-upload-panel + every modal button (data-cy + text
 * + disabled) so the upload's apply/confirm mechanism is unambiguous.
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
  const hard = setTimeout(() => process.exit(0), 140_000);
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

  await page.locator('[data-cy="upload-image-button"]').first().click({ timeout: 8000 });
  await page.waitForSelector('[data-cy="advanced-selection-modal"]', { timeout: 10_000 });
  await page
    .locator('[data-cy="reference-sidebar-upload"]')
    .first()
    .click({ timeout: 6000 })
    .catch(() => {});
  await page.waitForTimeout(1200);
  await page.locator('[data-cy="upload-button"]').first().click({ timeout: 6000 });
  await page.waitForTimeout(6000);

  const out = await page
    .evaluate(() => {
      const m = document.querySelector('[data-cy="advanced-selection-modal"]');
      if (!m) return 'no modal';
      const panel = document.querySelector('[data-cy="individual-upload-panel"]');
      const allBtns = [...m.querySelectorAll('button')].map((b) => {
        const cy = b.getAttribute('data-cy');
        const t = (b.textContent || '').trim().slice(0, 28);
        const dis = (b as HTMLButtonElement).disabled || b.getAttribute('aria-disabled') === 'true';
        return `${cy || '<btn>'}${t ? ` "${t}"` : ''}${dis ? ' [disabled]' : ''}`;
      });
      const blob = [...m.querySelectorAll('img')].some((i) => /^blob:/.test((i as HTMLImageElement).src || ''));
      const panelHTML = panel ? (panel.outerHTML || '') : '(no individual-upload-panel)';
      return JSON.stringify(
        { blobPresent: blob, modalButtons: [...new Set(allBtns)], panelLen: panelHTML.length },
        null,
        2,
      ) + '\n\n---- individual-upload-panel ----\n' + panelHTML.slice(0, 9000);
    })
    .catch((e: any) => 'ERR ' + e);
  console.log(out);

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
