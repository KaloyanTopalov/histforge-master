/**
 * Task-7: capture ONE real human reference-upload. Launches the logged-in
 * profile + extension, auto-opens the reference modal → Uploads tab, then
 * records every click (element + data-cy + path) and every non-GET network
 * request while the OPERATOR manually uploads an image as a reference. When
 * the references counter flips 0/8 → N/8 it snapshots the exact gesture +
 * the recent upload requests. Untracked dev tooling. Zero generation spend.
 *
 * Operator: when the on-page green banner appears, click "Upload an image",
 * pick ANY image, and finish adding it as a reference. Then wait.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'freepik-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'freepik-profile');
const HARD_MS = 240_000;

/** Build a UNIQUE random-pixel PNG so Magnific can't dedupe it against any
 * prior upload — this is the "brand-new image never used before". */
function makeFreshImage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fresh-'));
  const raw = path.join(dir, 'raw.bin');
  const out = path.join(dir, `fresh-${Date.now()}.png`);
  const size = 900;
  fs.writeFileSync(raw, randomBytes(size * size * 3));
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${size}x${size}`,
    '-i', raw, '-frames:v', '1', '-c:v', 'png', out,
  ]);
  fs.unlinkSync(raw);
  return out;
}

async function main(): Promise<void> {
  const hard = setTimeout(() => {
    console.log('[demo] hard deadline — exit.');
    process.exit(0);
  }, HARD_MS);
  hard.unref?.();

  // @ts-ignore optional dep
  const playwright: any = await import('playwright');
  const context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const page = context.pages()[0] ?? (await context.newPage());

  // A brand-new unique image. When the operator's flow opens a file chooser
  // (Playwright always intercepts the native OS dialog), inject THIS so the
  // upload XHR + post-upload sequence is captured for a truly novel image.
  const FRESH = makeFreshImage();
  console.log(`[demo] fresh test image: ${FRESH}`);
  page.on('filechooser', async (fc: any) => {
    console.log('[demo] >>> file chooser opened — injecting the fresh image');
    await fc.setFiles(FRESH).catch((e: any) => console.log('[demo] setFiles err', String(e)));
  });

  // ---- network capture (non-GET / upload-ish) -----------------------------
  const net: string[] = [];
  page.on('request', (r: any) => {
    try {
      const m = r.method();
      const u = r.url();
      const rt = r.resourceType();
      if (m === 'GET' && !/upload|asset|reference|media|file/i.test(u)) return;
      if (/google|sentry|segment|analytics|onetrust|datadog|clarity/i.test(u)) return;
      const ct = (r.headers()['content-type'] || '').slice(0, 40);
      const pd = r.postData();
      net.push(
        `${new Date().toISOString().slice(11, 19)} ${m} ${u.slice(0, 110)} rt=${rt} ct=${ct}${
          pd ? ` body~${pd.length}b` : ''
        }`,
      );
    } catch {
      /* ignore */
    }
  });
  page.on('response', (res: any) => {
    try {
      const u = res.url();
      if (/upload|reference\/|\/media|files?\//i.test(u) && res.request().method() !== 'GET') {
        net.push(`${new Date().toISOString().slice(11, 19)}  ↳ ${res.status()} ${u.slice(0, 110)}`);
      }
    } catch {
      /* ignore */
    }
  });

  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector('[data-cy="image-prompt-input"]', { timeout: 20_000 });
  } catch {
    console.log('[demo] not on generator (logged out?). abort.');
    await context.close();
    process.exit(1);
  }
  await page.waitForTimeout(3000);
  await page
    .evaluate(() =>
      (
        document.querySelector('#accept-recommended-btn-handler') ||
        document.querySelector('#onetrust-accept-btn-handler')
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    .catch(() => {});
  await page.waitForTimeout(1000);

  // ---- click recorder via exposed binding ---------------------------------
  const clicks: string[] = [];
  await page.exposeFunction('__afClick', (d: string) => {
    clicks.push(d);
  });
  // NOTE: pass as a STRING — tsx/esbuild instruments named inner functions in
  // page.evaluate(fn) with a `__name` helper that doesn't exist in the page.
  await page.evaluate(`(() => {
    var desc = function(el){
      if (!el || el === document) return 'document';
      var cy = el.getAttribute && el.getAttribute('data-cy');
      var near = el.closest && el.closest('[data-cy]');
      var nearCy = near && near !== el ? near.getAttribute('data-cy') : null;
      var t = (el.textContent||'').trim().replace(/\\s+/g,' ').slice(0,36);
      var cls = (typeof el.className === 'string' ? el.className : '').slice(0,60);
      return '<'+(el.tagName?el.tagName.toLowerCase():'?')+' data-cy="'+cy+'" nearCy="'+nearCy+'" id="'+el.id+'" "'+t+'" class="'+cls+'">';
    };
    var h = function(e){
      try { window.__afClick(new Date().toISOString().slice(11,19)+' '+e.type+' '+desc(e.target)); } catch(_e){}
    };
    document.addEventListener('pointerdown', h, true);
    document.addEventListener('click', h, true);
    document.addEventListener('change', h, true);
  })()`);

  // NO pre-open — capture the operator's COMPLETE natural flow for adding a
  // brand-new image as a reference (whatever they click, start to finish).
  // On-page instruction banner.
  await page
    .evaluate(() => {
      const b = document.createElement('div');
      b.id = 'af-demo-banner';
      b.textContent =
        'AF CAPTURE: add a NEW reference image your normal manual way (full steps). When a file picker opens it is auto-filled with a fresh test image — just continue. Recording…';
      b.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#15803d;color:#fff;padding:12px;font:700 14px system-ui;text-align:center;box-shadow:0 2px 12px rgba(0,0,0,.4)';
      document.body.appendChild(b);
    })
    .catch(() => {});

  console.log('\n========================================================');
  console.log('[demo] READY. In the Chrome window, add a BRAND-NEW image as a');
  console.log('[demo] reference exactly how you do it manually (full flow).');
  console.log('[demo] The file picker is auto-filled with a fresh image —');
  console.log('[demo] just keep clicking your normal steps. Recording 200s …');
  console.log('========================================================\n');

  const counter = async () =>
    page
      .evaluate(() => {
        const i = document.querySelector('[data-cy="image-references-input"]');
        return i ? ((i.textContent || '').match(/(\d)\s*\/\s*8/) || ['?', '?'])[1] : '?';
      })
      .catch(() => '?');

  let applied = false;
  let flipClicks = 0;
  let flipNet = 0;
  const start = Date.now();
  while (Date.now() - start < 200_000) {
    const c = await counter();
    if (c !== '0' && c !== '?' && Number(c) >= 1) {
      applied = true;
      flipClicks = clicks.length;
      flipNet = net.length;
      console.log(`\n[demo] ★ REFERENCE APPLIED — counter=${c}/8 ★`);
      break;
    }
    await page.waitForTimeout(1200);
  }
  // let any trailing requests land
  await page.waitForTimeout(2500);

  console.log('\n==================== FULL CLICK / CHANGE TRACE ====================');
  for (const c of clicks.slice(-90)) console.log(c);
  console.log('\n==================== NETWORK (non-GET / upload) ====================');
  for (const n of net.slice(-90)) console.log(n);
  if (applied) {
    console.log('\n==================== DECISIVE: last gestures BEFORE the flip ====================');
    for (const c of clicks.slice(Math.max(0, flipClicks - 16), flipClicks)) console.log('  ' + c);
    console.log('  -- network around the flip --');
    for (const n of net.slice(Math.max(0, flipNet - 18), flipNet)) console.log('  ' + n);
  }
  console.log(`\n==================== RESULT: applied=${applied} ====================\n`);

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('[demo] fatal:', e);
  process.exit(1);
});
