/**
 * Watch a live album: poll its DB row + tail pipeline.log for entries
 * matching the album id. Exits 0 on status=done, 1 on status=failed,
 * 2 on awaiting_captcha / awaiting_suno_relogin (operator action needed),
 * 3 on hard timeout.
 *
 * Usage: node scripts/watch-album.js <albumId> [logOffsetBytes] [timeoutMs]
 */
const fs = require('node:fs');
const Database = require('better-sqlite3');

const albumId = process.argv[2];
const initialOffset = Number(process.argv[3] || 0);
const timeoutMs = Number(process.argv[4] || 15 * 60 * 1000);

if (!albumId) {
  console.error('usage: node scripts/watch-album.js <albumId> [logOffsetBytes] [timeoutMs]');
  process.exit(255);
}

const DB = 'data/ambientforge.db';
const LOG = 'data/pipeline.log';

let logCursor = initialOffset;
const startedAt = Date.now();

function tailLog() {
  if (!fs.existsSync(LOG)) return;
  const stat = fs.statSync(LOG);
  if (stat.size <= logCursor) return;
  const fd = fs.openSync(LOG, 'r');
  try {
    const len = stat.size - logCursor;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, logCursor);
    logCursor = stat.size;
    const text = buf.toString('utf8');
    for (const line of text.split('\n')) {
      if (line.includes(albumId)) {
        // strip the timestamp prefix for terser output
        const stripped = line.replace(/^\[pipeline\] [^ ]+ t=[\d.]+ms album=\S+ /, '  ');
        console.log(stripped);
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

function readAlbum() {
  const db = new Database(DB, { readonly: true });
  try {
    return db
      .prepare(
        'SELECT status, video_status, distrokid_status, video_progress_pct, last_error FROM albums WHERE id = ?',
      )
      .get(albumId);
  } finally {
    db.close();
  }
}

let lastStatusLine = '';
function statusSnapshot() {
  const a = readAlbum();
  if (!a) return null;
  const line = `status=${a.status} video=${a.video_status}@${a.video_progress_pct}% dk=${a.distrokid_status}${a.last_error ? ` err="${a.last_error}"` : ''}`;
  if (line !== lastStatusLine) {
    console.log(`[poll] ${line}`);
    lastStatusLine = line;
  }
  return a;
}

(async () => {
  console.log(`watching album ${albumId} (timeout ${(timeoutMs / 1000) | 0}s)`);
  while (true) {
    if (Date.now() - startedAt > timeoutMs) {
      console.error('TIMEOUT');
      tailLog();
      process.exit(3);
    }
    tailLog();
    const a = statusSnapshot();
    if (!a) {
      console.error('album row disappeared');
      process.exit(255);
    }
    if (a.status === 'done') {
      tailLog();
      console.log('FINAL: done');
      process.exit(0);
    }
    if (a.status === 'failed') {
      tailLog();
      console.log(`FINAL: failed (${a.last_error || 'unknown'})`);
      process.exit(1);
    }
    if (a.status === 'awaiting_captcha' || a.status === 'awaiting_suno_relogin') {
      // Don't exit — Phase 3 may auto-resume. Just keep polling. The
      // statusSnapshot dedupe means we won't spam the log with repeats.
      // Ctrl-C to abandon the wait.
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
})();
