# Design: Image styles registry + per-workflow style selection + pixel-dissolve reveal effect

**Date:** 2026-05-29
**Author:** design session (Claude + user)
**Status:** Pending implementation plan
**Related specs:**
- `2026-05-27-magnific-narrative-image-generation-design.md` (the image generation producer this builds on)
- `2026-05-27-magnific-playwright-runtime-design.md` (runtime executing dispatches)
- `doodle-visual-metaphor-skill.md` (the SUBJECT-selection skill wired into step 09 for doodle styles — the intelligence layer that pairs with this plumbing)
**Branch base:** `master` (post structural-safety PR merge — see Rollout)

## Context

HistForge's current narrative pipeline generates images via Nano Banana 2 (Magnific) with a single prompt template baked into `generate_visual_prompts`. The output is good for cinematic content but locks every video into one aesthetic. The operator has identified a distinct visual style (whiteboard/doodle illustration with progressive image reveal) used by high-engagement faceless YouTube channels that they want to produce alongside cinematic content.

The doodle style is a fundamentally different category than cinematic — it's not a parameter tweak, it's a different prompt template AND a different render-step behavior (white background, slow image reveal). This spec introduces the concept of **image styles** as named bundles of (prompt template + per-style locks + render behavior) selectable per workflow.

The initial styles are:

1. **Cinematic** (default, preserves current behavior) — photorealistic/atmospheric prompts, full-bleed image, no reveal effect, B&W line-art lock (the current global lock), current pacing
2. **Doodle (polished)** (new) — colored whiteboard doodle prompts, clean confident linework, white background, pixel-dissolve reveal, current pacing
3. **Doodle (rough marker)** (new) — colored whiteboard doodle prompts pushed toward authentic hand-drawn marker texture (wobbly lines, scribble fill, flat 2D, no render polish), white background, pixel-dissolve reveal, current pacing

**Both doodle variants were validated by hand** against a reference channel frame during the design session: prompts were run directly through Magnific (Nano Banana 2) and produced output matching the target genre. The polished variant came out clean/modern; the rough variant (with explicit anti-polish negatives) pushes toward the reference channel's authentic marker look. Both are kept because they suit different content moods (polished = friendly/positive, rough = urgent/warning). Their exact prompts are locked in the registry section below.

**Critical conflict this spec must resolve — the global lock fights color.** HistForge's current visual-style assembler (step 09) appends two GLOBAL lock strings after the per-video style:
- `style_lock_description` default: *"2D hand-drawn animation style, plain white background, pure black line work only, no color, no shading, no gradients..."*
- `character_lock_negative` default: *"color, shading, gradient, 3D, photorealistic..."*

The colored doodle styles need color; the global lock forbids it and the negative actively penalizes it. Run a colored doodle prompt through the current pipeline and the global lock muddies/washes the color that the standalone Magnific tests produced cleanly. Because the operator runs MULTIPLE styles (cinematic needs the B&W lock; doodle needs a color-allowing lock), a single global lock cannot serve both. **This spec therefore moves the locks from global settings into per-style fields** — see "Per-style locks" below. This is the load-bearing structural change without which colored doodle does not survive the pipeline.

## Scope

### In scope

1. **Image styles registry.** New leaf module `src/lib/image/styles.ts` exporting `IMAGE_STYLE_NAMES` (tuple of style ids) and `IMAGE_STYLE_DEFINITIONS` (map from style id to its prompt prefix + per-style locks + render config). Mirrors the `IMAGE_PROVIDER_NAMES`/`IMAGE_PROVIDER_LABELS` pattern from PR #13.

2. **Per-workflow `image_style` field.** New nullable string column on the workflows table (`image_style`), Zod enum on `NarrativeRowSchema.image_style`. Default `null` → resolves to `cinematic` at runtime (backwards compatible: existing workflows without the field behave exactly as before).

3. **Per-style locks (the structural fix).** Move `style_lock_description` and `character_lock_negative` from GLOBAL settings into per-style fields in the registry. Step 09's assembler uses the picked style's locks, not the globals. Cinematic style carries the current B&W lock; doodle styles carry color-allowing locks. Backwards compat: if a style defines no lock, fall back to the existing global lock setting (so cinematic / unmigrated styles behave exactly as today). This is what lets colored doodle survive the pipeline without washing out.

4. **Workflow editor dropdown.** Add `image_style` selector to the workflow editor, derived from the styles registry (same derive-from-schema pattern PR #13 established for `image_provider`).

5. **Prompt prefix selection.** The `generate_visual_prompts` step reads the workflow's `image_style`, looks up the style's prompt prefix from the registry, and the assembler appends it (replacing the single hardcoded style today). The per-chunk SUBJECT still comes from the step's LLM; the style prefix + per-style locks wrap it.

6. **Pixel-dissolve reveal effect.** New FFmpeg filter chain in the render step that, when the style declares `reveal_effect: "pixel_dissolve"`:
   - Composites each image over a white background (from `background_color`)
   - Plays a pixel-dissolve transition from white → image over the first `image_reveal_fraction` of each image's screen time
   - Image is fully visible for the remaining `1 - image_reveal_fraction` of the time
   - Existing Ken Burns motion continues normally after the reveal completes

7. **Reveal duration setting.** New global setting `image_reveal_fraction` (numeric, default `0.35`, range `0.1-0.8`). The fraction of each image's display time spent on the reveal. Tunable without touching code.

8. **Backwards compatibility.** Existing workflows without `image_style` set continue to behave identically. Cinematic style produces the same output as the current pipeline (same B&W lock, no reveal, full-bleed). Only doodle-style workflows get the new behavior.

9. **Seeded doodle workflows.** Two new built-in workflows copying `narrative-magnific-nano-banana` but with `image_style = "doodle_polished"` and `image_style = "doodle_rough"`. Operator picks the workflow at queue time to get the corresponding doodle output.

### Out of scope

- **Per-video style override.** The operator picks a workflow per video; the workflow's style applies. No per-video override field in v1. If operators report needing it, a small follow-up adds it.
- **More than the 3 initial styles.** Cinematic + doodle_polished + doodle_rough only. Adding a fourth style later (painted, anime, vintage photograph, etc.) is appending to the registry + seeding a new workflow — a small follow-up, not v1 work.
- **Other reveal effects** (mask wipe, fade-in, particle dissolve, sketch reveal). Only `pixel_dissolve` and `none` in v1. Other effects can be added to the same render-step infrastructure later.
- **Animated reveal-effect customization per workflow.** The reveal effect comes from the style; no per-workflow override of reveal duration or background color in v1.
- **Sketch-on / draw-on whiteboard animation.** Explicitly out of scope per the design conversation — it requires SVG vector assets with stroke-order metadata, which is not what AI image generation produces. If true whiteboard animation is needed, that's a separate tool (VideoScribe, Doodly), not a HistForge feature.
- **Style preview in the editor.** The workflow editor doesn't show a thumbnail of what the style produces. Operator finds out by queueing a test video.

## Architecture

```
Workflow row (DB)
  ├── existing fields
  └── image_style: string | null  (new — defaults to null = cinematic)
                        │
                        ▼
generate_visual_prompts step (step 09)
  ├── reads workflow.image_style (or 'cinematic' if null)
  ├── LLM writes the per-chunk SUBJECT (style-free, as today)
  ├── looks up IMAGE_STYLE_DEFINITIONS[style]
  └── assembler concatenates:
        <subject>. <style.prompt_prefix>.
        <style.style_lock ?? global style_lock_description>.
        Negative: <perShotNeg, style.negative_lock ?? global character_lock_negative>.
                        │
                        ▼
generate_images step (Magnific narrative provider)
  └── dispatches the styled prompts to Nano Banana 2 via the existing pipeline
                        │
                        ▼
render step
  ├── reads workflow.image_style (or 'cinematic' if null)
  ├── looks up IMAGE_STYLE_DEFINITIONS[style].reveal_effect + .background_color
  └── if reveal_effect === 'pixel_dissolve':
        ├── composite image over background_color canvas
        ├── apply xfade=transition=pixelize from white -> image
        ├── duration = image_duration * image_reveal_fraction
        └── continue Ken Burns motion as before after reveal completes
```

## Data model changes

### Workflows table

Add column:
```sql
ALTER TABLE workflows ADD COLUMN image_style TEXT DEFAULT NULL;
```

Migration is forward-compatible: existing rows get `NULL`, which resolves to `cinematic` at runtime. No data migration script needed.

### Settings table

Add row:
```
image_reveal_fraction = '0.35'
```

Via DEFAULT_SETTINGS + upgrade-path INSERT OR IGNORE block in `src/lib/db.ts`, same pattern as `auto_cleanup_after_render` from the structural-safety PR.

### Styles registry

New file `src/lib/image/styles.ts`:

```typescript
export const IMAGE_STYLE_NAMES = ["cinematic", "doodle_polished", "doodle_rough"] as const;
export type ImageStyleName = typeof IMAGE_STYLE_NAMES[number];

export const IMAGE_STYLE_LABELS: Record<ImageStyleName, string> = {
  cinematic: "Cinematic",
  doodle_polished: "Doodle — polished",
  doodle_rough: "Doodle — rough marker",
};

export interface ImageStyleDefinition {
  // Appended after the per-chunk SUBJECT by the step 09 assembler.
  // Contains ONLY style words — never subject words. The subject comes from the step's LLM.
  prompt_prefix: string;
  // Per-style locks REPLACE the global style_lock_description / character_lock_negative
  // for this style. If null, the assembler falls back to the global lock setting
  // (preserves current behavior for cinematic / unmigrated styles).
  style_lock: string | null;       // positive lock appended after prompt_prefix
  negative_lock: string | null;    // negative prompt for this style
  reveal_effect: "none" | "pixel_dissolve";
  background_color: string | null; // CSS color, null = no background composite (full-bleed)
  pacing_hint?: string;            // operator-facing note about recommended image durations
}

export const IMAGE_STYLE_DEFINITIONS: Record<ImageStyleName, ImageStyleDefinition> = {
  cinematic: {
    prompt_prefix: "",                 // cinematic uses the existing LLM subject + global lock unchanged
    style_lock: null,                  // null => fall back to global style_lock_description (current B&W lock)
    negative_lock: null,               // null => fall back to global character_lock_negative
    reveal_effect: "none",
    background_color: null,
    pacing_hint: "5-7 seconds per image works well",
  },

  // VALIDATED BY HAND in Magnific (Nano Banana 2) during the design session.
  // Came out clean/modern — confident linework, smooth flat color. Good for
  // friendly/positive content. This is the operator's working prompt verbatim.
  doodle_polished: {
    prompt_prefix:
      "whiteboard doodle cartoon illustration, " +
      "thick black felt-tip marker outline, " +
      "flat accent colors (green for money, red for warnings, yellow for highlights), " +
      "pure white background, single centered composition, " +
      "simple scribble shading, friendly hand-drawn style, vector-clean lines",
    // Color-allowing lock — REPLACES the global B&W lock for this style.
    style_lock:
      "consistent whiteboard-marker doodle style, flat 2D, pure white background, " +
      "functional color coding (green = money/good, red = warning/loss, yellow = highlight)",
    negative_lock:
      "photorealistic, 3D render, photograph, dark background, complex background, " +
      "realistic textures, dramatic lighting, gradient background",
    reveal_effect: "pixel_dissolve",
    background_color: "#FFFFFF",
    pacing_hint: "3-5 seconds per image works well",
  },

  // VALIDATED DIRECTION in Magnific. Pushes toward the reference channel's
  // authentic hand-drawn marker look (wobbly lines, directional scribble fill,
  // flat 2D, no render polish) via explicit anti-polish negatives. Good for
  // urgent/warning content. NB2 biases toward polish, so the negatives are
  // load-bearing here — without them the output drifts back to doodle_polished.
  doodle_rough: {
    prompt_prefix:
      "rough hand-drawn whiteboard marker doodle, " +
      "wobbly uneven black marker outlines with visible marker texture, " +
      "directional scribble fill shading with visible individual strokes, " +
      "flat 2D look, slightly messy imperfect linework like a real whiteboard drawing, " +
      "flat accent colors (green for money, red for warnings, yellow for highlights), " +
      "pure white background, single centered composition, friendly hand-drawn doodle style",
    style_lock:
      "authentic rough marker doodle, flat 2D, hand-drawn imperfection, pure white background, " +
      "functional color coding (green = money/good, red = warning/loss, yellow = highlight)",
    negative_lock:
      "smooth shading, gradient, drop shadow, 3D render, polished, clean vector lines, " +
      "professional illustration, soft lighting, depth of field, photorealistic, photograph",
    reveal_effect: "pixel_dissolve",
    background_color: "#FFFFFF",
    pacing_hint: "3-5 seconds per image works well",
  },
};
```

Both doodle prompts are the operator's hand-validated prompts, locked verbatim from the design session — NOT placeholders to iterate later. The polished variant produced clean output; the rough variant's anti-polish negatives push NB2 toward the reference channel's raw marker texture (NB2 defaults to over-polishing, so those negatives are required, not optional). The `cinematic` entry deliberately keeps `style_lock: null` / `negative_lock: null` so it falls back to the existing global locks and behaves identically to today.

## Schema changes

### NarrativeRowSchema

In `src/lib/workflows-schema.ts`:

```typescript
image_style: z.enum(IMAGE_STYLE_NAMES).nullable().default(null),
```

Imported from the styles registry, not hand-maintained. Same derive-from-registry pattern PR #13 established for `image_provider`.

### WorkflowPatchSchema

The editor's PATCH route automatically picks up the new field via its derive from `NarrativeRowSchema`. No separate update.

## UI changes

### Workflow editor

Add a new field in the editor:

```typescript
<SelectField
  label="Image style"
  field="image_style"
  options={IMAGE_STYLE_NAMES.map((name) => ({
    value: name,
    label: IMAGE_STYLE_LABELS[name],
  }))}
  description="Visual aesthetic for AI-generated images. 'Cinematic' is the default."
/>
```

Placement: in the same section as `image_provider`. Visible only when `image_provider !== "(none)"` (no point picking a style if no images are generated).

The dropdown options are derived from `IMAGE_STYLE_NAMES` — same anti-drift pattern as the `image_provider` fix from PR #13. Adding a new style to the registry automatically surfaces in the editor with no code change there.

### Settings page

Add `image_reveal_fraction` to the appropriate settings tab (likely "Render" or "Pipeline", matching where `auto_cleanup_after_render` landed in the structural-safety PR). Numeric input, range 0.1-0.8, default 0.35. Description: "Fraction of each image's screen time spent on the reveal effect. Only applies when the workflow's image style uses a reveal effect."

## Render-step implementation

> **SUPERSEDED 2026-05-31** — the pixel-dissolve / FFmpeg xfade reveal mechanism specified below was tested and rejected: "doesn't look like drawing." Replaced by the OpenCV contour-draw-on approach in [doodle-draw-on-render-requirements.md](./doodle-draw-on-render-requirements.md). The image-styles registry + per-style locks + seeded doodle workflows from Session 1 still stand; only this Session 2 render mechanism (and the related `image_reveal_fraction` setting + `reveal_effect: "pixel_dissolve"` registry value) is superseded.

### Pixel dissolve filter chain

For each image in the render sequence where the style declares `reveal_effect: "pixel_dissolve"`:

```
# Pseudo-pipeline per image, conceptually:
1. Create a solid-color background canvas of background_color, dimensions matching the output video
2. Generate the "fully-revealed" image segment (with Ken Burns motion as today)
3. Apply xfade=transition=pixelize transition:
   - From: the background canvas (white)
   - To: the image-with-motion clip
   - Duration: image_duration_sec * image_reveal_fraction
   - Offset: 0 (starts at the beginning of the image's screen time)
4. Continue the rest of the image's segment (without reveal — just Ken Burns)
```

The actual ffmpeg command uses `xfade` for the transition or `geq` for a custom pixel-randomization, depending on which produces cleaner output. Implementation will need to grep the existing render.ts for how segments are built and integrate the reveal as a pre-segment filter step.

Concrete plan-mode investigation needed:
- How does `render.ts` currently build per-image segments (xfade between images, concat, ffmpeg complex filter)?
- Can the reveal be added as a single new filter step in the existing chain, or does it require restructuring?
- What's the simplest FFmpeg approach that produces visually good pixel dissolve? (`xfade=transition=pixelize` is documented but the visual quality varies)

### Backwards compatibility

If `reveal_effect === "none"` (cinematic or any future no-reveal style), the render step skips the white-background composite AND the dissolve filter — runs the existing pipeline unchanged. Zero performance/quality impact on cinematic videos.

### Performance

Pixel dissolve adds ~1 FFmpeg filter per image. For a 25-min video with 200 images, that's 200 additional filter invocations. The xfade transition itself is GPU-accelerated via NVENC if the project's encoder is NVENC. Expected render-time overhead: <5%.

## Seeded workflows: two doodle variants

Add to `src/lib/db.ts`'s `SEED_WORKFLOWS`:

```typescript
{
  id: "narrative-magnific-nano-banana-doodle-polished",
  kind: "narrative",
  label: "Narrative — Magnific (NB2) Doodle Polished",
  short_label: "Magnific NB2 Doodle (polished)",
  description: "Colored whiteboard doodle, clean linework. White background, pixel-dissolve reveal. Friendly/positive mood.",
  script_llm_provider: "openrouter",
  tts_provider: "chatterbox-fast",
  image_provider: "magnific",
  image_style: "doodle_polished",  // NEW
  video_provider: null,
  chunker_step: "chunk_images_only",
  steps: [...same step list as narrative-magnific-nano-banana],
  enabled: 1,
},
{
  id: "narrative-magnific-nano-banana-doodle-rough",
  kind: "narrative",
  label: "Narrative — Magnific (NB2) Doodle Rough",
  short_label: "Magnific NB2 Doodle (rough)",
  description: "Colored whiteboard doodle, rough marker texture. White background, pixel-dissolve reveal. Urgent/warning mood.",
  script_llm_provider: "openrouter",
  tts_provider: "chatterbox-fast",
  image_provider: "magnific",
  image_style: "doodle_rough",  // NEW
  video_provider: null,
  chunker_step: "chunk_images_only",
  steps: [...same step list as narrative-magnific-nano-banana],
  enabled: 1,
},
```

Both copy the existing narrative-magnific-nano-banana workflow, differing only in `image_style`. Operator picks the polished or rough workflow at queue time; the original (no image_style) stays cinematic. All three doodle/cinematic workflows share the same chatterbox-fast TTS provider set earlier.

## Testing strategy

1. **`__tests__/unit/lib/image/styles.test.ts`** (new) — IMAGE_STYLE_NAMES is non-empty and contains cinematic + doodle_polished + doodle_rough; IMAGE_STYLE_DEFINITIONS has an entry for every name; both doodle variants declare pixel_dissolve + white background + non-null style_lock + non-null negative_lock; cinematic declares none + null background + null locks (global fallback); doodle_rough's negative_lock contains the anti-polish terms ("drop shadow", "3D render", "polished").

2. **`__tests__/unit/lib/settings.test.ts`** (extend) — `image_reveal_fraction` default 0.35, accepts 0.1-0.8 range, rejects garbage, round-trips.

3. **`__tests__/unit/lib/db.test.ts`** (extend) — seed includes both `narrative-magnific-nano-banana-doodle-polished` (image_style "doodle_polished") and `...-doodle-rough` (image_style "doodle_rough"); existing seeded workflows have `image_style: null` (backwards compat).

4. **`__tests__/unit/worker/steps/generate-visual-prompts.test.ts`** (new or extend) — when workflow.image_style === 'doodle_polished', the assembled prompt includes the polished prefix AND the per-style color-allowing lock (NOT the global B&W lock); when 'doodle_rough', includes the rough prefix + anti-polish negative_lock; when null or 'cinematic', falls back to the global locks (current behavior — pin this, it's the backwards-compat contract).

5. **`__tests__/unit/lib/render.test.ts`** (extend) — when style.reveal_effect === 'pixel_dissolve', render produces a clip with white-canvas overlay + dissolve filter applied; when 'none', no reveal filters; integration with existing Ken Burns motion still works (reveal completes, then Ken Burns runs normally).

6. **`__tests__/components/workflows/edit-form.test.tsx`** (extend) — image_style dropdown renders; selecting doodle saves the value; default is "cinematic" / "(none)".

7. **Manual smoke (post-implementation)** — operator generates a short narrative video (60s, ~10 images) using the doodle workflow. Validates: doodle-style images produced, pixel dissolve visible at the start of each image, white background visible during transitions, image fully visible for ~65% of its display time, final video plays cleanly.

8. **Backwards-compat regression** — running an existing cinematic workflow produces bit-identical output to the pre-change pipeline (if practical to test with hash comparison) OR visually indistinguishable output.

## File-level deliverables

**Create:**
- `src/lib/image/styles.ts` — registry of style names, labels, definitions
- `src/app/api/workflows/[id]/edit-form-styles.tsx` — possibly extracted style-dropdown sub-component (if patterns warrant)

**Modify:**
- `src/lib/db.ts` — workflows table `image_style` column migration, settings DEFAULT_SETTINGS, upgrade-path INSERT OR IGNORE, two seeded doodle workflows
- `src/lib/settings.ts` — `image_reveal_fraction` schema
- `src/lib/settings-tabs.ts` — `image_reveal_fraction` placement
- `src/lib/workflows-schema.ts` — `image_style` enum field on NarrativeRowSchema (derived from IMAGE_STYLE_NAMES)
- `src/app/workflows/[id]/edit/edit-form.tsx` — image_style dropdown (derived from registry)
- `src/app/settings/render-tab.tsx` (or wherever the setting belongs) — `image_reveal_fraction` field
- `src/worker/steps/09-generate-visual-prompts.ts` — read workflow.image_style; assembler appends `style.prompt_prefix` + `style.style_lock ?? globalStyleLock` + `style.negative_lock ?? globalNegativeLock`; wire the metaphor skill (separate doc `doodle-visual-metaphor-skill.md`) into the step's LLM system prompt CONDITIONALLY when image_style is a doodle variant
- `src/lib/render.ts` — pixel dissolve filter integration, white background composite
- Tests for all of the above

**Estimated:** ~12 production files modified + 6-7 test files. Single PR off master post-structural-safety merge.

## Rollout / risk

- **Backwards compatibility:** existing workflows without `image_style` default to `null` which resolves to `cinematic`. Existing cinematic videos produce identical output. Zero risk to existing pipelines.
- **Prompt validation:** RESOLVED. Both doodle prompts were hand-validated in Magnific during the design session against a reference channel frame; output matched the target genre (polished variant clean, rough variant pushed toward authentic marker texture via anti-polish negatives). The prompts in the registry are locked verbatim, not placeholders. Remaining risk is only that the per-style LOCK strings (newly written, not individually image-tested) interact unexpectedly with the locked prefixes — mitigated by the Session 1 manual smoke, which generates real images through the full assembler and compares to the standalone validated output.
- **Per-style lock fallback risk:** the assembler must correctly choose per-style lock when present and fall back to the global lock when null. If the fallback is wrong, cinematic could lose its B&W lock (regression) or doodle could inherit the global B&W lock (color washout — the exact bug this refactor fixes). **Mitigation:** the generate-visual-prompts test pins all three cases (doodle_polished uses its own lock, doodle_rough uses its own lock, cinematic/null falls back to global). This is the load-bearing contract test.
- **Pixel dissolve visual quality risk:** `xfade=transition=pixelize` is the standard FFmpeg approach but its output varies. **Mitigation:** during implementation, render a single test image with the effect and visually evaluate before integrating. If pixelize looks bad, try `dissolve` or `fadewhite`. Pick what looks good, not what was first.
- **Performance risk:** pixel dissolve adds filter overhead per image. Expected <5% render-time impact, but should be benchmarked. **Mitigation:** time a doodle render vs cinematic render of the same script.
- **Render-step complexity:** the render code is already non-trivial (Ken Burns + crossfade between images). Adding reveal effect on top requires care to not break existing logic. **Mitigation:** the precheck and existing tests from PR structural-safety act as regression guards; the cinematic path stays unchanged.
- **PR shape:** all commits prefixed `image-styles:` (or similar). Two sessions feels right based on scope. Single PR.

## Implementation method

Session boundaries (operator confirms in implementation plan-mode pass):

- **Session 1: Styles registry + per-style locks + workflow integration + metaphor skill.** 
  - Create `src/lib/image/styles.ts` with the registry, the two locked doodle prompts, and per-style lock fields.
  - Add `image_style` column to workflows table (DB migration).
  - Add `image_style` enum to NarrativeRowSchema, derived from registry.
  - Add `image_style` dropdown to workflow editor, derived from registry.
  - Refactor step 09 assembler: append `style.prompt_prefix`, then `style.style_lock ?? global`, then `style.negative_lock ?? global`. Pin the fallback contract in tests.
  - Wire the metaphor skill (`doodle-visual-metaphor-skill.md`) into step 09's LLM system prompt conditionally when image_style is a doodle variant — this is what makes the LLM choose visual metaphors (winged money, two clipboards) instead of literal subjects.
  - Seed both doodle workflows (polished + rough).
  - All tests for the above.
  - **Manual smoke at session end:** queue a video on each doodle workflow, observe that (a) the assembled prompts contain the correct per-style prefix + color-allowing lock (NOT the global B&W lock), (b) step 09's subjects are metaphorical not literal, (c) Magnific generates images matching the hand-validated standalone output. Image quality + color survival is the gate to proceed.

- **Session 2: Render effect + reveal duration setting.**
  - Add `image_reveal_fraction` setting (DEFAULT_SETTINGS + Zod + tab field).
  - Wire render step to read workflow.image_style + setting and apply pixel dissolve.
  - White-background composite for styles with non-null `background_color`.
  - Integration with existing Ken Burns motion (reveal completes, motion continues).
  - All tests for the above.
  - **Manual smoke at session end:** render a video on a doodle workflow, watch the output. Validates: white background visible during reveal, pixel dissolve plays for ~35% of each image's time, image fully visible for the rest, Ken Burns motion plays normally after reveal.

After both sessions: one PR opened against master, you review, merge.

## Carry-forwards (deliberately NOT in this PR)

- **More image styles** (painted, anime, vintage photograph, etc.) — easy follow-up via registry append + seeded workflow.
- **More reveal effects** (mask wipe, fade-in, particle dissolve) — easy follow-up via registry extension; render step can support multiple `reveal_effect` values.
- **Per-video style override** — easy follow-up if operators need it. Add a nullable field to the video row that takes precedence over the workflow's style.
- **Style preview in editor** — UI polish; not load-bearing.
- **Adobe After Effects integration / sketch-on effect** — explicitly out of scope. If true whiteboard animation is required, switch tools (VideoScribe), not HistForge.

## Open questions to settle in Session 1 plan-mode

1. **The current cinematic prompt template** — where exactly does it live in `generate_visual_prompts`? Is it a string literal in the step file, or a setting, or in a prompts/ subfolder? The exact location determines how the registry refactor lands.
2. **The render step's filter complexity** — what does the current FFmpeg command look like for a multi-image segment? Knowing this in plan-mode prevents surprises when adding the reveal.
3. **The `image_style` column placement in the workflows table schema** — schema.ts/migration ordering matters for SQL compatibility. Confirm via grep.
4. **The current global lock wording** — confirm the exact current `style_lock_description` and `character_lock_negative` default strings in `src/lib/db.ts` so the cinematic fallback and the per-style lock replacement are wired against the real values. (Doodle prompt iteration is already DONE — both prompts hand-validated and locked in the registry above; no further prompt iteration needed before Session 1.)
5. **The metaphor skill injection point** — where in step 09 does the LLM system prompt get built (`09-generate-visual-prompts.ts:90-94` per earlier investigation)? Confirm how to conditionally inject the metaphor skill only for doodle styles without disturbing the cinematic path.

## Dependency on structural-safety PR

This work waits on the structural-safety PR (Sessions 1+2 done at b3da9d7, Session 3 pending) to merge. Reasons:

1. Render step changes here would conflict with the render-precheck changes there.
2. Settings layer additions are cleaner once the cleanup-setting from structural-safety has landed (consistent settings-add pattern across both PRs).
3. Workflow editor changes here would conflict with the image_provider dropdown derive-from-schema work from PR #13.

Sequence:

1. Structural-safety Session 3 lands → push, PR, merge.
2. Short cinematic test video to validate baseline (uses existing workflow).
3. Test the metaphor skill in isolation (feed the skill + ~10 sample narration sentences to the LLM, confirm it produces metaphorical subjects matching the hand-validated quality). No code. (Doodle prompts already validated — this step validates the SUBJECT-selection skill, the remaining unproven piece.)
4. Image styles PR Session 1.
5. Image styles PR Session 2.
6. One real video on each doodle workflow to validate end-to-end.
7. Doodle PR merges.
