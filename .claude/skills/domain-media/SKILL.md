---
name: domain-media
description: Guide for the media production pipeline — voiceover, audio-text alignment, chunking (three asset-typed variants), image + clip generation, and FFmpeg rendering. Use when modifying steps 06-08 (any of the three chunker variants), the unified `generate_images` / `generate_clips` steps, step 14 (render), step 15 (cleanup), or any TTS / image / video / alignment / render library. For the Google Flow worker plumbing (queue, webhooks, reaper, accounts, moderation), see `domain-google-flow-coordinator` instead.
---

# Media Production Pipeline

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Step slugs**: `voiceover`, `align`, `generate_images`, `generate_clips`, `render`, `cleanup`
- **Chunker variants** (values of `chunker_step`): `chunk_clips_then_images`, `chunk_images_only`, `chunk_clips_only`
- **Provider registry surface**: `TtsProvider`, `ImageProvider`, `VideoProvider`, `getTtsProvider`, `getImageProvider`, `getVideoProvider`, `makeGoogleFlowImageProvider`, `makeGoogleFlowVideoProvider`, `comfyuiProvider`, `comfyuiVideoProvider`, `generateHookVideoBatch`, `TTS_PROVIDER_META`
- **Library entry points**: `align`, `wslPath`, `render`, `computeResolution`, `findGroupEnd`, `makeChunk`, `wavBytesToMp3`, `startChatterboxLivenessWatcher`
- **Workflow + provider-selection settings**: `tts_provider`, `image_provider`, `video_provider`, `chunker_step`
- **Render + ComfyUI setting keys**: `aspect_ratio`, `long_edge_px`, `framerate`, `video_encoder`, `comfyui_base_url`, `comfyui_workflow_path`, `comfyui_hook_video_workflow_path`
- **Env vars**: `AI33_API_KEY`, `GENAIPRO_API_KEY`, `WSL_DISTRO`

## Architecture

Media production turns the assembled script into a finished `.mp4`. Four phases:

1. **Audio** (steps 06-08) — TTS voiceover, forced alignment via aeneas (WSL), sentence-to-chunk grouping. Step 08 is the **chunker slot**: a workflow's `chunker_step` column picks one of three chunker variants, each emitting a different distribution of `Chunk.kind` (`"clip"` and/or `"image"`).
2. **Image / clip generation** — `generate_images` and `generate_clips` each filter `chunks.json` by chunk kind and dispatch to a provider threaded onto `StepContext`. Either step is a no-op when its provider column is null in the snapshot — that's how workflows 2 and 3 drop one of the two steps. ComfyUI is the local provider; Google Flow is the remote-browser provider. Step 09 (`generate_visual_prompts` — supplies the prompts these steps consume) lives in `domain-content-gen`.
3. **Render** (step 14) — FFmpeg composition. For workflow 1 (clips + images): clip concat (Stage A), per-segment zoompan renders (Stage B), a **fused** Stage CD that builds the image-xfade chain + clip→image crossfade in one ffmpeg invocation, audio mux (Stage E). Workflow 2 (images only) bypasses Stage A entirely; workflow 3 (clips only) stream-copies the Stage A output past the xfade work straight to the audio mux. Stages A and B run **concurrently** because they share no inputs.
4. **Cleanup** (step 15) — Strip intermediates, keep only `final.mp4`, the script, and `pipeline.log`.

External dependencies: **AI33** and **GenAIPro** are ElevenLabs-compatible cloud TTS backends; **Chatterbox** is a local-server option (devnen wrapper); **Chatterbox (fast)** is a parallelism-capable sidecar (rsxdalv/chatterbox@fast) that accepts batched chunks; **aeneas** runs under WSL via Python; **ComfyUI** runs locally and must be up before any ComfyUI provider step; **ffmpeg** is on PATH and spawned directly. The Google Flow path uses a Chrome-extension dumb runner (see `domain-youforge-flow`) and a HistForge-side coordinator (see `domain-google-flow-coordinator`) — no Playwright is involved.

**Freepik is gone.** The pre-overhaul Freepik browser automation was removed. Video clips are now text-to-video directly via the video provider; no image-to-video bridging step exists.

## Setting-key vocabulary

The Phase-2 rename swapped `"hook" | "main"` → `"clip" | "image"` across chunk kinds, on-disk paths, step slugs, and queue/moderation enums. **Setting keys deliberately kept the historic `hook_` prefix** — `hook_video_clip_seconds`, `comfyui_hook_video_workflow_path`, `google_flow_hook_clip_seconds`, `hook_length_seconds` — because they describe per-clip target physics for workflow 1's hook section and survive as workflow-1 vocabulary. The clip-only chunker (workflow 3) reuses the same `getHookClipSeconds` helper for its per-chunk target; the `hook_` prefix becomes a documented historic artifact rather than load-bearing terminology. Don't rename these keys "for consistency" — it would force a settings migration with no semantic gain.

## Provider Registry Pattern

TTS, image, and video each ship with the same shape — an interface module, a registry keyed by setting/snapshot string, and per-backend modules. The orchestrator resolves providers once per run from the workflow snapshot and threads them onto `StepContext` — steps pull from `ctx`, never the registry directly, so tests can inject fakes.

**Singletons mixed with factories.** Stateless providers register as singletons. Providers that need per-run dependencies register as a factory `(deps) => Provider` so the dependency closure happens at run time, not module-load time. The Google Flow factories close over a `PromptModerator` built once per run; keeping it in the closure makes the content-policy re-entry loop a coordinator concern rather than something every step threads on its opts. The registry records remain the single enumeration source — the schema endpoint and workflow editor enumerate `Object.keys(imageProviders)`.

Image and video are **intentionally separate registries**: a workflow can use ComfyUI for images and Google Flow for clips (or any other combination), so they bind to independent `image_provider` / `video_provider` slots. The unified `generate_images` and `generate_clips` step slugs replaced the old per-provider slugs (`*_comfyui`, `*_google_flow`); orchestration now branches inside the provider, not at the step boundary.

**`generateBatch` opts stay narrow.** The pre-refactor `chat` / `promptsDir` fields were dropped: those are coordinator concerns (LLM moderator) that now live in the factory closure. Widening the opts re-opens the cross-provider coupling the closure was meant to encapsulate.

For the LLM registry pattern this mirrors, see **`domain-content-gen`**. For StepContext + the per-run DI mechanics, see **`domain-pipeline`**. For how a workflow row's `image_provider` / `video_provider` columns drive step materialization, see **`domain-workflows`**. For the moderator's role and the queue/webhook contract Google Flow uses, see **`domain-google-flow-coordinator`**.

## Audio Phase

### TTS (Step 06 — `voiceover`)

Reads the assembled script, produces `narration.mp3`. Four providers ship: **AI33** and **GenAIPro** (ElevenLabs-compatible cloud APIs with subtly different request shapes — AI33 nests voice tuning under `voice_settings`, GenAIPro is flat) plus **Chatterbox** and **Chatterbox (fast)** (two local sidecars sharing transcode + liveness plumbing but exposing different wire shapes — see below). The step is provider-agnostic; the provider is resolved from the snapshot once and threaded via `ctx`.

**Cloud-provider invariants (AI33 / GenAIPro — Chatterbox variants do none of this):**
- **No overall poll timeout.** A 2-hour audio job is normal; adding a timeout caused spurious failures pre-overhaul. A bound on *consecutive non-fatal poll failures* prevents a permanently-down upstream from spinning forever (counter resets on a schema-valid response).
- **Task-id sidecar for resume.** Written next to the output after a successful submit, deleted after download. A worker restart mid-poll resumes the existing (paid) task instead of submitting a duplicate. Terminal failure wipes it via `step.outputs`; the providers deliberately do not wipe it on throw.
- **Cancellation is terminal.** `AbortError` short-circuits both retries and the poll loop.

Design decisions worth preserving:
- **All voice params come from Settings**, not env. The operator controls voice tuning from the dashboard. Only API keys live in `.env`; everything else is DB-backed.
- **Per-provider operator metadata** (label, env-var name, endpoint) lives in a single client-safe metadata module so the Settings TTS panel and the worker providers share one source of truth. The metadata module has no `node:` imports so the UI bundle stays clean. Local providers use an empty-string `envKey`; worker code must **never** do `process.env[envKey]` for those — it would read whatever the empty-string env happens to be set to.
- **Transcripts are saved when the provider returns them.** Alignment doesn't consume them yet, but don't remove them "because nothing reads them" — future changes (e.g., swapping aeneas for WhisperX) may hinge on them.

#### Chatterbox vs Chatterbox (fast) vs cloud providers

Both Chatterbox variants diverge from the cloud submit/poll/sidecar pattern — each is a single synchronous HTTP request that returns audio bytes inline. They differ from each other in chunking and wire shape, not in the spawn/transcode/liveness plumbing they share.

- **Custom endpoints, not OpenAI-compat.** Neither uses the OpenAI `/v1/audio/speech` route — both wrappers' custom endpoints expose voice-selection fields the OpenAI route hides, which makes `chatterbox_voice_mode` / `chatterbox_voice_filename` load-bearing rather than decorative.
- **Sentence-aware chunking (fast variant).** `chunkScript` is a pure-function tokenizer that sentence-splits with an abbreviation guard ("Mr.", "U.S.", "e.g."), greedy-packs to a configured char budget, and falls back through `; : — ,` and word boundaries. The plain ASCII hyphen is **deliberately not** a secondary splitter — splitting on it tears compound words ("well-being"). The sidecar generates chunks in parallel (one model per worker, leased from a thread-safe pool) and joins them with configurable silence.
- **WAV-bytes transcode lives next to the providers, not in render.** It's a TTS wire-format adapter, not a rendering concern.
- **Speed handling lives in the transcode.** `chatterbox_speed_factor` is applied via ffmpeg's `atempo`, not on either wrapper. Chatterbox-fast's `model.generate()` exposes no speed parameter, and devnen's `speed_factor` path produces audible distortion at sub-1.0 rates — applying tempo client-side gives identical deterministic behavior across both variants.
- **Liveness watcher counts fetch errors, not probe timeouts.** The synchronous `/tts` handler holds PyTorch's GIL during inference, which blocks `/health` from responding for minutes at a time — counting those would kill in-progress turbo-model runs as false positives. The synthesize caller distinguishes a liveness-driven abort from a user-driven one via the abort reason and translates the former into a clear "server unreachable at X" error.
- **Fetch timeouts are disabled.** Both variants use a private undici `Agent` with zero header/body timeouts so multi-hour generations don't get killed by undici's default. The trade-off (server crashing mid-request leaves fetch waiting forever) is exactly what the liveness watcher covers.
- **No sidecar, no resume.** There's no remote task to resume; a worker crash just retries on the next run. Don't retrofit the cloud sidecar pattern onto either Chatterbox variant — see Common Pitfalls.

### Alignment (Step 07 — `align`)

Forced alignment runs via WSL because aeneas doesn't install cleanly on native Windows but is trivial in WSL2. The step is Windows-native + WSL-hybrid by design.

The Python script is the only thing that touches aeneas — TS code is responsible for sentence-splitting (sbd-based), spawning under WSL, and translating paths via `wslPath`; the script normalizes aeneas's `fragments`-wrapped output into the flat `[{ id, text, begin, end }, ...]` shape the rest of the pipeline expects, and writes the JSON itself.

The Python script is invoked through an **explicit venv interpreter**, not the bare `python3` symlink, because on NTFS-mounted WSL paths the symlink resolves to the system Python which can't see the venv's site-packages.

The `align` interface is deliberately generic (audio path, script path, output path) so a future drop-in replacement (WhisperX, cloud aligner) can swap in without touching step code.

### Chunking (Step 08 — `chunker_step` slot)

Step 08 is the **chunker slot**: a workflow's `chunker_step` column picks exactly one of three sibling chunker modules. All three share helpers in chunk-utils and write the same `chunks.json` shape — they differ only in which `Chunk.kind` values they emit and how the narration is partitioned.

- **`chunk_clips_then_images`** (workflow 1: hook clips + image body) — Two passes. The clip pass walks sentences from t=0, cuts at the nearest sentence boundary, and emits up to a derived clip-count (`round(hook_length_seconds / clip_seconds)`) of `clip_NN`-id chunks. Both the bound and the per-group target come from the **paired provider-aware helpers** (`getDerivedHookChunkCount` + `getHookClipSeconds`) so they can't drift: when `video_provider` is `google_flow` they resolve from the `google_flow_hook_*` keys, otherwise from `hook_video_*`. The image pass partitions remaining sentences with `image_NNN` ids.
- **`chunk_images_only`** (workflow 2) — Single-pass image partitioning over the whole narration; the snapshot pins `video_provider = null` so `generate_clips` drops out of the materialized step list.
- **`chunk_clips_only`** (workflow 3) — Single-pass clip partitioning over the whole narration. The same `getHookClipSeconds` helper drives the per-clip target — its "hook" prefix is a historic artifact (the per-clip duration physics are identical between workflow 1's hook and workflow 3's whole video). `image_provider = null` drops `generate_images`.

**Consistency rule.** The chunker variant and the provider columns must agree. The workflow validator enforces this at edit time and `bootValidate` re-checks every workflow at worker start.

**Field rename gotcha:** Alignment entries use `begin`/`end` (aeneas's convention); chunks use `start`/`end`. `makeChunk` translates. Don't confuse the two when modifying.

All `prompt` fields start as `null` — they are populated by step 09. The sum of chunk durations exactly equals the audio length: chunking leaves no gaps and no overlaps. Overlaps are introduced later by the render's xfade.

## Image + Clip Generation

### Step shape

`generate_images` and `generate_clips` are thin: filter `chunks.json` by `Chunk.kind`, build `{ id, prompt }` items, hand them to the provider's `generateBatch`. The provider returns either void (synchronous, e.g. ComfyUI) or a `DeferSignal` (Google Flow when every account is in cooldown). Either is propagated upward unchanged. The step's `outputs` array is empty because cleanup is provider-delegated via the optional `cleanup` hook on the provider interfaces. Target dirs are **asset-typed** post-Phase-2: images under `images/`, clips under `videos/clip/` (replacing the old `images/main/` and `videos/hook/` layouts).

### ComfyUI — one library, two entry points

The ComfyUI client exposes two batch functions sharing one HTTP client: an image batch on `comfyuiProvider`, and `generateHookVideoBatch`. The "HookVideo" name is a historic artifact — only step slugs and on-disk paths were renamed in Phase 2; the internal symbol stayed for diff-locality. `comfyuiVideoProvider` is a thin wrapper that adapts the `VideoProvider` interface onto this batch — no separate HTTP plumbing.

**Prompt node discovery:** priority 1 is a node explicitly flagged `_histforge_prompt: true`; priority 2 is the first `CLIPTextEncode` by ascending numeric key. The marker field lets custom workflows tag their prompt node unambiguously while keeping simple workflows working out of the box. **Node keys are strings** in ComfyUI's JSON format even though they look numeric — do not convert them.

**Image output-node discovery:** first `SaveImage`/`PreviewImage`. **Video output-node discovery:** matches by class-name pattern (`SaveVideo*`, `VHS_VideoCombine`, etc.) — different text-to-video backends (SVD, AnimateDiff, LTX, Wan) use different output nodes, so a fixed whitelist would force a HistForge patch every time the user swaps backends.

**Image vs video poll differ.** Image nodes always emit under `.images`; video nodes use varying keys (`videos`, `gifs`, `files`) so the video poller iterates and matches by "array of `{filename, subfolder, type}`-shaped entries". Don't unify the two — see Common Pitfalls.

**Resume:** existing outputs are skipped by filename existence check. No ID maps — paths are deterministic.

**Resolution** via `computeResolution` (same helper the renderer uses, so images and render always agree). Width and height round to even (libx264 requirement).

**Sequential processing.** Items are submitted one at a time. ComfyUI queues internally, so batching at the HTTP level would just move the queue — single-threaded makes logging and error handling much simpler.

**ComfyUI errors** distinguish unreachable-server (clear "ComfyUI is unreachable at X" message) from execution errors (extracted from the history entry's `status.messages`). Keep the distinction; operators read these literally. A consecutive-poll-failure counter (same pattern as TTS) bounds permanently-wedged states.

### Default image workflow

A minimal SDXL image workflow ships. The video workflow is **not shipped**; the user drops their own at the configured path, and `generate_clips` raises a clear "drop your ComfyUI video workflow at X" error if missing. This is deliberate — different hardware and model preferences (SVD, AnimateDiff, LTX, Wan) don't have a one-size-fits-all default.

### Google Flow

`makeGoogleFlowImageProvider` and `makeGoogleFlowVideoProvider` are factories that build worker-side adapters for the queue-and-webhook contract with the YouForge Flow Chrome extension. They are thin factories over a shared `runGoogleFlowStep` helper — differing only in chunk-kind, queue-kind, output dir, and extension. Each closes over the run's `PromptModerator` so the content-policy re-entry loop stays in the coordinator rather than leaking through provider opts. Output paths match ComfyUI's, so render and cleanup don't care which provider produced them — but the orchestration is fundamentally different (the provider yields a `DeferSignal` instead of blocking, downloads are SSRF-gated and atomic, and `cleanup` is a **deliberate no-op** so deletion of the output dir mid-flight does not orphan in-flight queue rows).

The Veo variant key for a given (base model, clip seconds) pair is resolved by `resolveHookVideoModelKey` — the dispatch route calls it at claim time so the Chrome-extension SW receives the right variant key without re-implementing the irregular mapping table.

**Do not edit Flow specifics from this skill.** Queue, reaper, webhook routes, account UI, dispatch/retry contract, and the moderation re-entry loop all live in **`domain-google-flow-coordinator`**.

## Render Phase (Step 14)

The render library owns all ffmpeg command construction and **spawns ffmpeg directly via Node `spawn`** so the orchestrator's AbortSignal kills the in-flight child on cancellation (the original `execFileSync` was structurally uninterruptible). Stderr is buffered (capped) and surfaced in rejections so operators reading `pipeline.log` see what ffmpeg complained about.

The renderer splits chunks by `kind` and dispatches through four stages. Topology depends on which kinds are populated, which mirrors the workflow's chunker variant:

- **A — Clip concat.** Per-chunk audio-video binding via ffprobe + `tpad=clone` to cover each chunk's audio span; the timed clips are then concat-demuxed (no crossfade — they should look like one continuous video). When image chunks follow, a re-encoded last-frame still is appended for crossfade tail; the held-frame tail is **skipped in clips-only** because there's no xfade bridge. Skipped entirely when there are no clip chunks (workflow 2).
- **B — Per-segment renders.** Each image chunk's PNG becomes a zoom-in segment via pre-upscale + `zoompan`. The per-chunk pre-crop upscale buffer is derived by `deriveZoomBuffer` (ADR-0005). Non-last segments are rendered with extra crossfade-duration content so Stage CD's xfade has overlap; the last segment uses exact duration. **Stages A and B run concurrently** because they share no inputs.
- **CD — Fused image-xfade chain + clip→image crossfade.** One ffmpeg invocation. Five sub-cases keyed on (clip count, image count): two stream-copy fast paths and three re-encoding paths. When clips and images are both present, the clip stream is normalized to target W×H/SAR/fps/yuv420p (Google Flow clips arrive at different resolution/framerate, and xfade requires both inputs to agree). **xfade offset is cumulative chunk duration, never with CF subtraction** — see Common Pitfalls. **Disk-segment inputs are normalized to AVTB before xfade** via `settb=AVTB`; without it, NVENC's pixfmt negotiation triggers filter-graph reinit and mid-chain xfades reject with "input link timebases do not match" (libx264 happens to skip reinit and silently masks the bug). The Stage CD encoder is selectable via `video_encoder`; **Stages A and B keep their libx264 args** — encoder selection only applies to Stage CD's re-encoding sub-cases. AV1 NVENC requires RTX 40-series or newer.
- **E — Audio mux.** Stream-copy video, AAC audio, `-shortest`.

**Constants live in the render library, not Settings:** crossfade duration, zoom target, segment concurrency. Changing these globally changes every future video's feel/throughput; they're deliberately not user-tunable.

**Resolution** via `computeResolution`. Landscape/square uses long edge as width; portrait uses it as height. Short edge rounds to even (libx264 requirement).

**Placeholder fallback** for missing image-chunk images: a black frame with "MISSING: <chunk_id>" drawtext via `buildPlaceholderArgs`. Logged but does not fail the step — a handful of missing chunks should not block a 2-hour render. **Clip videos are not placeholder-safe** — see Common Pitfalls.

**On retry, the render dir is wiped first.** No segment caching — start fresh. Belt-and-suspenders with the orchestrator's default cleanup; the renderer also deletes internally so direct test invocations are self-contained.

**Filter-graph size at scale:** for ~240-segment videos the xfade filter-graph string is large but feasible. If ffmpeg argv length becomes a problem, fall back to pair-wise xfade reduction (intermediate files). Hasn't been needed yet.

## Cleanup (Step 15)

**Enumerate-and-delete against a keep set**, not delete-from-a-list. This is robust to future files being added to project dirs — new intermediate files are automatically cleaned without touching the cleanup step.

If cleanup itself fails mid-run, the project dir is left half-tidied; there's no recovery mechanism because the keep set is well-defined enough that a human can finish manually. The step's empty `outputs` array intentionally **skips** default orchestrator cleanup — it would be nonsensical to undo a partial cleanup by deleting more.

## Common Pitfalls

- **Image and video are independent registries, and stateful entries are factories — not singletons.** Adding a backend means registering it in *both* registries and choosing factory-vs-singleton: anything closing over a coordinator-built dep (like `PromptModerator`) is a factory; stateless backends are singletons. **Why:** collapsing the registries again loses mix-and-match (ComfyUI for images + Google Flow for clips); eagerly resolving Google Flow at module load pins a stale moderator into the wrong run.
- **`generateBatch` opts stay narrow.** Don't add `chat` / `promptsDir` / other coordinator-shaped fields back onto the provider opts. **Why:** the depth-audit refactor moved the moderator into the closure precisely to keep step → provider plumbing narrow; widening the opts again drags every provider back into the moderation coupling the closure was meant to encapsulate.
- **The chunker variant and the provider columns must agree.** `chunk_clips_then_images` requires both providers; `chunk_images_only` requires image-only; `chunk_clips_only` requires video-only. The validator and `bootValidate` enforce this, but understand the *why*: the chunker decides the `Chunk.kind` distribution, and the asset-generation steps filter by it. **Why:** these three knobs are conceptually one decision (the video shape) — splitting them across columns is a UI convenience that the consistency rule re-couples.
- **Clip videos must all exist for render to succeed; images get a placeholder.** Don't add a placeholder fallback for clips. **Why:** in workflow 1 the clip section opens the video — a "MISSING: clip_03" frame at second 30 of a YouTube upload is far worse than a hard fail that asks the operator to re-run the clip step. In workflow 3 every frame is a clip, so a placeholder would be even more disruptive.
- **Don't unify the image and video ComfyUI poll functions.** Image nodes always emit under `.images`; video nodes use varying keys depending on the backend (SVD/AnimateDiff/LTX/Wan/VHS). **Why:** unifying them requires either overspecific matching (breaks uncommon video backends) or overbroad matching (picks up unrelated outputs like preview thumbnails).
- **Don't retrofit the cloud-provider sidecar/poll/timeout pattern onto either Chatterbox variant.** Both wrappers return audio inline from a single HTTP call — there's no remote task ID to persist, no submit-vs-download race to recover from, and no paid task to lose money on. The right protection against a wedged sidecar is the liveness watcher (already wired), not a `task_id` sidecar. **Why:** the cloud sidecar exists to protect against duplicate-charging on paid APIs; adding it to a local provider would be inventing infrastructure for a problem that doesn't exist. Likewise, **counting `/health` probe timeouts toward the liveness threshold is wrong** — chatterbox-devnen's sync `/tts` handler holds the GIL during inference, so timeouts on `/health` are ambiguous (busy ≠ dead) and killing the run on a timeout streak would false-positive every turbo-model job.
- **WSL is only for aeneas.** Every other subprocess (ffmpeg, ComfyUI HTTP, TTS HTTP) runs natively on Windows. Don't route anything else through WSL. **Why:** the `\\wsl$\` path-translation cost shows up quickly, and it pulls in a Python venv dependency that has nothing to do with most steps.
- **The xfade chain offset is cumulative *chunk* duration, never with `CF` subtraction.** Each non-last segment is rendered with `D_i + CF` content, so `offset_i = R_i − CF = D_i` on the first transition and `cumSum(D)` after. **Why:** the rendered-duration intuition (subtract CF because the segment is longer) produces visible jumps. The other render trap in this neighbourhood is forgetting `settb=AVTB` on disk-segment inputs — libx264 silently masks the missing-timebase bug but NVENC's pixfmt negotiation triggers filter-graph reinit and the xfade chain rejects mid-stream. Don't drop the `settb` step "for cleanliness".
