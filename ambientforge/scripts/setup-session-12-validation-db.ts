/**
 * Set up data/session-12-validation.db as a copy of data/ambientforge.db with
 * mock-mode settings overrides for Session 12 runtime validation.
 *
 * Idempotent — safe to re-run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/lib/db';

const SRC = path.join(process.cwd(), 'data', 'ambientforge.db');
const DST = path.join(process.cwd(), 'data', 'session-12-validation.db');
const DST_WAL = `${DST}-wal`;
const DST_SHM = `${DST}-shm`;

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

  // initSchema runs the v6→v7 migration on the copy. Backfill is gated on
  // "no existing prompt rows for the channel," so it only fires once.
  const db = openDb(DST);
  // Trigger migration explicitly by closing + re-opening through getDb-style
  // path — initSchema is idempotent; we run it via getDb() in app code, but
  // here we want to verify migration ran on the copy.
  const { initSchema } = require('../src/lib/db');
  initSchema(db);

  const settings: Array<[string, string]> = [
    ['tracks_per_album_override', '3'],
    ['openrouter_api_key', 'mock'],
    ['queue_state', 'running'],
    ['distrokid_dry_run', 'true'],
    ['target_video_seconds', '120'],
  ];
  const upsert = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  const tx = db.transaction(() => {
    for (const [k, v] of settings) upsert.run(k, v);
  });
  tx();
  for (const [k, v] of settings) console.log(`[setup]   settings.${k} = ${v}`);

  db.close();
  console.log('[setup] validation DB ready.');
}

main();
