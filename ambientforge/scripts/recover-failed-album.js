/**
 * One-shot helper to recover an album that failed mid-step-03 *before* the
 * Phase-1 bridge-disruption pause-and-resume logic was in place. Resets any
 * tracks that have status='failed' AND sunoTaskId=null (they failed at
 * submission, never got a Suno task) back to status='pending', then re-queues
 * the album. The runner picks it up on the next tick — step 03 sees the
 * cleared tracks in `pending`, step 04 skips already-downloaded tracks via
 * existing audio_path idempotency.
 *
 * Tracks that DID submit successfully but later failed at download (sunoTaskId
 * set, status='failed') are left alone — those are real failures, not
 * mid-album bridge disruptions.
 *
 * Usage: node scripts/recover-failed-album.js <albumId> [--db=<path>]
 * Env override: AMBIENTFORGE_DB_PATH (used when --db is not given)
 * Default DB: data/ambientforge.db (production)
 *
 * Safety: refuses to run if the target album is currently `in_progress`
 * (the worker is mid-run and would race writes). No-op safe: re-runs do
 * nothing once the album is queued / done.
 *
 * NOTE: Phase 1 pause-and-resume now turns submission failures into
 * `awaiting_suno_relogin` instead of `failed`, so this script is mostly
 * redundant for albums created post-Phase-1. Kept for legacy data + the
 * pre-Phase-1 retry-failed-track path.
 */
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const albumId = args.find((a) => !a.startsWith('--'));
const dbArg = args.find((a) => a.startsWith('--db='));
const DEFAULT_DB = 'data/ambientforge.db';
const dbPath = dbArg
  ? dbArg.slice('--db='.length)
  : process.env.AMBIENTFORGE_DB_PATH || DEFAULT_DB;

if (!albumId) {
  console.error('usage: node scripts/recover-failed-album.js <albumId> [--db=<path>]');
  process.exit(1);
}
if (dbPath === DEFAULT_DB) {
  console.error(`WARN: writing to production DB ${DEFAULT_DB}. Pass --db=<path> or set AMBIENTFORGE_DB_PATH to redirect.`);
}

const db = new Database(dbPath);

const album = db
  .prepare("SELECT id, status, last_error FROM albums WHERE id = ?")
  .get(albumId);
if (!album) {
  console.error(`album ${albumId} not found in ${dbPath}`);
  process.exit(1);
}
if (album.status === 'in_progress') {
  console.error(`album ${albumId} is currently in_progress — aborting to avoid racing the worker. Stop the worker (queue_state=paused) or wait for it to finish, then retry.`);
  process.exit(2);
}
console.log(`album ${albumId} current status=${album.status} db=${dbPath}`);

const tracks = db
  .prepare(
    "SELECT id, track_number, title, status, suno_task_id, audio_path FROM tracks WHERE album_id = ? ORDER BY track_number",
  )
  .all(albumId);
console.log(`tracks: ${tracks.length} total`);
const submissionFailures = tracks.filter(
  (t) => t.status === 'failed' && t.suno_task_id == null,
);
const downloadFailures = tracks.filter(
  (t) => t.status === 'failed' && t.suno_task_id != null,
);
const done = tracks.filter((t) => t.status === 'done');
const other = tracks.filter(
  (t) => t.status !== 'failed' && t.status !== 'done',
);
console.log(`  submission failures (will reset): ${submissionFailures.length}`);
console.log(`  download failures (left alone):   ${downloadFailures.length}`);
console.log(`  already done:                     ${done.length}`);
console.log(`  other (pending/submitted/...):    ${other.length}`);

if (submissionFailures.length > 0) {
  const reset = db.prepare(
    "UPDATE tracks SET status = 'pending', suno_task_id = NULL WHERE id = ?",
  );
  const tx = db.transaction(() => {
    for (const t of submissionFailures) reset.run(t.id);
  });
  tx();
  console.log(
    `reset ${submissionFailures.length} submission-failed tracks back to pending`,
  );
}

if (album.status === 'failed') {
  db.prepare(
    "UPDATE albums SET status = 'queued', last_error = NULL, updated_at = ? WHERE id = ?",
  ).run(Date.now(), albumId);
  console.log("album status: failed -> queued");
}

console.log('done. The worker will pick this up on the next tick.');
db.close();
