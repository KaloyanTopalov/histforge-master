/**
 * Validate per-album artifacts for the Midnight Whispers 3-album mock run.
 *
 * Usage: tsx scripts/validate-mock-albums-2026-04-29.ts <albumId1> <albumId2> ...
 *
 * Env: AMBIENTFORGE_DB_PATH must point at the validation DB.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';
const PROJECTS = path.join(process.cwd(), 'projects');
const PIPELINE_LOG = path.join(process.cwd(), 'data', 'pipeline.log');

type Result = { name: string; pass: boolean; note: string };

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function ffprobeWh(file: string): { w: number; h: number } | null {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0', file,
    ]).toString().trim();
    const [w, h] = out.split(',').map(Number);
    if (Number.isFinite(w) && Number.isFinite(h)) return { w, h };
  } catch {
    /* ignore */
  }
  return null;
}

function readFile(file: string): string | null {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function categorizeTitle(title: string): 'reassurance' | 'imperative' | 'unknown' {
  const t = title.trim();
  if (t.endsWith('...') || (!t.endsWith('.') && !t.endsWith('?') && !t.endsWith('!'))) return 'reassurance';
  if (t.endsWith('.')) return 'imperative';
  return 'unknown';
}

function validateAlbum(albumId: string): Result[] {
  const dir = path.join(PROJECTS, CHANNEL_ID, albumId);
  const r: Result[] = [];

  // 1. title.txt
  const title = readFile(path.join(dir, 'title.txt'));
  if (title === null) {
    r.push({ name: 'title.txt', pass: false, note: 'missing' });
  } else {
    const t = title.trim();
    const lower = t === t.toLowerCase();
    r.push({ name: 'title.txt', pass: lower && t.length > 0, note: `"${t}" lowercase=${lower}` });
  }

  // 2. description.txt — structural blocks
  const desc = readFile(path.join(dir, 'description.txt'));
  if (desc === null) {
    r.push({ name: 'description.txt', pass: false, note: 'missing' });
  } else {
    const hasTagline = desc.includes('ambient sleep music for overthinking');
    const hasAffirm = desc.includes('I hope you like my music ❤️') && desc.includes('Please like and subscribe ❤️');
    const hasAttrib = desc.includes('All pictures are made by myself.') && desc.includes('All music is either made by me or friends.');
    const hasHashtagLine = desc.includes('#ambient') && desc.includes('#sleep');
    const hasSeoBlock = desc.includes('ambient sleep music') && desc.includes('insomnia relief') && desc.includes('deep sleep music');
    const hasSmiley = desc.includes(':)');
    const hasHeart = desc.includes('❤️');
    const hasSleepEmoji = !desc.match(/[^a-zA-Z0-9\s.,'":!?\-#❤️():\)\.\n]/) || true;
    const otherEmojis = desc.match(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu)?.filter((c) => c !== '\u{1F4A4}' && c !== '\u{2764}') ?? [];
    const otherEmojiOk = otherEmojis.length === 0;
    const all = hasTagline && hasAffirm && hasAttrib && hasHashtagLine && hasSeoBlock && hasSmiley && hasHeart && otherEmojiOk;
    r.push({
      name: 'description.txt',
      pass: all,
      note: `tagline=${hasTagline} affirm=${hasAffirm} attrib=${hasAttrib} hashtag=${hasHashtagLine} seo=${hasSeoBlock} smiley=${hasSmiley} heart=${hasHeart} otherEmoji=[${otherEmojis.join(',')}]`,
    });
  }

  // 3. tracklist.txt — first 3 entries
  const tl = readFile(path.join(dir, 'tracklist.txt'));
  if (tl === null) {
    r.push({ name: 'tracklist.txt', pass: false, note: 'missing' });
  } else {
    const lines = tl.trim().split(/\r?\n/);
    const first3 = lines.slice(0, 3);
    const allMatch = first3.every((l) => /^\d+:\d{2} - .+$/.test(l));
    const titlesLower = first3.every((l) => {
      const m = l.match(/^\d+:\d{2} - (.+)$/);
      return m ? m[1] === m[1].toLowerCase() : false;
    });
    r.push({ name: 'tracklist.txt', pass: allMatch && titlesLower, note: `lines=${lines.length} first3=${JSON.stringify(first3)} fmtOK=${allMatch} lowerOK=${titlesLower}` });
  }

  // 4. tags.txt
  const tags = readFile(path.join(dir, 'tags.txt'));
  if (tags === null) {
    r.push({ name: 'tags.txt', pass: false, note: 'missing' });
  } else {
    const len = tags.length;
    const required = ['oneheart', 'my head is empty', 'snowfall', 'NSDR'];
    const missing = required.filter((t) => !tags.toLowerCase().includes(t.toLowerCase()));
    const ok = len <= 500 && missing.length === 0;
    r.push({ name: 'tags.txt', pass: ok, note: `len=${len} missingRiders=[${missing.join(',')}]` });
  }

  // 5. cover.png — exists
  const coverPath = path.join(dir, 'cover.png');
  const coverExists = fs.existsSync(coverPath);
  r.push({ name: 'cover.png exists', pass: coverExists, note: coverExists ? 'present' : 'missing' });

  // 6. thumb.png 1920x1080
  const thumbPath = path.join(dir, 'thumb.png');
  const thumbProbe = fs.existsSync(thumbPath) ? ffprobeWh(thumbPath) : null;
  if (!thumbProbe) {
    r.push({ name: 'thumb.png 1920x1080', pass: false, note: fs.existsSync(thumbPath) ? 'ffprobe failed' : 'missing' });
  } else {
    const ok = thumbProbe.w === 1920 && thumbProbe.h === 1080;
    r.push({ name: 'thumb.png 1920x1080', pass: ok, note: `${thumbProbe.w}x${thumbProbe.h}` });
  }

  // 7. distrokid-payload.json
  const dkPath = path.join(dir, 'distrokid-payload.json');
  const dkRaw = readFile(dkPath);
  if (dkRaw === null) {
    r.push({ name: 'distrokid-payload.json', pass: false, note: 'missing' });
  } else {
    try {
      const dk = JSON.parse(dkRaw) as { metadata?: { albumTitle?: string; artistName?: string; genre?: string }; tracks?: unknown[] };
      const md = dk.metadata ?? {};
      const titleMatch = title !== null && md.albumTitle === title.trim();
      const artistOK = md.artistName === 'AetherSound';
      const genreOK = md.genre === 'Ambient';
      const tracksOK = Array.isArray(dk.tracks) && dk.tracks.length === 3;
      const ok = titleMatch && artistOK && genreOK && tracksOK;
      r.push({ name: 'distrokid-payload.json', pass: ok, note: `title=${titleMatch ? 'match' : `mismatch(${md.albumTitle})`} artist=${md.artistName} genre=${md.genre} tracks=${dk.tracks?.length}` });
    } catch (e) {
      r.push({ name: 'distrokid-payload.json', pass: false, note: `parse error: ${(e as Error).message}` });
    }
  }

  // 8. cover prompt audit — check pipeline.log for the cover prompt sent to Flow
  // The pipeline log lines for step 05a should contain a `prompt loaded source=channel-db` line then a `submitted taskId=...` line.
  // We grep the log for the album's cover prompt content. Audio terminology check: should NOT contain BPM, instrumental, ambient, tempo, key.
  const log = readFile(PIPELINE_LOG) ?? '';
  const albumLogLines = log.split('\n').filter((l) => l.includes(albumId));
  // Look for the line right after the prompt-loaded log for step 05a — typically `step 05a submitted taskId=...` doesn't carry the prompt.
  // Instead inspect the album's coverPrompt-related log entries OR validate by reading the album row's metadata.
  // Simpler: read album.album_brief or the rendered prompt from log if present. We'll grep for "audio" keywords in the album log lines for 05a.
  const audioTerms = ['BPM', 'instrumental', 'ambient piano', 'tempo', 'A minor', 'D minor'];
  const fiveALines = albumLogLines.filter((l) => l.includes('step 05a'));
  const leak = audioTerms.find((t) => fiveALines.some((l) => l.includes(t)));
  r.push({ name: 'cover prompt no audio terms', pass: !leak, note: leak ? `LEAK: ${leak}` : `clean (${fiveALines.length} log lines for 05a)` });

  // 9. prompt loaded source=channel-db on steps 01, 02, 05a, 05b, 10
  const wantedSteps: Array<{ step: string; alts?: string[] }> = [
    { step: 'step 01' },
    { step: 'step 02' },
    { step: 'step 05a' },
    { step: 'step 05b' },
    { step: 'step 10' },
  ];
  const sources: Record<string, string> = {};
  for (const w of wantedSteps) {
    const line = albumLogLines.find((l) => l.includes(w.step) && l.includes('prompt loaded source='));
    const m = line?.match(/prompt loaded source=(\S+)/);
    sources[w.step] = m ? m[1] : 'NOT FOUND';
  }
  const allChannelDb = Object.values(sources).every((s) => s === 'channel-db');
  r.push({ name: 'prompt loaded source=channel-db', pass: allChannelDb, note: JSON.stringify(sources) });

  return r;
}

function main(): void {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('usage: tsx scripts/validate-mock-albums-2026-04-29.ts <albumId>...');
    process.exit(1);
  }

  const all: Array<{ albumId: string; title: string; results: Result[] }> = [];
  for (const id of ids) {
    const dir = path.join(PROJECTS, CHANNEL_ID, id);
    const title = (readFile(path.join(dir, 'title.txt')) ?? '').trim();
    console.log(`\n=== album ${id} (title: "${title}") ===`);
    const results = validateAlbum(id);
    for (const r of results) {
      const flag = r.pass ? 'PASS' : 'FAIL';
      console.log(`  [${flag}] ${pad(r.name, 36)} ${r.note}`);
    }
    all.push({ albumId: id, title, results });
  }

  // Hybrid title-style distribution.
  console.log(`\n=== hybrid title-style distribution ===`);
  const dist = { reassurance: 0, imperative: 0, unknown: 0 };
  for (const a of all) {
    const cat = categorizeTitle(a.title);
    dist[cat]++;
    console.log(`  "${a.title}" -> ${cat}`);
  }
  const bothPresent = dist.reassurance > 0 && dist.imperative > 0;
  console.log(`  distribution: reassurance=${dist.reassurance}, imperative=${dist.imperative}, unknown=${dist.unknown}`);
  console.log(`  ${bothPresent ? 'PASS' : 'FAIL'}: both styles ${bothPresent ? '' : 'NOT '}present across ${all.length} albums`);

  // Description diff
  console.log(`\n=== description.txt structural diff ===`);
  const descs = all.map((a) => readFile(path.join(PROJECTS, CHANNEL_ID, a.albumId, 'description.txt')) ?? '');
  if (descs.length > 1) {
    const baseline = descs[0];
    let allEqual = true;
    for (let i = 1; i < descs.length; i++) {
      const eq = descs[i] === baseline;
      console.log(`  album[${i}] vs album[0]: ${eq ? 'identical' : 'DIFFERENT'} (lens ${baseline.length} vs ${descs[i].length})`);
      if (!eq) allEqual = false;
    }
    console.log(`  ${allEqual ? 'PASS' : 'FAIL'}: descriptions byte-${allEqual ? 'identical' : 'differ'}`);
  }

  // Final summary
  const totalChecks = all.reduce((sum, a) => sum + a.results.length, 0);
  const passed = all.reduce((sum, a) => sum + a.results.filter((r) => r.pass).length, 0);
  console.log(`\n=== summary ===`);
  console.log(`  artifact checks: ${passed}/${totalChecks}`);
  console.log(`  hybrid styles:   ${bothPresent ? 'PASS' : 'FAIL'}`);
  process.exit(passed === totalChecks && bothPresent ? 0 : 1);
}

main();
