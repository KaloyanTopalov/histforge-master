/**
 * Task-7 iteration: after upload-button → filechooser → blob preview appears,
 * dump the DOM around the blob <img> (its clickable wrapper + any select
 * control) and click that wrapper, then Add, to confirm references 0/8 → 1/8.
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
  const hard = setTimeout(() => process.exit(0), 150_000);
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
    console.log('[blob] not on generator. abort.');
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
  await page.locator('[data-cy="upload-button"]').first().click({ timeout: 6000 });
  console.log('[blob] uploaded; waiting for blob preview …');
  await page.waitForTimeout(5000);

  // Dump the blob <img> and its ancestor chain (find the clickable wrapper).
  const dump = await page
    .evaluate(() => {
      const m = document.querySelector('[data-cy="advanced-selection-modal"]');
      if (!m) return 'no modal';
      const blob = [...m.querySelectorAll('img')].find((i) => /^blob:/.test(i.src || ''));
      if (!blob) return 'no blob img in modal';
      const chain: string[] = [];
      let el: any = blob;
      for (let i = 0; i < 6 && el; i++) {
        const cy = el.getAttribute && el.getAttribute('data-cy');
        const role = el.getAttribute && el.getAttribute('role');
        const cls = (typeof el.className === 'string' ? el.className : '').slice(0, 90);
        chain.push(
          `[${i}] <${el.tagName.toLowerCase()} data-cy="${cy}" role="${role}" class="${cls}">`,
        );
        el = el.parentElement;
      }
      const wrap = blob.closest('button,[role="button"],[data-cy],[class*="cursor-pointer" i]');
      return JSON.stringify(
        {
          blobSrc: (blob.src || '').slice(0, 50),
          chain,
          wrap: wrap
            ? `<${wrap.tagName.toLowerCase()} data-cy="${wrap.getAttribute('data-cy')}">`
            : null,
          wrapHTML: wrap ? (wrap.outerHTML || '').slice(0, 600) : null,
        },
        null,
        2,
      );
    })
    .catch((e: any) => 'ERR ' + e);
  console.log('[blob] DOM around uploaded preview:\n' + dump);

  // Click the blob image's clickable wrapper to select it.
  const selected = await page
    .evaluate(() => {
      const m = document.querySelector('[data-cy="advanced-selection-modal"]');
      const blob = m
        ? [...m.querySelectorAll('img')].find((i) => /^blob:/.test((i as HTMLImageElement).src || ''))
        : null;
      if (!blob) return 'no-blob';
      const wrap =
        (blob.closest('button,[role="button"],[class*="cursor-pointer" i]') as HTMLElement) ||
        (blob.parentElement as HTMLElement);
      wrap?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      return 'clicked:' + (wrap?.tagName || '?');
    })
    .catch((e: any) => 'ERR' + e);
  console.log('[blob] select attempt →', selected);
  await page.waitForTimeout(1500);
  const sel = await page
    .evaluate(() => {
      const m = document.querySelector('[data-cy="advanced-selection-modal"]');
      return m
        ? [...m.querySelectorAll('[aria-selected="true"],[class*="selected" i],[class*="ring-2" i],[class*="border-piki" i]')]
            .length
        : -1;
    })
    .catch(() => -1);
  console.log('[blob] selected-affordance count after click:', sel);

  await page
    .locator('[data-cy="upload-use-selected-button"]')
    .first()
    .click({ timeout: 4000 })
    .then(() => console.log('[blob] clicked Add'))
    .catch(() => console.log('[blob] Add not clickable'));
  await page.waitForTimeout(3500);
  console.log(`[blob] FINAL counter=${await counter()}/8  (1/8 = SUCCESS)`);

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('[blob] fatal:', e);
  process.exit(1);
});
