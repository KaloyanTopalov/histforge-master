/**
 * Task-7 micro-probe: open the reference upload modal, CDP-set source.jpg on
 * the file input, then time-sample the modal every 2s to learn exactly when
 * the uploaded image appears, whether it auto-selects, and when "Add"
 * (upload-use-selected-button) truly applies it (counter 0/8 → 1/8).
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
  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-cy="image-prompt-input"]', { timeout: 20_000 });
  } catch {
    console.log('[tl] not on generator (logged out?). abort.');
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
  await page.waitForTimeout(1500);
  await page
    .locator('input[data-cy="upload-file-input-button"], [data-cy="advanced-selection-modal"] input[type=file]')
    .first()
    .setInputFiles(SOURCE, { timeout: 8000 });
  console.log('[tl] file set; sampling modal every 2s …');

  const SAMPLE = `(()=>{
    const m=document.querySelector('[data-cy="advanced-selection-modal"]');
    const inp=document.querySelector('[data-cy="image-references-input"]');
    const counter=inp?((inp.textContent.match(/(\\d)\\s*\\/\\s*8/)||[])[1]||'?'):'?';
    const add=document.querySelector('[data-cy="upload-use-selected-button"]');
    const clear=document.querySelector('[data-cy="clear-selection-button"]');
    const panel=document.querySelector('[data-cy="individual-upload-panel"]');
    // images inside the modal (uploaded thumb candidates)
    const imgs=m?[...m.querySelectorAll('img')].filter(i=>(i.naturalWidth||i.width)>=40).map(i=>(i.src||'').slice(0,70)):[];
    // any "selected" affordance
    const sel=m?[...m.querySelectorAll('[aria-selected="true"],[data-selected="true"],.ring,[class*="selected" i],[class*="ring-" i]')].length:0;
    // progress / spinner
    const prog=m?[...m.querySelectorAll('[role="progressbar"],[class*="progress" i],[class*="spinner" i],[class*="animate-spin" i]')].length:0;
    // newest item in panel
    const firstItem=panel?panel.querySelector('button[data-cy^="feed-image-item-"],img'):null;
    return JSON.stringify({
      modal:!!m, counter, addPresent:!!add, addDisabled:add?(add.disabled||add.getAttribute('aria-disabled')==='true'):null,
      clearPresent:!!clear, modalImgs:imgs.length, firstImgs:imgs.slice(0,3), selAffordance:sel, progress:prog,
      panelFirst:firstItem?(firstItem.getAttribute('data-cy')||firstItem.tagName):null
    });
  })()`;

  for (let i = 0; i < 14; i++) {
    const s = await page.evaluate(SAMPLE).catch((e: any) => 'ERR ' + String(e));
    console.log(`t=${(i * 2).toString().padStart(2)}s ${s}`);
    await page.waitForTimeout(2000);
  }

  // Try: click the newest uploaded thumbnail in the panel to select it, then Add.
  console.log('[tl] attempting: click newest panel image → Add → recheck counter');
  await page
    .evaluate(() => {
      const panel = document.querySelector('[data-cy="individual-upload-panel"]');
      const it =
        panel?.querySelector('button[data-cy^="feed-image-item-"]') ||
        panel?.querySelector('img');
      (it as HTMLElement | null)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    })
    .catch(() => {});
  await page.waitForTimeout(1500);
  console.log('after panel-click:', await page.evaluate(SAMPLE).catch(() => 'ERR'));
  await page
    .locator('[data-cy="upload-use-selected-button"]')
    .first()
    .click({ timeout: 4000 })
    .catch((e: any) => console.log('[tl] Add click failed:', String(e).slice(0, 80)));
  await page.waitForTimeout(3000);
  console.log('after Add:', await page.evaluate(SAMPLE).catch(() => 'ERR'));

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('[tl] fatal:', e);
  process.exit(1);
});
