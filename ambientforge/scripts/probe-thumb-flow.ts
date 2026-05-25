/**
 * Task-7 live verification: drive the new content.js `imagegen-thumbnail`
 * path end-to-end via the SW → content `freepik:execute` relay (the real
 * production path, minus the bridge/worker). Magnific Seedream runs on
 * Freepik Premium (unlimited) so Generate is free.
 *
 * Captures the structured executeTask result + every [freepik-runner]/[thumb]
 * console line so the add-reference-image + collect-all flow can be verified
 * and iterated without blind content.js edits. Untracked dev tooling.
 */

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

/* eslint-disable @typescript-eslint/no-explicit-any */
const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'freepik-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'freepik-profile');
// Production source.jpg is a per-album unique Seedream cover, so simulate
// that with a unique random image (a reused file may dedupe in Magnific's
// Uploads and never appear as a NEW feed tile).
function makeFreshImage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-thumbsrc-'));
  const raw = path.join(dir, 'raw.bin');
  const out = path.join(dir, `src-${Date.now()}.png`);
  const sz = 1024;
  fs.writeFileSync(raw, randomBytes(sz * sz * 3));
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pixel_format', 'rgb24', '-video_size', `${sz}x${sz}`,
    '-i', raw, '-frames:v', '1', '-c:v', 'png', out,
  ]);
  fs.unlinkSync(raw);
  return out;
}
const SOURCE = makeFreshImage();
const HARD_DEADLINE_MS = 260_000;

async function main(): Promise<void> {
  const hard = setTimeout(() => {
    console.log('[thumb-flow] hard deadline — exit.');
    process.exit(0);
  }, HARD_DEADLINE_MS);
  hard.unref?.();

  let playwright: any;
  try {
    // @ts-ignore optional dep
    playwright = await import('playwright');
  } catch {
    console.error('[thumb-flow] playwright not installed.');
    process.exit(1);
  }
  if (!fs.existsSync(SOURCE)) {
    console.error('[thumb-flow] source.jpg missing:', SOURCE);
    process.exit(1);
  }

  let context: any;
  try {
    context = await playwright.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
  } catch (err) {
    console.error(
      '[thumb-flow] launch FAILED — a freepik:login Chrome may hold data/freepik-profile. Close it.',
    );
    console.error(String(err));
    process.exit(1);
  }

  const record = (t: string) => {
    if (t.includes('[freepik-runner]')) console.log(`[page] ${t}`);
  };
  context.on('page', (p: any) => p.on('console', (m: any) => record(m.text())));

  // MV3 SW reload-from-disk (so the 2026-05-18c content.js + handlers run).
  const swHasBg = (w: any) => w.url().includes('background');
  try {
    const stale =
      context.serviceWorkers().find(swHasBg) ??
      (await context.waitForEvent('serviceworker', { timeout: 20_000 }).catch(() => undefined));
    if (stale) {
      await stale.evaluate('chrome.runtime.reload()').catch(() => {});
      const dl = Date.now() + 20_000;
      while (Date.now() < dl) {
        await new Promise((r) => setTimeout(r, 1000));
        const fresh = context.serviceWorkers().find(swHasBg);
        if (fresh && fresh !== stale) break;
      }
      console.log('[thumb-flow] extension reloaded from disk.');
    }
  } catch {
    /* SW recovers via keepalive-less path; fine for a one-shot */
  }

  const page = context.pages()[0] ?? (await context.newPage());
  page.on('console', (m: any) => record(m.text()));

  const PROMPT_SEL = '[data-cy="image-prompt-input"]';
  let onGen = false;
  try {
    await page.goto('https://www.magnific.com/app/ai-image-generator', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    await page.waitForSelector(PROMPT_SEL, { timeout: 15_000 });
    onGen = true;
  } catch {
    try {
      await page.goto('https://www.magnific.com/app', {
        waitUntil: 'domcontentloaded',
        timeout: 60_000,
      });
      await page
        .locator('[data-cy="sidebar-pinned-text-to-image"], [data-cy="registered-tool-ai-image-generator"]')
        .first()
        .click({ timeout: 15_000 });
      await page.waitForSelector(PROMPT_SEL, { timeout: 20_000 });
      onGen = true;
    } catch {
      onGen = false;
    }
  }
  if (!onGen) {
    console.log('[thumb-flow] NOT on the generator (logged out / app changed). Aborting.');
    await context.close().catch(() => {});
    process.exit(1);
  }
  console.log('[thumb-flow] on the signed-in generator.');
  await page.waitForTimeout(4000);
  await page
    .evaluate(() =>
      (
        document.querySelector('#accept-recommended-btn-handler') ||
        document.querySelector('#onetrust-accept-btn-handler')
      )?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    .catch(() => {});
  await page.waitForTimeout(1500);

  // Dispatch the new imagegen-thumbnail task through the SW → content relay
  // (exactly what background.js runTask does).
  const sw =
    context.serviceWorkers().find(swHasBg) ??
    (await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => undefined));
  if (!sw) {
    console.log('[thumb-flow] no SW — cannot dispatch.');
    await context.close().catch(() => {});
    process.exit(1);
  }

  const task = {
    id: 'probe-thumb-1',
    mode: 'imagegen-thumbnail',
    model: 'Seedream 5 Lite',
    aspectRatio: '16:9',
    count: 2,
    imagePrompt:
      'TITLE_BLOCK\nLine 1: The Knight\nLine 2: Quiet Fire\nLine 3: GATES OF VORTALANIA\ncinematic medieval title overlay, cream serif, top-left, soft drop shadow',
    referenceImagePath: SOURCE.replace(/\\/g, '/'),
  };

  console.log('[thumb-flow] dispatching imagegen-thumbnail via SW → content …');
  const evalSrc = `(async () => {
    const tabs = await chrome.tabs.query({ url: '*://*.magnific.com/*' });
    if (!tabs.length) return { error: 'NO_MAGNIFIC_TAB' };
    try {
      const r = await chrome.tabs.sendMessage(tabs[0].id, { type: 'freepik:execute', task: ${JSON.stringify(
        task,
      )} });
      if (r && Array.isArray(r.mediaFiles)) {
        return { ok: true, mediaCount: r.mediaFiles.length, mimes: r.mediaFiles.map(m => m.mimeType), sizes: r.mediaFiles.map(m => m.size) };
      }
      return r;
    } catch (e) { return { error: 'SENDMESSAGE_THREW: ' + String(e) }; }
  })()`;
  const result = await sw.evaluate(evalSrc).catch((e: any) => ({ error: 'EVAL_ERR ' + String(e) }));

  console.log('\n==================== imagegen-thumbnail RESULT ====================');
  console.log(JSON.stringify(result, null, 2));
  console.log('==================================================================\n');

  await context.close().catch(() => {});
  clearTimeout(hard);
  process.exit(0);
}

main().catch((e) => {
  console.error('[thumb-flow] fatal:', e);
  process.exit(1);
});
