/**
 * Task-7 iteration: determine Magnific's REAL reference-upload trigger.
 * Opens the reference modal → Uploads tab, then tries strategies in order
 * and reports which one flips the references counter 0/8 → 1/8:
 *   S1: page.on('filechooser') + click [data-cy="upload-button"] → fc.setFiles
 *   S2: click upload-button, then setInputFiles on a freshly-created temporal input
 *   S3: setInputFiles directly on each data-debug="temporal-input"
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
  const hard = setTimeout(() => process.exit(0), 170_000);
  hard.unref?.();
  // @ts-ignore optional dep
  const playwright: any = await import('playwright');
  const context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  let fcCount = 0;
  let fcInfo = '';
  page.on('filechooser', async (fc: any) => {
    fcCount++;
    try {
      fcInfo = await fc
        .element()
        .evaluate(
          (e: any) =>
            `<${e.tagName.toLowerCase()} data-cy="${e.getAttribute('data-cy')}" data-debug="${e.getAttribute('data-debug')}">`,
        );
    } catch {
      fcInfo = '(elem?)';
    }
    console.log(`[strat] filechooser #${fcCount} el=${fcInfo} — setting source.jpg`);
    await fc.setFiles(SOURCE).catch((e: any) => console.log('[strat] fc.setFiles err', String(e)));
  });

  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-cy="image-prompt-input"]', { timeout: 20_000 });
  } catch {
    console.log('[strat] not on generator. abort.');
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

  const counter = async (): Promise<string> =>
    (await page
      .evaluate(() => {
        const inp = document.querySelector('[data-cy="image-references-input"]');
        return inp ? ((inp.textContent || '').match(/(\d)\s*\/\s*8/) || ['?', '?'])[1] : '?';
      })
      .catch(() => '?')) as string;

  const openModalUploads = async () => {
    // close any open modal first
    await page
      .locator('[data-cy="video-modal-close-button-desktop"]')
      .first()
      .click({ timeout: 1500 })
      .catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('[data-cy="upload-image-button"]').first().click({ timeout: 8000 });
    await page.waitForSelector('[data-cy="advanced-selection-modal"]', { timeout: 10_000 });
    await page
      .locator('[data-cy="reference-sidebar-upload"]')
      .first()
      .click({ timeout: 6000 })
      .catch(() => {});
    await page.waitForTimeout(1500);
  };

  console.log(`[strat] start counter=${await counter()}/8`);

  // -------- S1: filechooser via upload-button --------
  console.log('\n[strat] === S1: click [data-cy="upload-button"] (expect filechooser) ===');
  await openModalUploads();
  const before1 = fcCount;
  await page
    .locator('[data-cy="upload-button"]')
    .first()
    .click({ timeout: 6000 })
    .catch((e: any) => console.log('[strat] upload-button click err', String(e).slice(0, 100)));
  await page.waitForTimeout(6000);
  console.log(`[strat] S1 filechooser fired=${fcCount > before1} (info=${fcInfo})`);
  // wait for upload + auto-select, then Add
  for (let i = 0; i < 10; i++) {
    const c = await counter();
    const addDisabled = await page
      .evaluate(() => {
        const a = document.querySelector('[data-cy="upload-use-selected-button"]') as any;
        return a ? a.disabled || a.getAttribute('aria-disabled') === 'true' : null;
      })
      .catch(() => null);
    console.log(`[strat] S1 t=${i * 2}s counter=${c}/8 addDisabled=${addDisabled}`);
    if (c !== '0' && c !== '?') break;
    await page.waitForTimeout(2000);
  }
  await page
    .locator('[data-cy="upload-use-selected-button"]')
    .first()
    .click({ timeout: 3000 })
    .then(() => console.log('[strat] S1 clicked Add'))
    .catch(() => console.log('[strat] S1 Add not clickable'));
  await page.waitForTimeout(3500);
  console.log(`[strat] S1 RESULT counter=${await counter()}/8  (1/8 = SUCCESS)`);

  if ((await counter()) === '0' || (await counter()) === '?') {
    // -------- S3: direct on temporal inputs --------
    console.log('\n[strat] === S3: setInputFiles on each data-debug="temporal-input" ===');
    await openModalUploads();
    const tinputs = await page.locator('input[data-debug="temporal-input"]').count();
    console.log(`[strat] temporal-input count=${tinputs}`);
    for (let k = 0; k < tinputs; k++) {
      await page
        .locator('input[data-debug="temporal-input"]')
        .nth(k)
        .setInputFiles(SOURCE, { timeout: 6000 })
        .then(() => console.log(`[strat] S3 set temporal-input[${k}]`))
        .catch((e: any) => console.log(`[strat] S3 set[${k}] err`, String(e).slice(0, 80)));
      await page.waitForTimeout(4000);
      console.log(`[strat] S3 after temporal[${k}] counter=${await counter()}/8`);
    }
    await page
      .locator('[data-cy="upload-use-selected-button"]')
      .first()
      .click({ timeout: 3000 })
      .catch(() => {});
    await page.waitForTimeout(3000);
    console.log(`[strat] S3 RESULT counter=${await counter()}/8  (1/8 = SUCCESS)`);
  }

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('[strat] fatal:', e);
  process.exit(1);
});
