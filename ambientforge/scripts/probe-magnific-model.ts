/**
 * Focused capture of the SIGNED-IN Magnific app generator
 * (https://www.magnific.com/app/ai-image-generator). Profile is now authed,
 * so this runs unattended: load the real generator, dump all data-cy hooks,
 * find + click the model trigger, dump the opened picker options + search.
 * Tells us exactly how to fix openModelPicker/clickModelOption in content.js.
 *
 *   npx tsx scripts/probe-magnific-model.ts
 */
import path from 'node:path';
import fs from 'node:fs';

const EXT_DIR = path.resolve(process.cwd(), 'extensions', 'freepik-runner');
const PROFILE_DIR = path.resolve(process.cwd(), 'data', 'freepik-profile');
const APP_URL = 'https://www.magnific.com/app/ai-image-generator';
const log = (...a: unknown[]) => console.log('[probe]', ...a);

const READY_JS = `(function(){return !!document.querySelector('textarea,[contenteditable="true"]');})()`;

const DATACY_JS = `(function () {
  var seen = {};
  Array.prototype.slice.call(document.querySelectorAll('[data-cy]')).forEach(function (e) {
    var c = e.getAttribute('data-cy'); if (c && !seen[c]) seen[c] = e.tagName.toLowerCase();
  });
  return Object.keys(seen).map(function (k) { return k + ' <' + seen[k] + '>'; });
})()`;

// Click the model trigger (text holds the current model, e.g. "ModelSeedream
// 5 Lite") and report what it + the opened picker look like.
const PICKER_JS = `(function () {
  function txt(e){return (e.textContent||'').replace(/\\s+/g,' ').trim();}
  function info(e){
    return {
      tag: e.tagName.toLowerCase(),
      dataCy: e.getAttribute('data-cy'),
      role: e.getAttribute('role'),
      aria: e.getAttribute('aria-label'),
      cls: ((e.className&&e.className.baseVal!==undefined?e.className.baseVal:(''+e.className))||'').slice(0,60),
      txt: txt(e).slice(0,50),
      html: (e.outerHTML||'').replace(/\\s+/g,' ').slice(0,240)
    };
  }
  var clickables = Array.prototype.slice.call(document.querySelectorAll('button,[role=button],[role=combobox],[aria-haspopup]'));
  var trig = null;
  for (var i=0;i<clickables.length;i++){ if(/seedream 5 lite/i.test(txt(clickables[i]))){ trig=clickables[i]; break; } }
  if(!trig){ for (var j=0;j<clickables.length;j++){ if(/^model/i.test(txt(clickables[j]))){ trig=clickables[j]; break; } } }
  var trigInfo = trig ? info(trig) : null;
  if (trig) {
    try { trig.click(); } catch (e) {}
  }
  return { trigger: trigInfo };
})()`;

const OPTIONS_JS = `(function () {
  function txt(e){return (e.textContent||'').replace(/\\s+/g,' ').trim();}
  var fam=/seedream|flux|mystic|ideogram|gpt|runway|google|recraft|grok|qwen|reve|imagen|phoenix|classic|nano banana|z image/i;
  var nodes=Array.prototype.slice.call(document.querySelectorAll('button,[role=button],[role=option],[role=menuitem],[role=menuitemradio],li,[data-cy]'));
  var opts=[];
  for (var i=0;i<nodes.length;i++){
    var t=txt(nodes[i]);
    if(t.length>0 && t.length<46 && fam.test(t)){
      opts.push({tag:nodes[i].tagName.toLowerCase(),dataCy:nodes[i].getAttribute('data-cy'),role:nodes[i].getAttribute('role'),txt:t.slice(0,46)});
    }
  }
  var u=[]; var k={}; for (var n=0;n<opts.length;n++){var key=opts[n].tag+'|'+opts[n].txt; if(!k[key]){k[key]=1;u.push(opts[n]);}}
  var search=document.querySelector('input[type=search],input[placeholder*="earch" i],[role=dialog] input,[role=listbox] input');
  return { options:u.slice(0,40), searchInput: search?{ph:search.placeholder||'',cy:search.getAttribute('data-cy')}:null };
})()`;

async function main(): Promise<void> {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  let pw: typeof import('playwright');
  try {
    // @ts-ignore optional dep
    pw = await import('playwright');
  } catch {
    log('playwright not installed'); process.exit(1); return;
  }
  let ctx;
  try {
    ctx = await pw.chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      viewport: { width: 1400, height: 900 },
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
    });
  } catch (err) {
    log('LAUNCH FAILED — close other windows using data/freepik-profile. ' + String((err as Error)?.message ?? err));
    process.exit(2); return;
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  log('opening the Magnific app hub…');
  try {
    await page.goto('https://www.magnific.com/app', {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
  } catch (err) {
    log('nav error: ' + String((err as Error)?.message ?? err));
  }

  console.log('\n********************************************************************');
  console.log('  In THIS window:');
  console.log('   1. If it shows logged out, sign in.');
  console.log('   2. Open the IMAGE GENERATOR tool (click into it from the hub)');
  console.log('      so you see the prompt box + model selector. STOP there.');
  console.log('  I auto-capture once the real generator is up. ~6 min.');
  console.log('********************************************************************\n');

  let ready = false;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(4000);
    let url = '';
    try {
      url = page.url();
      ready = (await page.evaluate(READY_JS).catch(() => false)) as boolean;
    } catch {
      /* page navigating */
    }
    if (i % 3 === 0) log(`wait ${i}: url=${url} hasPrompt=${ready}`);
    if (ready && /\/app\/ai-image-generator/.test(url)) break;
  }
  if (!ready) {
    log('generator never became ready — window left open; sign in / open the');
    log('Image Generator, then tell me and I will retry the capture.');
    await new Promise<void>((r) => ctx.on('close', () => r()));
    return;
  }
  log('generator is up — capturing.');
  await page.waitForTimeout(1500);

  const dataCy = (await page.evaluate(DATACY_JS).catch(() => [])) as string[];
  const pick = (await page.evaluate(PICKER_JS).catch(() => ({ trigger: null }))) as {
    trigger: Record<string, unknown> | null;
  };
  await page.waitForTimeout(1800);
  const opened = (await page.evaluate(OPTIONS_JS).catch(() => ({
    options: [],
    searchInput: null,
  }))) as { options: Record<string, unknown>[]; searchInput: unknown };

  console.log('\n==================== SIGNED-IN APP DUMP ====================');
  console.log('url=' + page.url());
  console.log('\nALL data-cy hooks (' + dataCy.length + '):');
  dataCy.forEach((d) => console.log('  ' + d));
  console.log('\nMODEL TRIGGER element:');
  console.log('  ' + JSON.stringify(pick.trigger, null, 0));
  console.log('\nOPENED PICKER options (' + opened.options.length + '):');
  opened.options.forEach((o) => console.log('  ' + JSON.stringify(o)));
  console.log('\npicker search input: ' + JSON.stringify(opened.searchInput));
  console.log('===========================================================\n');

  log('Window stays open until you close it (leave open for now).');
  await new Promise<void>((r) => ctx.on('close', () => r()));
}

main().catch((err) => {
  console.error('[probe] FATAL', err);
  process.exit(1);
});
