/**
 * One-off DB update — Midnight Whispers channel config fix.
 *
 * Channel: 01KQ7HRA4SJ9GX6JMC4Q3CNWR1 (sad-ambient-01 / "midnight whispers")
 *
 * Reads target DB from AMBIENTFORGE_DB_PATH (default data/ambientforge.db).
 * Single transaction, prints BEFORE/AFTER diff per column.
 *
 * Run: tsx scripts/fix-midnight-whispers-2026-04-29.ts
 */
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

const SUNO_STYLE_PROMPT =
  'slow ambient piano, 50-65 BPM, A minor or D minor, soft sustained pads, deep atmospheric reverb, late-night reflective mood, no percussion, no vocals, instrumental only, melancholic but gentle, sparse, contemplative, fragile, distant bell-like tones, occasional muted strings, subtle low-frequency drone, cinematic stillness, dreamlike, comforting darkness';

const DESCRIPTION =
  'Sad ambient sleep music, instrumental, 4-hour loops, @imissher.ambient style.';

const HASHTAGS =
  'ambientmusic,sleepmusic,sad,playlist,sleep,calm,relaxing,deepsleep,insomnia,nsdr';

const PROMPT_ALBUM_BRIEF = `Generate a sad-ambient sleep music album. Mix two title styles for variety across the channel — randomly pick ONE style per album.

Output ONLY valid JSON, no prose, no code fences:

{
  "albumTitle": "<see rules below>",
  "titleStyle": "<'reassurance' OR 'imperative' — which one was used>",
  "artistName": "{{ channel.distrokidArtistName }}",
  "genre": "Ambient",
  "theme": "<one sentence describing emotional arc — comfort, surrender, late-night thoughts, reassurance>"
}

Title rules (HARD — do not break):
- All lowercase always
- 3-7 words
- NEVER capitalized for emphasis. NEVER exclamation marks, question marks
- NEVER uses words: dreamland, drift, slumber, lullaby, peaceful, twinkle, magical, sweet dreams (overused/cringe)

Style A — REASSURANCE (no period, often ends with "..." or no punctuation):
Examples to imitate (do NOT reuse):
- "it's going to be okay..."
- "you're safe here"
- "stop thinking, go to bed"
- "it's 4am and you can't sleep"
- "everything will work out..."
- "go to sleep, you need it"
- "it's okay, just let go"
- "she was only a dream"

Style B — IMPERATIVE (always ends with period, soft direction):
Examples to imitate (do NOT reuse):
- "you need to sleep."
- "calm your heart."
- "you need to rest."
- "forget about it and relax."
- "give yourself a break."
- "clear your mind."
- "close your eyes."
- "you found a place to rest."

Pick ONE style per album. Roughly 60% reassurance / 40% imperative across the channel over time. Theme is one sentence describing the emotional register the album occupies.

<!-- mock-response: {"albumTitle": "you're safe here", "titleStyle": "reassurance", "artistName": "AetherSound", "genre": "Ambient", "theme": "the quiet comfort of finally letting yourself rest after a long, anxious day."} -->`;

const PROMPT_TRACK_BRIEFS = `Generate {{ tracksPerAlbum }} instrumental ambient tracks for the album "{{ album.albumTitle }}".
Theme: {{ album.theme }}
Channel base style (passed to Suno): all tracks must be slow ambient piano + soft pads, no percussion, no vocals.

Output ONLY valid JSON, no prose, no code fences:

{
  "tracks": [
    {
      "trackNumber": 1,
      "title": "<lowercase, 2-5 words, atmospheric>",
      "stylePrompt": "<refinement of the channel base style for this specific track>"
    }
    // ... continue for all {{ tracksPerAlbum }} tracks
  ]
}

Track title style:
- All lowercase
- 2-5 words
- Imagery: rain, glass, breath, silence, distance, soft, slow, alone, quiet, dim, fading, late, still, dark, heavy
- Examples: "first quiet hour.", "rain on glass.", "you'll be fine.", "let it pass.", "soft dark.", "closing your eyes.", "almost asleep.", "the long pause.", "after midnight."
- Avoid: anything with "dream", "star", "magic", "sweet", "lullaby", "moonlight", "twinkle"

Each stylePrompt extends the channel base style. Vary slightly across the album so the listener has subtle progression:
- Early tracks: tentative, more piano-forward, slightly brighter
- Middle tracks: deepening, more pads, more reverb
- Later tracks: very sparse, near-silence, almost ambient drone

Each stylePrompt: 15-25 words. Always reinforce: instrumental, no vocals, no percussion. Specify BPM in 50-65 range. Specify key (A minor, D minor, or F minor preferred).

<!-- mock-response: {"tracks": [{"trackNumber": 1, "title": "first quiet hour.", "stylePrompt": "slow ambient piano in A minor, soft pads, sparse melodic line, gentle opening, 60 BPM, instrumental, no vocals, no percussion"}, {"trackNumber": 2, "title": "rain on glass.", "stylePrompt": "ambient piano with subtle rain texture, D minor, soft reverb, 55 BPM, melancholic, instrumental, no vocals"}, {"trackNumber": 3, "title": "let it pass.", "stylePrompt": "deep ambient pad, distant piano, A minor to D minor, very slow, surrender mood, 50 BPM, instrumental"}]} -->`;

const PROMPT_COVER_IMAGE = `Convert this album theme into a single visual prompt for a 1:1 square cover image.

Album: "{{ album.albumTitle }}"
Theme: "{{ album.theme }}"

Output ONLY a single visual prompt string (not JSON, not a list, just text on one line).

Visual aesthetic (matching channels like "i miss her." / @imissher.ambient):
- Cinematic still, looks like a frame from a quiet drama film
- Muted dark color palette: deep navy, charcoal, dusty blue, cool gray, soft amber lamplight, faded gold
- Single subject, centered or off-center: a back-turned figure, an empty bed, a window with rain, a dim lamp, an empty room, a hallway, a chair by a window, a sleeping cat
- NEVER: faces visible, bright colors, sun, smiling people, multiple people, text/logos, sharp daytime light
- Soft natural lighting: late evening, dim lamp, moonlight through curtains, blue hour, 2am bedroom darkness
- Slight film grain, soft focus, atmospheric haze
- Slight melancholy without being depressing — comforting darkness
- Square 1:1 composition, leaving breathing space around the subject

Strip ALL audio terminology (BPM, instrumental, ambient, etc.) — visual only.

<!-- mock-response: A solitary figure sitting on the edge of a bed seen from behind, soft amber lamp glow on dark navy walls, rain streaks blurred against the window beside them, muted color palette of charcoal and dusty blue, cinematic film grain, atmospheric haze, late-night stillness, 1:1 square composition, soft focus background -->`;

const PROMPT_THUMBNAIL = `Always derive the YouTube thumbnail from the album cover image (cropped/scaled to 1920x1080). No second image generation needed.

Output ONLY this JSON object, no prose, no code fences:

{"useCover": true}

<!-- mock-response: {"useCover": true} -->`;

const PROMPT_YT_METADATA = `Generate YouTube metadata for an instrumental ambient sleep music video.

Album title: "{{ album.albumTitle }}"
Theme: "{{ album.theme }}"
Tracklist:
{{ tracklist }}

Output ONLY valid JSON, no prose, no code fences:

{
  "title": "<EXACTLY {{ album.albumTitle }} — copy verbatim, preserve all punctuation including '...' or '.' or no ending — do not normalize>",
  "description": "<full description, multi-line, see structure below>",
  "tags": ["<tag1>", "<tag2>", ...]
}

DESCRIPTION STRUCTURE (each section separated by single blank line, in this exact order):

1. Playlist links block (only include if channel has playlist URLs configured; if not, omit this section entirely):
   my playlist 💤 : {{ channel.spotifyPlaylistUrl }}
   {{ channel.appleMusicPlaylistUrl }}

2. ONE-line tagline: "ambient sleep music for overthinking, sleeping or just feeling sad :) "

3. Two-line affirmation block:
   I hope you like my music ❤️
   Please like and subscribe ❤️

4. Two-line attribution block:
   All pictures are made by myself.
   All music is either made by me or friends.

5. Hashtag line — combine these in a single line with double-spaces: #ambient  #music   #sad #playlist #sleep

6. SEO keyword block, three plain lines, no formatting, no hashtags:
   ambient sleep music
   insomnia relief
   deep sleep music

That's the entire description. Do NOT add tracklist (the worker appends tracklist separately if configured). Do NOT add subscribe CTA beyond the one above. Do NOT add emoji elsewhere. Do NOT add timestamps in the description text.

TAGS — return exactly 30 tags as JSON array, all lowercase strings, no hashtag prefix:
- 10 generic-niche tags: ambient mix, dark ambient mix, ambient music, dark ambient, sleep music, ambient music dark, music for sleep, music for better sleep, ambient sleep music, deep sleep music
- 6 functional tags: music to sleep, music for studying, music to help you sleep, music for relaxation, music to calm down, ambient music for sleep
- 6 SEO-rider tags (real ambient artist names — these channels piggyback on artist search traffic): oneheart, my head is empty, daniel mp3, shes gone, patient, diedlonely
- 3 atmosphere tags: snowfall, dreamscape mix, NSDR
- 5 generic mood tags: calm music, chill music, deep sleep, sleep aid, relaxing music

Total tag string must stay under 500 chars.

<!-- mock-response: {"title": "you're safe here", "description": "ambient sleep music for overthinking, sleeping or just feeling sad :)\\n\\nI hope you like my music ❤️\\nPlease like and subscribe ❤️\\n\\nAll pictures are made by myself.\\nAll music is either made by me or friends.\\n\\n#ambient  #music   #sad #playlist #sleep\\n\\nambient sleep music\\ninsomnia relief\\ndeep sleep music", "tags": ["ambient mix", "dark ambient mix", "ambient music", "dark ambient", "sleep music", "ambient music dark", "music for sleep", "music for better sleep", "ambient sleep music", "deep sleep music", "music to sleep", "music for studying", "music to help you sleep", "music for relaxation", "music to calm down", "ambient music for sleep", "oneheart", "my head is empty", "daniel mp3", "shes gone", "patient", "diedlonely", "snowfall", "dreamscape mix", "NSDR", "calm music", "chill music", "deep sleep", "sleep aid", "relaxing music"]} -->`;

const COLUMNS = [
  'description',
  'suno_style_prompt',
  'suno_mode',
  'suno_instrumental',
  'suno_model',
  'suno_persona_id',
  'target_video_seconds',
  'tracks_per_album',
  'distrokid_primary_genre',
  'distrokid_label_name',
  'prompt_album_brief',
  'prompt_track_briefs',
  'prompt_cover_image',
  'prompt_thumbnail',
  'prompt_yt_metadata',
  'hashtags',
  'youtube_channel_handle',
  'distrokid_songwriter_name',
  'distrokid_performer_name',
  'distrokid_performer_role',
  'distrokid_producer_name',
  'distrokid_producer_role',
] as const;

const NEW_VALUES: Record<(typeof COLUMNS)[number], string | number | null> = {
  description: DESCRIPTION,
  suno_style_prompt: SUNO_STYLE_PROMPT,
  suno_mode: 'description',
  suno_instrumental: 1,
  suno_model: 'chirp-fenix',
  suno_persona_id: null,
  target_video_seconds: 14400,
  tracks_per_album: 30,
  distrokid_primary_genre: 'Ambient',
  distrokid_label_name: null,
  prompt_album_brief: PROMPT_ALBUM_BRIEF,
  prompt_track_briefs: PROMPT_TRACK_BRIEFS,
  prompt_cover_image: PROMPT_COVER_IMAGE,
  prompt_thumbnail: PROMPT_THUMBNAIL,
  prompt_yt_metadata: PROMPT_YT_METADATA,
  hashtags: HASHTAGS,
  youtube_channel_handle: null,
  distrokid_songwriter_name: null,
  distrokid_performer_name: null,
  distrokid_performer_role: null,
  distrokid_producer_name: null,
  distrokid_producer_role: null,
};

const PROMPT_COLUMNS = new Set([
  'prompt_album_brief',
  'prompt_track_briefs',
  'prompt_cover_image',
  'prompt_thumbnail',
  'prompt_yt_metadata',
  'suno_style_prompt',
]);

function fmt(col: string, value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  const s = String(value);
  if (PROMPT_COLUMNS.has(col)) {
    return `(${s.length} chars) ${JSON.stringify(s.slice(0, 200))}${s.length > 200 ? '…' : ''}`;
  }
  return JSON.stringify(s);
}

function main(): void {
  const db = openDb();
  console.log(`Opened DB: ${process.env.AMBIENTFORGE_DB_PATH ?? 'data/ambientforge.db'}`);

  const before = db
    .prepare(`SELECT ${COLUMNS.join(',')} FROM channels WHERE id = ?`)
    .get(CHANNEL_ID) as Record<string, unknown> | undefined;
  if (!before) {
    console.error(`channel ${CHANNEL_ID} not found`);
    process.exit(1);
  }

  const setClauses = COLUMNS.map((c) => `${c} = @${c}`).join(', ');
  const stmt = db.prepare(
    `UPDATE channels SET ${setClauses}, updated_at = @updated_at WHERE id = @id`,
  );

  const params: Record<string, unknown> = {
    id: CHANNEL_ID,
    updated_at: Date.now(),
  };
  for (const c of COLUMNS) params[c] = NEW_VALUES[c];

  const tx = db.transaction(() => {
    const info = stmt.run(params);
    if (info.changes !== 1) {
      throw new Error(`expected 1 row updated, got ${info.changes}`);
    }
  });
  tx();

  const after = db
    .prepare(`SELECT ${COLUMNS.join(',')} FROM channels WHERE id = ?`)
    .get(CHANNEL_ID) as Record<string, unknown>;

  console.log('\n=== BEFORE → AFTER per column ===');
  let changedCount = 0;
  for (const c of COLUMNS) {
    const b = before[c];
    const a = after[c];
    const changed = String(b ?? '__NULL__') !== String(a ?? '__NULL__');
    if (changed) changedCount++;
    console.log(`\n${c}${changed ? '  [CHANGED]' : '  (unchanged)'}`);
    console.log(`  before: ${fmt(c, b)}`);
    console.log(`  after:  ${fmt(c, a)}`);
  }

  console.log(`\n=== summary: ${changedCount}/${COLUMNS.length} columns changed ===`);

  const expectations: [keyof typeof NEW_VALUES, unknown][] = [
    ['suno_mode', 'description'],
    ['suno_instrumental', 1],
    ['target_video_seconds', 14400],
    ['distrokid_primary_genre', 'Ambient'],
  ];
  console.log('\n=== assertions ===');
  let assertionsOK = true;
  for (const [k, expected] of expectations) {
    const got = after[k];
    const ok = String(got) === String(expected);
    console.log(`  ${k}: ${ok ? 'OK' : 'FAIL'} expected=${JSON.stringify(expected)} got=${JSON.stringify(got)}`);
    if (!ok) assertionsOK = false;
  }
  for (const k of ['prompt_album_brief', 'prompt_track_briefs', 'prompt_cover_image', 'prompt_thumbnail', 'prompt_yt_metadata']) {
    const v = after[k];
    const ok = typeof v === 'string' && v.includes('<!-- mock-response:');
    console.log(`  ${k} contains mock-response: ${ok ? 'OK' : 'FAIL'}`);
    if (!ok) assertionsOK = false;
  }

  if (!assertionsOK) {
    console.error('\nassertions failed — exiting non-zero');
    process.exit(2);
  }
}

main();
