/**
 * Set up data/session-cover-fix-validation.db as a copy of data/ambientforge.db
 * (with the LA-skyline-girl prompt already applied) plus mock-only overrides
 * for the cover-resample-threshold + cover-prompt validation run.
 *
 * Usage: tsx scripts/setup-cover-fix-validation-db-2026-04-29.ts
 *
 * Idempotent — safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/lib/db';

const SRC = path.join(process.cwd(), 'data', 'ambientforge.db');
const DST = path.join(process.cwd(), 'data', 'session-cover-fix-validation.db');
const DST_WAL = `${DST}-wal`;
const DST_SHM = `${DST}-shm`;
const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

function main(): void {
  if (!fs.existsSync(SRC)) {
    console.error(`source db not found: ${SRC}`);
    process.exit(1);
  }

  for (const f of [DST_WAL, DST_SHM]) {
    if (fs.existsSync(f)) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }

  const srcDb = openDb(SRC);
  srcDb.pragma('wal_checkpoint(TRUNCATE)');
  srcDb.close();
  console.log('[setup] checkpointed source WAL');

  fs.copyFileSync(SRC, DST);
  console.log(`[setup] copied ${SRC} -> ${DST}`);

  const db = openDb(DST);

  const updateChannel = db.prepare(
    'UPDATE channels SET target_video_seconds = ?, updated_at = ? WHERE id = ?',
  );
  updateChannel.run(120, Date.now(), CHANNEL_ID);
  console.log('[setup] channel.target_video_seconds = 120 (mock-only)');

  const settings: Array<[string, string]> = [
    ['tracks_per_album_override', '3'],
    ['openrouter_api_key', 'mock'],
    ['queue_state', 'running'],
    ['distrokid_dry_run', 'true'],
    ['broll_allowed_root_paths', '[]'],
    ['target_video_seconds', '120'],
    ['cover_resample_threshold_mb', '9.5'],
  ];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    for (const [k, v] of settings) upsert.run(k, v);
  });
  tx();
  for (const [k, v] of settings) console.log(`[setup]   settings.${k} = ${v}`);

  // Sanity: verify the LA-skyline prompt is in the validation DB.
  const ch = db
    .prepare(
      'SELECT length(prompt_cover_image) AS plen, substr(prompt_cover_image, 1, 80) AS phead FROM channels WHERE id = ?',
    )
    .get(CHANNEL_ID) as { plen: number; phead: string } | undefined;
  console.log(`[setup] channel.prompt_cover_image: plen=${ch?.plen} phead="${ch?.phead}"`);
  if (!ch || !ch.phead.includes('16:9 cinematic photog')) {
    console.error(
      '[setup] WARNING: production DB does not appear to have the LA-skyline-girl prompt applied. Run scripts/update-cover-prompt-2026-04-29.ts first.',
    );
  }

  const allActive = db
    .prepare("SELECT count(*) as n FROM albums WHERE status NOT IN ('done','failed')")
    .get() as { n: number };
  if (allActive.n > 0) {
    console.log(
      `[setup] note: ${allActive.n} pre-existing non-terminal albums on the validation DB; new POSTs will queue behind them`,
    );
  }

  db.close();
  console.log('[setup] validation DB ready.');
  console.log('[setup] start dev with:');
  console.log(
    '  AMBIENTFORGE_DB_PATH=data/session-cover-fix-validation.db FLOW_MODE=mock SUNO_MODE=mock DISTROKID_MODE=mock OPENROUTER_API_KEY=mock npx concurrently -n web,worker -c blue,magenta "next dev -p 3004" "tsx watch src/worker/runner.ts"',
  );
}

main();
