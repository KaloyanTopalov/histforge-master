/**
 * Swap the hardcoded tracklist block in prompt_yt_metadata for the
 * `{{ tracklistEscaped }}` placeholder so step 10 fills it from real
 * track durations.
 *
 * Usage: node scripts/patch-yt-metadata.js <channelId> [--db=<path>]
 * Default DB: data/session-rap-validation.db
 */
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const channelId = args.find((a) => !a.startsWith('--'));
const dbArg = args.find((a) => a.startsWith('--db='));
const dbPath = dbArg
  ? dbArg.slice('--db='.length)
  : process.env.AMBIENTFORGE_DB_PATH || 'data/session-rap-validation.db';

if (!channelId) {
  console.error('usage: node scripts/patch-yt-metadata.js <channelId> [--db=<path>]');
  process.exit(1);
}

const db = new Database(dbPath);
const row = db.prepare('SELECT prompt_yt_metadata FROM channels WHERE id = ?').get(channelId);
if (!row) {
  console.error(`channel ${channelId} not found in ${dbPath}`);
  process.exit(1);
}
const orig = row.prompt_yt_metadata;

// The DB stores literal backslash-n sequences (\n as 2 chars) inside the JSON
// mock-response string — that's how the JSON encoded newlines.
// We need to swap the hardcoded tracklist block for {{ tracklistEscaped }}.
const target = "0:00 - Diamond Cut Glass\\n3:14 - Streets Don't Sleep\\n6:42 - Iced Out Anthem";
const newPrompt = orig.split(target).join('{{ tracklistEscaped }}');

if (newPrompt === orig) {
  if (orig.includes('{{ tracklistEscaped }}')) {
    console.log('already applied (placeholder present) — no-op');
    db.close();
    process.exit(0);
  }
  console.error('No match found and placeholder absent — template may have drifted.');
  process.exit(1);
}

db.prepare('UPDATE channels SET prompt_yt_metadata = ? WHERE id = ?').run(newPrompt, channelId);
console.log('updated prompt_yt_metadata: tracklist block -> {{ tracklistEscaped }}');

const after = db.prepare('SELECT prompt_yt_metadata FROM channels WHERE id = ?').get(channelId);
const idx = after.prompt_yt_metadata.indexOf('{{ tracklistEscaped }}');
console.log('placeholder present at index:', idx);
db.close();
