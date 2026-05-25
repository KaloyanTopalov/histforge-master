/**
 * Task-6 automation: drive the freepik-runner editref probe headfully and
 * capture the [freepik-runner][editref] console output without operator hands.
 *
 * Mirrors scripts/freepik-login.ts (persistent profile + extension + the
 * MV3 SW reload-from-disk fix), then: navigates to the signed-in generator,
 * clicks #af-editref-probe-btn (build 2026-05-18b), and prints every
 * [freepik-runner] console line. Zero spend (the probe never fills a prompt
 * or clicks Generate). Self-terminating.
 *
 * Untracked dev tooling — not part of the shipped pipeline.
 */

import path from 'node:path';
import fs from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'freepik-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'freepik-profile');
const HARD_DEADLINE_MS = 100_000;

async function main(): Promise<void> {
  const hardTimer = setTimeout(() => {
    console.log('[probe] hard deadline hit — exiting.');
    process.exit(0);
  }, HARD_DEADLINE_MS);
  hardTimer.unref?.();

  let playwright: any;
  try {
    // @ts-ignore optional dep
    playwright = await import('playwright');
  } catch {
    console.error('[probe] playwright not installed.');
    process.exit(1);
  }

  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  console.log('[probe] launching Chromium (persistent profile + extension)…');
  let context: any;
  try {
    context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [
        `--disable-extensions-except=${EXT_DIR}`,
        `--load-extension=${EXT_DIR}`,
      ],
    });
  } catch (err) {
    console.error(
      '[probe] launchPersistentContext FAILED — is a freepik:login Chrome already using data/freepik-profile? Close it and retry.',
    );
    console.error('[probe] detail:', String(err));
    process.exit(1);
  }

  const lines: string[] = [];
  const record = (src: string, text: string) => {
    if (text.includes('[freepik-runner]')) {
      lines.push(text);
      console.log(`[page:${src}] ${text}`);
    }
  };
  context.on('page', (p: any) => {
    p.on('console', (m: any) => record('console', m.text()));
    p.on('pageerror', (e: any) => console.log('[page:error]', String(e)));
  });

  // MV3 SW reload-from-disk (same rationale as freepik-login.ts).
  const swHasBg = (w: any) => w.url().includes('background');
  try {
    const stale =
      context.serviceWorkers().find(swHasBg) ??
      (await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => undefined));
    if (stale) {
      await stale.evaluate('chrome.runtime.reload()').catch(() => {});
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const fresh = context.serviceWorkers().find(swHasBg);
        if (fresh && fresh !== stale) break;
      }
      console.log('[probe] extension reloaded from disk.');
    }
  } catch {
    /* keepalive-less probe — SW not strictly required for the DOM probe */
  }

  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m: any) => record('console', m.text()));

  const SOURCE = path.resolve(
    process.cwd(),
    'projects/01KRNX8PRFD4MNF5T20P0GXV0C/01KRQR5NKGC1JWNMANQJAHPNEC/source.jpg',
  );
  let fileChooserSeen = false;
  page.on('filechooser', async (fc: any) => {
    fileChooserSeen = true;
    let elInfo = '(unknown)';
    try {
      elInfo = await fc
        .element()
        .evaluate((e: any) => `<${e.tagName.toLowerCase()} data-cy="${e.getAttribute('data-cy')}" data-debug="${e.getAttribute('data-debug')}" accept="${e.getAttribute('accept')}">`);
    } catch {
      /* ignore */
    }
    console.log(`[probe] FILECHOOSER fired. multiple=${fc.isMultiple?.()} element=${elInfo}`);
    try {
      await fc.setFiles(SOURCE);
      console.log('[probe] filechooser.setFiles(source.jpg) OK — reference should populate.');
    } catch (e: any) {
      console.log('[probe] setFiles failed:', String(e));
    }
  });

  const PROMPT_SEL = '[data-cy="image-prompt-input"]';
  let onGenerator = false;
  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector(PROMPT_SEL, { timeout: 15_000 });
    onGenerator = true;
  } catch {
    try {
      await page.goto('https://www.magnific.com/app', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page
        .locator(
          '[data-cy="sidebar-pinned-text-to-image"], [data-cy="registered-tool-ai-image-generator"]',
        )
        .first()
        .click({ timeout: 15_000 });
      await page.waitForSelector(PROMPT_SEL, { timeout: 20_000 });
      onGenerator = true;
    } catch {
      onGenerator = false;
    }
  }
  console.log(
    onGenerator
      ? '[probe] ON the signed-in generator (prompt box found → logged in).'
      : '[probe] NOT on the generator — likely LOGGED OUT or app changed. Capturing whatever loaded.',
  );

  await page.waitForTimeout(4000);

  // Dismiss the OneTrust cookie dialog so it stops shadowing real modals.
  await page
    .evaluate(() => {
      const b =
        document.querySelector('#accept-recommended-btn-handler') ||
        document.querySelector('#onetrust-accept-btn-handler');
      (b as HTMLButtonElement | null)?.click();
    })
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Deep DOM exploration of the add-reference-image flow (the real Task-7
  // path; edit-reference-button only exists AFTER a reference is added).
  const explore = async (label: string, fn: string) => {
    const out = await page.evaluate(fn).catch((e: any) => `EVAL_ERR ${String(e)}`);
    console.log(`\n===== ${label} =====\n${typeof out === 'string' ? out : JSON.stringify(out, null, 2)}`);
  };

  const BOUND = `(el,cap=2500)=>{if(!el)return '(null)';const h=el.outerHTML||'';return h.length>cap?h.slice(0,cap)+' …(+'+(h.length-cap)+')':h;}`;

  await explore(
    'reference area outerHTML',
    `(()=>{const B=${BOUND};const ids=['image-references-input','reference-add-button','reference-style-placeholder','reference-character-placeholder','upload-image-button'];return ids.map(id=>{const el=document.querySelector('[data-cy="'+id+'"]');return id+': '+B(el,1800);}).join('\\n\\n');})()`,
  );

  // Trusted Playwright click (real pointer events — opens Radix triggers that
  // synthetic .click() can't). Try upload-image-button first.
  const tryClick = async (sel: string) => {
    try {
      await page.locator(sel).first().click({ timeout: 6000 });
      console.log(`[probe] trusted-clicked ${sel}`);
      return true;
    } catch (e: any) {
      console.log(`[probe] click ${sel} failed: ${String(e).slice(0, 120)}`);
      return false;
    }
  };

  await tryClick('[data-cy="upload-image-button"]');
  await page.waitForTimeout(2500);

  await explore(
    'after upload-image-button: dialogs/menus + new hooks + file inputs',
    `(()=>{const B=${BOUND};const dialogs=[...document.querySelectorAll('[role="dialog"],[role="menu"],[data-cy*="modal" i],[data-cy*="popover" i]')].filter(d=>!(d.getAttribute('aria-label')||'').includes('Privacy'));const re=/reference|upload|file|drop|edit|style|character|add|modal|crop|use|select/i;const hooks=[...new Set([...document.querySelectorAll('[data-cy]')].map(e=>e.getAttribute('data-cy')).filter(c=>re.test(c||'')))];const fis=[...document.querySelectorAll('input[type=file]')];return 'fileChooserSeen='+${fileChooserSeen}+'\\nhooks: '+JSON.stringify(hooks)+'\\n\\ndialogs/menus:\\n'+dialogs.map(d=>B(d,4500)).join('\\n--\\n')+'\\n\\nfile inputs ('+fis.length+'):\\n'+fis.map(f=>B(f,300)).join('\\n');})()`,
  );

  // The modal opened (advanced-selection-modal). Go to the "Uploads" tab.
  await page
    .locator('[data-cy="reference-sidebar-upload"]')
    .first()
    .click({ timeout: 6000 })
    .then(() => console.log('[probe] clicked reference-sidebar-upload (Uploads tab)'))
    .catch((e: any) => console.log('[probe] Uploads tab click failed:', String(e).slice(0, 120)));
  await page.waitForTimeout(2000);

  await explore(
    'Uploads panel structure (individual-upload-panel + file input + buttons)',
    `(()=>{const B=${BOUND};const panel=document.querySelector('[data-cy="individual-upload-panel"]')||document.querySelector('[data-cy="advanced-selection-modal"]');const fi=document.querySelector('[data-cy="upload-file-input-button"]');const btns=[...document.querySelectorAll('[data-cy="advanced-selection-modal"] button[data-cy]')].map(b=>b.getAttribute('data-cy')+(b.disabled?'(disabled)':''));return 'upload-file-input-button: '+B(fi,400)+'\\n\\nmodal buttons[data-cy]: '+JSON.stringify([...new Set(btns)])+'\\n\\nindividual-upload-panel:\\n'+B(panel,4000);})()`,
  );

  // Set the file directly on the hidden upload input (Playwright can target a
  // hidden input; this is exactly what CDP DOM.setFileInputFiles will do in
  // Task 7, mirroring the end-frame primitive).
  await page
    .locator('input[data-cy="upload-file-input-button"], [data-cy="advanced-selection-modal"] input[type=file]')
    .first()
    .setInputFiles(SOURCE, { timeout: 8000 })
    .then(() => console.log('[probe] setInputFiles(source.jpg) on the modal upload input OK'))
    .catch((e: any) => console.log('[probe] setInputFiles failed:', String(e).slice(0, 160)));
  await page.waitForTimeout(5000);

  await explore(
    'modal AFTER file set (uploaded thumb + confirm/use button)',
    `(()=>{const B=${BOUND};const m=document.querySelector('[data-cy="advanced-selection-modal"]');const btns=[...document.querySelectorAll('[data-cy="advanced-selection-modal"] button')].map(b=>{const t=(b.textContent||'').trim().slice(0,30);return (b.getAttribute('data-cy')||'<btn>')+(t?(' "'+t+'"'):'')+(b.disabled?' [disabled]':'');}).filter(Boolean);return 'modal present='+!!m+'\\nmodal buttons: '+JSON.stringify([...new Set(btns)])+'\\n\\nmodal:\\n'+B(m,7000);})()`,
  );

  // Try the likely confirm/use buttons to apply the upload as a reference.
  for (const sel of [
    '[data-cy="upload-use-selected-button"]',
    '[data-cy="advanced-selection-add-images-button"]',
    '[data-cy="upload-button"]',
    '[data-cy="advanced-selection-modal"] button:has-text("Add")',
    '[data-cy="advanced-selection-modal"] button:has-text("Use")',
  ]) {
    const ok = await page
      .locator(sel)
      .first()
      .click({ timeout: 2500 })
      .then(() => true)
      .catch(() => false);
    if (ok) {
      console.log(`[probe] clicked confirm via ${sel}`);
      break;
    }
  }
  await page.waitForTimeout(4000);

  await explore(
    'reference state after add (counter + cards) — did 0/8 become 1/8?',
    `(()=>{const B=${BOUND};const inp=document.querySelector('[data-cy="image-references-input"]');const counter=inp?(inp.textContent.match(/\\d\\/8/)||['?'])[0]:'?';const cards=[...document.querySelectorAll('[data-cy^="reference-"]')].map(c=>c.getAttribute('data-cy'));return 'counter='+counter+'\\ncards: '+JSON.stringify(cards)+'\\n\\nimage-references-input:\\n'+B(inp,6000);})()`,
  );

  // Hover the first reference card to surface its overlay → edit-reference-button.
  await page
    .locator('[data-cy="image-references-input"] .group\\/reference-card')
    .first()
    .hover({ timeout: 3000 })
    .catch(() => {});
  await page.waitForTimeout(900);

  await explore(
    'edit-reference-button + its card (the operator-supplied hook)',
    `(()=>{const B=${BOUND};const e=document.querySelector('[data-cy="edit-reference-button"]');if(!e)return 'edit-reference-button STILL absent — see counter/cards above';const card=e.closest('.group\\\\/reference-card,[data-cy*="reference" i]');return 'edit-reference-button: '+B(e,900)+'\\n\\ncard: '+B(card,3500);})()`,
  );

  await page
    .locator('[data-cy="edit-reference-button"]')
    .first()
    .click({ timeout: 4000 })
    .then(() => console.log('[probe] clicked edit-reference-button'))
    .catch((e: any) => console.log('[probe] edit-reference-button click skipped:', String(e).slice(0, 100)));
  await page.waitForTimeout(2500);

  await explore(
    'edit-reference modal (Task-7 target DOM)',
    `(()=>{const B=${BOUND};const dialogs=[...document.querySelectorAll('[role="dialog"],[data-cy*="modal" i]')].filter(d=>!(d.getAttribute('aria-label')||'').includes('Privacy'));const re=/edit|reference|crop|adjust|strength|weight|apply|save|done|remove|replace|upload/i;const hooks=[...new Set([...document.querySelectorAll('[data-cy]')].map(e=>e.getAttribute('data-cy')).filter(c=>re.test(c||'')))];return 'hooks: '+JSON.stringify(hooks)+'\\n\\nmodal(s):\\n'+dialogs.map(d=>B(d,5000)).join('\\n--\\n');})()`,
  );

  console.log('\n==================== CAPTURED [freepik-runner] LINES ====================');
  if (lines.length === 0) console.log('(none captured)');
  for (const l of lines) console.log(l);
  console.log('==================== END ====================\n');

  await context.close().catch(() => {});
  clearTimeout(hardTimer);
  process.exit(0);
}

main().catch((err) => {
  console.error('[probe] fatal:', err);
  process.exit(1);
});
