---
status: accepted
date: 2026-05-20
---

# Video kind discriminator on `videos` and `workflows` rather than additive-only or full-separation

## Context

HistForge ships a narrative pipeline today: a one-line topic → script → narration → alignment → chunks → per-chunk visuals → multi-stage xfade render → ~90 min historical YouTube video. The workflow registry (`workflows` table + `workflow_snapshot` JSON pinned per video) lets four shipped workflows differ along orthogonal axes — `script_llm_provider`, `tts_provider`, `image_provider`, `video_provider`, `chunker_step` — without forking step code. `materializeStepList` interleaves the workflow's authored script steps with `voiceover`, `align`, the chunker, `generate_visual_prompts`, then `generate_images` / `generate_clips`, then `render`, `cleanup`.

A new product is being added: a music video. Magnific Seedream image (HITL — operator picks a variation in Chrome), Magnific Seedance image-to-video loop clip, thumbnail derived from the same image, N Suno songs concatenated and repeated M times, looped under the clip. Structurally there is no script, no narration, no alignment, no chunks, no per-chunk visuals, no multi-stage xfade render. The narrative pipeline's entire backbone past `assemble_script` does not apply.

The decision is how to make a workflow row produce this fundamentally different step backbone. Three options were weighed in the design conversation:

1. **Additive-only** — one new workflow row (`music-video-magnific-suno`) in the existing registry, no schema discriminator. The materializer absorbs the divergence by reading null providers: when `tts_provider`, `chunker_step`, and the visual-prompt path are all null, skip the entire script→align→chunker→visual-prompts→assets backbone and emit a music-video backbone instead. Cheapest schema migration but the materializer becomes a null-pyramid and the Add modal needs per-row conditional fields with nothing in the registry naming the divergence.

2. **Full separation** — new `music_videos` table, `/music-videos` page, `/music-workflows` page, parallel worker queue or shared worker reading both tables. Duplicates the entire lifecycle module that ADR-0007 carved out as shared (`new → queued → in_progress → done | failed`, `paused`, `deferred_until`, `delete_requested`, FIFO picker, per-step harness, retry/restart/delete), duplicates the AI-skill workflow-drafts pipeline, and asks operators to monitor two queues.

3. **Discriminator** — add `kind TEXT NOT NULL DEFAULT 'narrative'` to both `videos` and `workflows`, values `narrative` | `music_video`. The materializer switches on `snapshot.kind` to emit a different backbone per kind. Mirrors ambientforge's proven `channel.workflow` + `album.workflow` discriminator pattern that already scaled to three workflow types without forking the pipeline orchestrator.

The pipeline backbones diverge at the BACKBONE level — not at a step-list-permutation level — which is what makes Option 1 awkward (the materializer's null-checks would carry the load of an unnamed kind axis) and what makes Option 2 tempting (clean per-domain modelling). The lifecycle layer, the worker queue, the per-step harness, the artifact tree convention, the retry/restart/delete flows, and the AI-skill drafts pipeline are all kind-agnostic — which is what makes Option 3 cheap.

## Decision

1. **`videos.kind TEXT NOT NULL DEFAULT 'narrative'`** and **`workflows.kind TEXT NOT NULL DEFAULT 'narrative'`**, values `narrative` | `music_video`. The kind is pinned on each `videos` row at creation and mirrors onto `workflow_snapshot.kind` via the workflow registry at `transitionNewToQueued`. Adding a third kind later is a new enum value + a new branch in the materializer.

2. **The materializer (`src/lib/workflows.ts:materializeStepList`) switches on `snapshot.kind`.** `narrative` keeps the existing logic verbatim (no behavioural change for shipped workflows). `music_video` emits the new backbone: `generate-loop-image`, `generate-loop-clip`, `make-thumbnail`, `generate-music`, `download-music`, `render-music-video` (no cleanup in v1). The kind switch is the only place that branches on `kind`; orchestrator, runner, lifecycle modules, dashboard list polling, retry/restart/delete, and the AI-skill drafts pipeline stay kind-agnostic.

3. **Two existing `workflows` columns become nullable** to support the music-video kind cleanly: `script_llm_provider TEXT NULL` (no script chain) and `chunker_step TEXT NULL` (no chunking). The existing `validateChunkerStepConsistency` advisory in `src/lib/workflows-validator.ts` becomes kind-aware: chunker-consistency rules only apply when `kind='narrative'`; for `kind='music_video'` the validator asserts both columns are NULL and the music-specific provider columns are populated.

4. **Four new typed columns on `videos`** for music-video per-topic inputs: `magnific_image_prompt TEXT NULL`, `suno_style_prompt TEXT NULL`, `song_count INTEGER NULL` ∈ `[1..30]`, `repeat_factor INTEGER NULL` ∈ `[1..10]`. Nullable for narrative-kind rows. JSON-blob and side-table alternatives were rejected on introspection / migration grounds; the existing `videos.provided_script TEXT NULL` precedent makes nullable typed columns the established pattern.

5. **Two new `workflows` columns** name the new provider axes: `music_provider TEXT NULL` (today only `suno`) and `upscaler_provider TEXT NULL` (deferred to v2 — column shipped now, no v1 step consumes it). Existing `image_provider` / `video_provider` enums extend to include `magnific` (in addition to `comfyui` / `google_flow`).

6. **The `/videos` dashboard gets page-level tabs** (Narrative | Music videos). Each tab owns its own Topics / Queue / Finished sections, kind-relevant banners, and kind-specific Add modals (Add Topic + Add Ready Script on the Narrative tab; Add Music Video on the Music videos tab). The underlying worker queue is unified — one FIFO by `created_at` across both kinds.

## Considered options (rejected)

**Additive-only — one workflow row, no `kind` axis.** Rejected because the music-video pipeline diverges from narrative at the *backbone* level (no script chain, no align, no chunker, no visual prompts), not at the step-permutation level the existing materializer was designed for. Modelling it as "a narrative workflow with everything null" would push a six-way null-check pyramid into the materializer and force the Add modal to render per-row conditional fields based on the workflow row's provider-null pattern. The Zod schema and `workflows-validator.ts` would have to encode the music-video shape implicitly via null combinations rather than naming it. Future readers grep'ing for "music_video" would find nothing.

**Full separation — `music_videos` table + `/music-videos` page + parallel worker queue.** Rejected because the lifecycle module (ADR-0007), the FIFO queue picker, the per-step harness (ADR-0009), the delete-requested / pause / defer machinery, the retry/restart flows, the dashboard polling, and the AI-skill drafts pipeline (§19a) are all kind-agnostic — they operate on "a unit of work with a status and a step list," which both kinds are. Duplicating those for `music_videos` would re-pay infrastructure costs HistForge already absorbed once. Operators would also need to monitor two queues (the worker still runs one item globally; mental model split between two pages is a real cost).

**JSON-blob column on `videos`** (e.g., `kind_params TEXT NOT NULL`) instead of four nullable typed columns. Rejected on three grounds: loses Zod-at-the-DB-edge type safety (per-column Zod parsing is more discoverable than blob-field Zod parsing), harder to introspect via `sqlite3` shell during operator debugging, and harder to migrate a field out later if the blob model proves wrong. The `videos.provided_script TEXT NULL` precedent already establishes nullable typed columns as the pattern for kind-variant fields.

**Side table** (`music_video_params` with FK to `videos`). Rejected as over-engineering for v1 when only one extra kind exists. The join cost is small but the repo + migration ceremony is real. Revisit if a third or fourth kind appears with a denser per-kind column surface.

## Consequences

- **The materializer is the only kind-switching site in the worker process.** `src/lib/workflows.ts:materializeStepList` gains a `switch (snapshot.kind)` block; everything downstream of materialization stays kind-agnostic. `src/lib/workflows-validator.ts:validateChunkerStepConsistency` gains a kind-aware branch.
- **`workflow_snapshot` JSON gains three new keys**: `kind`, `music_provider`, `upscaler_provider`. The snapshot shape is the authoritative runtime contract for the orchestrator; `workflow_snapshot.kind` re-pinning at `transitionNewToQueued` follows the same pattern as `visual_style_snapshot` (ADR-0010).
- **The Add modal split is by kind, not by workflow.** "Add Topic" and "Add Ready Script" stay narrative-kind-only (they live on the Narrative tab); "Add Music Video" is the music-video-kind entry point (lives on the Music videos tab). Each modal's workflow dropdown is filtered to `workflows.kind` matching the modal's kind, plus `workflows.enabled=1`.
- **The artifact tree under `projects/<video_id>/` diverges per kind.** Narrative-kind keeps `script/`, `audio/`, `alignment/`, `chunks/`, `images/`, `videos/clip/`. Music-video-kind has `loop_image.png`, `loop_clip.mp4`, `thumbnail.jpg`, `songs/song_NN.wav`. The orchestrator does not need to know — each step writes its own outputs and the artifact tree happens to look different per kind.
- **CONTEXT.md gains "Video kinds" and "Music video language" sections.** The existing narrative-only terms (script, narration, chunk, audio span, narrative-kind clip, narrative-kind render) are flagged as narrative-only; the music-video terms (loop image, loop clip, song, song count N, repeat factor M, music video render) are defined separately to avoid cross-kind collision.
- **The spec (`docs/histforge-spec.md`) gains a music-video kind section** documenting the new backbone, schema columns, new queue tables (`magnific_queue`, `suno_queue` — defined in ADR-0012), webhook routes (`/api/magnific/*`, `/api/suno/*`), and the kind-aware materializer. Spec update is non-trivial but additive — no existing section is rewritten.
- **AI-skill workflow drafts (§19a) work for both kinds.** The drafts JSON schema gains `kind`, `music_provider`, `upscaler_provider` keys; `WorkflowImportSchema` validates the kind-specific provider constraints (kind=narrative requires chunker_step + at least one of tts_provider/image_provider/video_provider; kind=music_video requires music_provider + image_provider=magnific + video_provider=magnific and forbids tts_provider / chunker_step). Round-trip parity (`/api/workflows/[id]/export` ↔ import) holds across kinds.
- **Adding a third kind later (podcast, shorts, etc.) is one materializer branch + new step files + UI surface (a new tab).** The schema columns may need new nullable kind-specific columns on `videos` for that kind's per-topic inputs; nothing about the existing two kinds is touched. The discriminator is open-ended by design.
- **Default kind is `narrative`** on both `videos` and `workflows` so existing rows on the migrated DB keep their semantics; the four shipped workflows seed at `kind='narrative'`.
- **One built-in music-video workflow ships in v1**: `music-video-magnific-suno` with `kind='music_video'`, `image_provider='magnific'`, `video_provider='magnific'`, `music_provider='suno'`, `upscaler_provider=NULL`, `script_llm_provider=NULL`, `tts_provider=NULL`, `chunker_step=NULL`. Operators can clone it via the existing `/workflows` UI to make variants once more providers exist.
