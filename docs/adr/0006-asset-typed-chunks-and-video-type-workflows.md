---
status: accepted
date: 2026-05-16
---

# Three video-type variants as separate workflows; chunks discriminate asset type

## Context

HistForge today produces one shape of video: a hook section (clips, ~8s each, opening) followed by a main section (zoom-panned still images). Two more shapes are wanted: image-only (just stitched zoom-panned images + narration) and clip-only (just stitched clips + narration).

The current `chunk.kind: "hook" | "main"` field doubles as both an asset-type discriminator (hook → clip file in `videos/hook/`; main → image file in `images/main/`) and a section-position label (hook section = the opening; main section = the body). For the current video type those coincide; for the two new types they split.

`materializeStepList(snapshot): string[]` ([`src/lib/workflows.ts`](../../src/lib/workflows.ts)) orders pipeline steps using three optional gates on the `tts_provider`/`image_provider`/`video_provider` columns. Today's chunker (`08-chunk.ts`) is welded to producing the hook-then-main topology by both the `hookChunkCount` cap and two different per-chunk target durations (`clipSeconds` vs. 30s for mains). It cannot produce the two new topologies by toggling providers alone — the chunker itself has to choose a different sentence-partition strategy.

Descriptive research of the current `materializeStepList` and its consumers is in [`docs/research/2026-05-16-materialize-step-list.md`](../research/2026-05-16-materialize-step-list.md). The proposal that triggered this design conversation is suggestion #2 of [`docs/refactoring/depth-audit-2026-05-12.md`](../refactoring/depth-audit-2026-05-12.md); that suggestion is refined out by this ADR — see "Considered options" below.

## Decision

1. **Three workflows in the registry, three chunker variants.** Each of the three video types is a registered workflow with its own chunker. The chunker variant is declared explicitly via a new `chunker_step` column on the `workflows` table (mirrored on `WorkflowSnapshot`). `materializeStepList` reads `snapshot.chunker_step` in place of the literal `"chunk"`. Chunker slugs:
   - `chunk_clips_then_images` — current video type: clip-shaped prefix + image-shaped body.
   - `chunk_images_only` — narration partitioned entirely into image-paired chunks.
   - `chunk_clips_only` — narration partitioned entirely into clip-paired chunks.

2. **Rename `chunk.kind` to asset-type vocabulary.** `"hook" | "main"` → `"clip" | "image"`. The field becomes a pure asset-type discriminator at the data level. "Hook section" / "main section" survive only as workflow-1 glossary vocabulary describing the rendered output's structural pattern when both kinds are present.

3. **Full rename propagation.** chunks.json values; code variables (`hookChunks` → `clipChunks`, `mainChunks` → `imageChunks`); step slugs (`generate_main_images` → `generate_images`, `generate_hook_video` → `generate_clips`); render intermediates (`hook_final.mp4` → `clip_final.mp4`, `hook_concat.mp4` → `clip_concat.mp4`, etc.); on-disk asset directories (`videos/hook/` → `videos/clip/`, `images/main/` → `images/`). The boot validator's Phase-5-analogue check extends to flag legacy slugs and directory layouts on in-flight videos.

4. **No typed `WorkflowPlan` abstraction.** `materializeStepList` keeps `string[]` as its return type. Suggestion #2 proposed promoting it to a named-segment `WorkflowPlan` value, but the leverage that motivated the proposal (UI plan-preview, segment-presence queries, validator structure-recovery) is either trivial against the existing `WorkflowSnapshot` (`snapshot.tts_provider !== null` answers "is voiceover in this plan?") or doesn't exist in current consumers (the input-availability validator walks the flat `string[]`; it never reads provider columns). Extend the existing function; don't introduce a typed wrapper without a real consumer that needs it.

5. **Validation rule on `chunker_step`.** Must be consistent with `(image_provider, video_provider)`:
   - `chunk_clips_then_images` ⇒ image and video providers both non-null.
   - `chunk_images_only` ⇒ image provider non-null, video provider null.
   - `chunk_clips_only` ⇒ image provider null, video provider non-null.

   Enforced in `validateInputAvailability` (or a sibling) and at boot.

## Considered options (rejected)

**One parametric workflow with a `video_topology` column.** Rejected because the chunker's variation isn't "skip a step" — it's "partition the script differently." A topology toggle hides three structurally distinct chunkers behind one slug, and the workflow registry stops being the answer to "which steps does this video run?". The chunker variants produce different `chunks.json` topologies, not different transports.

**Single `chunk` slug with internal dispatch on `(image_provider, video_provider)`.** Mirrors Phase 5's image-provider unification pattern. Rejected because Phase 5's lesson is specifically about *transport* variation (same step semantics, different provider implementation). Chunker variants are *structural* variation — different sentence-walk loops producing different `chunks.json` shapes. Branching three structurally distinct strategies inside one step file hides a workflow-registry concern (which chunker?) in a step-internal switch.

**Typed `WorkflowPlan` with named segments (depth-audit suggestion #2 as proposed).** Rejected for the reasons in decision 4 above.

**Stretching the glossary: keep `kind = "hook" | "main"` and redefine "hook section" to include the whole-video case for type 3.** Rejected as awkward — readers would see "hook section = the opening" in the glossary and have to mentally apply a workflow-specific override for types 2 and 3.

## Consequences

- `materializeStepList`'s return signature is stable (`string[]`); only its body grows the chunker-slug read.
- The workflow editor needs to surface the `chunker_step` choice and enforce the consistency rule with the provider columns.
- The Phase-5-analogue boot validator extends to flag legacy slug names (`generate_main_images`, `generate_hook_video`, the unqualified `chunk`) and legacy directory layouts on in-flight videos.
- CONTEXT.md gains updates to the **Chunk**, **Hook chunk / Main chunk** (renamed to **Clip chunk / Image chunk**), **Clip**, **Image**, **Hook section**, **Main section**, **Throwaway intermediate**, and **Relationships** sections. Hook/main vocabulary is documented as workflow-1-only.
- The AI-skill workflow-drafts JSON contract may need a `chunker_step` field; coordinate with the `domain-workflow-drafts` skill during implementation.
- **Out of scope of this ADR:** tuning the new chunker variants' per-chunk target durations (clip-only chunker may want its own setting separate from `clipSeconds`); UI for selecting between the three workflow types when creating a video; telemetry for which video type is most common.
