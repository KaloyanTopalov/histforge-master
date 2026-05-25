/**
 * Task-7: confirm the FRESH-upload recipe using the operator-validated commit
 * button. upload-image-button → modal → Uploads tab → upload-button →
 * filechooser(setFiles) → wait for the uploaded tile → select newest
 * feed-image-item (or the blob tile) → [data-cy="advanced-selection-add-images-button"]
 * → expect references counter 0/8 → 1/8. Untracked dev tooling.
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
    console.log('not on generator');
    await context.close();
    process.exit(1);
  }
  await page.waitForTimeout(3000);
  await page
    .evaluate(
      `(() => { var b = document.querySelector('#accept-recommended-btn-handler') || document.querySelector('#onetrust-accept-btn-handler'); if (b) b.dispatchEvent(new MouseEvent('click',{bubbles:true})); })()`,
    )
    .catch(() => {});
  await page.waitForTimeout(1000);

  const counter = async () =>
    page
      .evaluate(
        `(() => { var i=document.querySelector('[data-cy="image-references-input"]'); return i?((i.textContent||'').match(/(\\d)\\s*\\/\\s*8/)||['?','?'])[1]:'?'; })()`,
      )
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

  // snapshot existing feed-item ids
  const before = (await page
    .evaluate(
      `(() => [...document.querySelectorAll('[data-cy^="feed-image-item-"]')].map(e=>e.getAttribute('data-cy')))()`,
    )
    .catch(() => [])) as string[];

  await page.locator('[data-cy="upload-button"]').first().click({ timeout: 6000 });
  console.log('clicked upload-button; waiting for uploaded tile/blob …');
  // wait for either a NEW feed-image-item or the blob preview
  await page
    .waitForFunction(
      `(() => {
        var before = ${JSON.stringify(before)};
        var items = [...document.querySelectorAll('[data-cy^="feed-image-item-"]')].map(e=>e.getAttribute('data-cy'));
        var fresh = items.filter(x=>before.indexOf(x)===-1);
        var blob = [...document.querySelectorAll('[data-cy="advanced-selection-modal"] img')].some(i=>/^blob:/.test(i.src||''));
        return fresh.length>0 || blob;
      })()`,
      { timeout: 25_000 },
    )
    .then(() => console.log('uploaded tile/blob detected'))
    .catch(() => console.log('no fresh tile/blob detected (continuing)'));
  await page.waitForTimeout(2500);

  // STAGE 1: in the individual-upload-panel, click upload-use-selected-button
  // ("Add") to stage the just-uploaded blob into the picker.
  const stage = await page
    .evaluate(
      `(() => { var p=document.querySelector('[data-cy="individual-upload-panel"]'); var b=(p&&p.querySelector('[data-cy="upload-use-selected-button"]'))||document.querySelector('[data-cy="upload-use-selected-button"]'); if(!b) return 'no-stage-btn'; b.click(); return 'staged via upload-use-selected-button'; })()`,
    )
    .catch((e: any) => 'ERR' + e);
  console.log('stage1 →', stage, ' counter=' + (await counter()));
  await page.waitForTimeout(3000);

  // Now the grid/picker view should show the upload as a (selected?) tile.
  const grid = await page
    .evaluate(
      `(() => {
        var items=[...document.querySelectorAll('[data-cy^="feed-image-item-"]')];
        var commit=document.querySelector('[data-cy="advanced-selection-add-images-button"]');
        var blob=[...document.querySelectorAll('[data-cy="advanced-selection-modal"] img')].find(i=>/^blob:/.test(i.src||''));
        return JSON.stringify({feedItems:items.length, firstFeed:items[0]?items[0].getAttribute('data-cy'):null, commitBtn:!!commit, commitDisabled:commit?(commit.disabled||commit.getAttribute('aria-disabled')==='true'):null, blobStill:!!blob});
      })()`,
    )
    .catch((e: any) => 'ERR' + e);
  console.log('post-stage grid →', grid);

  // Select the first/newest feed tile if present (operator selected one).
  await page
    .evaluate(
      `(() => { var it=document.querySelector('[data-cy^="feed-image-item-"]'); if(it){ it.dispatchEvent(new MouseEvent('click',{bubbles:true})); return 'clicked '+it.getAttribute('data-cy'); } return 'no-feed-item'; })()`,
    )
    .then((r: any) => console.log('select →', r))
    .catch(() => {});
  await page.waitForTimeout(1200);

  // STAGE 2: commit with the OPERATOR-VALIDATED button.
  const commit = await page
    .evaluate(
      `(() => { var b=document.querySelector('[data-cy="advanced-selection-add-images-button"]'); if(!b) return 'no-commit-btn'; if(b.disabled||b.getAttribute('aria-disabled')==='true') return 'commit-disabled'; b.click(); return 'clicked-advanced-selection-add-images-button'; })()`,
    )
    .catch((e: any) => 'ERR' + e);
  console.log('stage2 commit →', commit);
  await page.waitForTimeout(4000);
  const fin = await counter();
  console.log(`FINAL counter=${fin}/8  →  ${fin !== '0' && fin !== '?' ? 'SUCCESS ✓✓✓' : 'still 0 ✗'}`);

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
