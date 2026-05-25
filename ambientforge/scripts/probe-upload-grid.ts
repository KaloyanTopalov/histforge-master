/**
 * Task-7 iteration: after the genuine upload (click [data-cy="upload-button"]
 * → filechooser → setFiles), observe the Uploads grid, find the newly
 * uploaded item, select it, click Add, and confirm references 0/8 → 1/8.
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
  const hard = setTimeout(() => process.exit(0), 160_000);
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
    console.log('[grid] filechooser → setFiles');
    await fc.setFiles(SOURCE).catch(() => {});
  });

  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-cy="image-prompt-input"]', { timeout: 20_000 });
  } catch {
    console.log('[grid] not on generator. abort.');
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
  console.log(`[grid] pre-upload counter=${await counter()}/8`);
  await page.locator('[data-cy="upload-button"]').first().click({ timeout: 6000 });
  console.log('[grid] clicked upload-button; observing Uploads grid …');

  const GRID = `(()=>{
    const m=document.querySelector('[data-cy="advanced-selection-modal"]');
    if(!m) return JSON.stringify({modal:false});
    const items=[...m.querySelectorAll('[data-cy^="feed-image-item-"]')];
    const imgs=[...m.querySelectorAll('img')].filter(i=>(i.naturalWidth||i.width)>=40);
    const blobImgs=imgs.filter(i=>/blob:|data:|uploads|user/i.test(i.src||'')).map(i=>(i.src||'').slice(0,60));
    const selected=[...m.querySelectorAll('[aria-selected="true"],[data-selected="true"],[class*="selected" i],[class*="ring-2" i],[class*="border-piki" i]')].length;
    const add=m.querySelector('[data-cy="upload-use-selected-button"]');
    const prog=[...m.querySelectorAll('[role="progressbar"],[class*="spin" i],[class*="progress" i],[class*="uploading" i]')].length;
    return JSON.stringify({modal:true,feedItems:items.length,imgCount:imgs.length,blobImgs:blobImgs.slice(0,3),selected,addDisabled:add?(add.disabled||add.getAttribute('aria-disabled')==='true'):null,progress:prog});
  })()`;

  for (let i = 0; i < 12; i++) {
    console.log(`t=${i * 2}s ${await page.evaluate(GRID).catch((e: any) => 'ERR' + e)}`);
    await page.waitForTimeout(2000);
  }

  // Select the FIRST grid item (newest upload usually prepended), then Add.
  console.log('[grid] selecting first feed-image-item, then Add …');
  await page
    .locator('[data-cy="advanced-selection-modal"] [data-cy^="feed-image-item-"]')
    .first()
    .click({ timeout: 4000 })
    .then(() => console.log('[grid] clicked first feed item'))
    .catch((e: any) => console.log('[grid] feed item click err', String(e).slice(0, 80)));
  await page.waitForTimeout(1500);
  console.log(`[grid] post-select ${await page.evaluate(GRID).catch(() => 'ERR')}`);
  await page
    .locator('[data-cy="upload-use-selected-button"]')
    .first()
    .click({ timeout: 4000 })
    .then(() => console.log('[grid] clicked Add'))
    .catch(() => console.log('[grid] Add not clickable'));
  await page.waitForTimeout(3500);
  console.log(`[grid] FINAL counter=${await counter()}/8  (1/8 = SUCCESS)`);

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('[grid] fatal:', e);
  process.exit(1);
});
