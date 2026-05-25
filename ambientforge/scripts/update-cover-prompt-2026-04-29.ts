/**
 * One-off: update prompt_cover_image for channel 01KQ7HRA4SJ9GX6JMC4Q3CNWR1
 * (sad-ambient-01 / "midnight whispers") with the LA-skyline-girl visual prompt.
 *
 * Cinematic-bedroom prompt (April 2026 era) → LA-skyline-girl prompt
 * (high-performing January-February 2026 era of @imissher.ambient).
 *
 * Single transaction, single column. No other channel field changed.
 */
import Database from 'better-sqlite3';
import path from 'node:path';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';
const DB_PATH = path.resolve('data', 'ambientforge.db');

const NEW_PROMPT = `Convert this album theme into a single visual prompt for a 16:9 cinematic photograph cover image.

Album: "{{ album.albumTitle }}"

Output ONLY valid JSON matching this exact schema, no prose, no code fences:

{
  "imagePrompt": "<single visual prompt string>"
}

Visual aesthetic — beautiful young woman with Los Angeles night skyline. Reference: high-performing era of @imissher.ambient (Jan-Feb 2026 videos hitting 240K-808K views per video).

- Subject: ONE young woman, mid-20s, soft natural beauty, long dark hair, gentle closed-mouth or slight open smile (NEVER wide grin, never fake-pose), warm and approachable, looking just past camera into the distance
- Setting: rooftop or balcony with Los Angeles night skyline behind her, downtown LA city lights blurred (bokeh), distant skyscrapers with glowing windows, palm tree silhouettes occasionally visible, sometimes ocean horizon if shooting from the hills
- Color palette: deep purples, neon magentas, electric blues, warm pink-amber from city lights — Miami-Vice-meets-late-night-drive
- Lighting: cinematic key light on her face from soft natural source (city light bouncing, neon reflection), face slightly lit warm against the cool blue/purple background
- Wardrobe: simple, soft tones — light sweater, thin tank top, soft blouse — never glamorous or revealing, more "introspective late evening" than "fashion shoot"
- Mood: late-night LA, contemplative, peaceful exhaustion, soft melancholy — she looks like someone you could sit next to in silence
- Composition: 16:9 widescreen, subject occupying right or left third (rule of thirds), city skyline filling the rest, slight blur on background for depth
- Camera: medium close-up to medium shot (head + shoulders + chest), shallow depth of field, 85mm lens look, slight film grain
- Photorealistic, NOT illustration, NOT anime, NOT digital painting

NEVER include: text or logos, multiple visible faces, sunglasses covering eyes, hands in front of camera, sexual posing, alcohol or drugs, brand logos on clothes

Strip ALL audio terminology (BPM, instrumental, ambient, tempo, key, vocals) — visual only.

<!-- mock-response: {"imagePrompt": "Photorealistic cinematic 16:9 photograph of a young woman in her mid-twenties with long dark hair, sitting on a rooftop balcony at night with the Los Angeles skyline behind her, downtown LA skyscrapers blurred with warm bokeh lights in deep purple and electric magenta tones, palm tree silhouettes faintly visible, soft natural smile looking past the camera into the distance, wearing a simple light sweater, warm key light on her face contrasting with the cool neon background, shallow depth of field 85mm lens look, slight film grain, late-night contemplative mood, dreamy purple-blue-pink palette, medium close-up, rule-of-thirds composition"} -->`;

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new Error(`new prompt missing required substring "${needle}" (${label})`);
  }
}

function main(): void {
  // Pre-flight validate the new prompt content before opening the DB.
  assertContains(NEW_PROMPT, 'Los Angeles night skyline', 'visual aesthetic');
  assertContains(NEW_PROMPT, '<!-- mock-response:', 'mock directive');
  assertContains(NEW_PROMPT, 'Strip ALL audio terminology', 'audio-strip directive');
  if (NEW_PROMPT.length <= 1500) {
    throw new Error(`new prompt length ${NEW_PROMPT.length} <= 1500 (sanity)`);
  }
  console.log(`[update] new prompt validated: length=${NEW_PROMPT.length}`);

  const db = new Database(DB_PATH);
  try {
    const before = db
      .prepare(
        'SELECT length(prompt_cover_image) AS plen, substr(prompt_cover_image, 1, 80) AS phead FROM channels WHERE id = ?',
      )
      .get(CHANNEL_ID) as { plen: number; phead: string } | undefined;
    if (!before) throw new Error(`channel ${CHANNEL_ID} not found`);
    console.log(`[update] BEFORE plen=${before.plen} phead="${before.phead}"`);

    // Snapshot full row for safety verification post-update.
    const beforeRow = db.prepare('SELECT * FROM channels WHERE id = ?').get(CHANNEL_ID) as Record<
      string,
      unknown
    >;

    const tx = db.transaction(() => {
      const info = db
        .prepare('UPDATE channels SET prompt_cover_image = ? WHERE id = ?')
        .run(NEW_PROMPT, CHANNEL_ID);
      if (info.changes !== 1) throw new Error(`expected 1 row updated, got ${info.changes}`);
    });
    tx();

    const after = db
      .prepare(
        'SELECT length(prompt_cover_image) AS plen, substr(prompt_cover_image, 1, 80) AS phead FROM channels WHERE id = ?',
      )
      .get(CHANNEL_ID) as { plen: number; phead: string };
    console.log(`[update] AFTER  plen=${after.plen} phead="${after.phead}"`);

    // Verify NO other column changed.
    const afterRow = db.prepare('SELECT * FROM channels WHERE id = ?').get(CHANNEL_ID) as Record<
      string,
      unknown
    >;
    const changedCols: string[] = [];
    for (const k of Object.keys(beforeRow)) {
      if (beforeRow[k] !== afterRow[k]) changedCols.push(k);
    }
    if (changedCols.length !== 1 || changedCols[0] !== 'prompt_cover_image') {
      throw new Error(`unexpected columns changed: ${JSON.stringify(changedCols)}`);
    }
    console.log(`[update] only column changed: prompt_cover_image — OK`);

    // Substring sanity in DB.
    const verify = db
      .prepare('SELECT prompt_cover_image AS p FROM channels WHERE id = ?')
      .get(CHANNEL_ID) as { p: string };
    assertContains(verify.p, 'Los Angeles night skyline', 'DB after-substring');
    assertContains(verify.p, '<!-- mock-response:', 'DB after-mock');
    assertContains(verify.p, 'Strip ALL audio terminology', 'DB after-audio-strip');
    console.log(`[update] DB substring checks passed`);
  } finally {
    db.close();
  }
}

main();
