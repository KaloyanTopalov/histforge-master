/**
 * Direct step05aInternal validation against data/session-cover-fix-validation.db.
 * Replaces the dev-server-driven Check C + D.
 *
 * Check C (small mock cover):
 *   - Channel + album seeded.
 *   - Mock Flow client copies tests/fixtures/flow/fixture-square.png (small).
 *   - LLM mocked via OPENROUTER_API_KEY=mock + the LA-skyline-girl prompt's
 *     <!-- mock-response: ... --> directive.
 *   - Asserts: prompt loaded source=channel-db kind=cover-image, visual prompt
 *     mentions LA/skyline imagery, no audio terms, no-resample log path,
 *     cover.png present, cover.jpg absent.
 *
 * Check D (large cover regression):
 *   - Reset album cover/ytImage paths to defeat the idempotency noop.
 *   - Mock Flow client writes the failed album's real 13 MB cover.png as the
 *     raw output.
 *   - Asserts: resample log path triggered, cover.jpg < 9.5 MB, q-scale and
 *     attempts logged. Then re-run a 3rd time to confirm idempotency noop.
 */
process.env.AMBIENTFORGE_DB_PATH = process.env.AMBIENTFORGE_DB_PATH ?? 'data/session-cover-fix-validation.db';
process.env.OPENROUTER_API_KEY = 'mock';
process.env.FLOW_MODE = 'mock';

import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/lib/db';
import * as channelsRepo from '../src/lib/repos/channels';
import * as albumsRepo from '../src/lib/repos/albums';
import { step05aInternal } from '../src/worker/steps/05a-cover-image';
import type { FlowClient } from '../src/lib/flow/client';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';
const FAILED_ALBUM_COVER = path.resolve(
  'projects',
  CHANNEL_ID,
  '01KQCG9YSY5P0V7S1XSAYJ8QA9',
  'cover.png',
);
const SQUARE_FIXTURE = path.resolve('tests', 'fixtures', 'flow', 'fixture-square.png');

type Result = { name: string; pass: boolean; note: string };

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function makeCustomFlowClient(rawSourcePath: string): FlowClient {
  let counter = 0;
  return {
    async submitPrompt(_prompt) {
      counter += 1;
      return `mock-direct-${counter}`;
    },
    async poll() {
      return 'ready';
    },
    async download(_taskId, destPath) {
      await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
      await fs.promises.copyFile(rawSourcePath, destPath);
    },
  };
}

async function main(): Promise<void> {
  // Sanity-check fixtures exist.
  if (!fs.existsSync(SQUARE_FIXTURE)) {
    console.error(`[direct] missing fixture: ${SQUARE_FIXTURE} — run "npm run fixtures:setup"`);
    process.exit(1);
  }
  if (!fs.existsSync(FAILED_ALBUM_COVER)) {
    console.error(`[direct] missing failed-album cover: ${FAILED_ALBUM_COVER}`);
    process.exit(1);
  }

  // Use the validation DB.
  const db = openDb();
  const channel = channelsRepo.get(CHANNEL_ID);
  if (!channel) {
    console.error(`[direct] channel ${CHANNEL_ID} not found in validation DB`);
    process.exit(1);
  }
  console.log(`[direct] using channel ${channel.id} workflow=${channel.workflow}`);
  console.log(`[direct] prompt_cover_image plen=${(channel.promptCoverImage ?? '').length}`);

  // Create a fresh mock album via the repo (snapshots channel.workflow onto it).
  const album = albumsRepo.create({ channelId: CHANNEL_ID });
  // step 05a expects albumTitle / artistName / sunoStylePrompt to interpolate.
  albumsRepo.patch(album.id, {
    albumTitle: 'cover-fix validation album',
    artistName: channel.distrokidArtistName,
    sunoStylePrompt: 'gentle late-night ambient',
    primaryGenre: channel.distrokidPrimaryGenre,
  });
  console.log(`[direct] created mock album ${album.id}`);

  // Use a tmp projects dir so we don't touch the production projects/ tree.
  const projectsDir = path.resolve(
    process.cwd(),
    'projects-cover-fix-validation',
  );

  // Capture log lines for later assertions.
  type Logged = [string, string];
  const logs: Logged[] = [];
  const log = (stage: string, msg: string) => {
    logs.push([stage, msg]);
    console.log(`  [${stage}] ${msg}`);
  };

  // ----- Check C: small mock cover ------------------------------------------
  console.log('\n=== Check C: small mock cover (no-resample path) ===');
  const fresh = albumsRepo.get(album.id)!;
  await step05aInternal(fresh, log, makeCustomFlowClient(SQUARE_FIXTURE), {
    pollIntervalMs: 0,
    pollTimeoutMs: 30_000,
    projectsDir,
  });

  const albumDir = path.join(projectsDir, channel.id, album.id);
  const coverC = path.join(albumDir, 'cover.png');
  const jpgC = path.join(albumDir, 'cover.jpg');

  const fiveALines = logs.filter(([stage]) => stage === 'step 05a').map(([, m]) => m);
  const promptLoaded = fiveALines.find(
    (m) => m.includes('prompt loaded source=') && m.includes('kind=cover-image'),
  );
  const promptPreview = fiveALines.find((m) => m.startsWith('prompt="'));
  const noResampleLog = fiveALines.some((m) => m.includes('no resample needed'));
  const resampleLog = fiveALines.some((m) => m.includes('resampling to cover.jpg'));

  const visualPrompt = promptPreview?.match(/prompt="([^"]*)"/)?.[1] ?? '';
  const laHit = /Los Angeles|skyline|skyscrapers|rooftop|palm tree|magenta|neon/i.test(visualPrompt);
  const audioTerms = ['BPM', 'instrumental', ' tempo ', 'A minor', 'D minor'];
  const audioLeak = audioTerms.find((t) => visualPrompt.toLowerCase().includes(t.toLowerCase()));

  const cResults: Result[] = [
    {
      name: 'prompt loaded source=channel-db (cover-image)',
      pass: !!(promptLoaded && /source=channel-db/.test(promptLoaded)),
      note: promptLoaded ?? '(missing)',
    },
    {
      name: 'visual prompt mentions LA/skyline imagery',
      pass: laHit,
      note: visualPrompt.slice(0, 120) + (visualPrompt.length > 120 ? '...' : ''),
    },
    {
      name: 'visual prompt has no audio terms',
      pass: !audioLeak,
      note: audioLeak ? `LEAK: ${audioLeak}` : 'clean',
    },
    {
      name: 'no-resample log path triggered',
      pass: noResampleLog && !resampleLog,
      note: `noResampleLog=${noResampleLog} resampleLog=${resampleLog}`,
    },
    {
      name: 'cover.png exists',
      pass: fs.existsSync(coverC),
      note: fs.existsSync(coverC) ? `${(fs.statSync(coverC).size / 1024).toFixed(0)}KB` : 'missing',
    },
    {
      name: 'cover.jpg absent (small mock fixture)',
      pass: !fs.existsSync(jpgC),
      note: fs.existsSync(jpgC) ? 'unexpected' : 'absent',
    },
  ];

  console.log('\nCheck C results:');
  for (const r of cResults) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${pad(r.name, 50)} ${r.note}`);
  }

  // ----- Check D: 13 MB cover triggers resample -----------------------------
  console.log('\n=== Check D: 13 MB cover triggers resample ===');

  // Reset album fields so step 05a re-runs (defeat idempotency noop).
  albumsRepo.patch(album.id, { coverImagePath: null, ytImagePath: null });
  // Wipe the project dir.
  fs.rmSync(albumDir, { recursive: true, force: true });
  logs.length = 0;

  const freshD = albumsRepo.get(album.id)!;
  await step05aInternal(freshD, log, makeCustomFlowClient(FAILED_ALBUM_COVER), {
    pollIntervalMs: 0,
    pollTimeoutMs: 60_000,
    projectsDir,
  });

  const coverD = path.join(albumDir, 'cover.png');
  const jpgD = path.join(albumDir, 'cover.jpg');
  const fiveALinesD = logs.filter(([stage]) => stage === 'step 05a').map(([, m]) => m);
  const resampleLogD = fiveALinesD.find((m) => m.includes('resampling to cover.jpg'));
  const jpgLogD = fiveALinesD.find((m) => /cover\.jpg q=\d+/.test(m));
  const jpgSizeBytes = fs.existsSync(jpgD) ? fs.statSync(jpgD).size : 0;

  const dResults: Result[] = [
    {
      name: 'resample-triggered log line present',
      pass: !!resampleLogD,
      note: resampleLogD ?? '(missing)',
    },
    {
      name: 'cover.jpg q-scale log present',
      pass: !!jpgLogD,
      note: jpgLogD ?? '(missing)',
    },
    {
      name: 'cover.jpg present',
      pass: fs.existsSync(jpgD),
      note: fs.existsSync(jpgD) ? `${(jpgSizeBytes / 1024 / 1024).toFixed(2)}MB` : 'missing',
    },
    {
      name: 'cover.jpg < 9.5 MB threshold',
      pass: jpgSizeBytes > 0 && jpgSizeBytes < Math.floor(9.5 * 1024 * 1024),
      note: `${(jpgSizeBytes / 1024 / 1024).toFixed(2)}MB`,
    },
    {
      name: 'cover.png present (untouched source)',
      pass: fs.existsSync(coverD),
      note: fs.existsSync(coverD) ? `${(fs.statSync(coverD).size / 1024 / 1024).toFixed(2)}MB` : 'missing',
    },
  ];

  console.log('\nCheck D results:');
  for (const r of dResults) {
    console.log(`  [${r.pass ? 'PASS' : 'FAIL'}] ${pad(r.name, 50)} ${r.note}`);
  }

  // ----- Idempotency: 3rd run should noop ------------------------------------
  console.log('\n=== Idempotency: 3rd run should noop (cover and ytImage already valid) ===');
  logs.length = 0;
  const freshIdem = albumsRepo.get(album.id)!;
  await step05aInternal(freshIdem, log, makeCustomFlowClient(SQUARE_FIXTURE), {
    pollIntervalMs: 0,
    pollTimeoutMs: 30_000,
    projectsDir,
  });
  const noopHit = logs.some(([stage, m]) => stage === 'step 05a' && m.includes('noop'));
  const idemResult: Result = {
    name: 'idempotency noop on re-run',
    pass: noopHit,
    note: noopHit ? 'noop log seen' : 'expected noop',
  };
  console.log(`  [${idemResult.pass ? 'PASS' : 'FAIL'}] ${pad(idemResult.name, 50)} ${idemResult.note}`);

  // ----- Cleanup ------------------------------------------------------------
  // Mark album as terminal so it doesn't dangle as in_progress on the validation DB.
  albumsRepo.patch(album.id, { status: 'done' });
  db.close();

  // ----- Final summary ------------------------------------------------------
  const all = [...cResults, ...dResults, idemResult];
  const passed = all.filter((r) => r.pass).length;
  console.log(`\n=== summary: ${passed}/${all.length} checks passed ===`);
  if (passed !== all.length) process.exit(1);
}

main().catch((err) => {
  console.error('[direct] FAILED:', err);
  process.exit(1);
});
