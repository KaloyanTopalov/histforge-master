/**
 * Apply two mock-response patches to a rap channel:
 *
 *   1. prompt_track_briefs mock-response: 2 tracks -> 10 tracks (rap workflow
 *      default). Templates can't dynamically size arrays via mustache; 10 is
 *      the most common production count. Test overrides outside {1..10} will
 *      need their own mock data.
 *
 *   2. prompt_yt_metadata mock-response: hardcoded tracklist -> {{ tracklistEscaped }}.
 *      This works for any N because step 10 builds tracklist.text from real
 *      track durations and passes it as a scalar template var.
 *
 * Idempotent: re-runs are safe (re-applies same content).
 *
 * Usage: node scripts/patch-prod-rap-prompts.js <channelId> [--db=<path>]
 * Env override: AMBIENTFORGE_DB_PATH (used when --db is not given)
 * Default DB: data/ambientforge.db (production)
 */
const Database = require('better-sqlite3');

const args = process.argv.slice(2);
const RAP_CHANNEL_ID = args.find((a) => !a.startsWith('--'));
const dbArg = args.find((a) => a.startsWith('--db='));
const DEFAULT_DB = 'data/ambientforge.db';
const DB_PATH = dbArg
  ? dbArg.slice('--db='.length)
  : process.env.AMBIENTFORGE_DB_PATH || DEFAULT_DB;

if (!RAP_CHANNEL_ID) {
  console.error('usage: node scripts/patch-prod-rap-prompts.js <channelId> [--db=<path>]');
  process.exit(1);
}

const db = new Database(DB_PATH);

// ---------- Patch 1: prompt_track_briefs ----------
const tbRow = db
  .prepare('SELECT prompt_track_briefs FROM channels WHERE id = ?')
  .get(RAP_CHANNEL_ID);
const tbOrig = tbRow.prompt_track_briefs;

// Build a 10-track mock-response. Each track has a distinct rap title +
// structurally-correct lyrics with [Intro][Verse 1][Hook][Verse 2][Hook][Outro].
// Lyrics are short but valid — the schema only requires non-empty strings, the
// content-validity check is implicit (Suno + downstream aren't actually called
// during mock runs).
const TRACKS_10 = [
  { title: 'Diamond Cut Glass', theme: 'iced-out luxury' },
  { title: "Streets Don't Sleep", theme: 'late-night grind' },
  { title: 'Crown Heavy', theme: 'kingship + legacy' },
  { title: 'Ice In My Veins', theme: 'cold-blooded composure' },
  { title: 'Real Recognize Real', theme: 'loyalty + circle' },
  { title: 'Detroit Soul', theme: 'hometown roots' },
  { title: 'West Coast Anthem', theme: 'regional pride' },
  { title: 'Studio Smoke', theme: 'late-night recording' },
  { title: 'Empire Built', theme: 'self-made success' },
  { title: 'Legacy In Stone', theme: 'permanence + history' },
];

function buildLyrics(seed) {
  return [
    '[Intro]',
    'Yeah, look',
    `Tag this one ${seed}, let's go`,
    '',
    '[Verse 1]',
    'Started from the floor now I look at the sky',
    'Every word a brick, building empires that fly',
    'Real ones know the grind, fake ones just pry',
    'When the streets test your soul, you fold or you fly',
    '',
    '[Hook]',
    'We the real ones, we the kings',
    'Diamond cut the truth in everything',
    'Real recognize real in the trenches',
    "We don't fold, we don't flinch, we just live",
    '',
    '[Verse 2]',
    'Every step calculated like the chess board',
    'Never played the victim, made my own reward',
    'Bars heavier than the chains around my neck now',
    'Every word I drop another bag I check now',
    '',
    '[Hook]',
    'We the real ones, we the kings',
    'Diamond cut the truth in everything',
    'Real recognize real in the trenches',
    "We don't fold, we don't flinch, we just live",
    '',
    '[Outro]',
    'Real ones only',
    "Let's go",
  ].join('\n');
}

const mockObj = {
  tracks: TRACKS_10.map((t, i) => ({
    trackNumber: i + 1,
    title: t.title,
    lyrics: buildLyrics(t.title),
  })),
};

const tbNew = tbOrig.replace(
  /<!-- mock-response: \{[\s\S]*?\} -->/,
  '<!-- mock-response: ' + JSON.stringify(mockObj) + ' -->',
);

if (tbNew === tbOrig) {
  console.error('FAIL: track-briefs mock-response block not found');
  process.exit(1);
}

db.prepare('UPDATE channels SET prompt_track_briefs = ?, updated_at = ? WHERE id = ?').run(
  tbNew,
  Date.now(),
  RAP_CHANNEL_ID,
);
console.log('patch 1: prompt_track_briefs mock-response now has', mockObj.tracks.length, 'tracks');

// ---------- Patch 2: prompt_yt_metadata ----------
const ytRow = db
  .prepare('SELECT prompt_yt_metadata FROM channels WHERE id = ?')
  .get(RAP_CHANNEL_ID);
const ytOrig = ytRow.prompt_yt_metadata;

// The hardcoded tracklist in the mock-response uses literal "\n" (backslash-n)
// because it's stored inside a JSON string in the prompt template.
const tracklistTarget =
  "0:00 - Diamond Cut Glass\\n3:14 - Streets Don't Sleep\\n6:42 - Iced Out Anthem";
const ytNew = ytOrig.split(tracklistTarget).join('{{ tracklistEscaped }}');

if (ytNew === ytOrig) {
  // No match: either already patched (idempotent re-run) or the template
  // changed shape. Distinguish the two so the operator can tell.
  if (ytOrig.includes('{{ tracklistEscaped }}')) {
    console.log('patch 2: already applied (placeholder present) — no-op');
  } else {
    console.error(
      'WARN: patch 2: yt-metadata hardcoded tracklist not found AND placeholder absent — template may have drifted',
    );
  }
} else {
  db.prepare('UPDATE channels SET prompt_yt_metadata = ?, updated_at = ? WHERE id = ?').run(
    ytNew,
    Date.now(),
    RAP_CHANNEL_ID,
  );
  console.log('patch 2: prompt_yt_metadata hardcoded tracklist -> {{ tracklistEscaped }}');
}

db.close();
