/**
 * Set up data/session-prompt-validation.db as a copy of data/ambientforge.db
 * with mock-only overrides for the Midnight Whispers 3-album validation run.
 *
 * Usage: tsx scripts/setup-validation-db-2026-04-29.ts
 *
 * Expects production DB to already have the operator-edited prompts (Part 1
 * of the prompt-quality validation plan). Idempotent — safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/lib/db';

const SRC = path.join(process.cwd(), 'data', 'ambientforge.db');
const DST = path.join(process.cwd(), 'data', 'session-prompt-validation.db');
const DST_WAL = `${DST}-wal`;
const DST_SHM = `${DST}-shm`;
const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

function main(): void {
  if (!fs.existsSync(SRC)) {
    console.error(`source db not found: ${SRC}`);
    process.exit(1);
  }

  // Only remove WAL/SHM (small, never long-held); leave .db to be overwritten by copyFileSync
  // (Windows rmSync sometimes fails with EBUSY if another process held a handle recently).
  for (const f of [DST_WAL, DST_SHM]) {
    if (fs.existsSync(f)) {
      try { fs.rmSync(f, { force: true }); } catch { /* ignore */ }
    }
  }

  // Checkpoint WAL so the .db file is fully self-contained.
  const srcDb = openDb(SRC);
  srcDb.pragma('wal_checkpoint(TRUNCATE)');
  srcDb.close();
  console.log('checkpointed source WAL');

  fs.copyFileSync(SRC, DST);
  console.log(`copied ${SRC} -> ${DST}`);

  const db = openDb(DST);

  const updateChannel = db.prepare(
    'UPDATE channels SET target_video_seconds = ?, updated_at = ? WHERE id = ?',
  );
  updateChannel.run(120, Date.now(), CHANNEL_ID);
  console.log(`channel.target_video_seconds = 120 (mock-only)`);

  const settings: Array<[string, string]> = [
    ['tracks_per_album_override', '3'],
    ['openrouter_api_key', 'mock'],
    ['queue_state', 'running'],
    ['distrokid_dry_run', 'true'],
    ['broll_allowed_root_paths', '[]'],
    ['target_video_seconds', '120'],
  ];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    for (const [k, v] of settings) upsert.run(k, v);
  });
  tx();
  for (const [k, v] of settings) console.log(`  settings.${k} = ${v}`);

  const allActive = db
    .prepare("SELECT count(*) as n FROM albums WHERE status NOT IN ('done','failed')")
    .get() as { n: number };
  if (allActive.n > 0) {
    console.log(`note: ${allActive.n} pre-existing non-terminal albums on the validation DB; new POSTs will queue behind them`);
  }

  const ch = db
    .prepare(
      "SELECT id, display_name, target_video_seconds, distrokid_artist_name, suno_mode, suno_instrumental FROM channels WHERE id = ?",
    )
    .get(CHANNEL_ID) as Record<string, unknown> | undefined;
  console.log('\nValidation channel state:');
  console.log(JSON.stringify(ch, null, 2));

  console.log('\nValidation DB ready.');
  console.log('Start dev with:');
  console.log('  AMBIENTFORGE_DB_PATH=data/session-prompt-validation.db SUNO_MODE=mock FLOW_MODE=mock DISTROKID_MODE=mock npm run dev');
}

main();
