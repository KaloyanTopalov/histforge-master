# Design: Per-video image pacing overrides + hard floor in chunker

**Date:** 2026-05-27
**Author:** brainstorm session (Claude + user)
**Status:** Approved by user; pending implementation plan
**Related memory:** `storyboard-density-and-prompt-design`, `debug-image-quality-consistency`, `research-gpt-image-2-character-sheet`, `product-direction-tubegen-shape`
**Branch base:** `feature/image-chunk-target-setting` (NOT master — master does not yet carry `image_chunk_target_seconds`)
**New branch:** `pacing-per-video-and-floor`

## Context

The current image-only chunker (`08-chunk-images-only.ts`) walks aligned VO sentences and partitions them into chunks of ~`image_chunk_target_seconds` (global setting, default 8s). One global knob for the whole DB.

For HistForge's actual target — 2-hour historical videos (~17,000 words of script) — three production gaps remain:

1. **No per-video override.** All videos share one global pacing. Different shapes (high-density narrative explainer vs. slow contemplative documentary) want different defaults, and flipping the global between batches is error-prone for unattended overnight queues.
2. **No floor / ceiling enforcement.** The chunker walks to a *target*, but a single short sentence at the tail can land below an acceptable hold time (visual whiplash), and a long sentence can stretch a single image past natural attention span.
3. **No structural metadata** to mark which chunks are establishing shots vs. fact-cards vs. reveals — useful both for future beat-aware render effects and for the LLM in step 09 to reason about what kind of frame it is composing.

The user's brief framed this as a separate `target_seconds_per_image` + `min_scene_sec` + `max_scene_sec` triple, with a per-video override and a hard floor that the chunker enforces (timing authority lives in step 08, not in step 09 — see "Decision: timing authority" below).

## Scope

### In scope

1. **Three new global settings** alongside the existing `image_chunk_target_seconds`:
   - `image_chunk_min_seconds` (default `4`) — hard floor; chunker merges short chunks forward until satisfied.
   - `image_chunk_max_seconds` (default `12`) — soft ceiling; chunker prefers not to exceed but a single oversized sentence wins (cannot subdivide a sentence).
   - `step_09_examples_json` (default `""`) — JSON-encoded array of exemplar scene objects injected into the step 09 prompt template as a `<good_examples>` block.

2. **Three new nullable columns** on `videos`:
   - `image_chunk_target_seconds INTEGER NULL`
   - `image_chunk_min_seconds INTEGER NULL`
   - `image_chunk_max_seconds INTEGER NULL`

   Each column overrides the corresponding global setting when non-NULL. NULL = fall through to the global setting.

3. **Chunker (step 08) algorithm change:** forward-merge to satisfy `min`, plus a final backward-merge tidy for the last chunk. Target behavior unchanged. Oversized single sentences accepted with a logged warning.

4. **New `beat_type` field on `Shot`** in `src/types.ts` — optional, set by the LLM in step 09:
   - `establishing` | `narrative` | `fact_card` | `reveal` | `emphasis`

   Pure metadata. Does NOT influence chunk timing. Documented in the prompt template alongside typical-duration *guidance* (not a constraint).

5. **Pacing panel on `/videos/[id]`** — three number inputs with "use global" clear buttons, live "≈ N images at 150 WPM" hint computed from script word count. Pattern mirrors the existing `character-reference-upload.tsx` widget on the same page.

6. **PATCH /api/videos/[id]** route accepts the three pacing override fields, validates via Zod (min ≥ 2, max ≤ 60, target between min and max when all three are non-NULL).

7. **Few-shot examples slot** in `prompts/09_generate_visual_prompts.md`: a new `{{good_examples}}` variable always supplied by the step, defaulting to empty string. When `step_09_examples_json` is set, it renders into a `<good_examples>...</good_examples>` block above the existing INPUT block.

8. **Settings > Script tab gets `step_09_examples_json`** field — JSON-validated textarea.

### Out of scope

- **Beat-aware timing.** Approach C from brainstorm (LLM pre-pass classifying beat_type and using it to weight chunk merges) is deferred. Approach A (this design) makes `beat_type` purely descriptive metadata. If the operator finds the chunker's timing too flat after this lands, that's the trigger to revisit.
- **Character bible / reference PNG plumbing.** Tracked in `research-gpt-image-2-character-sheet`. Separate spec.
- **Validate-and-reprompt loop** on step 09 (auto-retry if LLM returns fewer entries than expected). Step 09 already has retry-once-on-parse-failure → per-chunk fallback (`ADR-0002`). Extending this is outside this spec.
- **Timestamp-encoded filenames** for editor sync. Render is automated (step 14); no human editor sync exists to feed.
- **CLIP auto-review.** Provider-agnostic but premature; closes after density + consistency.
- **Other chunker variants.** `chunk_clips_then_images` and `chunk_clips_only` keep their existing behavior. Only `chunk_images_only` is touched.
- **Magnific / music-video workflows.** Music-video kind uses a different pipeline (loop image + loop clip + music). Pacing settings do not apply.

## Decision: timing authority lives in step 08

Per brainstorm Q1, the chunker (step 08) owns chunk start/end timing — it derives both from real VO alignment timestamps. Step 09 stays as pure content enrichment. `beat_type` is a content tag; it does NOT alter timing.

Rejected alternative: step 09 emits `duration_sec` per chunk and overrides the chunker's timing. This would either (a) duplicate what alignment already measured, or (b) introduce a re-timing layer that the render and `generate_images` steps would have to consume. Bigger blast radius; rejected.

## Architecture

```
videos table (per-video overrides, nullable)
   image_chunk_target_seconds ──┐
   image_chunk_min_seconds    ──┤
   image_chunk_max_seconds    ──┤
                                │
                                ▼
                  getImageChunkPacing(video, db)  ←── reads global settings as fallback
                                │     image_chunk_target_seconds (default 8)
                                │     image_chunk_min_seconds    (default 4)
                                │     image_chunk_max_seconds    (default 12)
                                ▼
                          { target, min, max }
                                │
                                ▼
       src/worker/steps/08-chunk-images-only.ts
       partitions alignment.json sentences into
       chunks satisfying min ≤ duration (modulo oversized-sentence carve-out),
       targeting `target`, soft-capped at `max`.
                                │
                                ▼
                        chunks/chunks.json
                                │
                                ▼
       src/worker/steps/09-generate-visual-prompts.ts
       enriches each Chunk into a Shot with optional `beat_type`
       (in addition to existing scene/camera/subject_kind/trigger_text/refs).
       Prompt template renders {{good_examples}} from `step_09_examples_json`.
                                │
                                ▼
                        downstream: generate_images, render
                        (unchanged — they consume chunk.start/end as today)
```

## Data model changes

### Settings (src/lib/settings.ts + src/lib/db.ts)

Add to `DEFAULT_SETTINGS`:

```ts
image_chunk_min_seconds: "4",
image_chunk_max_seconds: "12",
step_09_examples_json: "",
```

Add to `SETTING_SCHEMAS`:

```ts
image_chunk_min_seconds: z.coerce.number().int().min(2).max(20),
image_chunk_max_seconds: z.coerce.number().int().min(4).max(60),
step_09_examples_json: z.string(),
```

Schema invariant **not** enforced at write time: `min ≤ target ≤ max`. Validation lives at the *resolved* level (after per-video override resolution), in `getImageChunkPacing`, because the global settings can legitimately be in any order if a per-video override fills the gap.

### Migrations (src/lib/db.ts)

Inside `createDb`, add three `ALTER TABLE videos ADD COLUMN ... INTEGER NULL` migrations, idempotent via the existing pragma-checked pattern (look at the existing migration block for the precedent — `delete_requested`, `paused`, `deferred_until` follow the same shape).

Plus `INSERT OR IGNORE` migrations for the three new settings keys so upgraded DBs gain the defaults.

### Video type (src/types.ts)

Extend the `Video` interface:

```ts
export interface Video {
  // ... existing fields
  image_chunk_target_seconds: number | null;
  image_chunk_min_seconds: number | null;
  image_chunk_max_seconds: number | null;
}
```

### Shot type (src/types.ts)

```ts
export type BeatType =
  | "establishing"
  | "narrative"
  | "fact_card"
  | "reveal"
  | "emphasis";

export interface Shot extends Chunk {
  // ... existing fields
  beat_type?: BeatType;
}
```

### Pacing resolver (new helper in src/lib/settings.ts or a sibling)

```ts
export interface ImageChunkPacing {
  target: number;
  min: number;
  max: number;
}

export function getImageChunkPacing(
  video: Pick<Video,
    | "image_chunk_target_seconds"
    | "image_chunk_min_seconds"
    | "image_chunk_max_seconds">,
  db: DatabaseType = getDb()
): ImageChunkPacing {
  const target = video.image_chunk_target_seconds
    ?? getSetting("image_chunk_target_seconds", db);
  const min = video.image_chunk_min_seconds
    ?? getSetting("image_chunk_min_seconds", db);
  const max = video.image_chunk_max_seconds
    ?? getSetting("image_chunk_max_seconds", db);
  if (!(min <= target && target <= max)) {
    throw new ImageChunkPacingInvariantError(
      `Resolved pacing violates min ≤ target ≤ max: min=${min}, target=${target}, max=${max} (video=${video} — check per-video override columns and global settings).`
    );
  }
  return { target, min, max };
}
```

Throws a typed error at step entry rather than letting the chunker produce garbage. The check is *runtime* because the constituent values may come from any combination of (video column / global setting) sources.

## Chunker algorithm (src/worker/steps/08-chunk-images-only.ts)

```ts
async run(videoId, ctx) {
  const video = videosRepo.findById(ctx.db, videoId);
  const pacing = getImageChunkPacing(video, ctx.db);
  const sentences: AlignmentEntry[] = JSON.parse(readFileSync(alignmentPath, "utf-8"));

  // Forward partition: walk sentences accumulating until target hit, then satisfy min.
  const groups: AlignmentEntry[][] = [];
  let pos = 0;
  while (pos < sentences.length) {
    let end = findGroupEnd(sentences, pos, pacing.target);
    let duration = sentences[end].end - sentences[pos].begin;
    // Extend forward until min satisfied (or out of sentences)
    while (duration < pacing.min && end < sentences.length - 1) {
      end += 1;
      duration = sentences[end].end - sentences[pos].begin;
    }
    groups.push(sentences.slice(pos, end + 1));
    pos = end + 1;
  }

  // Backward-tidy: if the final group is still under-min, absorb into previous.
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const lastDuration = last[last.length - 1].end - last[0].begin;
    if (lastDuration < pacing.min) {
      const prev = groups[groups.length - 2];
      groups[groups.length - 2] = [...prev, ...last];
      groups.pop();
    }
  }

  // Oversized-single-sentence carve-out: a single sentence longer than max
  // cannot be subdivided. Emit it and log a warning. Do NOT throw — a long
  // sentence in real VO is a content reality, not a chunker bug.
  for (const g of groups) {
    const dur = g[g.length - 1].end - g[0].begin;
    if (dur > pacing.max) {
      ctx.log.warn(
        `chunk_images_only: chunk starting at ${g[0].begin}s exceeds max=${pacing.max}s (duration=${dur.toFixed(2)}s) — single oversized sentence; cannot subdivide.`
      );
    }
  }

  // Defensive floor check — should be impossible after forward+backward merge
  // unless the WHOLE video is < min, which means a 1-chunk edge case anyway.
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const dur = g[g.length - 1].end - g[0].begin;
    if (dur < pacing.min && groups.length > 1) {
      throw new ChunkerFloorError(
        `chunk_images_only: chunk index ${i} duration ${dur.toFixed(2)}s is below floor ${pacing.min}s after merge passes — chunker bug.`
      );
    }
  }

  const chunks: Chunk[] = groups.map((g, i) =>
    makeChunk(`image_${String(i + 1).padStart(3, "0")}`, "image", g)
  );

  mkdirSync(chunksDir, { recursive: true });
  writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
}
```

**Why forward-only:** matches `findGroupEnd`'s walking direction; deterministic; no tiebreaker rule needed.

**Why a final backward-tidy:** without it, a video ending in a short sentence produces a sub-floor tail. The tidy only fires once, only on the last group, and only when the forward pass left it under-min — bounded blast radius.

**Why warn-not-throw on oversize:** A real VO sentence can naturally exceed any reasonable max (e.g. a long enumeration). Throwing would force operators to re-write the script. A warning surfaces the issue without blocking.

**Why a defensive `ChunkerFloorError`:** Belt-and-suspenders. The forward+backward merge passes should guarantee `dur ≥ min` for every chunk except the single-chunk edge case (video shorter than `min`). If somehow a sub-floor chunk slips through, fail loudly.

## Step 09 changes (src/worker/steps/09-generate-visual-prompts.ts)

### Beat-type extraction

Add to `extractShotExtras` (lenient — silently drops malformed values, matching the existing pattern):

```ts
const VALID_BEAT_TYPES: ReadonlySet<BeatType> = new Set<BeatType>([
  "establishing", "narrative", "fact_card", "reveal", "emphasis",
]);

// ... inside extractShotExtras:
if (
  typeof entry.beat_type === "string" &&
  VALID_BEAT_TYPES.has(entry.beat_type as BeatType)
) {
  out.beat_type = entry.beat_type as BeatType;
}
```

Persist via the existing `persistBatch` flow — add `beat_type` to the list of fields copied from `extras` onto the chunk.

Eager pre-write reset: add `delete chunks[i].beat_type;` to the existing reset loop alongside the other Shot extras, so a re-run from `null prompt` clears stale beat_type.

### Prompt template change (prompts/09_generate_visual_prompts.md)

Two additions:

1. **`{{good_examples}}` slot** at the very top of the user-message body (above the existing `STYLE` block). Step 09 always supplies a `good_examples` template variable. When `step_09_examples_json` is non-empty and parseable, the variable expands to:

   ```
   <good_examples>
   Here are example scenes from a video the operator considers high-quality. Match this voice and density.

   {{verbatim example objects, pretty-printed JSON, one per line of the array}}
   </good_examples>
   ```

   When empty / invalid, the variable expands to `""`. The render() call's strict-throw stays satisfied because the variable is always supplied.

2. **`beat_type` documentation** added to the per-entry-fields list, just below `subject_kind`:

   ```markdown
   - `beat_type` — string, optional. One of exactly: `establishing`, `narrative`, `fact_card`, `reveal`, `emphasis`. Describes the editorial intent of the frame:
     - `establishing` — opening / transition / scene-setter, typical 4-5s
     - `narrative` — default storytelling beat, typical 4-7s
     - `fact_card` — date, name, place the viewer must read, typical 5-8s
     - `reveal` — twist or answer moment, typical 6-10s
     - `emphasis` — single most important visual in the section, typical 8-12s

     Duration is NOT controlled by `beat_type` in this version — chunk timing is fixed by the upstream chunker. The duration hints above describe the *content* the LLM should put in each kind of frame (a fact_card scene should contain text/numbers that read in ~5-8 seconds), not the playback timing.
   ```

3. **Update the example output** to include a `beat_type` field on one of the two example entries (so the LLM has a concrete pattern to mimic).

## API + UI changes

### PATCH /api/videos/[id]

Add three optional Zod-validated fields to the route's body schema:

```ts
image_chunk_target_seconds: z.number().int().min(2).max(60).nullable().optional(),
image_chunk_min_seconds: z.number().int().min(2).max(20).nullable().optional(),
image_chunk_max_seconds: z.number().int().min(4).max(60).nullable().optional(),
```

**Validation strategy: validate the resolved pacing, not just the request body.** The route reads the existing video row, applies the patch fields on top of it, then resolves the resulting (column-or-global) triple via the same logic as `getImageChunkPacing`. If the resolved `(min, target, max)` violates `min ≤ target ≤ max`, return 400 with a field-specific error naming which constraint is broken and which value came from where (column override vs global setting), so the operator can see which knob to adjust.

This catches the partial-patch trap (`PATCH { min: 10 }` on a row whose `target` falls through to global `8`) that a request-body-only check would miss.

### Pacing panel — new component at `src/app/videos/[id]/pacing-panel.tsx`

Three number inputs, each with a single "Use global" affordance (a button or a tri-state where blank ↔ NULL — pick whichever fits the existing settings UI pattern best). When set to NULL, the input displays the current global value as placeholder text so the operator can see what they would be falling through to. Plus a live computed hint.

Computed hint, displayed below the target input:
```
≈ {scriptWordCount × 60 / (target × 150)} images for this script at 150 WPM.
   { (if target/min/max all set) "Min/max constraints may reduce this number." }
```

The hint reads `videos.provided_script` (if non-null, ready-script videos) or computes from the assembled script if available, otherwise displays "—".

Pattern mirrors `src/app/videos/[id]/character-reference-upload.tsx` (introduced on the current branch). Same fetch-on-mount + optimistic-update PATCH shape.

### Settings > Script tab — add `step_09_examples_json`

Append to `src/app/settings/script-tab.tsx` (already on the branch — see git diff: the file gained 9 lines on this branch already, so the pattern is recent and clear).

JSON-validated textarea. Show parse errors inline. Save button persists via PATCH /api/settings.

## Error handling

| Failure | Surface | Behavior |
|---|---|---|
| Resolved pacing violates `min ≤ target ≤ max` | Step 08 entry | `ImageChunkPacingInvariantError` thrown; step fails; operator sees the resolved values in the error message |
| Final chunk under min after forward+backward merge | Step 08 emit | `ChunkerFloorError` thrown only if `groups.length > 1` (single-chunk videos are unconditionally accepted) |
| Single sentence > max | Step 08 emit | `ctx.log.warn(...)`; chunk emitted anyway; step continues |
| Step 09 LLM emits invalid `beat_type` value | `extractShotExtras` | Silently dropped; chunk persisted without `beat_type` (matches existing extractor pattern for `camera`/`subject_kind`) |
| `step_09_examples_json` is non-empty but invalid JSON | Step 09 entry | Logged warning; variable expands to `""` (no `<good_examples>` block); step proceeds normally |
| PATCH /api/videos/[id] with min > target or target > max | Route handler | 400 with field-specific error; row not modified |

## Testing strategy

All tests use vitest, follow existing `__tests__/` patterns.

1. **`__tests__/unit/lib/db.test.ts`** (extend existing) — migration adds the three columns with NULL default; settings seed gains the three new keys; idempotent on re-run.

2. **`__tests__/unit/lib/settings.test.ts`** (extend existing) — `getImageChunkPacing` falls through to globals when columns are NULL; uses overrides when non-NULL; throws `ImageChunkPacingInvariantError` when resolved values violate the invariant.

3. **`__tests__/unit/worker/steps/chunk-images-only.test.ts`** (extend existing) — three new cases:
   - **Pacing constraints case:** synthetic alignment with ~600 words of varied-length sentences, video row pacing target=4/min=4/max=10. Assert: every emitted chunk has duration in `[min, max]` (modulo single-sentence oversize, which is allowed). Sum of durations equals sum of input sentence durations (no drift).
   - **Forward-merge case:** alignment includes a deliberately short sentence ("The moon." — synthetic ~1s sentence) at min=4. Assert: that sentence is grouped with the next sentence; no sub-4 chunk emitted.
   - **Backward-tidy case:** alignment ending with a 2s tail sentence after several normal-length sentences, min=4. Assert: the tail is absorbed into the previous chunk; final chunk satisfies min.
   - **Oversized-single-sentence case:** alignment with one synthetic 15s sentence, max=10. Assert: chunk is emitted with duration 15; `ctx.log.warn` was called; no error thrown.

4. **`__tests__/unit/worker/steps/chunk-images-only-floor-error.test.ts`** (new) — construct a pathological alignment that would trigger `ChunkerFloorError` (single sentence under min, with `groups.length > 1` somehow). Assert: typed error with chunk index in message.

5. **`__tests__/unit/worker/steps/generate-visual-prompts.test.ts`** (extend existing) — LLM emits `beat_type` per entry; chunks.json persists it. Invalid `beat_type` value (`"foo"`) is silently dropped.

6. **`__tests__/unit/lib/prompts.test.ts`** (extend existing, or new `__tests__/unit/lib/prompt-fewshot.test.ts`) — render of the step 09 template with `good_examples=""` produces no `<good_examples>` block; with a non-empty value produces the block verbatim.

7. **`__tests__/api/videos/[id]/route.test.ts`** (extend existing if present, else new) — PATCH with valid pacing fields persists; min > max returns 400 with field-specific error; partial updates (only one of three) work; NULL clears.

8. **Smoke fixture (manual / CI)** — existing reference video build (whichever 60s narrative fixture is used as the golden) still passes end-to-end with NULL pacing overrides. Mean chunk duration within ±1.5 of the global `image_chunk_target_seconds`. No regressions in step ordering or output schema beyond the new `beat_type` field.

## File-level deliverables

- `src/types.ts` — `Video` interface gains 3 fields; new `BeatType` type; `Shot` gains `beat_type?`.
- `src/lib/db.ts` — 3 settings defaults; 3 settings INSERT OR IGNORE migrations; 3 ALTER TABLE migrations on `videos`.
- `src/lib/settings.ts` — 3 new Zod schemas; `getImageChunkPacing` helper; `ImageChunkPacingInvariantError` typed error class.
- `src/lib/repos/videos.ts` — `findById` already returns the full row; the new columns flow through automatically. Add an `updatePacing` function if the existing update helpers don't cover the new fields cleanly.
- `src/worker/steps/08-chunk-images-only.ts` — switch from `getSetting("image_chunk_target_seconds")` to `getImageChunkPacing(video, db)`; new partition + tidy + defensive-check algorithm; `ChunkerFloorError` typed error class.
- `src/worker/steps/09-generate-visual-prompts.ts` — extend `extractShotExtras` with beat_type validation; add `step_09_examples_json` resolution + `good_examples` template variable; extend eager reset.
- `prompts/09_generate_visual_prompts.md` — add `{{good_examples}}` slot at top; document `beat_type` taxonomy; update example output.
- `src/app/api/videos/[id]/route.ts` — extend body schema; min/max/target invariant check; persist new columns.
- `src/app/settings/script-tab.tsx` — new field for `step_09_examples_json`.
- `src/app/videos/[id]/pacing-panel.tsx` — new component.
- `src/app/videos/[id]/video-detail-client.tsx` — mount the panel alongside the existing character-reference-upload widget.
- All seven `__tests__/...` files listed in the testing section.

## Rollout / risk

- **Backwards compatibility:** All new columns are NULL by default; existing videos see no behavior change. All new settings have sensible defaults (4/12 for floor/ceiling already match what the brainstorm-confirmed reference video uses).
- **Migration safety:** ADD COLUMN with default NULL on a 50M-row table is fast on SQLite (no row rewrite). HistForge's `videos` table is at most thousands of rows in practice.
- **No silent failures:** The chunker's defensive `ChunkerFloorError` and the resolver's `ImageChunkPacingInvariantError` are typed and named. The oversized-sentence case logs a warning but doesn't fail — see "Error handling" rationale.
- **Step 09's parse-failure-retry semantics are preserved:** `beat_type` joins the lenient `extractShotExtras` pool; a malformed value drops without retrying the whole batch, matching how `camera`/`subject_kind` already behave.
- **PR shape:** All commits prefixed `pacing:`. Single PR off `feature/image-chunk-target-setting`. Estimated ~10 files touched + 7 test files.

## Implementation method

TDD per the `tdd` skill: red-green-refactor on each test case in the testing section, in the order listed. Settings + types first (foundation), then chunker algorithm (the heart), then step 09 (smallest content change), then UI + API (cosmetic). Each test goes red → green → refactor → next.

Final pre-PR checks: `npm run lint`, `npm run test`, `npm run build`. All clean before merge. CLAUDE.md "Key Conventions" gets a one-line note on per-video pacing overrides. `docs/histforge-spec.md` schema section updated with the three new columns.

PR title: `pacing: per-video image chunk pacing overrides + hard floor in chunker`.
