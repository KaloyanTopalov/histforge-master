/**
 * Schema-align the 4 broken prompts on production DB.
 *
 * Channel: 01KQ7HRA4SJ9GX6JMC4Q3CNWR1
 *
 * Fixes (one-off after the initial Part 1 fix):
 *   1. prompt_album_brief    — outputs {albumTitle, sunoStylePrompt, primaryGenre} (was {albumTitle, titleStyle, artistName, genre, theme})
 *   2. prompt_track_briefs   — outputs lyrics:null per track (was stylePrompt)
 *   3. prompt_cover_image    — outputs {imagePrompt: "..."} (was bare string)
 *   4. prompt_yt_metadata    — embeds {{tracklist}} in description structure; mock-response uses {{tracklistEscaped}} placeholder (operator-approved tracklist substitution)
 *
 * Run: tsx scripts/fix-prompts-v2-2026-04-29.ts
 */
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

const PROMPT_ALBUM_BRIEF = `Generate a sad-ambient sleep music album. Mix two title styles for variety across the channel — randomly pick ONE style per album.

Output ONLY valid JSON matching this exact schema, no prose, no code fences:

{
  "albumTitle": "<see rules below>",
  "sunoStylePrompt": "<copy the channel base style verbatim, with optional per-album mood refinement appended>",
  "primaryGenre": "Ambient"
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

Pick ONE style per album. Roughly 60% reassurance / 40% imperative across the channel over time.

sunoStylePrompt: take the channel's base Suno style descriptor and optionally append a single mood refinement clause based on the album title's emotional register (e.g. ", with a slightly warmer Rhodes overlay" for reassurance albums; ", sparser and more sub-bass-forward" for imperative albums). Keep total under 400 chars. Do NOT remove "no vocals", "instrumental", or BPM range from the base.

<!-- mock-response: {"albumTitle": "you're safe here", "sunoStylePrompt": "slow ambient piano, 50-65 BPM, A minor or D minor, soft sustained pads, deep atmospheric reverb, late-night reflective mood, no percussion, no vocals, instrumental only, melancholic but gentle, sparse, with a slightly warmer Rhodes overlay", "primaryGenre": "Ambient"} -->`;

const PROMPT_TRACK_BRIEFS = `Generate {{ tracksPerAlbum }} instrumental ambient tracks for the album "{{ album.albumTitle }}".
All tracks are instrumental — lyrics field MUST be null for every track.

Output ONLY valid JSON matching this exact schema, no prose, no code fences:

{
  "tracks": [
    {
      "trackNumber": 1,
      "title": "<lowercase, 2-5 words, atmospheric>",
      "lyrics": null
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

Track titles should subtly progress in mood across the album:
- Early tracks: tentative, slightly brighter ("first quiet hour.", "the lights dim.")
- Middle tracks: deepening ("rain on glass.", "let it pass.")
- Later tracks: very sparse, near-sleep ("almost asleep.", "the long pause.")

Each lyrics field MUST be exactly null (JSON null, not the string "null", not empty string). The track is instrumental.

<!-- mock-response: {"tracks": [{"trackNumber": 1, "title": "first quiet hour.", "lyrics": null}, {"trackNumber": 2, "title": "rain on glass.", "lyrics": null}, {"trackNumber": 3, "title": "let it pass.", "lyrics": null}]} -->`;

const PROMPT_COVER_IMAGE = `Convert this album theme into a single visual prompt for a 1:1 square cover image.

Album: "{{ album.albumTitle }}"

Output ONLY valid JSON matching this exact schema, no prose, no code fences:

{
  "imagePrompt": "<single visual prompt string>"
}

Visual aesthetic (matching channels like "i miss her." / @imissher.ambient):
- Cinematic still, looks like a frame from a quiet drama film
- Muted dark color palette: deep navy, charcoal, dusty blue, cool gray, soft amber lamplight, faded gold
- Single subject, centered or off-center: a back-turned figure, an empty bed, a window with rain, a dim lamp, an empty room, a hallway, a chair by a window, a sleeping cat
- NEVER: faces visible, bright colors, sun, smiling people, multiple people, text/logos, sharp daytime light
- Soft natural lighting: late evening, dim lamp, moonlight through curtains, blue hour, 2am bedroom darkness
- Slight film grain, soft focus, atmospheric haze
- Slight melancholy without being depressing — comforting darkness
- Square 1:1 composition, leaving breathing space around the subject

Strip ALL audio terminology (BPM, instrumental, ambient, tempo, key, vocals) — visual only.

<!-- mock-response: {"imagePrompt": "A solitary figure sitting on the edge of a bed seen from behind, soft amber lamp glow on dark navy walls, rain streaks blurred against the window beside them, muted color palette of charcoal and dusty blue, cinematic film grain, atmospheric haze, late-night stillness, 1:1 square composition, soft focus background"} -->`;

const PROMPT_YT_METADATA = `Generate YouTube metadata for an instrumental ambient sleep music video.

Album title: "{{ album.albumTitle }}"
Tracklist:
{{ tracklist }}

Output ONLY valid JSON, no prose, no code fences:

{
  "title": "<EXACTLY {{ album.albumTitle }} — copy verbatim, preserve all punctuation including '...' or '.' or no ending — do not normalize>",
  "description": "<full description, multi-line, see structure below>",
  "tags": ["<tag1>", "<tag2>", ...]
}

DESCRIPTION STRUCTURE (each section separated by single blank line, in this exact order):

1. Playlist links block (only include if {{ channel.spotifyPlaylistUrl }} is non-empty; otherwise omit entirely):
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

7. Tracklist block — embed the tracklist exactly. The placeholder {{ tracklist }} below MUST appear verbatim in the output description so the worker's tracklist verification passes:
   {{ tracklist }}

That's the entire description. Sections 1-7 in that order, separated by blank lines. No emoji other than 💤 and ❤️. No subscribe CTA beyond the one above. No timestamps in the description text outside the tracklist block (the tracklist itself contains its own M:SS - Title formatting).

TAGS — return exactly 30 tags as JSON array, all lowercase strings, no hashtag prefix:
- 10 generic-niche tags: ambient mix, dark ambient mix, ambient music, dark ambient, sleep music, ambient music dark, music for sleep, music for better sleep, ambient sleep music, deep sleep music
- 6 functional tags: music to sleep, music for studying, music to help you sleep, music for relaxation, music to calm down, ambient music for sleep
- 6 SEO-rider tags (real ambient artist names): oneheart, my head is empty, daniel mp3, shes gone, patient, diedlonely
- 3 atmosphere tags: snowfall, dreamscape mix, NSDR
- 5 generic mood tags: calm music, chill music, deep sleep, sleep aid, relaxing music

Total tag string must stay under 500 chars.

<!-- mock-response: {"title": "you're safe here", "description": "ambient sleep music for overthinking, sleeping or just feeling sad :)\\n\\nI hope you like my music ❤️\\nPlease like and subscribe ❤️\\n\\nAll pictures are made by myself.\\nAll music is either made by me or friends.\\n\\n#ambient  #music   #sad #playlist #sleep\\n\\nambient sleep music\\ninsomnia relief\\ndeep sleep music\\n\\n{{tracklistEscaped}}", "tags": ["ambient mix", "dark ambient mix", "ambient music", "dark ambient", "sleep music", "ambient music dark", "music for sleep", "music for better sleep", "ambient sleep music", "deep sleep music", "music to sleep", "music for studying", "music to help you sleep", "music for relaxation", "music to calm down", "ambient music for sleep", "oneheart", "my head is empty", "daniel mp3", "shes gone", "patient", "diedlonely", "snowfall", "dreamscape mix", "NSDR", "calm music", "chill music", "deep sleep", "sleep aid", "relaxing music"]} -->`;

const COLUMNS = ['prompt_album_brief', 'prompt_track_briefs', 'prompt_cover_image', 'prompt_yt_metadata'] as const;
const NEW: Record<(typeof COLUMNS)[number], string> = {
  prompt_album_brief: PROMPT_ALBUM_BRIEF,
  prompt_track_briefs: PROMPT_TRACK_BRIEFS,
  prompt_cover_image: PROMPT_COVER_IMAGE,
  prompt_yt_metadata: PROMPT_YT_METADATA,
};

function main(): void {
  const db = openDb();

  const before = db
    .prepare(`SELECT ${COLUMNS.join(',')} FROM channels WHERE id = ?`)
    .get(CHANNEL_ID) as Record<string, string> | undefined;
  if (!before) {
    console.error(`channel ${CHANNEL_ID} not found`);
    process.exit(1);
  }

  const setClauses = COLUMNS.map((c) => `${c} = @${c}`).join(', ');
  const stmt = db.prepare(
    `UPDATE channels SET ${setClauses}, updated_at = @updated_at WHERE id = @id`,
  );
  const params: Record<string, unknown> = { id: CHANNEL_ID, updated_at: Date.now() };
  for (const c of COLUMNS) params[c] = NEW[c];

  const tx = db.transaction(() => {
    const info = stmt.run(params);
    if (info.changes !== 1) throw new Error(`expected 1 row updated, got ${info.changes}`);
  });
  tx();

  const after = db
    .prepare(`SELECT ${COLUMNS.join(',')} FROM channels WHERE id = ?`)
    .get(CHANNEL_ID) as Record<string, string>;

  console.log('=== prompt updates ===');
  for (const c of COLUMNS) {
    const b = before[c] ?? '';
    const a = after[c] ?? '';
    const hasMock = a.includes('<!-- mock-response:');
    console.log(`${c}: ${b.length} -> ${a.length} chars, mock=${hasMock ? 'YES' : 'MISSING'}`);
  }

  console.log('\n=== assertions ===');
  let ok = true;
  const checks: Array<[string, string, boolean]> = [
    ['album-brief contains "sunoStylePrompt"', after.prompt_album_brief, after.prompt_album_brief.includes('sunoStylePrompt')],
    ['album-brief contains "primaryGenre"', after.prompt_album_brief, after.prompt_album_brief.includes('primaryGenre')],
    ['track-briefs mock has lyrics:null', after.prompt_track_briefs, after.prompt_track_briefs.includes('"lyrics": null')],
    ['cover-image mock has imagePrompt key', after.prompt_cover_image, after.prompt_cover_image.includes('"imagePrompt"')],
    ['yt-metadata mock has {{tracklistEscaped}}', after.prompt_yt_metadata, after.prompt_yt_metadata.includes('{{tracklistEscaped}}')],
  ];
  for (const [name, _content, pass] of checks) {
    console.log(`  ${pass ? 'OK  ' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }
  if (!ok) process.exit(2);
}

main();
