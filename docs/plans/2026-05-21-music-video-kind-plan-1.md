# Plan 1 — Music-video kind foundations

## Overview

Add a `kind` ∈ `{narrative, music_video}` discriminator to `videos` + `workflows`, branch the materializer on it, seed one builtin music-video workflow, add stub step files, and surface page-level tabs (Narrative | Music videos) on `/videos` with an Add Music Video modal. After this plan lands, a music-video row created via the dashboard walks the six-step backbone end-to-end with marker-artifact outputs (1×1 PNG, 1-second black MP4, silent WAVs, placeholder `final.mp4`). No Magnific or Suno code is touched — that's Plans 2 and 3.

The contracts this plan implements are pinned in [`docs/adr/0011-video-kind-discriminator.md`](../adr/0011-video-kind-discriminator.md) (schema + materializer kind-switch) and [`docs/adr/0012-hitl-via-extension-no-timeout.md`](../adr/0012-hitl-via-extension-no-timeout.md) (HITL via per-task flag — not yet exercised in this plan but the schema needs to coexist with it). The build-order rationale (stubs before real providers) follows the §22 spec pattern: verify queue + resume + failure paths with stubs before any third-party integration.

## Current State

**Schema and DB** (`src/lib/db.ts`):
- `workflows` CREATE TABLE — `src/lib/db.ts:256-271`. Columns: `id, label, short_label, description, script_llm_provider, tts_provider, image_provider, video_provider, is_builtin, enabled, version, created_at, updated_at, chunker_step`.
- `videos` CREATE TABLE — `src/lib/db.ts:280-299`. Existing kind-variant columns (`paused`, `deferred_until`, `provided_script`, `visual_style_id`, `visual_style_snapshot`, `workflow_snapshot`) ship via additive ALTER blocks, not the CREATE TABLE — that's the pattern to mirror.
- Idempotent migration pattern (try/catch on `ALTER TABLE`, swallow `duplicate column name`, rethrow anything else) — `src/lib/db.ts:387-396` (`paused`), `:401-408` (`deferred_until`), `:424-438` (`workflow_snapshot`), `:444-451` (`provided_script`), `:458-473` (`visual_style_id` + `visual_style_snapshot`).
- `SeedWorkflow` type — `src/lib/db.ts:88-102`. `BUILTIN_WORKFLOWS` array (4 narrative entries) — `:104-173`. `seedDefaultWorkflows` INSERT OR IGNORE — `:189-223`.

**Types** (`src/types.ts`):
- `Video` interface — `:15-34` (note: `workflow_snapshot` is absent — TEXT columns read back as strings are not mirrored on the interface).
- `WorkflowRow` — `:155-170`.
- `WorkflowSnapshot` JSON shape — `:190-199`.
- `ChunkKind = "clip" | "image"` at `:235` — precedent for a narrow union literal type.

**Repos**:
- `createNewVideo` — `src/lib/repos/videos.ts:63-93`. Takes `{ id, title, topic_info, workflow_id, provided_script?, visual_style_id?, created_at }`, calls `computeSnapshot` + `computeVisualStyleSnapshot` in the same transaction. INSERT column list at `:80`.
- `updateVideoDraft` field union — `src/lib/repos/videos.ts:116-168`.
- `findById` — `src/lib/repos/workflows.ts:27-35`. `list` — `:37-41`. `findStepsByWorkflow` — `:43-52`. INSERT statement column list — `:61-85`. `UpdatableField` allowlist — `:117-138`.

**Materializer and validator**:
- `resolveSnapshot` — `src/lib/workflows.ts:47-66`. Assembles the JSON from the workflow row + step rows. This is the function that needs to start emitting `kind` into the snapshot.
- `computeSnapshot` (stringifies `resolveSnapshot`) — `:73-78`.
- `materializeStepList` — `:100-121`. Currently iterates `snapshot.steps`, appends `assemble_script`, conditionally `voiceover`, `align`, `snapshot.chunker_step`, `generate_visual_prompts`, conditionally `generate_images`/`generate_clips`, `render`, `cleanup`. This is the single kind-switch site.
- `validateChunkerStepConsistency` — `src/lib/workflows-validator.ts:117-158`. Pattern (switch on a column value, need/forbid helpers) to mirror for `validateKindConsistency`.
- `validateInputAvailability` — `src/lib/workflows-validator.ts:68-101`. Walks the materialized step list against the step registry; will need to tolerate the new kind's step list.
- `WorkflowRowSchema` Zod — `src/lib/workflows-schema.ts:22-50`. `WorkflowImportSchema = WorkflowRowSchema` alias at `:72`.
- `GET /api/workflows/schema` — `src/app/api/workflows/schema/route.ts:18-38`. Projects `REAL_STEPS` + provider names; the AI-skill drafts importer relies on the response shape.
- `bootValidate` — `src/worker/boot.ts:42-68` (first loop: workflows) and `:85-100` (second loop: in-flight videos via snapshot).

**Worker steps**:
- `REAL_STEPS` registry — `src/worker/steps/index.ts:26-41`. `STEP_OUTPUTS` derived map at `:48-49` — auto-updates when new steps register.
- `Step` interface shape — `src/worker/steps/01-research-outline.ts:38-44`. Object with `{ name, module, label, description, inputs, outputs, async run(videoId, ctx) }`. The `run` receives `(videoId, ctx)`; ctx exposes `db`, `projectsDir`, `chat`, etc.

**Dashboard**:
- `VideosClientProps` — `src/app/videos/videos-client.tsx:46-58`. `workflows`, `visualStyles`, `initialBannerFlags`.
- `modal` state union — `:109-115`. Discriminated union over modal modes (`add`, `edit`, `addReadyScript`, `editReadyScript`). The discriminator pattern is the place to extend with `addMusicVideo`.
- Topics / Queue / Finished section structure — `:247-325` / `:327-387` / `:389-400`. Modal dispatch (renders `AddVideoModal` for two of the four modes) — `:402-423`.
- `getVideosPageState` returns `videos: VideoListItem[]` for all kinds — `src/lib/videos-page-state.ts:50-71`. The client splits by kind; no fetch-layer change needed.
- `AddVideoModal` shape: `AddVideoModalProps`/`FormState` — `src/app/videos/add-video-modal.tsx:27-40`; `canSubmit` guard + `onSubmit` POST/PATCH — `:63-113`; Dialog → form layout — `:115-197`.
- `CreateVideoSchema` Zod — `src/app/api/videos/route.ts:25-31`. Workflow existence + enabled check — `:42-52`. `createNewVideo` call site — `:77-85`.
- `PatchVideoSchema` Zod — `src/app/api/videos/[id]/route.ts:49-65`. PATCH handler — `:67-130`.

**Other relevant constraints**:
- `tsc-alias` resolves `@/` → `src/` in both the Next.js build and the worker post-compile (CLAUDE.md).
- Settings are stored as strings; defaults live in `lib/db.ts` (CLAUDE.md).
- No new settings keys land in Plan 1 — provider tokens / dispatch timeouts arrive in Plans 2/3.

## Scope

**Doing**:
- Add `kind` column + four music-video-only columns to `videos`, add `kind` + `music_provider` + `upscaler_provider` to `workflows`, relax `script_llm_provider` and `chunker_step` to nullable.
- Seed the `music-video-magnific-suno` builtin workflow row.
- Extend the snapshot shape with `kind`, `music_provider`, `upscaler_provider`; teach the materializer to switch on `kind`; teach the workflow validators + Zod schema to enforce the kind-specific provider triple.
- Add six stub step files (one for each music-video step) that write marker artifacts, register them in `REAL_STEPS`.
- Add page-level Narrative | Music videos tabs to `/videos`, an Add Music Video modal, and the API-route changes to accept/validate the new kind on `POST /api/videos` and `PATCH /api/videos/[id]`.
- Audit existing test fixtures for implicit `kind='narrative'` assumptions (handoff Open question #7).

**Not doing**:
- Magnific / Suno extension code, queue tables (`magnific_queue`, `suno_queue`), webhook routes, reaper changes (Plans 2 + 3).
- Real implementations of any of the six music-video steps — all six ship as stubs.
- Adding `magnific` to `IMAGE_PROVIDER_NAMES` / `VIDEO_PROVIDER_NAMES` (Plan 2 — no v1 step uses it until then).
- Settings tabs / token UI for Magnific or Suno (Plans 2 + 3).
- AI-skill workflow drafts UX changes (the JSON contract becomes kind-aware in Phase 1.2 so existing drafts round-trip cleanly; no dedicated UX work for authoring music-video drafts).
- Touching any narrative-kind step file, `lib/render.ts`, Flow code, ComfyUI code, TTS code, aeneas/alignment/chunker code, visual-styles gallery code (handoff "Files NOT to touch").
- Cleanup step for music-video kind (deferred to v2 — intermediates preserved).

## Tasks

### Phase 1.1 — Schema migration + builtin workflow seed

**Vertical end**: `npm run db:init` on a populated narrative DB succeeds; all narrative rows behave identically; one `workflows` row with `kind='music_video'` exists.

- [x] **Task 1: Add `kind` + music-video columns to `videos`**
  **Files**: `src/lib/db.ts`
  **What**: Append `kind` (`TEXT NOT NULL DEFAULT 'narrative'`), `magnific_image_prompt` (`TEXT NULL`), `suno_style_prompt` (`TEXT NULL`), `song_count` (`INTEGER NULL`), `repeat_factor` (`INTEGER NULL`) to the `videos` CREATE TABLE block AND ship them as idempotent `ALTER TABLE` blocks so existing DBs migrate cleanly. Per-row validation of the music-video tuple lives at the repo / API layer, not in SQL.
  **Context**: Mirror the pattern at `src/lib/db.ts:444-451` (`provided_script` ALTER block) — try/catch swallowing `duplicate column name`, rethrowing anything else. Default `kind='narrative'` is load-bearing for existing rows per ADR-0011 §Consequences.

- [x] **Task 2: Add `kind`, `music_provider`, `upscaler_provider` to `workflows`; relax two existing columns to nullable**
  **Files**: `src/lib/db.ts`
  **What**: Append the three new columns to the `workflows` CREATE TABLE (`:256-271`) with their idempotent ALTER companions. Relax `script_llm_provider` and `chunker_step` to nullable — SQLite doesn't support `ALTER COLUMN`, so this is documented as "the new CREATE TABLE has the relaxed shape; pre-existing rows already populated non-null so the relaxation is forward-only." No data migration of existing rows.
  **Context**: ADR-0011 §Decision 3 calls out this relaxation. The advisory validator (`workflows-validator.ts:117-158`) is the runtime enforcer — schema-level nullability is just removing the false NOT NULL.

- [x] **Task 3: Seed the `music-video-magnific-suno` builtin workflow**
  **Files**: `src/lib/db.ts`
  **What**: Append one new `SeedWorkflow` entry to `BUILTIN_WORKFLOWS`. Shape: `kind='music_video'`, `image_provider='magnific'`, `video_provider='magnific'`, `music_provider='suno'`, `upscaler_provider=null`, `script_llm_provider=null`, `tts_provider=null`, `chunker_step=null`. `steps` array is empty (the six music-video step slugs come from the materializer, not the `workflow_steps` table — same model as the existing narrative workflows where glue steps aren't listed in `workflow_steps`).
  **Context**: `SeedWorkflow` type at `:88-102` needs the four new optional keys before this seed row can compile. `seedDefaultWorkflows` (`:189-223`) needs its INSERT column list extended.

- [x] **Task 4: Extend `Video`, `WorkflowRow`, and the `VideoKind` literal in `types.ts`**
  **Files**: `src/types.ts`
  **What**: Add `kind: VideoKind`, `magnific_image_prompt: string | null`, `suno_style_prompt: string | null`, `song_count: number | null`, `repeat_factor: number | null` to `Video` (`:15-34`). Add `kind: VideoKind`, `music_provider: string | null`, `upscaler_provider: string | null` to `WorkflowRow` (`:155-170`). Mark `WorkflowRow.script_llm_provider` and `chunker_step` as `string | null` to match the new schema. Add `export type VideoKind = 'narrative' | 'music_video'`.
  **Context**: Place `VideoKind` near `VideoStatus` (`:11`) — both are narrow string unions for top-level row discriminators. `ChunkKind` (`:235`) is the existing precedent for an inline union.

- [x] **Task 5: Extend `createNewVideo` to accept `kind` + music-video tuple**
  **Files**: `src/lib/repos/videos.ts`
  **What**: Extend the signature (`:63-93`) and INSERT statement (`:80`) to thread `kind` + the four music-video fields. Validate at the function boundary: `kind='music_video'` requires all four music-video fields present, forbids `topic_info`/`provided_script`/`visual_style_id`; `kind='narrative'` requires `topic_info`, forbids the four music-video fields. Throw on contract violation.
  **Context**: This is the canonical create site — the API route delegates here. ADR-0011 §Decision 4 pins the four typed columns; the per-kind required/forbidden invariants live here so the route validator can stay thin.

- [x] **Task 6: Extend `workflows` repo writes to thread `kind`, `music_provider`, `upscaler_provider`**
  **Files**: `src/lib/repos/workflows.ts`
  **What**: Add the three columns to the `insert` column list (`:61-85`) and the `UPDATABLE_FIELDS` allowlist (`:117-138`). `findById`/`list` already SELECT `*` — no read-path change needed (verify).
  **Context**: The seed loop in `seedDefaultWorkflows` calls into this repo; without the column list update, the new builtin row won't carry its kind-specific provider columns.

- [x] **Task 7: Audit existing test fixtures for implicit `kind='narrative'` assumption**
  **Files**: Grep `__tests__/` and `*.test.ts` for fixture builders that construct `Video` or `WorkflowRow` objects.
  **What**: Find every fixture/factory that constructs a `Video` or `WorkflowRow` and add an explicit `kind: 'narrative'` to keep behaviour stable. The schema default at the DB layer covers SQL-level INSERTs, but in-memory object fixtures need explicit kind to satisfy TypeScript narrowing once `VideoKind` is added.
  **Context**: Handoff Open question #7. Treat this as a sweep, not a transformation — narrative tests should be net behaviour-identical after the audit.

**Phase verification gate**: `npm run db:init` on a populated narrative DB succeeds; `SELECT kind, COUNT(*) FROM videos GROUP BY kind` returns all existing rows as `narrative`; `SELECT id FROM workflows WHERE kind='music_video'` returns exactly `music-video-magnific-suno`; existing narrative video queries return identical results to pre-migration; `npm run test` passes (the fixture audit kept narrative tests green).

### Phase 1.2 — Snapshot + materializer + validator + Zod schema kind-awareness

**Vertical end**: `materializeStepList` against a `kind='music_video'` snapshot returns the six-step list; narrative snapshots are byte-identical to before; `bootValidate` passes for the new builtin workflow; the AI-skill drafts JSON contract round-trips both kinds.

- [x] **Task 1: Thread `kind` + `music_provider` + `upscaler_provider` through the snapshot**
  **Files**: `src/lib/workflows.ts`, `src/types.ts`
  **What**: Extend `WorkflowSnapshot` (`src/types.ts:190-199`) with the three new keys. `resolveSnapshot` (`src/lib/workflows.ts:47-66`) reads them from the workflow row. `computeSnapshot` (`:73-78`) is unchanged structurally (it just stringifies). Audit each `computeSnapshot` call site (create, `transitionNewToQueued`, any other re-pin point) to confirm the new keys flow through.
  **Context**: ADR-0011 §Consequences: "`workflow_snapshot` JSON gains three new keys." Same pattern as the `visual_style_snapshot` re-pinning that ADR-0010 introduced. The ADR specifies `transitionNewToQueued` as the queue-time re-pin site.

- [x] **Task 2: Branch `materializeStepList` on `snapshot.kind`**
  **Files**: `src/lib/workflows.ts`
  **What**: At the top of `materializeStepList` (`:100-121`), add a switch on `snapshot.kind`. `narrative` falls through to the existing logic verbatim (no behaviour change). `music_video` emits exactly `['generate_loop_image', 'generate_loop_clip', 'make_thumbnail', 'generate_music', 'download_music', 'render_music_video']` and returns — no script chain, no chunker, no visual prompts, no narrative render, no cleanup.
  **Context**: ADR-0011 §Decision 2: this is the ONLY kind-switching site. Note: ADR-0011 and the handoff write the six step names in kebab-case for prose aesthetic; the plan normalizes them to snake_case to match the existing `REAL_STEPS` convention (e.g. `research_outline`, `generate_images`). File names stay kebab-case (`generate-loop-image.ts`) per `01-research-outline.ts` precedent. Downstream consumers (orchestrator, queue picker, lifecycle module) stay kind-agnostic. Unit test in `__tests__/unit/lib/workflows.test.ts` (or co-located equivalent) — assert both kinds' outputs.

- [x] **Task 3: Add a kind-aware workflow validator**
  **Files**: `src/lib/workflows-validator.ts`, `src/worker/boot.ts`
  **What**: Add ONE kind-aware entry-point validator — name it `validateWorkflowConsistency` (per ADR-0011 §Consequences phrasing). For `kind='narrative'`, it delegates to today's `validateChunkerStepConsistency` body (chunker/provider rule). For `kind='music_video'`, it asserts `image_provider='magnific'`, `video_provider='magnific'`, `music_provider='suno'`, and `script_llm_provider`/`tts_provider`/`chunker_step` all null. `bootValidate` first loop (`src/worker/boot.ts:42-68`) calls only the new entry point — the old `validateChunkerStepConsistency` either becomes private to the validator file or is kept exported as a narrative-only helper for the entry point to call.
  **Context**: ADR-0011 §Decision 3 + §Consequences. A single kind-aware call site keeps `bootValidate` clean. `bootValidate`'s second loop (`:85-100`) materializes step lists for in-flight videos by snapshot — once the materializer is kind-aware (Task 2), the loop's step-slug check tolerates the new step names automatically (verify by spot-check that `knownSlugs` includes the six new slugs after Phase 1.3 Task 7 registers them in `REAL_STEPS`).

- [x] **Task 4: Replace `WorkflowImportSchema` with a kind-discriminated union**
  **Files**: `src/lib/workflows-schema.ts`, `src/app/api/workflows/schema/route.ts`
  **What**: Convert `WorkflowRowSchema` (`src/lib/workflows-schema.ts:22-50`) into a `z.discriminatedUnion('kind', [narrativeBranch, musicVideoBranch])` (or factor the shared keys into a base schema each branch extends, whichever reads cleaner). The `narrativeBranch` reuses today's provider enums + `chunker_step` enum + at-least-one-provider rule. The `musicVideoBranch` uses `z.literal('magnific')` for `image_provider`, `z.literal('magnific')` for `video_provider`, `z.literal('suno')` for `music_provider`, and forces `script_llm_provider`, `tts_provider`, `chunker_step` to `z.null()` (or `z.literal(null)`). Using literals — not extending `IMAGE_PROVIDER_NAMES` — keeps the provider-name constants narrative-only, deferring the `magnific` registration to Plan 2 Phase 2.3 per Scope. `WorkflowImportSchema = WorkflowRowSchema` (`:72`) auto-inherits. `GET /api/workflows/schema` (`src/app/api/workflows/schema/route.ts:18-38`) reflects both branches so the AI-skill drafts importer can author either kind round-trip.
  **Context**: ADR-0011 §Consequences explicitly calls for "discriminated-union validation." The handoff's "Not doing: add `magnific` to IMAGE_PROVIDER_NAMES" is preserved by the literal-per-branch approach — the music-video branch hard-codes the only valid provider triple instead of widening the shared enum. Round-trip parity (`/api/workflows/[id]/export` ↔ import) must hold — assert this in a unit test for both kinds.

**Phase verification gate**: New unit test on `materializeStepList` returns the six-step list for `music_video` and the unchanged step list for `narrative`. New unit test on `validateWorkflowConsistency` accepts the seeded `music-video-magnific-suno` workflow shape and rejects mutations of it (e.g., `tts_provider` set). `WorkflowImportSchema.parse` rejects a music_video workflow that includes `tts_provider`, and rejects a narrative workflow that omits `chunker_step`. Existing narrative-side workflow tests stay green. (Note: `bootValidate` end-to-end against the seeded row fully passes only after Phase 1.3 Task 7 registers the six stubs in `REAL_STEPS` — Phase 1.2 verifies the validator in isolation; Phase 1.3's gate verifies `bootValidate` round-trip.)

### Phase 1.3 — Stub step files registered + walking end-to-end

**Vertical end**: A row inserted by SQL (with `kind='music_video'`, `workflow_id='music-video-magnific-suno'`, `status='queued'`) walks all six stubs and lands at `status='done'` with marker artifacts on disk. UI is still narrative-only at this point — the next phase adds the operator-facing surface.

- [x] **Task 1: Stub `generate_loop_image` + extend the `Step.module` type**
  **Files**: `src/worker/steps/generate-loop-image.ts`, `src/worker/pipeline.ts` (or wherever the `Step` type lives — search for `type Step` / `interface Step`)
  **What**: First, extend the `Step.module` field's union type to include `'music_video'` so all six new stubs can use it. Then export a `Step` whose `run(videoId, ctx)` writes a 1×1 PNG to `projects/<videoId>/loop_image.png`. Declare `name: 'generate_loop_image'`, `module: 'music_video'`, `inputs: []`, `outputs: ['loop_image.png']`. Naming: file is kebab-case (`generate-loop-image.ts`), step `name` is snake_case (`generate_loop_image`) — matches existing convention (e.g., `01-research-outline.ts` exports `name: 'research_outline'`).
  **Context**: Step file shape per `src/worker/steps/01-research-outline.ts:38-44` (where `module: 'script'`). `module` is metadata — `workflows-schema.ts:18-20` derives `SCRIPT_STEP_NAMES` by filtering `REAL_STEPS` to `module === 'script'`, so `music_video` doesn't accidentally get pulled into the script-name enum. The 1×1 PNG can be a hardcoded base64-decoded constant — no ffmpeg required for this stub. Real implementation in Plan 2 Phase 2.3 replaces this with the Magnific HITL flow.

- [x] **Task 2: Stub `generate-loop-clip`**
  **Files**: `src/worker/steps/generate-loop-clip.ts`
  **What**: Shell out to ffmpeg to generate a 1-second black 1920×1080 MP4 at `projects/<videoId>/loop_clip.mp4` via `ffmpeg -f lavfi -i color=black:s=1920x1080:r=24 -t 1 -c:v libx264 -pix_fmt yuv420p`. `inputs: ['loop_image.png']`, `outputs: ['loop_clip.mp4']`. Thread `ctx.signal` into the ffmpeg child process so cancellation propagates (per `project_long_running_step_cancellation` memory: `StepContext.signal` is the single AbortSignal contract).
  **Context**: For the ffmpeg child_process + AbortSignal wiring pattern, look at the existing narrative render code path (`src/worker/steps/14-render.ts` + `src/lib/render.ts`) as a read-only reference. `lib/render.ts` is in the handoff's "Files NOT to touch" list — don't modify it; the stub here makes its own ffmpeg call inline.

- [x] **Task 3: Stub `make-thumbnail`**
  **Files**: `src/worker/steps/make-thumbnail.ts`
  **What**: Write a 1×1 JPG to `projects/<videoId>/thumbnail.jpg`. `inputs: ['loop_image.png']`, `outputs: ['thumbnail.jpg']`. Real implementation in Plan 2 Phase 2.3 will replace this with the 16:9 ffmpeg crop.
  **Context**: Same Step shape. Hardcoded JPG bytes or trivial Sharp call — either is fine for a stub.

- [x] **Task 4: Stub `generate-music`**
  **Files**: `src/worker/steps/generate-music.ts`
  **What**: No-op step: returns immediately. The real implementation in Plan 3 enqueues N suno_queue tasks and waits on them. `inputs: []`, `outputs: []`.
  **Context**: A no-op step is fine — the orchestrator marks it `done` once `run` resolves. This is the only step that doesn't write a marker artifact in Plan 1.

- [x] **Task 5: Stub `download-music`**
  **Files**: `src/worker/steps/download-music.ts`
  **What**: Read `videos.song_count` from the DB. ffmpeg-generate N 1-second silent WAVs at `projects/<videoId>/songs/song_01.wav` ... `song_NN.wav` via `ffmpeg -f lavfi -i anullsrc=channel_layout=stereo:sample_rate=44100 -t 1`. `inputs: []`, `outputs: ['songs/']`.
  **Context**: Mirror Task 2's ffmpeg pattern. The directory output convention — declaring `'songs/'` rather than enumerated `song_*.wav` — needs to match what STEP_OUTPUTS / the orchestrator's artifact tracking expects; verify via a comparable narrative-kind directory-output step (likely one of the chunkers).

- [x] **Task 6: Stub `render-music-video`**
  **Files**: `src/worker/steps/render-music-video.ts`
  **What**: `cp projects/<videoId>/loop_clip.mp4 projects/<videoId>/final.mp4`. `inputs: ['loop_clip.mp4', 'songs/']`, `outputs: ['final.mp4']`.
  **Context**: Plan 2 Phase 2.4 swaps this to a real ffmpeg mux with silent audio; Plan 3 Phase 3.3 swaps the audio source to the concat-and-loop pipeline.

- [x] **Task 7: Register all six stubs in `REAL_STEPS`**
  **Files**: `src/worker/steps/index.ts`
  **What**: Add six new imports + six entries in `REAL_STEPS` (`:26-41`). `STEP_OUTPUTS` (`:48-49`) auto-derives.
  **Context**: ORDERING within `REAL_STEPS` doesn't drive runtime order (the materializer does); but conventionally group the six music-video stubs together below the narrative steps for readability.

**Phase verification gate**: Manual SQL insert with `kind='music_video'`, `workflow_id='music-video-magnific-suno'`, `status='queued'`, valid `song_count` (e.g., 3 to make the test fast). Worker picks it up, walks all six steps, lands `status='done'`. Inspect `projects/<videoId>/` — sees `loop_image.png`, `loop_clip.mp4`, `thumbnail.jpg`, `songs/song_01.wav` ... `songs/song_03.wav`, `final.mp4`, and `pipeline.log` showing all six step start/end lines. `bootValidate` against an in-flight music-video row passes.

> **Known gap (deferred to Plan 2):** the live worker round-trip is currently blocked by `resolveDeps` (`src/worker/pipeline.ts`). The function eagerly reads `<script_llm_provider>_script_model` settings and eagerly calls `getLlmProvider(...)` / `getImageProvider(...)` / `getVideoProvider(...)`. For a `music_video` snapshot those resolutions throw — `script_llm_provider` is `null` and `image_provider`/`video_provider` are `'magnific'`, which isn't in the runtime registry (Plan 2 registers it). The Phase 1.3 in-tree gate that does pass today is the `bootValidate` round-trip against a seeded `music_video` row + the stub-registration tests; the live worker walk lights up once Plan 2 Phase 2.3 lands the `magnific` providers (or, sooner, when `resolveDeps` learns the same null-tolerance the existing `tts_provider` resolution already has).

### Phase 1.4 — Dashboard tabs + Add Music Video modal + API kind-awareness

**Vertical end**: Operator opens `/videos`, switches to the Music videos tab, clicks Add Music Video, fills the form, submits, sees the row appear in Topics, clicks Start, watches the row walk all six stub steps via dashboard polling, lands in Finished with a downloadable (placeholder) `final.mp4`.

- [x] **Task 1: Extend `VideosClientWorkflow` with `kind` + project it in the server fetch**
  **Files**: `src/app/videos/videos-client.tsx`, `src/app/videos/page.tsx`
  **What**: Add `kind: VideoKind` to the `VideosClientWorkflow` interface (`src/app/videos/videos-client.tsx:23-27`). Extend `listEnabledWorkflowsForClient` (`src/app/videos/page.tsx:19-29`) to project `kind` from the workflow row into the client prop. This unlocks the kind-filtered workflow dropdown in the Add Music Video modal (Task 5) and lets the existing `AddVideoModal` filter its dropdown to `kind === 'narrative'` for symmetry (low-risk polish — do it here).
  **Context**: Without this projection, the modal's workflow filter has nothing to read. ADR-0011 §Consequences: "Each modal's workflow dropdown is filtered to `workflows.kind` matching the modal's kind."

- [x] **Task 2: Tabs switcher driven by `?tab=`**
  **Files**: `src/app/videos/videos-tabs.tsx` (new), `src/app/videos/videos-client.tsx`
  **What**: New tabs component reads `?tab=` from `useSearchParams` (default `narrative` on missing/invalid). Renders two pill buttons (Narrative | Music videos) that push `?tab=narrative` or `?tab=music_videos` via `router.replace` (history.replaceState-like — no history pollution on tab switch). `videos-client.tsx` (`:46-58`, `:247-400`) wraps its current section render in a kind-routing layer: if `tab === 'narrative'`, render the `NarrativeTab` (Task 4); if `tab === 'music_videos'`, render the `MusicVideosTab` (Task 3).
  **Context**: Tab state lives in URL per handoff Decision 17. `useSearchParams` is from `next/navigation`. The replace-not-push contract keeps the back button useful (tab switches are not navigation events).

- [x] **Task 3: Music videos tab — Topics/Queue/Finished sections filtered to `kind='music_video'`**
  **Files**: `src/app/videos/music-videos-tab.tsx` (new), `src/app/videos/videos-client.tsx`
  **What**: New component renders the same three section shape as the narrative tab (Topics with Add Music Video button, Queue, Finished), but the row filter is `video.kind === 'music_video'`. No Flow banners (Flow is narrative-only). No Magnific/Suno banners yet — those land in Plans 2/3. Reuses existing `<TopicsTable>` / `<VideoQueueTable>` / `<FinishedVideosTable>` components (verify they're kind-agnostic — they render the row fields that exist for both kinds; if any column is narrative-specific, it stays empty for music-video rows or the table accepts a `kind` prop to switch column layout).
  **Context**: ADR-0011 §Consequences: "The Add modal split is by kind." Narrative tab keeps the existing two-modal pattern (Add Topic + Add Ready Script); Music videos tab has one modal (Add Music Video).

- [x] **Task 4: Narrative tab — extract existing sections behind a tab wrapper**
  **Files**: `src/app/videos/narrative-tab.tsx` (new), `src/app/videos/videos-client.tsx`
  **What**: Move the existing Topics/Queue/Finished render (`videos-client.tsx:247-400`) into the new component. Filter to `video.kind === 'narrative'`. Keep the Flow banners — Flow only produces narrative-kind assets per the handoff's "Existing Flow banners move into `NarrativeTab`" note. No behaviour change from a single-kind operator's perspective.
  **Context**: Pure mechanical extraction. The tabs switcher (Task 2) makes this the default render path on first load (preserves the existing landing experience per handoff Decision 17).

- [x] **Task 5: Add Music Video modal**
  **Files**: `src/app/videos/add-music-video-modal.tsx` (new)
  **What**: New modal mirrors `AddVideoModal` shape (`add-video-modal.tsx:27-40`/`63-113`/`115-197`) with kind-specific fields: Title (Input), Workflow Select (filtered to workflows where `kind === 'music_video'` — initially one option, `music-video-magnific-suno`; Task 1 made the `kind` field available on `VideosClientWorkflow`), Magnific image prompt (Textarea), Suno style prompt (Textarea), Song count (Number Input, default 10, min 1, max 30), Repeat factor (Number Input, default 3, min 1, max 10). `canSubmit` guard: title non-empty, workflow_id present, both prompt fields non-empty, song_count and repeat_factor within range. `onSubmit` POSTs to `/api/videos` with `kind: 'music_video'` and the four music-video fields. No visual-style picker. No `topic_info` field.
  **Context**: Defaults `song_count=10`, `repeat_factor=3` per handoff Decision 15. The same modal pattern (Dialog → form → footer) keeps the operator's mental model continuous.

- [x] **Task 6: Wire modal mount + state on the music-videos tab**
  **Files**: `src/app/videos/music-videos-tab.tsx`, `src/app/videos/videos-client.tsx`
  **What**: Extend the `modal` discriminated union (`videos-client.tsx:109-115`) with `{ mode: 'addMusicVideo' }`. The music-videos tab renders the "Add Music Video" button which dispatches this mode. Modal dispatch block (`:402-423`) gains a branch that renders `<AddMusicVideoModal>` when the mode matches.
  **Context**: The modal-state-at-the-client-root pattern is established. The dispatch branch lands one line and a render. No edit-music-video flow in Plan 1 (defer — operators can delete + recreate; this matches the narrative-tab's behaviour for ready scripts in early phases).

- [x] **Task 7: Extend `CreateVideoSchema` + the POST handler for music-video kind**
  **Files**: `src/app/api/videos/route.ts`
  **What**: Extend `CreateVideoSchema` (`:25-31`) with `kind` (discriminator), `magnific_image_prompt`, `suno_style_prompt`, `song_count`, `repeat_factor`. Use `z.discriminatedUnion('kind', [narrativeSchema, musicVideoSchema])`: narrative requires `topic_info` and rejects the music-video tuple; music_video requires the four music-video fields and rejects `topic_info`/`provided_script`/`visual_style_id`. After parse, the workflow existence + enabled check (`:42-52`) gains a kind compare: `workflow.kind === parsed.kind` or 400. The `createNewVideo` call site (`:77-85`) threads the new fields through.
  **Context**: The repo-level validator from Phase 1.1 Task 5 is the second line of defense; the Zod schema is the first. Workflow kind-match is critical — without it an operator could submit a narrative workflow with music-video fields via API.

- [x] **Task 8: Extend `PatchVideoSchema` + the PATCH handler**
  **Files**: `src/app/api/videos/[id]/route.ts`
  **What**: Extend `PatchVideoSchema` (`:49-65`) to permit the four music-video fields. PATCH is kind-scoped: cannot change `kind`; cannot patch music-video fields on a narrative video and vice versa. The status gate at `:67-130` (new/queued only) stays intact.
  **Context**: ADR-0011 §Decision 1: kind is pinned at creation. The PATCH handler enforces this by rejecting any patch that includes a `kind` field different from the row's stored `kind`.

- [x] **Task 9: Music-videos tab integration test (end-to-end)**
  **Files**: `__tests__/integration/music-video-foundation.test.ts` (new) or co-located equivalent
  **What**: A single integration-style test that exercises the milestone path: POST `/api/videos` with `kind='music_video'` + the music-video tuple → row appears in `getVideosPageState` filtered to music_video → trigger the existing dashboard start flow (whichever endpoint the narrative-side "Start" button uses — discover at implementation time and mirror) → worker walks the six stubs → final row has `status='done'`, `output_path` set, all six marker artifacts on disk. Run against a temp-dir SQLite + worker — same harness as existing integration tests (find the closest narrative analog and mirror it).
  **Context**: This phase-spanning test earns its own task per the create-plan guideline ("End-to-end or integration tests that exercise behavior no single task owns *do* earn their own phase (or a final task within the last feature phase)"). It's the verification gate for the plan as a whole.
  **Scope as landed**: Test exercises POST → page-state → /start → queued (mirroring the narrative-side `ready-script-flow.test.ts`). The "worker walks the six stubs" portion is documented as deferred to Plan 2 inside the test file — `resolveDeps` in `src/worker/pipeline.ts` can't resolve a music_video snapshot today (the known gap also called out in Phase 1.3 and at `pipeline.ts:257-268`).

**Phase verification gate** (also the plan-level milestone): Operator opens `/videos` → sees Narrative active by default → clicks Music videos → sees empty Topics + Add Music Video button → clicks button → modal opens → fills (title, picks workflow, both prompts, song_count=3 for speed, repeat_factor=2) → submits → row appears in Music videos > Topics → clicks Start → row moves through Queue → walks the six stubs visible in the step timeline → lands in Music videos > Finished with `final.mp4` artifact downloadable. Narrative tab unchanged. The integration test in Task 9 passes.

## References

- [`docs/handoffs/2026-05-20-music-video-kind-plan.md`](../handoffs/2026-05-20-music-video-kind-plan.md) — the three-plan handoff this plan implements.
- [`docs/adr/0011-video-kind-discriminator.md`](../adr/0011-video-kind-discriminator.md) — `kind` discriminator design + rejected alternatives.
- [`docs/adr/0012-hitl-via-extension-no-timeout.md`](../adr/0012-hitl-via-extension-no-timeout.md) — HITL via per-task `no_timeout` (not exercised in Plan 1; informs schema neighborhood for Plans 2-3).
- [`docs/histforge-spec.md`](../histforge-spec.md) — canonical schema + pipeline reference; §22 (build-order pattern) justifies stubs-first.
- [`CONTEXT.md`](../../CONTEXT.md) — already carries "Video kinds" + "Music video language" sections.
- `src/lib/db.ts:387-396` — idempotent ALTER migration pattern.
- `src/lib/workflows.ts:100-121` — the single kind-switch site (`materializeStepList`).
- `src/lib/workflows-validator.ts:117-158` — validator pattern.
- `src/worker/steps/01-research-outline.ts:38-44` — `Step` interface shape for new stubs.
- `src/app/videos/videos-client.tsx:109-115` — modal discriminated-union pattern.
- `src/app/videos/add-video-modal.tsx:115-197` — modal layout template.
