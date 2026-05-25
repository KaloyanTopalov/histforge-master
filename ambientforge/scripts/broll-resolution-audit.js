/**
 * Random-sample N clips from a broll folder, ffprobe each, and report:
 *   - resolution distribution (WxH histogram)
 *   - most common codec
 *   - average bitrate (across video streams only)
 *   - average duration (for context — short clips drive the cut frequency)
 *
 * No mutation. Read-only audit.
 *
 * Usage: node scripts/broll-resolution-audit.js <brollDir> [sampleSize] [seed]
 * Default sampleSize=30, seed=42 (deterministic).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const BROLL_DIR = process.argv[2];
const SAMPLE_SIZE = Number(process.argv[3] || 30);
const SEED = Number(process.argv[4] || 42);

if (!BROLL_DIR) {
  console.error('usage: node scripts/broll-resolution-audit.js <brollDir> [sampleSize] [seed]');
  process.exit(1);
}
if (!fs.existsSync(BROLL_DIR) || !fs.statSync(BROLL_DIR).isDirectory()) {
  console.error(`broll dir not a directory: ${BROLL_DIR}`);
  process.exit(1);
}

// Same LCG used in src/lib/broll/select.ts for consistency
function lcg(state) {
  state.value = (state.value * 1664525 + 1013904223) >>> 0;
  return state.value / 0x100000000;
}

function seededShuffle(arr, seed) {
  const out = [...arr];
  const state = { value: seed >>> 0 };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(lcg(state) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const VIDEO_EXT = new Set(['.mp4', '.mov', '.webm', '.mkv']);
const all = fs
  .readdirSync(BROLL_DIR)
  .filter((f) => VIDEO_EXT.has(path.extname(f).toLowerCase()));
console.log(`broll folder total clips: ${all.length}`);

const sampled = seededShuffle(all, SEED).slice(0, SAMPLE_SIZE);
console.log(`probing ${sampled.length} random clips (seed=${SEED})`);
console.log('');

const results = [];
for (const f of sampled) {
  const full = path.join(BROLL_DIR, f);
  let probeOut;
  try {
    probeOut = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height,codec_name,bit_rate,r_frame_rate:format=duration,bit_rate',
        '-of',
        'json',
        full,
      ],
      { encoding: 'utf8' },
    );
  } catch (err) {
    console.error(`probe failed for ${f}: ${err.message}`);
    continue;
  }
  const j = JSON.parse(probeOut);
  const v = j.streams && j.streams[0];
  const fmt = j.format || {};
  if (!v) continue;
  results.push({
    file: f,
    width: v.width,
    height: v.height,
    codec: v.codec_name,
    fps: v.r_frame_rate,
    streamBitrate: v.bit_rate ? Number(v.bit_rate) : null,
    formatBitrate: fmt.bit_rate ? Number(fmt.bit_rate) : null,
    duration: fmt.duration ? Number(fmt.duration) : null,
  });
}

// ---------- Resolution distribution ----------
const resCounts = new Map();
for (const r of results) {
  const key = `${r.width}x${r.height}`;
  resCounts.set(key, (resCounts.get(key) || 0) + 1);
}
const resSorted = [...resCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log('=== Resolution distribution ===');
for (const [res, n] of resSorted) {
  const pct = ((n / results.length) * 100).toFixed(0);
  const meets1080p = (() => {
    const [w, h] = res.split('x').map(Number);
    return w >= 1920 && h >= 1080;
  })();
  console.log(`  ${res.padEnd(12)} ${String(n).padStart(3)} clips  ${pct.padStart(3)}%  ${meets1080p ? '(>=1080p)' : '(<1080p)'}`);
}
console.log('');

// ---------- Codec ----------
const codecCounts = new Map();
for (const r of results) codecCounts.set(r.codec, (codecCounts.get(r.codec) || 0) + 1);
const codecSorted = [...codecCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log('=== Codec ===');
for (const [c, n] of codecSorted) console.log(`  ${c.padEnd(10)} ${n} clips`);
console.log('');

// ---------- Bitrate (use formatBitrate when streamBitrate is missing) ----------
const bitrates = results
  .map((r) => r.streamBitrate ?? r.formatBitrate)
  .filter((b) => b != null && b > 0);
const avgKbps = bitrates.length > 0 ? Math.round(bitrates.reduce((a, b) => a + b, 0) / bitrates.length / 1000) : 0;
const minKbps = bitrates.length > 0 ? Math.round(Math.min(...bitrates) / 1000) : 0;
const maxKbps = bitrates.length > 0 ? Math.round(Math.max(...bitrates) / 1000) : 0;
console.log('=== Bitrate (kbps) ===');
console.log(`  avg ${avgKbps}  min ${minKbps}  max ${maxKbps}  (samples=${bitrates.length})`);
console.log('');

// ---------- Duration ----------
const durs = results.map((r) => r.duration).filter((d) => d != null && d > 0);
const avgDur = durs.length > 0 ? (durs.reduce((a, b) => a + b, 0) / durs.length).toFixed(2) : 0;
const minDur = durs.length > 0 ? Math.min(...durs).toFixed(2) : 0;
const maxDur = durs.length > 0 ? Math.max(...durs).toFixed(2) : 0;
console.log('=== Duration (s) ===');
console.log(`  avg ${avgDur}  min ${minDur}  max ${maxDur}`);
console.log('');

// ---------- 1080p+ ratio (for recommendation) ----------
const meet1080 = results.filter((r) => r.width >= 1920 && r.height >= 1080).length;
console.log('=== 1080p+ ratio ===');
console.log(`  ${meet1080}/${results.length} (${((meet1080 / results.length) * 100).toFixed(0)}%) meet 1920x1080+`);
console.log('');

// ---------- Frame rate (consistency check, matters for stream-copy concat) ----------
const fpsCounts = new Map();
for (const r of results) fpsCounts.set(r.fps, (fpsCounts.get(r.fps) || 0) + 1);
const fpsSorted = [...fpsCounts.entries()].sort((a, b) => b[1] - a[1]);
console.log('=== Frame rate ===');
for (const [fps, n] of fpsSorted) console.log(`  ${fps.padEnd(10)} ${n} clips`);
