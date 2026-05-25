# Local Image & TTS Providers (ComfyUI + Chatterbox)

## Overview
Replace the Freepik image generation and GenAI Pro TTS services with local model providers — ComfyUI for images, Chatterbox for voiceover — behind provider-registry abstractions so a second provider (Stable Diffusion WebUI, Orpheus) can be added later by dropping in one file. Freepik's image-to-video generation (step 12) is preserved. TTS moves to per-chapter, sentence-split-and-stitch synthesis to avoid Chatterbox drift, and the hook is kept as its own audio file (stitched into the final video at render time). Settings remain global — no per-video provider selection in this iteration.

## Current State

### Freepik (image + video)
- Image steps: `src/worker/steps/10-freepik-main-images.ts:27-79`, `src/worker/steps/11-freepik-hook-images.ts`
- Video step: `src/worker/steps/12-freepik-hook-videos.ts` (keep)
- Download step: `src/worker/steps/13-download-assets.ts:34-88` — dual-purpose: main images via `main_id_map.json` (lines 69-75) and hook videos via `hook_id_map.videos` (lines 81-86)
- Freepik library: `src/lib/freepik/session.ts`, `generate.ts`, `download.ts`, `selectors.ts`, `relogin-state.ts` — all used by both images and videos today
- Session loss handling: `src/worker/pipeline.ts:275-276` (`FreepikSessionLost` throws queue pause)

### GenAI Pro TTS
- Client: `src/lib/genaipro.ts:94-113` — `synthesize(text, outPath, opts?)`, submit + poll + download MP3
- Step: `src/worker/steps/06-voiceover.ts:33-49` — reads `script/full_script.md` (full text), writes `audio/narration.mp3`
- Downstream MP3 dependency: `src/worker/steps/07-align.ts` (aeneas), `src/worker/steps/14-render.ts`

### Chapter & script structure
- Hook: `script/03_hook.md` (written by step 03)
- Chapters: `script/04_chapter_01.md` … `04_chapter_<N>.md` (written by step 04, count from `chapter_count` setting)
- Assembly: `src/worker/steps/05-assemble-script.ts:23-41` concatenates hook + chapters → `script/full_script.md`
- Chunking today: `src/worker/steps/08-chunk.ts:26-100` splits first 120s as hook, remainder as main (hardcoded 120s threshold to be removed)

### Settings & DB
- Schema registry: `src/lib/settings.ts:12-48` (zod)
- Defaults: `src/lib/db.ts:12-30` seeded via `seedDefaultSettings()` at `src/lib/db.ts:32-42`
- Current voice settings (ElevenLabs/GenAI-Pro passthrough, to be removed): `voiceover_model_id`, `voice_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`
- Current image setting (kept for video step): `freepik_style_name`, `aspect_ratio`, `long_edge_px`

### Pipeline orchestration
- Step registration: `src/worker/steps/index.ts:22-38` (`REAL_STEPS`)
- Step order: `src/worker/pipeline.ts:57-73` (`STEP_ORDER`)
- Step outputs for failure cleanup: `src/worker/pipeline.ts:82-109` (`STEP_OUTPUTS`)

### Spec
- `docs/histforge-spec.md` — sections to update: §4 (DB schema, lines 167-242), §6 (pipeline step list, 284-315), §8 (voiceover, 362-396), §12 (Freepik agent 10-13, 467-542), §13 (render, 544-612), §14 (cleanup, 614-628), §15-21 (dashboard/config, 631-821)

## Scope

**Doing**:
- Remove Freepik image generation; keep Freepik video generation.
- Integrate ComfyUI as the image provider behind a provider registry (`src/lib/image/`).
- Integrate Chatterbox as the TTS provider behind a provider registry (`src/lib/tts/`), run as a local FastAPI server.
- Restructure step 06 to per-chapter, sentence-split-and-stitch synthesis; produce separate `audio/hook.mp3` and `audio/narration.mp3`.
- Update step 07 to align hook and chapters independently; update step 08 to consume both alignment files; update step 14 to compose both audio tracks.
- Rename steps 10/11 to provider-agnostic names; rename step 13; rename project folders to `images/main/`, `images/hook/`, `videos/hook/`.
- Replace voice settings with Chatterbox-specific ones + provider/URL/seed/reference-path keys; add ComfyUI URL + workflow-path keys.
- Ship a default reference voice clip in the repo and a baseline ComfyUI workflow JSON.
- Delete `src/lib/genaipro.ts` and trim image-specific code from `src/lib/freepik/*` while preserving the video paths.
- Write `docs/setup-comfyui.md` and `docs/setup-chatterbox.md`; update `docs/histforge-spec.md`.

**Not doing**:
- Per-video provider selection (stays global).
- Stub files for future providers (Stable Diffusion WebUI, Orpheus) — adding one later is a one-file drop-in.
- Dashboard upload UI for the reference voice clip (file swap on disk).
- Changes to steps 01-05, 09, 15 beyond cleanup-path adjustments.

## Tasks

### Phase 1: Settings & DB groundwork

- [ ] **Task 1: Update settings schema and defaults**
  **Files**: `src/lib/settings.ts`, `src/lib/db.ts`, `src/app/api/settings/route.ts`
  **What**: Remove the 7 ElevenLabs-style voice keys. Add new keys: `tts_provider` (enum `"chatterbox"`, default `"chatterbox"`), `chatterbox_base_url` (string, default `"http://127.0.0.1:8001"`), `voice_reference_path` (string, default `"data/voices/default.wav"`), `voice_exaggeration` (0–1, default `0.5`), `voice_cfg_weight` (0.1–1.0, default `0.5`), `voice_temperature` (0.1–1.5, default `0.7`), `voice_seed` (integer, default `42`), `image_provider` (enum `"comfyui"`, default `"comfyui"`), `comfyui_base_url` (string, default `"http://127.0.0.1:8188"`), `comfyui_workflow_path` (string, default `"prompts/comfyui/default-workflow.json"`). Keep `freepik_style_name`, `aspect_ratio`, `long_edge_px` (still used by the video step). Mirror the changes in `DEFAULT_SETTINGS` and in the PATCH validator. Ensure `seedDefaultSettings()` still works idempotently for existing DBs (it uses `INSERT OR IGNORE`, so removed keys will linger — add a one-shot migration that DELETEs the 7 removed keys).
  **Context**: Schema pattern at `src/lib/settings.ts:12-48`; defaults at `src/lib/db.ts:12-30`; seed logic at `src/lib/db.ts:32-42`; API PATCH validation at `src/app/api/settings/route.ts:31-74`.

- [ ] **Task 2: Update settings form UI**
  **Files**: `src/app/settings/settings-form.tsx`, any matching `src/app/settings/*` partials
  **What**: Remove fields for the 7 removed voice keys. Add fields for all new keys from Task 1 (grouped: "TTS" section and "Image" section). Preserve the dirty-diff pattern (only changed fields PATCH).
  **Context**: Form pattern at `src/app/settings/settings-form.tsx:42-92`; dirty-diff at lines 18-29; protected keys at lines 14-16.

### Phase 2: Provider abstractions

- [ ] **Task 3: Create image provider interface and registry**
  **Files**: `src/lib/image/types.ts`, `src/lib/image/index.ts`
  **What**: Define an `ImageProvider` interface with a single method that takes a batch of `{ id, prompt }` and a target directory, and writes files named `<id>.png` directly into the target directory. Export `getImageProvider(name: string): ImageProvider` that reads the registry and returns the instance. Only `"comfyui"` is registered in this iteration.
  **Context**: Mirror the dependency-injection pattern used in existing Freepik steps (e.g., `FreepikDeps` in `src/worker/steps/10-freepik-main-images.ts`). Keep the interface narrow — inputs in, files on disk out, no intermediate JSON maps.

- [ ] **Task 4: Create TTS provider interface and registry**
  **Files**: `src/lib/tts/types.ts`, `src/lib/tts/index.ts`
  **What**: Define a `TtsProvider` interface with a method `synthesize(text: string, outWavPath: string, opts: { seed, exaggeration, cfgWeight, temperature, referencePath, log? }): Promise<void>`. Output is always WAV; caller is responsible for MP3 transcode. Export `getTtsProvider(name: string): TtsProvider`. Only `"chatterbox"` is registered in this iteration.
  **Context**: Mirror the `opts.log` callback pattern from `src/lib/genaipro.ts:94-113`.

### Phase 3: ComfyUI provider

- [ ] **Task 5: Implement ComfyUI client**
  **Files**: `src/lib/image/comfyui.ts`
  **What**: HTTP client against ComfyUI's API (`POST /prompt` to enqueue, poll `GET /history/<prompt_id>` until the workflow completes, read the saved output image from ComfyUI's output directory, copy/move to the caller's target directory renamed to `<chunk_id>.png`). Workflow JSON is loaded from `comfyui_workflow_path` (setting); the prompt text is injected into the workflow's positive-prompt node at submission time. Seed is taken from `voice_seed` equivalent — no, use a new setting if needed, but for v1 allow ComfyUI to use its own seed (deterministic not required for images). Surface helpful errors when ComfyUI is unreachable.
  **Context**: Read the default workflow from a known node ID (document which one in the workflow file itself via a `_prompt_node_id` custom key, or pick the first `CLIPTextEncode` with `title` containing "positive"). Keep network config in settings (`comfyui_base_url`), not hardcoded.

- [ ] **Task 6: Create baseline ComfyUI workflow template**
  **Files**: `prompts/comfyui/default-workflow.json`, `prompts/comfyui/README.md`
  **What**: Export a working ComfyUI workflow JSON (checkpoint, positive/negative prompt, sampler, VAE, SaveImage) that produces 16:9 images at a sensible resolution. Resolution should match `aspect_ratio` guidance documented in the README. Include a short README explaining how to export a workflow from ComfyUI's UI (Save (API Format)), which nodes the HistForge client looks for, and how to swap checkpoints/LoRAs.
  **Context**: ComfyUI workflow format is the "API format" JSON (exportable via the UI's dev mode). The client needs to locate the positive-prompt text node and the SaveImage node — document the convention in the README.

### Phase 4: Chatterbox provider

- [ ] **Task 7: Create Chatterbox Python FastAPI server**
  **Files**: `python/chatterbox_server.py`, `python/requirements-chatterbox.txt`, `python/README.md` (if not existing, else update)
  **What**: FastAPI app exposing `POST /synthesize` that accepts JSON `{ text, seed, exaggeration, cfg_weight, temperature, reference_path }` and returns raw WAV bytes. Model loads once on startup. Add a `/health` endpoint. Provide `requirements-chatterbox.txt` listing chatterbox-tts, torch, torchaudio, fastapi, uvicorn, soundfile. Document that this venv is separate from the aeneas venv used by `python/align.py`.
  **Context**: Chatterbox's public API is `ChatterboxTTS.from_pretrained(device)` + `model.generate(text, audio_prompt_path, exaggeration, cfg_weight, temperature)`. Return WAV via `soundfile.write` to a BytesIO then `Response(content=buf.getvalue(), media_type="audio/wav")`. Raw bytes response — Node transcodes to MP3 downstream.

- [ ] **Task 8: Implement Chatterbox Node client**
  **Files**: `src/lib/tts/chatterbox.ts`
  **What**: HTTP client that POSTs to the Chatterbox server's `/synthesize`, writes the returned WAV bytes to `outWavPath`. Retries transient network failures (2-3 attempts, short backoff). Logs via `opts.log`. Surfaces a clear error if the server is unreachable (instruct the user to run `npm run tts:serve`).
  **Context**: Mirror the log-callback pattern from `src/lib/genaipro.ts:94-113`. Use standard `fetch` or `undici`; keep dependencies minimal.

- [ ] **Task 9: Add npm script for launching Chatterbox server**
  **Files**: `package.json`
  **What**: Add `"tts:serve"` script that invokes `uvicorn` on the Chatterbox server module (activated in the correct venv — document in setup guide). Do not wire it into `npm run dev`.
  **Context**: Existing script patterns in `package.json`. Keep command platform-agnostic where possible; Windows-specific activation lives in the setup guide.

- [ ] **Task 10: Ship default reference voice clip**
  **Files**: `data/voices/default.wav`, `data/voices/README.md`
  **What**: Add a ~10-second public-domain narration clip in WAV (16 kHz or 24 kHz mono, clean) as the default Chatterbox reference. README documents source, license, and how to replace it (file swap).
  **Context**: The path matches the `voice_reference_path` default in Task 1.

### Phase 5: Voiceover step restructure

- [ ] **Task 11: Add sentence splitter utility**
  **Files**: `src/lib/tts/sentence-split.ts`, `package.json`
  **What**: Install the `sbd` (sentence-boundary-detection) package. Wrap it in a utility that (a) splits chapter text into sentences handling common abbreviations ("A.D.", "St.", "Dr.", Roman numerals, dates), and (b) optionally groups very short sentences up to ~20 seconds of estimated speech (estimate: ~2.5 words/second). Export `splitAndGroup(text: string, maxSeconds: number): string[]`.
  **Context**: This is the textbook defense against Chatterbox drift. Cap segment length aggressively (~20s max) per user agreement in plan discussion.

- [ ] **Task 12: Rewrite voiceover step (06)**
  **Files**: `src/worker/steps/06-voiceover.ts`
  **What**: Replace the GenAI Pro call with the new chapter-scoped flow:
    1. Read `script/03_hook.md` and `script/04_chapter_01.md` … `04_chapter_<N>.md` (N from `chapter_count` setting).
    2. Load TTS provider via `getTtsProvider(settings.tts_provider)`.
    3. For each source (hook first, then each chapter): split into sentence groups via `splitAndGroup`; synthesize each group via Chatterbox to a temp WAV; concatenate WAVs in-memory with ~80ms silence between; ffmpeg-encode the concatenated WAV to MP3.
    4. Write `audio/hook.mp3` (from hook) and `audio/narration.mp3` (concatenation of chapter MP3s; no hook).
    5. Stream progress to `appendLog`. Preserve resume semantics by writing the output files atomically (temp + rename).
  **Context**: Current implementation at `src/worker/steps/06-voiceover.ts:33-49`. FFmpeg is already used elsewhere in the repo (step 14 render) — reuse the helper if one exists in `src/lib/`. The hook stays separate per user decision — stitch everything at render time.

### Phase 6: Alignment, chunking, render

- [ ] **Task 13: Update alignment step (07)**
  **Files**: `src/worker/steps/07-align.ts`, `python/align.py` (if it needs arg changes)
  **What**: Run aeneas twice: (hook.mp3, 03_hook.md) → `alignment/hook_alignment.json`; (narration.mp3, concatenated chapter text) → `alignment/main_alignment.json`. Remove dependence on `script/full_script.md` as the single alignment source if present; otherwise, write a small helper that materializes the chapter-only concatenation for aeneas.
  **Context**: Current align step reads `audio/narration.mp3` + `script/full_script.md`. The Python script `python/align.py` is the aeneas wrapper — check whether it accepts file paths as args (likely yes) and invoke it twice.

- [ ] **Task 14: Update chunking step (08)**
  **Files**: `src/worker/steps/08-chunk.ts`
  **What**: Read `alignment/hook_alignment.json` for hook chunks and `alignment/main_alignment.json` for main chunks. Remove the hardcoded 120s hook/main split. Hook produces chunks `hook_01..hook_NN` based on its actual duration (same grouping logic as before — sentence-based or fixed-duration groupings within the hook's own timeline). Main produces chunks `main_001..main_NNN` as today. Still emit one `chunks/chunks.json`.
  **Context**: Current implementation at `src/worker/steps/08-chunk.ts:26-100`. The 120s time split must go; use the actual hook audio length. Downstream consumers (step 10/11 image gen, step 12 video gen) read `chunks.json` by `kind` (`hook` vs `main`) and expect `id`, `start`, `end`, `text`, `prompt` unchanged.

- [ ] **Task 15: Update render step (14)**
  **Files**: `src/worker/steps/14-render.ts`
  **What**: Compose the final video with hook audio (`audio/hook.mp3`) during the hook section and narration audio (`audio/narration.mp3`) during the main section, back-to-back. A small gap or crossfade (~100-200ms) between them is acceptable. Adjust any timing offsets — main chunk timestamps are relative to narration.mp3's start (0), not the full video timeline, so add `hook_duration` offset when placing main visuals.
  **Context**: Current render composes one narration track. The hook-duration offset must propagate from the chunking step or be recomputed from hook.mp3's duration at render time. Prefer recomputing from the audio file to keep the contract small.

### Phase 7: Image step renaming and implementation

- [ ] **Task 16: Replace step 10 with ComfyUI-backed `generate_main_images`**
  **Files**: new `src/worker/steps/10-generate-main-images.ts`; delete `src/worker/steps/10-freepik-main-images.ts`
  **What**: New step named `generate_main_images`. Reads `chunks/chunks.json`, filters `kind === "main"`, calls `getImageProvider(settings.image_provider).generateBatch(chunks, "images/main/")`. No id_map file — provider writes `<chunk_id>.png` directly. Preserve any existing retry / resume semantics (skip chunks whose output file already exists).
  **Context**: Current Freepik main images step at `src/worker/steps/10-freepik-main-images.ts:27-79` as a reference for retry/resume logic. Use the same dependency-injection pattern for testability.

- [ ] **Task 17: Replace step 11 with ComfyUI-backed `generate_hook_images`**
  **Files**: new `src/worker/steps/11-generate-hook-images.ts`; delete `src/worker/steps/11-freepik-hook-images.ts`
  **What**: Same as Task 16 but filters `kind === "hook"` and writes to `images/hook/`.
  **Context**: Current hook images step for patterns. Same interface as Task 16.

- [ ] **Task 18: Update Freepik hook-videos step (12)**
  **Files**: `src/worker/steps/12-freepik-hook-videos.ts`
  **What**: Update the input path for hook images from `freepik/hook/` (or wherever step 11 previously wrote) to `images/hook/`. Update the output hook id_map path from `freepik/hook_id_map.json` to `videos/hook_id_map.json`. Verify that Freepik's image-to-video upload flow still works given the new image source paths (user confirmed it accepts uploaded local images).
  **Context**: Current implementation reads hook image locations that were populated by step 11 + step 13 (download). After the change, step 11 writes the ComfyUI images directly to `images/hook/` with no download step for images.

- [ ] **Task 19: Rename step 13 to `download_hook_videos` and remove image paths**
  **Files**: new `src/worker/steps/13-download-hook-videos.ts`; delete `src/worker/steps/13-download-assets.ts`
  **What**: Strip the image-download branch (old `main_id_map.json` → `.png` download, current lines 69-75). Keep only the video-download branch (current lines 81-86), reading `videos/hook_id_map.json` and writing to `videos/hook/`.
  **Context**: Current dual-purpose downloader at `src/worker/steps/13-download-assets.ts:34-88`.

### Phase 8: Freepik library trim and deletions

- [ ] **Task 20: Delete GenAI Pro client**
  **Files**: `src/lib/genaipro.ts`
  **What**: Delete the file. Verify no remaining imports (`src/worker/steps/06-voiceover.ts` was the only consumer).
  **Context**: Clean removal; git history preserves it.

- [ ] **Task 21: Trim image paths from `src/lib/freepik/*`**
  **Files**: `src/lib/freepik/generate.ts`, `src/lib/freepik/download.ts`, `src/lib/freepik/session.ts`, `src/lib/freepik/selectors.ts`, `src/lib/freepik/relogin-state.ts`
  **What**: Audit each file. Remove code paths used only by image generation (e.g., image-specific selectors, image-only branches in `submitBatch`/`downloadProjectFolder`). Preserve the code the video step (12) and the new video-only download step (13) need: session management, video-generation submission, video-ZIP download with correct rename. Keep `relogin-state.ts` and the `FreepikSessionLost` error — still needed for video.
  **Context**: Files at `src/lib/freepik/session.ts:66`, `generate.ts:141`, `download.ts:162`, `selectors.ts:51`. Careful audit — image and video paths share helpers.

### Phase 9: Pipeline orchestrator updates

- [ ] **Task 22: Update `REAL_STEPS` registration**
  **Files**: `src/worker/steps/index.ts`
  **What**: Remove imports/exports for the deleted files (`10-freepik-main-images`, `11-freepik-hook-images`, `13-download-assets`). Add the new ones (`10-generate-main-images`, `11-generate-hook-images`, `13-download-hook-videos`). Order stays the same.
  **Context**: `src/worker/steps/index.ts:22-38`.

- [ ] **Task 23: Update `STEP_ORDER` and `STEP_OUTPUTS`**
  **Files**: `src/worker/pipeline.ts`
  **What**: Rename step IDs in `STEP_ORDER` (freepik_main_images → generate_main_images; freepik_hook_images → generate_hook_images; download_assets → download_hook_videos). In `STEP_OUTPUTS`, update artifact paths to reflect new folder names: `generate_main_images: ["images/main"]`, `generate_hook_images: ["images/hook"]`, `freepik_hook_videos: ["videos/hook_id_map.json"]` (was appending to hook_id_map — now self-contained), `download_hook_videos: ["videos/hook"]`. Update step 06's outputs to include both `audio/hook.mp3` and `audio/narration.mp3`. Update step 07's outputs to include both alignment files.
  **Context**: `src/worker/pipeline.ts:57-73` (STEP_ORDER), `82-109` (STEP_OUTPUTS). Session-loss handling at line 275-276 stays.

- [ ] **Task 24: Update cleanup step (15)**
  **Files**: `src/worker/steps/15-cleanup.ts`
  **What**: Update folder paths referenced during cleanup to `images/main`, `images/hook`, `videos/hook`, `alignment/*`, `audio/*`. Remove references to `freepik/main`, `freepik/hook`, `freepik/main_id_map.json`. Keep `videos/hook_id_map.json` handling.
  **Context**: Current cleanup is flagged as temporarily disabled at `src/worker/steps/index.ts:37` — confirm whether this plan re-enables it or keeps it disabled (keep behavior as-is; only update paths).

### Phase 10: Documentation

- [ ] **Task 25: Write ComfyUI setup guide**
  **Files**: `docs/setup-comfyui.md`
  **What**: Step-by-step install instructions for Windows: download ComfyUI portable (or install from GitHub), install at least one checkpoint (recommend a general-purpose SDXL checkpoint), launch ComfyUI, verify it's reachable at the default URL. Explain the workflow file: how to export the default workflow from the UI, which nodes HistForge looks for (positive-prompt text, SaveImage), how to tweak for styles/LoRAs, where to put the JSON. Troubleshooting section (port conflicts, VRAM, missing models).
  **Context**: User runs on Windows (confirmed). Keep it pragmatic — link to ComfyUI's official repo for deep details.

- [ ] **Task 26: Write Chatterbox setup guide**
  **Files**: `docs/setup-chatterbox.md`
  **What**: Step-by-step install on Windows: create a dedicated Python venv (separate from the aeneas venv), activate, `pip install -r python/requirements-chatterbox.txt`, note hardware expectations (GPU strongly recommended, ~6 GB VRAM), first-run model download, launch via `npm run tts:serve`, verify `/health` endpoint. Troubleshooting (torch CUDA install, model download failures, reference-clip tips — clean ~10s WAV, mono, 16/24 kHz). Explain how to swap the reference clip (file swap at `data/voices/default.wav`).
  **Context**: Two-venv setup is intentional to avoid dep conflicts with aeneas.

- [ ] **Task 27: Update `CLAUDE.md`**
  **Files**: `CLAUDE.md`
  **What**: Link to the two new setup guides from the Troubleshooting or Architecture section. Update the Development Commands section to include `npm run tts:serve`. Mention that ComfyUI must be running for image steps, Chatterbox server must be running for TTS.
  **Context**: Existing file structure already has a Project Skills table and Troubleshooting section — slot the additions in naturally.

- [ ] **Task 28: Update design spec**
  **Files**: `docs/histforge-spec.md`
  **What**: Update the following sections:
    - §4 DB Schema (lines 167-242): replace the 7 removed voice keys with the new TTS keys, add the new image keys.
    - §6 Pipeline Step List (lines 284-315): rename steps 10, 11, 13 and note the new folder paths; document the hook/narration audio split in step 06; document dual alignment in step 07.
    - §8 Voiceover (lines 362-396): rewrite entirely. Describe the per-chapter, sentence-split-and-stitch flow with Chatterbox, the external Python server, the reference-clip approach, and the hook/narration file split.
    - §12 Freepik Agent (lines 467-542): delete the image-generation subsections (12.1–12.4 per investigation notes); retain the video subsections. Add a new §11 or §11b describing the image-provider abstraction and ComfyUI.
    - §13 Render (lines 544-612): document the two-audio-track composition.
    - §14 Cleanup (lines 614-628): update artifact paths.
    - §15-21 (lines 631-821): minor touches to config/env and dashboard settings docs.
  **Context**: Spec is the canonical reference per `CLAUDE.md`. Keep the style and heading structure consistent with the rest of the doc.

## References
- `docs/histforge-spec.md` — spec (sections §4, §6, §8, §12, §13, §14, §15-21 to be updated)
- `src/worker/pipeline.ts:57-73` — STEP_ORDER
- `src/worker/pipeline.ts:82-109` — STEP_OUTPUTS
- `src/worker/steps/index.ts:22-38` — REAL_STEPS registration
- `src/worker/steps/06-voiceover.ts:33-49` — current voiceover step
- `src/worker/steps/08-chunk.ts:26-100` — current chunking (120s hook split to remove)
- `src/worker/steps/13-download-assets.ts:34-88` — dual image/video download (image path to strip)
- `src/lib/settings.ts:12-48` — settings schema
- `src/lib/db.ts:12-30` — settings defaults
- `src/lib/genaipro.ts` — to be deleted
- `src/lib/freepik/*` — to be trimmed, not deleted (video paths preserved)
