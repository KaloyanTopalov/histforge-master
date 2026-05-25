/**
 * Patch the validation DB's prompt mock-response directives so they conform
 * to the actual step schemas. The operator's production-DB prompts have
 * mock-responses misaligned with steps 01/02/05a/10 — see report. This patch
 * rewrites the mock-responses on the VALIDATION DB ONLY.
 *
 * Issues found and fixed (validation DB only):
 *   - prompt_album_brief: mock had {genre, theme, titleStyle, artistName} —
 *     step 01 expects {albumTitle, sunoStylePrompt, primaryGenre}.
 *   - prompt_track_briefs: mock had stylePrompt — step 02 expects lyrics
 *     (string|null). For ambient/instrumental, null.
 *   - prompt_cover_image: mock was a bare string — step 05a's image-prompt
 *     LLM call expects {imagePrompt: "..."}.
 *   - prompt_yt_metadata: step 10 enforces description.includes(tracklist).
 *     Mock had no tracklist; we inject {{tracklistEscaped}} placeholder.
 *
 * Usage: AMBIENTFORGE_DB_PATH=data/session-prompt-validation.db tsx scripts/patch-validation-mock-prompts-2026-04-29.ts
 */
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';

const NEW_MOCKS: Record<string, string> = {
  prompt_album_brief: `<!-- mock-response: {"albumTitle": "you're safe here", "sunoStylePrompt": "slow ambient piano, soft sustained pads, A minor, 60 BPM, instrumental, no vocals, no percussion, comforting darkness", "primaryGenre": "Ambient"} -->`,
  prompt_track_briefs: `<!-- mock-response: {"tracks": [{"trackNumber": 1, "title": "first quiet hour.", "lyrics": null}, {"trackNumber": 2, "title": "rain on glass.", "lyrics": null}, {"trackNumber": 3, "title": "let it pass.", "lyrics": null}]} -->`,
  prompt_cover_image: `<!-- mock-response: {"imagePrompt": "A solitary figure sitting on the edge of a bed seen from behind, soft amber lamp glow on dark navy walls, rain streaks blurred against the window beside them, muted color palette of charcoal and dusty blue, cinematic film grain, atmospheric haze, late-night stillness, 1:1 square composition, soft focus background"} -->`,
  // prompt_thumbnail mock-response is correct as-is.
  // prompt_yt_metadata: description must include the tracklist text verbatim
  // (step 10 enforcement). We embed {{tracklistEscaped}} which renderTemplate
  // substitutes BEFORE extractMockResponse parses, so the final JSON has
  // the live tracklist string.
  prompt_yt_metadata: `<!-- mock-response: {"title": "you're safe here", "description": "ambient sleep music for overthinking, sleeping or just feeling sad :)\\n\\nI hope you like my music ❤️\\nPlease like and subscribe ❤️\\n\\nAll pictures are made by myself.\\nAll music is either made by me or friends.\\n\\n#ambient  #music   #sad #playlist #sleep\\n\\nambient sleep music\\ninsomnia relief\\ndeep sleep music\\n\\n{{tracklistEscaped}}", "tags": ["ambient mix", "dark ambient mix", "ambient music", "dark ambient", "sleep music", "ambient music dark", "music for sleep", "music for better sleep", "ambient sleep music", "deep sleep music", "music to sleep", "music for studying", "music to help you sleep", "music for relaxation", "music to calm down", "ambient music for sleep", "oneheart", "my head is empty", "daniel mp3", "shes gone", "patient", "diedlonely", "snowfall", "dreamscape mix", "NSDR", "calm music", "chill music", "deep sleep", "sleep aid", "relaxing music"]} -->`,
};

const MOCK_DIRECTIVE_RE = /<!--\s*mock-response:\s*[\s\S]*?\s*-->/;

function main(): void {
  const db = openDb();

  for (const [col, newMock] of Object.entries(NEW_MOCKS)) {
    const row = db
      .prepare(`SELECT ${col} FROM channels WHERE id = ?`)
      .get(CHANNEL_ID) as Record<string, string> | undefined;
    if (!row) {
      console.error(`channel ${CHANNEL_ID} not found`);
      process.exit(1);
    }
    const before = row[col];
    if (typeof before !== 'string' || before.length === 0) {
      console.error(`column ${col} is empty/null on channel`);
      process.exit(1);
    }
    if (!MOCK_DIRECTIVE_RE.test(before)) {
      console.error(`column ${col} has no <!-- mock-response: --> directive`);
      process.exit(1);
    }
    const after = before.replace(MOCK_DIRECTIVE_RE, newMock);
    db.prepare(`UPDATE channels SET ${col} = ?, updated_at = ? WHERE id = ?`).run(
      after,
      Date.now(),
      CHANNEL_ID,
    );
    console.log(`patched ${col}: directive replaced (${before.length} -> ${after.length} chars)`);
  }

  console.log('\nValidation DB mock-responses now schema-aligned.');
}

main();
