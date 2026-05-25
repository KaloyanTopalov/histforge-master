# AI33 TTS & ComfyUI Image Providers

## Overview
Replace the GenAI Pro TTS service with AI33's ElevenLabs-compatible cloud API, and replace Freepik browser-automated image generation with a local ComfyUI instance — both behind provider-registry abstractions. Freepik video generation (step 12) is kept but needs rework — a research task (Task 11) will determine how to feed local ComfyUI images into Freepik's image-to-video flow; implementation follows in a separate plan. Since AI33 handles the full script in one call (like GenAI Pro today), the voiceover step structure stays unchanged — no per-chapter restructure needed. AI33 transcripts (SRT + JSON) are saved alongside the audio for future use.

## Current State

### GenAI Pro TTS
- Client: `src/lib/genaipro.ts:94-113` — `synthesize(text, outPath, opts?)`, submit + poll + download MP3
- Submit: `POST https://genaipro.vn/api/v1/labs/task` with `Authorization: Bearer` header
- Poll: `GET .../task/{task_id}` every 30s, statuses: `pending`/`processing`/`completed`/`failed`
- Body built at `src/lib/genaipro.ts:120-131`: reads all `voice_*` settings from DB
- Step: `src/worker/steps/06-voiceover.ts:33-49` — reads `script/full_script.md`, writes `audio/narration.mp3`
- Downstream: `src/worker/steps/07-align.ts` (aeneas), `src/worker/steps/08-chunk.ts`, `src/lib/render.ts:386-398`

### Freepik (image + video)
- Image steps: `src/worker/steps/10-freepik-main-images.ts:34`, `src/worker/steps/11-freepik-hook-images.ts:35`
- Video step: `src/worker/steps/12-freepik-hook-videos.ts:33` (keep)
- Download step: `src/worker/steps/13-download-assets.ts:34` — dual-purpose: main images (lines 69-75) and hook videos (lines 81-86)
- Freepik library: `src/lib/freepik/session.ts`, `generate.ts`, `download.ts`, `selectors.ts`, `relogin-state.ts`
- Session loss: `src/worker/pipeline.ts:275-276` (`FreepikSessionLost` → queue pause)

### Settings & DB
- Schema: `src/lib/settings.ts:12-48` (zod per-key validation)
- Defaults: `src/lib/db.ts:12-30`, seeded via `seedDefaultSettings()` at `src/lib/db.ts:32-42`
- Voice settings (7 keys, all kept): `voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`
- Image/video settings (kept): `freepik_style_name`, `aspect_ratio`, `long_edge_px`

### Pipeline orchestration
- Step registration: `src/worker/steps/index.ts:22-38` (`REAL_STEPS`)
- Step order: `src/worker/pipeline.ts:57-73` (`STEP_ORDER`)
- Step outputs: `src/worker/pipeline.ts:82-109` (`STEP_OUTPUTS`)

### AI33 API (new provider)
- Submit: `POST https://api.ai33.pro/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128`
- Auth: `xi-api-key` header, key from `AI33_API_KEY` env var
- Body: `{ text, model_id, with_transcript: true }` + voice tuning params per ElevenLabs convention (exact body shape TBD — reference ElevenLabs API docs at implementation time; current GenAI Pro uses top-level fields, ElevenLabs nests under `voice_settings`)
- Response: `{ success: true, task_id, ec_remain_credits }`
- Poll: `GET https://api.ai33.pro/v1/task/{task_id}` with same `xi-api-key` header
- Poll response: `{ id, status, error_message, metadata: { audio_url, srt_url, json_url }, progress, type }`
- Statuses: `doing` / `done` / `error`
- Reference: `docs/ai33_api.md`, `docs/get_task.md`, ElevenLabs API docs for voice parameter body format

### Spec
- `docs/histforge-spec.md` — sections to update: §4 (DB schema), §6 (pipeline step list), §8 (voiceover), §12 (Freepik → image provider), §15-21 (dashboard/config)

## Scope

**Doing**:
- Replace GenAI Pro TTS with AI33 behind a TTS provider registry (`src/lib/tts/`).
- Save AI33 transcript files (SRT + JSON) alongside the audio for future use.
- Remove Freepik image generation; keep Freepik video generation.
- Integrate ComfyUI as the image provider behind an image provider registry (`src/lib/image/`).
- Rename steps 10/11 to provider-agnostic names; rename step 13 to video-only downloader.
- Add new settings: `tts_provider`, `image_provider`, `comfyui_base_url`, `comfyui_workflow_path`. Keep all existing voice settings.
- Delete `src/lib/genaipro.ts`; trim image-specific code from `src/lib/freepik/*` while preserving video paths.
- Ship a baseline ComfyUI workflow JSON.
- Write `docs/setup-comfyui.md`; update `docs/histforge-spec.md` and `CLAUDE.md`.

**Not doing**:
- Per-video provider selection (stays global).
- Voiceover restructure — AI33 handles the full script in one call, so steps 07 (align), 08 (chunk) stay unchanged.
- Implementing the step 12 rework (Freepik image-to-video with local images) — Task 11 is research only; implementation follows in a separate plan.
- Stub files for future providers (adding one later is a one-file drop-in).
- Wiring AI33 transcript into the alignment step (saved for future use only).
- Changes to steps 01-05, 09, 15.

## Pipeline state after this plan
After all tasks are complete, steps 01-11 and 14-15 are fully functional. Steps 12-13 (hook video generation and download) are **not functional** until the Task 11 research is resolved and step 12 is reworked in a follow-up plan. The render step throws on missing hook videos (`render.ts:258-261`), so the full pipeline will fail at step 12 or step 14 if hook chunks exist. To test end-to-end before the step 12 rework, the operator must either: (a) skip steps 12-13 manually (e.g., mark them as `completed` in the DB), or (b) temporarily disable hook chunking so no hook chunks are produced.

## Tasks

### Phase 1: Settings & DB groundwork

- [x] **Task 1: Add new settings keys**
  **Files**: `src/lib/settings.ts`, `src/lib/db.ts`, `src/app/api/settings/route.ts`, `__tests__/unit/lib/settings.test.ts`, `__tests__/unit/lib/db.test.ts`
  **What**: Add four new keys to `SETTING_SCHEMAS` and `DEFAULT_SETTINGS`: `tts_provider` (enum `"ai33"`, default `"ai33"`), `image_provider` (enum `"comfyui"`, default `"comfyui"`), `comfyui_base_url` (string, default `"http://127.0.0.1:8188"`), `comfyui_workflow_path` (string, default `"prompts/comfyui/default-workflow.json"`). All 7 existing voice settings and all existing image/video settings stay unchanged. Mirror changes in the PATCH validator.
  **Context**: Schema pattern at `src/lib/settings.ts:12-48`; defaults at `src/lib/db.ts:12-30`; seed logic at `src/lib/db.ts:32-42` (uses `INSERT OR IGNORE`, so new keys are added idempotently to existing DBs); API PATCH validation at `src/app/api/settings/route.ts`.

- [x] **Task 2: Update settings form UI**
  **Files**: `src/app/settings/settings-form.tsx`, `__tests__/components/settings/settings-form.test.tsx`
  **What**: Add fields for the 4 new settings from Task 1. Group them logically: `tts_provider` near the existing voice settings section; `image_provider`, `comfyui_base_url`, `comfyui_workflow_path` in a new "Image Generation" section. Preserve the dirty-diff PATCH pattern (only changed fields sent).
  **Context**: Form pattern at `src/app/settings/settings-form.tsx`; dirty-diff logic near top of the component.

#### Phase 1 implementation notes

**Key ordering convention**: New keys are co-located with their logical group, not appended to the end. `tts_provider` sits before `voice_id` (with the voice settings), and `image_provider`/`comfyui_base_url`/`comfyui_workflow_path` sit after `freepik_style_name` (with the image/render settings). This ordering is consistent across all 5 files: `settings.ts` (SETTING_SCHEMAS), `db.ts` (DEFAULT_SETTINGS), `settings.test.ts` (all assertion objects), `db.test.ts` (seedDefaultSettings assertion), and `settings-form.test.tsx` (fixture). The form's section grouping mirrors the same order: Image Generation section before Voice section.

**PATCH route (`src/app/api/settings/route.ts`) needed no code changes** — the validator is driven entirely by `setSetting()` which calls `assertKnownKey()` against `SETTING_SCHEMAS`. Adding keys to the schema is sufficient; there is no separate whitelist or per-key logic in the route.

**Test pattern notes**: `getByDisplayValue` from testing-library throws if the element is missing, so wrapping it in `expect(...).toBeTruthy()` is redundant — just call it bare. The project does not have a vitest setup file registering jest-dom matchers, so `.toBeInTheDocument()` is unavailable without additional setup. For `setSetting` tests, new keys get both positive round-trip tests (grouped by type category: enums with the enum section, strings with the string section) and negative rejection tests (grouped with other enum rejections), plus mutation-check assertions verifying rejected writes don't corrupt stored values.

**Pre-existing test failures** (unrelated to this plan): `__tests__/unit/lib/align.test.ts` (path-matching assertion) and `__tests__/unit/worker/steps/freepik-steps.test.ts` (timeout). Both fail on clean master.

### Phase 2: Provider abstractions

- [x] **Task 3: Create TTS provider interface and registry**
  **Files**: `src/lib/tts/types.ts`, `src/lib/tts/index.ts`
  **What**: Define a `TtsProvider` interface with a single method: `synthesize(text: string, outMp3Path: string, opts: { db?: DatabaseType, log?: (msg: string) => void }): Promise<TtsResult>`. `TtsResult` includes optional transcript paths: `{ transcripts?: { srtPath?: string, jsonPath?: string } }`. The provider reads voice settings from the DB internally. Export `getTtsProvider(name: string): TtsProvider` that returns the registered instance. Only `"ai33"` is registered in this iteration.
  **Context**: Mirror the `opts.log` callback pattern from `src/lib/genaipro.ts:94-113`. The interface stays close to the current `synthesize` signature to minimize step-level changes.

- [x] **Task 4: Create image provider interface and registry**
  **Files**: `src/lib/image/types.ts`, `src/lib/image/index.ts`
  **What**: Define an `ImageProvider` interface with a single method: `generateBatch(items: { id, prompt }[], targetDir: string, opts: { db?: DatabaseType, log?: (msg: string) => void }): Promise<void>`. The provider reads its own settings (e.g., `comfyui_base_url`, `comfyui_workflow_path`, `aspect_ratio`, `long_edge_px`) from the DB internally via `opts.db ?? getDb()`. Writes files named `<id>.png` directly into the target directory. Export `getImageProvider(name: string): ImageProvider`. Only `"comfyui"` is registered in this iteration.
  **Context**: Consistent with the TTS provider interface (Task 3) — both accept `opts.db` for testability and `opts.log` for progress reporting. Mirror the dependency-injection pattern used in existing Freepik steps (e.g., `FreepikDeps` in `src/worker/steps/10-freepik-main-images.ts`). Keep the interface narrow — inputs in, files on disk out, no intermediate JSON maps.

#### Phase 2 implementation notes

Both registries follow the same structure: `types.ts` (interface + result type) and `index.ts` (re-exports, `providers` map, `getXxxProvider()` getter). Stubs throw "not yet implemented" — replaced by real implementations in Tasks 5 and 7. `TtsProvider.synthesize` returns `Promise<TtsResult>` (transcript paths are dynamic); `ImageProvider.generateBatch` returns `Promise<void>` (caller knows output paths by `<id>.png` convention). Both opts share `{ db?: DatabaseType; log?: (message: string) => void }`.

### Phase 3: AI33 TTS provider

- [x] **Task 5: Implement AI33 client**
  **Files**: `src/lib/tts/ai33.ts`
  **What**: HTTP client implementing the `TtsProvider` interface against AI33's API. Three-phase flow mirroring the existing GenAI Pro client: (1) Submit: `POST https://api.ai33.pro/v1/text-to-speech/{voice_id}?output_format=mp3_44100_128` — voice_id from settings, auth via `xi-api-key: $AI33_API_KEY` header, body includes `{ text, model_id, with_transcript: true }` plus voice tuning params (consult ElevenLabs API docs for exact body shape — may be top-level fields or nested `voice_settings` object). (2) Poll `GET https://api.ai33.pro/v1/task/{task_id}` every 30s until `status === "done"` or `status === "error"`. (3) Download MP3 from `metadata.audio_url` to `outMp3Path`; also download `metadata.srt_url` and `metadata.json_url` to sibling paths (`narration.srt`, `narration.json` next to the MP3). Retry submit transient failures (2-3 attempts, exponential backoff). Surface clear error when `AI33_API_KEY` is missing. Return transcript paths in `TtsResult`.
  **Context**: The current GenAI Pro client at `src/lib/genaipro.ts` is the direct structural reference — same submit/poll/download pattern, same `logOnce` dedup for unusual poll events, same injectable `pollIntervalMs`/`retryDelayMs` for testing. Key differences: different URL scheme (voice_id in path), different auth header (`xi-api-key` vs `Authorization: Bearer`), different status values (`doing`/`done`/`error` vs `pending`/`processing`/`completed`/`failed`), and transcript download. API reference at `docs/ai33_api.md`, `docs/get_task.md`, and ElevenLabs API docs for voice parameter format.

- [x] **Task 6: Update voiceover step to use TTS provider registry**
  **Files**: `src/worker/steps/06-voiceover.ts`, `__tests__/unit/worker/steps/voiceover.test.ts`
  **What**: Replace the direct `genaipro.synthesize` import with a call through the TTS provider registry. Load provider via `getTtsProvider(getSetting('tts_provider', db))`. The step still reads `script/full_script.md` and writes `audio/narration.mp3`. Additionally, log transcript paths if returned by the provider. Update `VoiceoverDeps` interface to accept an injectable provider for testing.
  **Context**: Current step at `src/worker/steps/06-voiceover.ts:33-49`. The structural change is minimal — swap the import and add the provider lookup. The `deps.synthesize` injection pattern should adapt to `deps.provider` or similar so tests can mock the full `TtsProvider` interface.

#### Phase 3 implementation notes

**ElevenLabs body format resolved**: AI33 uses the ElevenLabs nested `voice_settings` convention. Body shape: `{ text, model_id, with_transcript: true, voice_settings: { stability, similarity_boost, style, use_speaker_boost, speed } }`. Note `similarity_boost` (ElevenLabs name) maps from the `voice_similarity` setting.

**`AI33SynthesizeOpts` extends the `TtsProvider` interface opts** with `retryDelayMs` and `pollIntervalMs` (test-only timing knobs, same pattern as GenAI Pro). Tests import `ai33Provider` directly from `@/lib/tts/ai33` to access the extended opts; production path goes through the registry and uses interface defaults.

**`downloadFile` is generic** (unlike GenAI Pro's `downloadMp3`) — reused for MP3, SRT, and JSON transcript downloads. Transcript downloads are conditional on non-null URLs from the poll response; when both are null, `TtsResult` returns `{ transcripts: undefined }`.

**Voiceover step DI changed from `deps.synthesize` (bare function) to `deps.provider` (full `TtsProvider`)** — tests inject a mock provider object instead of a mock function. The step resolves the real provider via `getTtsProvider(getSetting("tts_provider", getDb()))` in production. It does not pass `db` to `provider.synthesize()`; the provider calls `getDb()` internally (same pattern as the old GenAI Pro path).

**Cross-phase cleanup**: Aligned log callback parameter name from `msg` to `message` in both `TtsProvider` and `ImageProvider` interfaces, matching the codebase convention (GenAI Pro, AI33, `appendLog`). Updated the Phase 2 notes above accordingly.

### Phase 4: ComfyUI image provider

- [x] **Task 7: Implement ComfyUI client**
  **Files**: `src/lib/image/comfyui.ts`
  **What**: HTTP client implementing the `ImageProvider` interface against ComfyUI's API. For each image: (1) Load workflow JSON from `comfyui_workflow_path` setting. (2) Inject the prompt text into the workflow's positive-prompt node (first `CLIPTextEncode` node, or a node marked with a `_histforge_prompt` key). (3) Inject width/height into the workflow's EmptyLatentImage node (or equivalent), derived from `aspect_ratio` and `long_edge_px` settings via the existing `computeResolution()` helper at `src/lib/render.ts:27`. (4) `POST /prompt` to `comfyui_base_url` to enqueue. (5) Poll `GET /history/{prompt_id}` until complete. (6) Download the output image from ComfyUI's output endpoint and write to the target directory as `<chunk_id>.png`. Process batch items sequentially (ComfyUI queues internally). Log progress via `opts.log` (e.g., "Generating image 3/45: main_003"). Surface helpful errors when ComfyUI is unreachable.
  **Context**: ComfyUI's API format: `POST /prompt` with `{ prompt: <workflow_json>, client_id: <uuid> }` returns `{ prompt_id }`. `GET /history/{prompt_id}` returns outputs when done. Keep network config in settings (`comfyui_base_url`), not hardcoded. The `computeResolution()` helper is already used by the render step — reuse it rather than duplicating the aspect-ratio math.

- [x] **Task 8: Create baseline ComfyUI workflow template**
  **Files**: `prompts/comfyui/default-workflow.json`, `prompts/comfyui/README.md`
  **What**: Ship a working ComfyUI workflow JSON (API format) that produces 16:9 images: checkpoint loader, positive/negative CLIP text encode, KSampler, VAE decode, SaveImage. Mark the positive-prompt node so the client can find it. README documents: how to export a workflow from ComfyUI's UI (Save API Format), which nodes HistForge looks for, how to swap checkpoints/LoRAs, resolution guidance per aspect ratio.
  **Context**: The workflow must be in ComfyUI's "API format" (node-based JSON, not the UI-graph format). The client needs to locate the positive-prompt node and the SaveImage node.

#### Phase 4 implementation notes

**Registry wiring**: `src/lib/image/index.ts` now imports `comfyuiProvider` from `./comfyui` directly (Phase 2 stub replaced). Tests import `comfyuiProvider` from `@/lib/image/comfyui` to access the extended `ComfyUIGenerateBatchOpts` (adds `pollIntervalMs`); production callers go through the registry with the base `ImageProvider` opts.

**`computeResolution` imported from `src/lib/render.ts`** — pure function, no heavy deps pulled in. Resolution computed once before the batch loop, injected into each workflow clone.

**`findOutputNodeId` accepts `SaveImage` or `PreviewImage`** — both are valid ComfyUI output nodes. The ID is resolved once from the template before the loop, then used to index into each `/history` response.

**Poll error detection**: `pollUntilComplete` checks `entry.status.status_str === "error"` and extracts `exception_message` from the `execution_error` message tuple. Without this, a failed ComfyUI job (entry present, empty outputs) caused an infinite loop. This matches AI33's explicit error-status throw pattern.

**Seed**: Default workflow uses `"seed": 0` (deterministic). Each chunk has a unique prompt so images differ; reproducibility is useful for crash-resume.

**Default workflow nodes**: `"3"` KSampler, `"4"` CheckpointLoaderSimple (`sd_xl_base_1.0.safetensors`), `"5"` EmptyLatentImage, `"6"` CLIPTextEncode (positive, `_histforge_prompt: true`), `"7"` CLIPTextEncode (negative), `"8"` VAEDecode, `"9"` SaveImage. Phase 5 steps will pass chunk IDs and prompts; the client writes `<id>.png` directly.

### Phase 5: Image step renaming & implementation

- [x] **Task 9: Replace step 10 with provider-backed `generate_main_images`**
  **Files**: new `src/worker/steps/10-generate-main-images.ts`; delete `src/worker/steps/10-freepik-main-images.ts`; update `__tests__/unit/worker/steps/freepik-steps.test.ts` (remove step 10 section)
  **What**: New step named `generate_main_images`. Reads `chunks/chunks.json`, filters `kind === "main"`, calls `getImageProvider(settings.image_provider).generateBatch(chunks, "images/main/")`. No id_map file — provider writes `<chunk_id>.png` directly. Preserve resume semantics (skip chunks whose output file already exists).
  **Context**: Current Freepik step at `src/worker/steps/10-freepik-main-images.ts:34` for retry/resume patterns. Use the same dependency-injection pattern for testability.

- [x] **Task 10: Replace step 11 with provider-backed `generate_hook_images`**
  **Files**: new `src/worker/steps/11-generate-hook-images.ts`; delete `src/worker/steps/11-freepik-hook-images.ts`; update `__tests__/unit/worker/steps/freepik-steps.test.ts` (remove step 11 section)
  **What**: Same as Task 9 but filters `kind === "hook"` and writes to `images/hook/`.
  **Context**: Current hook images step for patterns. Same interface as Task 9.

- [x] **Task 11: Research — Freepik image-to-video with local images**
  **Files**: `src/worker/steps/12-freepik-hook-videos.ts`, `src/lib/freepik/generate.ts`, `src/lib/freepik/selectors.ts`
  **What**: Investigate how to make Freepik's image-to-video feature work when hook images are local ComfyUI PNGs instead of already-uploaded Freepik gallery items. The current flow (`12-freepik-hook-videos.ts:60-81`) navigates to a Freepik project folder, clicks an image by its `data-item` attribute, then clicks "image to video" — this entire interaction model breaks because there is no Freepik project containing the images. Possible approaches: (a) upload local PNGs to Freepik via browser automation before converting, (b) use Freepik's drag-and-drop or file-input upload if one exists on the image-to-video page, (c) restructure the step to use a different Freepik entry point. Deliverable: a short write-up of the viable approach with the specific selectors/flow needed, leading to an implementation task in a follow-up plan.
  **Context**: This is a research task, not an implementation task. The current step relies on `hookIdMap.images[chunk.id]` to find the Freepik `data-item` ID (`12-freepik-hook-videos.ts:68`), then clicks `[data-item="${imageItemId}"]` (`line 81`). With ComfyUI, there are no Freepik data-item IDs for images — only local `.png` files in `images/hook/`. The `HookIdMap` type (`src/types.ts:95-98`) may need its `images` section removed or repurposed depending on the approach chosen.

- [x] **Task 12: Rename step 13 to `download_hook_videos` and strip image paths**
  **Files**: new `src/worker/steps/13-download-hook-videos.ts`; delete `src/worker/steps/13-download-assets.ts`; update `__tests__/unit/worker/steps/freepik-steps.test.ts` (remove step 13 section)
  **What**: Strip the image-download branch (current lines 69-75 in `13-download-assets.ts`). Keep only the video-download branch (lines 81-86), writing to `videos/hook/`. Read the hook video id_map from `videos/hook_id_map.json` (target location — the exact path depends on step 12's rework per Task 11 research; use this path as the target and update if the research dictates otherwise).
  **Context**: Current dual-purpose downloader at `src/worker/steps/13-download-assets.ts:34-88`. Currently reads from `freepik/hook_id_map.json`. Note: until step 12 is reworked (follow-up to Task 11), the hook video pipeline (steps 12-13) will not function end-to-end. Steps 10-11 (image generation) and step 13 (video download) are independently correct.

#### Phase 5 implementation notes

**DI pattern matches voiceover step (Phase 3)**: Steps 10 and 11 inject an optional `ImageProvider` via `deps.provider`, falling back to `getImageProvider(getSetting("image_provider", getDb()))`. Step 13 injects `deps.downloadProjectFolder` (same pattern as the old `download_assets`). All three use `deps.projectsDir` with the standard `process.env.PROJECTS_DIR ?? "./projects"` fallback.

**Step 13 Playwright cold-import timeout**: Importing `13-download-hook-videos.ts` pulls in Playwright via `@/lib/freepik/session` and `@/lib/freepik/download`. In an isolated test file, the first test takes ~7s for module loading. Added `{ timeout: 15_000 }` to the first test. The step 12 tests in `freepik-steps.test.ts` don't need this because Playwright was already present in the test environment from prior phases, but may exhibit the same behavior if run in isolation.

**Step 13 id_map format**: Reads a flat `Record<string, string>` from `videos/hook_id_map.json` (not the nested `HookIdMap` with `images`/`videos` sections). This path and format are provisional — step 12 currently writes to `freepik/hook_id_map.json` in the nested format. Both will be reconciled when step 12 is reworked per the Task 11 research outcome.

**Task 11 research deliverable**: Written to `docs/research/task-11-freepik-image-to-video-with-local-images.md`. Recommends Approach A (upload local PNGs to Freepik before converting). Key open question: whether Freepik project folders support external image uploads — requires manual UI inspection.

**Test helper extraction**: Shared helpers (`tempDir`, `freshDb`, `seedTopicAndVideo`, `makeChunks`, `seedChunks`, `cleanup`) extracted to `__tests__/helpers/step-fixtures.ts`. All 4 test files in this phase (3 new + `freepik-steps.test.ts`) import from the shared module. Pre-existing duplication in other test files (voiceover, render, research, etc.) is out of scope.

### Phase 6: Cleanup & orchestrator

- [x] **Task 13: Delete GenAI Pro client**
  **Files**: `src/lib/genaipro.ts`, `__tests__/unit/lib/genaipro.test.ts`
  **What**: Delete both files. Verify no remaining imports of `genaipro` (step 06 was the only consumer, now updated in Task 6).
  **Context**: Clean removal; git history preserves both.

- [x] **Task 14: Trim image paths from `src/lib/freepik/*`**
  **Files**: `src/lib/freepik/generate.ts`, `src/lib/freepik/download.ts`, `src/lib/freepik/session.ts`, `src/lib/freepik/selectors.ts`, `src/lib/freepik/relogin-state.ts`, `__tests__/unit/lib/freepik/generate.test.ts`, `__tests__/unit/lib/freepik/download.test.ts`
  **What**: Audit each file. Remove code paths used only by image generation (image-specific selectors, image-only branches in `submitBatch`/`downloadProjectFolder`). Preserve the code the video step (12) and download step (13) need: session management, video-generation submission, video-ZIP download with correct rename. Keep `relogin-state.ts` and the `FreepikSessionLost` error.
  **Context**: Careful audit — image and video paths share helpers. The video step (12) will need different Freepik interactions after the Task 11 research is resolved (uploading local images instead of referencing already-uploaded ones), so trim conservatively — preserve all video-related code paths and anything that step 12's rework might still need. A second trim pass can follow the step 12 implementation.

- [x] **Task 15: Update `REAL_STEPS` registration**
  **Files**: `src/worker/steps/index.ts`
  **What**: Remove imports for deleted files (`10-freepik-main-images`, `11-freepik-hook-images`, `13-download-assets`). Add new ones (`10-generate-main-images`, `11-generate-hook-images`, `13-download-hook-videos`). Order stays the same.
  **Context**: `src/worker/steps/index.ts:22-38`.

- [x] **Task 16: Update `STEP_ORDER` and `STEP_OUTPUTS`**
  **Files**: `src/worker/pipeline.ts`, `__tests__/unit/worker/pipeline.test.ts`
  **What**: Rename step IDs in `STEP_ORDER`: `freepik_main_images` → `generate_main_images`, `freepik_hook_images` → `generate_hook_images`, `download_assets` → `download_hook_videos`. In `STEP_OUTPUTS`, update artifact paths: `generate_main_images: ["images/main"]`, `generate_hook_images: ["images/hook"]`, `download_hook_videos: ["videos/hook"]`. Keep `freepik_hook_videos: []` unchanged — step 12 hasn't been reworked yet and still writes to `freepik/hook_id_map.json`; update this entry when step 12 is reworked in the follow-up plan. Add `audio/narration.srt` and `audio/narration.json` to step 06's outputs (transcript files). Session-loss handling stays unchanged.
  **Context**: `src/worker/pipeline.ts:57-73` (STEP_ORDER), `82-109` (STEP_OUTPUTS).

- [x] **Task 17: Update render step (14) for new asset paths**
  **Files**: `src/lib/render.ts`, `__tests__/unit/lib/render.test.ts`
  **What**: Update the hardcoded image/video source paths: `freepik/main` → `images/main` (line 244), `freepik/hook_videos` → `videos/hook` (line 246). No other render logic changes.
  **Context**: `src/lib/render.ts:244-247` hardcodes `join(projectDir, "freepik", "main")` and `join(projectDir, "freepik", "hook_videos")`. These are the only two path references that need updating — the rest of the render pipeline (stages A-E) works on relative paths derived from these variables.

- [x] **Task 18: Update types**
  **Files**: `src/types.ts`
  **What**: Remove the `MainIdMap` type (line 88) — no longer needed since ComfyUI writes PNGs directly with no id_map. Update the `Chunk.prompt` docstring (lines 70-71) from "visual prompt string for Freepik" to provider-agnostic wording. Keep `HookIdMap` for now — its final shape depends on the Task 11 research outcome.
  **Context**: `src/types.ts:84-98`. `MainIdMap` was consumed by steps 10 and 13 (both being replaced). Verify no other imports of `MainIdMap` remain after steps are replaced.

- [x] **Task 19: Update `.env.example`**
  **Files**: `.env.example`
  **What**: Replace `GENAIPRO_API_KEY=` with `AI33_API_KEY=`.
  **Context**: Current file has `GENAIPRO_API_KEY=` at line 2.

#### Phase 6 implementation notes

**Task 14 audit result**: `generate.ts` (entirely image-only) and `generate.test.ts` deleted. `selectors.ts` trimmed: 5 image-setup selectors removed (`styleSelector`, `aspectRatioSelector`, `newFolderButton`, `folderNameInput`, `folderCreateButton`). `download.ts`, `session.ts`, `relogin-state.ts` kept unchanged — all used by video steps 12/13. `download.test.ts` kept unchanged (tests generic helpers). `selectors.test.ts` updated to match.

**Render step path update (Task 17) had wider blast radius than planned**: `render.test.ts` and the separate `render.test.ts` (step wrapper in `__tests__/unit/worker/steps/`) both contained `freepik/main` and `freepik/hook_videos` fixture paths. The `cleanup.test.ts` and `pipeline.test.ts` FreepikSessionLost test also had stale fixtures using old directory layout and step names — caught and fixed in a consistency pass after initial implementation.

**`.env` not updated (Task 19)**: `.env.example` was updated (`GENAIPRO_API_KEY` → `AI33_API_KEY`), but the actual `.env` file still contains `GENAIPRO_API_KEY` with a live credential. Operator must manually add `AI33_API_KEY` and remove the old key.

**Stale references caught in review**: `types.ts` module docstring still listed deleted `MainIdMap`; `HookIdMap` docstring referenced step 11 as a writer (no longer true); `render.ts` comment referenced old step name `download_assets`. All fixed.

### Phase 7: Documentation

- [x] **Task 20: Write ComfyUI setup guide**
  **Files**: `docs/setup-comfyui.md`
  **What**: Step-by-step install for Windows: download ComfyUI portable, install a checkpoint (recommend SDXL), launch, verify reachable at default URL. Explain the workflow file: how to export from ComfyUI UI, which nodes HistForge looks for, how to swap checkpoints/LoRAs. Troubleshooting (port conflicts, VRAM, missing models).
  **Context**: User runs on Windows. Keep pragmatic — link to ComfyUI's repo for deep details.

- [x] **Task 21: Update `CLAUDE.md`**
  **Files**: `CLAUDE.md`
  **What**: Update Development Commands to mention ComfyUI must be running for image steps. Note `AI33_API_KEY` env var requirement. Link to setup guide from Troubleshooting section.
  **Context**: Existing structure has Project Skills table and Troubleshooting section.

- [x] **Task 22: Update design spec**
  **Files**: `docs/histforge-spec.md`
  **What**: Update the following sections:
  - §4 DB Schema: add `tts_provider`, `image_provider`, `comfyui_base_url`, `comfyui_workflow_path` keys.
  - §6 Pipeline Step List: rename steps 10, 11, 13 and note new folder paths.
  - §8 Voiceover: update to describe AI33 provider (submit/poll/download flow, `AI33_API_KEY` env var, ElevenLabs-compatible voice settings, transcript file saving). Remove GenAI Pro references.
  - §12 Freepik Agent: delete image-generation subsections; retain video subsections. Add new section describing image-provider abstraction and ComfyUI.
  - §13 Render: update asset source paths (`freepik/main` → `images/main`, `freepik/hook_videos` → `videos/hook`) to match Task 17 code changes.
  - §15-21: minor touches to config/env and dashboard settings docs.
  **Context**: Spec is the canonical reference per `CLAUDE.md`. Keep style and heading structure consistent.

## References
- `docs/ai33_api.md` — AI33 TTS submit endpoint
- `docs/get_task.md` — AI33 task polling endpoint
- ElevenLabs API docs — voice parameter body format (AI33 references these)
- `docs/histforge-spec.md` — spec (sections §4, §6, §8, §12, §15-21 to update)
- `src/lib/genaipro.ts` — current TTS client (structural reference for AI33 client, to be deleted)
- `src/worker/steps/06-voiceover.ts:33-49` — current voiceover step
- `src/worker/pipeline.ts:57-73` — STEP_ORDER
- `src/worker/pipeline.ts:82-109` — STEP_OUTPUTS
- `src/worker/steps/index.ts:22-38` — REAL_STEPS registration
- `src/worker/steps/10-freepik-main-images.ts:34` — current main image step
- `src/worker/steps/11-freepik-hook-images.ts:35` — current hook image step
- `src/worker/steps/12-freepik-hook-videos.ts:60-81` — current hook video step (image-to-video flow)
- `src/worker/steps/13-download-assets.ts:34-88` — current dual download step
- `src/lib/render.ts:244-247` — hardcoded `freepik/main` and `freepik/hook_videos` paths
- `src/types.ts:84-98` — `MainIdMap` (to remove), `HookIdMap` (to update), `Chunk` (docstring fix)
- `src/lib/settings.ts:12-48` — settings schema
- `src/lib/db.ts:12-30` — settings defaults
- `.env.example` — env var template (GENAIPRO_API_KEY → AI33_API_KEY)
- `src/lib/freepik/*` — to be trimmed, not deleted (video paths preserved)
- `src/lib/render.ts:27` — `computeResolution()` helper (reused by ComfyUI client)
- `__tests__/unit/lib/genaipro.test.ts` — to be deleted with client
- `__tests__/unit/worker/steps/voiceover.test.ts` — update for new provider interface
- `__tests__/unit/worker/steps/freepik-steps.test.ts` — remove sections for steps 10, 11, 13
- `__tests__/unit/lib/freepik/generate.test.ts` — update after Freepik trim
- `__tests__/unit/lib/freepik/download.test.ts` — update after Freepik trim
- `__tests__/unit/worker/pipeline.test.ts` — update step name references
- `__tests__/unit/lib/render.test.ts` — update path references
- `__tests__/components/settings/settings-form.test.tsx` — update for new settings fields
- `__tests__/unit/lib/settings.test.ts` — update for new settings keys
- `__tests__/unit/lib/db.test.ts` — update for new default settings
- `docs/plans/2026-04-14-local-image-and-tts-providers.md` — predecessor plan (ComfyUI + Chatterbox)
