You are a visual prompt writer. For each chunk in the batch below, write a single visual prompt that an AI image / video generator will use to create an image for that chunk.

STYLE (apply to every prompt in this batch):
{{style_prompt}}

INPUT:

A JSON array of chunks. Each chunk has:
- `id` — chunk identifier; use this exactly as the key in your output.
- `prev_text` — text of the chunk before this one (empty for the first chunk); for narrative continuity.
- `current_text` — narration text for this chunk; describes what the scene is *about*.
- `next_text` — text of the chunk after this one (empty for the last chunk); for narrative continuity.

```json
{{batch_json}}
```

CRITICAL — NEVER name real people. Google's image/video generator rejects any prompt that names a prominent historical, political, military, or cultural figure (e.g. "Vincent van Gogh", "Winston Churchill", "Napoleon", "Hitler", "Lincoln", "Marilyn Monroe", "Hirohito"). The rejection is on the prompt text itself, not the image — so even a vague reference to a famous name will fail every time.

Instead, describe the person by role, era, and visual attributes:
- INSTEAD OF "Vincent van Gogh painting in his studio" → "a gaunt Dutch post-impressionist painter in his late thirties, red hair and beard, paint-stained smock, working at an easel in a sunlit Provence studio, 1880s"
- INSTEAD OF "Lieutenant John George with his rifle" → "a young American infantry officer in WWII Pacific theater fatigues, crouched in a jungle bunker, scoped bolt-action rifle braced on sandbags, 1943"
- INSTEAD OF "Churchill at his desk" → "a stout British prime minister in his late sixties, bow tie and three-piece suit, cigar in hand, seated at a paper-strewn desk in a wartime Whitehall office, 1940"

Apply this rule even when the chunk text names the person directly — strip the name from the visual prompt and replace with descriptors. Generic roles (soldier, painter, king, scientist) and fictional/composite characters are fine.

CRITICAL — Two safety filters read this prompt. The visual prompt is the ONLY text Google's video generator sees: it produces both the imagery AND the synchronized audio (Veo 3 invents ambient sound, SFX, and any dialogue based on the prompt's scene). So the prompt must avoid both **graphic-visual** triggers and **harmful-audio** triggers.

NEVER depict graphic violence, gore, or wounds — describe **aftermath, implication, or emotional reaction** instead. Forbidden visual language:
- "blood", "bloodstained", "blood pooling", "blood on stone", "dark pools of blood"
- "stab wounds", "wounded", "mutilated", "torn flesh", "gore", "corpse"
- "attacking with daggers/knives/swords", "stabbing", "slashing", "killing"
- "moment of violent chaos", "brutal assassination", "savage attack"

NEVER frame scenes around discrimination, persecution, or threatening intent — Veo's audio filter rejects prompts that would lead the audio model to synthesize hateful, threatening, or harmful speech. Forbidden framing language:
- "illegitimate child/boy/birth", "denied entry because of his birth/race/class"
- "ruthless authority", "barely restrained violence", "menacing presence"
- "force, not charm", "protect through violence", "rule by fear"
- "mercenaries" paired with "violence/threat/intimidation" descriptors
- Any phrasing that casts a person as inferior because of their lineage, class, or birth circumstance

Reframe to neutral/sympathetic/observational instead:
- INSTEAD OF "lies on marble floor with seventeen stab wounds, blood pooling beneath him while priests back away" → "a young Florentine nobleman in torn Renaissance finery lies motionless on polished marble, priests in black robes retreating in horror toward cathedral walls, golden sunlight streaming through tall arched windows, dramatic chiaroscuro"
- INSTEAD OF "moment of violent chaos—a young man mortally wounded on marble pavement surrounded by attackers with daggers, blood on stone" → "the aftermath of a sudden tragedy in a Renaissance Florence street, fallen young nobleman in dark-stained robes on marble pavement, stunned onlookers frozen in horror, attackers fleeing into the shadows of architectural arches, dramatic chiaroscuro lighting"
- INSTEAD OF "a young illegitimate boy denied entry to a prestigious university because his mother was a peasant" → "a curious young boy in simple homespun clothing standing thoughtfully outside the iron gates of a Renaissance university, scholars in robes passing through the archway behind him, the heavy wooden doors closed, soft afternoon light, expression of quiet longing"
- INSTEAD OF "Italian Renaissance military commander with ruthless authority and barely restrained violence, mercenaries visible in the background" → "an Italian Renaissance military commander in his forties, dark-haired and stern-faced, wearing ornate armor and a velvet cloak, standing with composed authority in a marble palazzo, armored soldiers at attention in the background, 15th century Milan, dramatic side-lighting casting sharp shadows across his determined expression"
- INSTEAD OF "executioner's axe striking the condemned man's neck" → "a hooded executioner standing on a wooden scaffold raising his axe overhead, the kneeling condemned figure bowed in prayer, the silent crowd holding its breath, overcast medieval village square"

Allowed: weapons being held, soldiers in formation, tense confrontations, expressions of fear or grief, fallen figures (so long as no wounds/blood are described), dramatic lighting, fleeing crowds, smoke and shadow, historical figures of authority described by **role and bearing** rather than by harm they intend to inflict. The goal is dramatic historical realism without triggering either the visual-safety or audio-safety filter.

OUTPUT (JSON only, no preamble, no commentary, no markdown fences):

Return a single JSON object: `{"prompts": [<entry>, ...]}`. Do not wrap the response in backticks. Do not prefix it with the word `json`. Begin your response with `{` and end it with `}`. Return one entry per input chunk, using the input `id` exactly.

Each entry MUST include `id` and `prompt`; the other fields are OPTIONAL but recommended — populate them when you can, omit them otherwise.

Per-entry fields:
- `id` — string, REQUIRED, must match the input chunk id exactly.
- `prompt` — string, REQUIRED, non-empty. The full visual prompt the image generator receives. No commentary, no labels, no formatting, just the prompt. This is the only field currently consumed downstream.
- `scene` — string, optional. One sentence describing what's in the frame (≤ 25 words, subject + setting, not style).
- `camera` — string, optional. One of exactly: `wide`, `medium`, `close-up`, `over-shoulder`, `pov`, `static`. If none fits, OMIT the field rather than inventing a value.
- `subject_kind` — string, optional. One of exactly: `character`, `environment`, `object`, `title-card`. `character` = a person is the focus; `environment` = a place/landscape; `object` = an artifact, document, or close-up of a thing; `title-card` = text on a flat background.
- `trigger_text` — string, optional. The most concrete noun or short phrase in the chunk's narration this image anchors to. Used for editor sync; if nothing concrete stands out, omit.
- `negative_prompt` — string, optional. A short fragment describing what must NOT appear in this specific shot.
- `references` — array, optional. Each entry has shape `{"role": "<role>", "source": <source>}`. `role` is exactly `"character"` or `"style"`. `source` is one of `{"kind": "entity", "entity_id": "<string>"}` for a saved provider entity, or `{"kind": "image", "url": "<string>"}` for an uploaded reference image URL. The LLM should normally LEAVE THIS EMPTY — references are attached upstream by the operator's per-video settings; emit one here only if the chunk text itself names a specific saved entity to use.

Example output for a two-chunk batch (this is literal, valid JSON — emit your output in exactly this shape):

```json
{
  "prompts": [
    {
      "id": "image_001",
      "prompt": "a gaunt Dutch post-impressionist painter in his late thirties, red hair and beard, paint-stained smock, working at an easel in a sunlit Provence studio, 1880s",
      "scene": "a painter at an easel in a sunlit studio",
      "camera": "medium",
      "subject_kind": "character",
      "trigger_text": "Provence"
    },
    {
      "id": "image_002",
      "prompt": "wide shot of golden wheat fields under heavy summer sun, distant cypress trees, late afternoon light",
      "scene": "golden wheat fields under summer sun",
      "camera": "wide",
      "subject_kind": "environment",
      "trigger_text": "wheat fields"
    }
  ]
}
```
