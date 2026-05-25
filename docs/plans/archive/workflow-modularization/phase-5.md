# Phase 5 — Video Provider Registry + Google Flow as Registered Provider

**Cross-phase invariants:** [`README.md`](README.md) — Invariant A (transitional provider→slug mapping **deleted this phase**), Invariant B (snapshot shape unchanged but materializer output changes), Invariant C (snapshot-validity check **added this phase** — point 3), Invariant D (`providers.image`/`providers.video` switch from hardcoded arrays to `Object.keys(<registry>)`), Invariant E (`generateBatch` opts must thread `ctx.chat` for prompt-rewriting providers)

**Phase progress (read first if resuming in a new session):**
- 5A — done.
- 5B — done. **Folded in partial 5C work** (Task 12 fully, Task 13 videoProvider half) and **partial 5F work** (Task 19 fully, Task 22 partially) to keep the test suite green at every commit. See the "Phase 5B landing notes" block at the top of §Tasks → Phase 5B.
- 5C — done.
- 5D — done.
- 5E — done. See "Phase 5E landing notes" under Task 16. **Folds in Task 22 fully** (snapshot regen verified byte-identical, no remaining work).
- 5F — done. Tasks 17, 18, 21 already covered by existing test files (verified passing). Tasks 20 + 23 added together as a new `runPipeline — Phase 5 snapshot-driven provider resolution (integration)` block in `__tests__/unit/worker/pipeline-workflow.test.ts` — uses a capture step (no provider deps overrides) so the snapshot's `image_provider` / `video_provider` columns drive registry lookup for real, and asserts identity against the live `imageProviders` / `videoProviders` exports for both seeded workflows and a cross-provider mix.

---

## Overview

Create the `VideoProvider` interface + registry, mirroring the TTS / Image registry shape. Register `google_flow` as a real `ImageProvider`; register `comfyui` and `google_flow` as `VideoProvider`s. Collapse the four `generate-*-{comfyui,google_flow}.ts` step files into two unified slugs — `generate_main_images` and `generate_hook_video` — that dispatch via `ctx.imageProvider` / `ctx.videoProvider`. Delete the Phase 1 transitional mapping (README Invariant A) so `materializeStepList` emits the unified slugs directly. Add the Invariant C point 3 snapshot-validity check to `bootValidate` so any in-flight video snapshotted with a legacy slug surfaces a clear boot error rather than silently breaking. Settings UI for both providers stays unchanged — the provider selection moved to per-workflow rows in Phase 1.

After Phase 5, the four module slots (script / tts / image / video) are uniform: each is a `<Select>` over a registry's `Object.keys`, and each is dispatched at runtime by reading the snapshot's `*_provider` column.

---

## Current State

**After Phase 4:**
- `src/lib/image/types.ts:3-12` — `ImageProvider.generateBatch(items, targetDir, opts): Promise<void>`. Phase 5 widens the return type.
- `src/lib/image/index.ts:1-16` — registry shape `Record<string, ImageProvider>` (locally named `providers`, **not exported**) with one entry: `comfyui: comfyuiProvider`. `getImageProvider("google_flow")` currently throws.
- `src/lib/image/comfyui.ts:283-345` — `generateHookVideoBatch` (hook video, today exported alongside `generateBatch`); `:347-408` `generateBatch` (main images, file-local non-exported function); `:410` `export const comfyuiProvider: ImageProvider = { generateBatch }` wrapper. Phase 5 keeps `generateBatch` here for the Image side and either wraps or moves `generateHookVideoBatch` for the Video side (implementer's choice; cleaner namespacing prefers move).
- `src/lib/tts/types.ts:10-19`, `src/lib/tts/index.ts:1-16` (note: `ttsProviders` IS exported here — the structural template Phase 5's `imageProviders` / `videoProviders` named exports must follow), `src/lib/tts/ai33.ts` — the structural model Phase 5 mirrors for `VideoProvider`.
- Four legacy step files dispatch via Phase 1's `materializeStepList` transitional mapping in `src/lib/workflows.ts` (README Invariant A):
  - `src/worker/steps/generate-main-images-comfyui.ts` — step block at `:49-64` with `outputs: ["images/main"]` (`:56`), no custom cleanup; calls `getImageProvider(setting).generateBatch` inside `runGenerateMainImages` at `:29-30`. Chunk-read + filter + provider.generateBatch call body at `:33-47`.
  - `src/worker/steps/generate-main-images-google-flow.ts` — step block at `:29-47` with `outputs: []` (`:36`); calls `runGoogleFlowStep(videoId, deps, spec)` with `chunkKind: "main"` / `mode: "createImage"`, returns `Promise<void | DeferSignal>`. Uses `ctx.chat` at `:43` for prompt rewriting (Invariant E).
  - `src/worker/steps/generate-hook-video-comfyui.ts` — step block at `:60-74` with `outputs: ["videos/hook"]` (`:67`), no custom cleanup; calls `generateHookVideoBatch` at `:45-52` via `resolveDefaultGenerator` (which dynamically imports it from `@/lib/image/comfyui` at `:56`).
  - `src/worker/steps/generate-hook-video-google-flow.ts` — step block at `:29-47` with `outputs: []` (`:36`); calls `runGoogleFlowStep` with `chunkKind: "hook"` / `mode: "text"`, returns `Promise<void | DeferSignal>`. Uses `ctx.chat` at `:43` (Invariant E).
- `src/worker/steps/google-flow-common.ts:66-108` — `runGoogleFlowStep(videoId, deps, spec): Promise<void | DeferSignal>`. `GoogleFlowStepSpec` (`:45-58`) accepts `stepName`, `chunkKind: "hook" | "main"`, `queueKind: "main_image" | "hook_video"`, `mode: "createImage" | "text"`, `outputDir`, `outputExt`. `GoogleFlowStepDeps` (`:19-33`) declares `chat?` and `promptsDir?` as **optional** (file-local rationale: missing chat/promptsDir disables the moderation loop rather than throwing — see comment at `:272-282`). Phase 5's new `generateBatch` opts can require these fields at the ImageProvider boundary while the underlying `GoogleFlowStepDeps` keeps them optional — the provider wrapper just always passes them.
- `src/worker/pipeline.ts:25-34` — `StepContext` after Phase 4: `db`, `projectsDir`, `promptsDir`, `log`, `chat`, `enrichChat`, `ttsProvider`, `imageProvider`. **No `videoProvider`** — Phase 5 adds it. `Step.run` already returns `Promise<void | DeferSignal>` (`pipeline.ts:99`); Phase 5 does not widen it. `DeferSignal` is at `:45-48`. The outputs/cleanup priority rule ("when a step provides `cleanup` the orchestrator skips the default `outputs`-based delete") is documented at `:79-81` and enforced at `:191-198` (the `if (step.cleanup) … else …` branch in `recordStepFailure`).
- `src/worker/pipeline.ts:248-295` — `resolveDeps`. After Phase 4's reorder (Phase 4 Task 7), the snapshot is parsed once at the top (`:257`). `imageProvider` resolution at `:266-267` still reads `getImageProvider(getSetting("image_provider", db))` — a Phase 1 deferral note. Phase 5 rewires to `getImageProvider(snapshot.image_provider)` and adds the parallel `videoProvider` resolution from `snapshot.video_provider`. **These line numbers may shift again as the file evolves; locate `resolveDeps` by name and the imageProvider line by the literal `getImageProvider(getSetting("image_provider", db))` if the offsets drift.** `ResolvedDeps` at `:134-143`; `buildStepContext` at `:150-165` (imageProvider thread-through at `:163`); the `tts_provider` / `image_provider` global-setting comment block at `:240-247`.
- `src/lib/artifact-grouping.ts:52-80` — `STEP_ARTIFACT_RULES` has four entries (`:73-76`) keyed by the legacy provider-specific slugs. Phase 5 collapses to two entries (one per unified slug).
- `src/lib/workflows.ts:105-129` — Phase 1's `materializeStepList`; the transitional mapping helpers `imageStepSlug` (`:82-86`) and `videoStepSlug` (`:88-92`) implement README Invariant A. Phase 5 deletes the helpers and emits `generate_main_images` / `generate_hook_video` directly from `materializeStepList`.
- `src/worker/boot.ts:21-42` — `bootValidate(db)` from Phase 1 covers Invariant C points 1 (workflow_steps reference REAL_STEPS, lines `:24-33`) and 2 (STEP_ARTIFACT_RULES reference REAL_STEPS, lines `:35-41`). Phase 5 adds point 3.
- `src/app/api/workflows/schema/route.ts:39-40` — Phase 3 Task 4 hardcodes `providers.image: ["comfyui", "google_flow"]` and `providers.video: ["comfyui", "google_flow"]` because the registries didn't yet contain both values. Phase 5 switches both to `Object.keys(<registry>)` (Invariant D, Phase 5 row).
- `src/worker/steps/index.ts` — `REAL_STEPS` array at `:27-43` (the four legacy step imports at `:11-14`); `STEP_OUTPUTS` at `:50-51` is `Object.fromEntries(REAL_STEPS.map(s => [s.name, s.outputs]))` (auto-derived; no per-step entry to update).
- `src/types.ts:11` — `VideoStatus = "new" | "queued" | "in_progress" | "done" | "failed"`. Non-terminal (Phase 5's snapshot-validity check scope) = `new | queued | in_progress`. Terminal (skipped by the check) = `done | failed`. README Invariant C originally listed `failed` as non-terminal; the actual VideoStatus enum and `transitionAllNewToQueued`/runner contract treat `failed` as terminal — see Task 15 for the resolved interpretation.

**Patterns Phase 5 reuses:**
- TTS registry shape: `src/lib/tts/index.ts:1-16` is the model for `src/lib/video/index.ts`.
- `runGoogleFlowStep` deferral semantics: `src/worker/steps/google-flow-common.ts:195,215` returns `DeferSignal` when the queue defers; the unified steps must propagate this return up unchanged.
- ComfyUI provider pattern: `src/lib/image/comfyui.ts:410` (`comfyuiProvider: ImageProvider`) is the existing wrapper precedent — `src/lib/video/comfyui.ts` mirrors it.
- Per-step `cleanup` hook: `src/worker/pipeline.ts:100` `Step.cleanup?(videoId, ctx)` on the `Step` interface (already there from before Phase 1). Phase 5 introduces the first non-trivial uses (provider-delegated cleanup).
- File-snapshot regression-style test: `__tests__/api/workflows/schema/route.test.ts` (Phase 3 Task 5). Snapshot file lives at `__tests__/api/workflows/schema/__snapshots__/schema.json`; the test uses `toMatchFileSnapshot`, not `toMatchInlineSnapshot`.

**Confirmed absent (Phase 5 introduces):**
- No `src/lib/video/` directory.
- No `videoProvider` field in `StepContext` / `ResolvedDeps` / `RunPipelineDeps`.
- No DeferSignal return on `ImageProvider.generateBatch`.
- No snapshot-validity check in `bootValidate`.

---

## Scope

**Doing:**
- `src/lib/image/types.ts` — widen `ImageProvider.generateBatch` return type to `Promise<void | DeferSignal>` and extend the `opts` struct with the full set of fields Google Flow's `runGoogleFlowStep` consumes today via `GoogleFlowStepDeps` (`google-flow-common.ts:19-33`): `videoId: string`, `projectsDir: string`, `promptsDir: string`, `chat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>` (the inline shape used by `pipeline.ts:30` — there is no exported `ChatFn` named type), `pollIntervalMs?: number`, `nowSec?: () => number`, `nowMs?: () => number`. Without these the Google Flow image/video providers can't satisfy `runGoogleFlowStep`'s contract (Invariant E covers `chat`; the rest are operational dependencies and test seams).
- `src/lib/image/google-flow.ts` (new) — `ImageProvider` wrapping `runGoogleFlowStep(chunkKind: "main", mode: "createImage")`. Implements optional `cleanup()` as a no-op (preserves in-flight queue rows).
- `src/lib/image/index.ts` — register `google_flow: googleFlowImageProvider` alongside the existing `comfyui` entry.
- `src/lib/image/comfyui.ts` — wrap `generateBatch` to accept the new opts struct (additive — `chat` and `videoId` ignored by ComfyUI). Implement optional `cleanup()` as `rmSync("images/main", { recursive: true, force: true })`.
- `src/lib/video/types.ts` (new) — `VideoProvider` interface mirroring the post-widening `ImageProvider` shape (`generateBatch(items, targetDir, opts): Promise<void | DeferSignal>` + optional `cleanup`).
- `src/lib/video/index.ts` (new) — registry `Record<string, VideoProvider>` with `comfyui` and `google_flow`. `getVideoProvider(name)` mirrors `getImageProvider`.
- `src/lib/video/comfyui.ts` (new) — `VideoProvider` wrapping the hook-video function (currently `generateHookVideoBatch` at `src/lib/image/comfyui.ts:283-345`). Either wrap from there or move it; either is fine — the function is a leaf, not a hot path. Implement `cleanup()` as `rmSync("videos/hook", { recursive: true, force: true })`.
- `src/lib/video/google-flow.ts` (new) — `VideoProvider` wrapping `runGoogleFlowStep(chunkKind: "hook", mode: "text")`. Cleanup is a no-op.
- `src/worker/steps/generate-main-images.ts` (new) — single step, `name: "generate_main_images"`, `module: "image"`, `for_each: "chunks"`, `outputs: []` (custom `cleanup` is the real cleanup; per `pipeline.ts:79-81` and the `if (step.cleanup) … else …` branch at `:191-198`, when both are set the orchestrator runs `cleanup` and ignores `outputs`). Reads `chunks.json`, filters to `kind === "main"`, calls `ctx.imageProvider.generateBatch(items, targetDir, { db: ctx.db, log: ctx.log, videoId, projectsDir: ctx.projectsDir, promptsDir: ctx.promptsDir, chat: ctx.chat })`. Step's `cleanup` delegates to `ctx.imageProvider.cleanup?.(videoId, { db: ctx.db, log: ctx.log, projectsDir: ctx.projectsDir })` so ComfyUI cleans up `images/main` and Google Flow no-ops.
- `src/worker/steps/generate-hook-video.ts` (new) — same pattern, `module: "video"`, `outputs: []`, dispatches to `ctx.videoProvider`.
- Delete the four legacy step files (`generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts`) and their imports in `src/worker/steps/index.ts`. Two new imports replace four.
- Delete the transitional provider→slug mapping table from `src/lib/workflows.ts` `materializeStepList`. Emit `generate_main_images` / `generate_hook_video` directly. Update Phase 1 unit tests that asserted on the legacy slugs.
- `src/lib/artifact-grouping.ts` — collapse the four `STEP_ARTIFACT_RULES` entries at `:73-76` into two entries keyed by the unified slugs (the path predicates are identical across each provider pair; deduplication is mechanical). Also: rewrite the comment block at `:43-50` and `:70-72` (the "comfyui rows precede their google_flow siblings" rationale becomes obsolete) and delete the suffix-stripping branch in `humanizeStepName` at `:9-16` — after the collapse no step has a `_comfyui`/`_google_flow` suffix, the regex is dead code, and the comment block at `:3-8` references a non-existent `lib/image/provider.ts` path.
- `src/worker/pipeline.ts` — extend `StepContext` (`:25-34`), `ResolvedDeps` (`:134-143`), and the `buildStepContext` thread-through (`:150-165`) with `videoProvider`. Rewire `resolveDeps` (`:248-295`) to read `imageProvider` and `videoProvider` from the snapshot (`snapshot.image_provider`, `snapshot.video_provider`) instead of from global settings — completes the Phase 1 deferral note. Skip `imageProvider` resolution when `snapshot.image_provider === null` and `videoProvider` resolution when `snapshot.video_provider === null` (per the README's Glue Insertion section and `materializeStepList`'s null-skip logic at `src/lib/workflows.ts:120-124` — null providers skip the slot at materialization, but `resolveDeps` should still produce a valid ctx for any non-skipped step that runs).
- `src/worker/boot.ts` — extend `bootValidate(db)` with Invariant C point 3: iterate every `videos.workflow_snapshot` whose `status` is in `("new", "queued", "in_progress")`, parse the snapshot, materialize the step list via `materializeStepList`, and assert every emitted slug is in `REAL_STEPS`. Throw on first violation with a message naming the offending video, the offending slug, and the operator action ("drain or restart this video before deploying").
- `src/app/api/workflows/schema/route.ts:39-40` — replace the hardcoded `providers.image: ["comfyui", "google_flow"]` and `providers.video: ["comfyui", "google_flow"]` arrays with `Object.keys(imageProviders)` and `Object.keys(videoProviders)` (Invariant D, Phase 5 row). Phase 3's file-snapshot test (Phase 3 Task 5; snapshot at `__tests__/api/workflows/schema/__snapshots__/schema.json`) regenerates with `vitest -u` — single dedicated commit, same handling as Phase 4 Task 14.
- Tests: image registry adds `google_flow`; new video registry tests; two new unified step tests replacing four legacy ones; pipeline integration regression for both built-in workflows; bootValidate rejection test for legacy-slug snapshots; Phase 3 schema-endpoint file snapshot regenerated.

**Not doing:**
- New settings keys — both providers continue to read existing global settings (`comfyui_base_url`, `comfyui_workflow_path`, `google_flow_*`). Provider selection is per-workflow (Phase 1 column on the `workflows` row).
- Settings UI changes — the ComfyUI tab fields (`src/app/settings/settings-form.tsx:50-55`) and Google Flow tab fields (`:56-67`) stay unchanged.
- Snapshot data migration — by design (Invariant C point 3 fails fast). Operators drain or restart in-flight videos before deploying. Document this prominently in the Phase 5 PR description (the §Migration Notes block below has the operator playbook).
- `tts_provider` snapshot rewire — Phase 1 deferred this with a note that `tts_provider` resolution still reads from global settings. Phase 5 does NOT touch `ttsProvider` resolution; the `tts_provider` snapshot column stays unconsumed at runtime. Promoting it is an Open Item for a future cleanup phase (the pattern Phase 5 establishes for image/video resolution makes the future patch trivial — copy-paste).
- Per-workflow ComfyUI workflow paths (e.g., per-workflow `comfyui_workflow_path` overrides). Phase 5 keeps `comfyui_workflow_path` global; per-workflow provider parameters are an Open Item for a later phase.
- Drag-and-drop or per-row reordering of provider order — irrelevant; provider order on a workflow is implicit (each module has at most one).
- Renaming or restructuring `lib/image/comfyui.ts`'s public exports beyond the `generateHookVideoBatch` move (if the implementer chooses move-over-wrap). The existing `generateBatch` stays where it is.

---

## Tasks

### Phase 5A — Provider interfaces + registries

- [x] **Task 1: Widen `ImageProvider.generateBatch` return + opts**
  **Files:** `src/lib/image/types.ts`
  **What:** Two coordinated edits:
  - Change return type from `Promise<void>` to `Promise<void | DeferSignal>`. Import `DeferSignal` from `@/worker/pipeline` (defined at `pipeline.ts:45-48`; the legacy Google Flow step files import it directly from `@/worker/pipeline` — same import path).
  - Extend the `opts` struct from `{ db?: DatabaseType; log?: (m: string) => void }` to:
    ```ts
    {
      db?: DatabaseType;
      log?: (m: string) => void;
      videoId: string;          // required — Google Flow keys per-video queue rows
      projectsDir: string;      // required — runGoogleFlowStep reads chunks/chunks.json from join(projectsDir, videoId)
      promptsDir: string;       // required — moderation loop loads prompt templates
      chat: (messages: ChatMessage[], opts?: ChatOpts) => Promise<string>;  // required — Invariant E (Google Flow prompt rewriting)
      pollIntervalMs?: number;  // test seam (preserves google-flow-common.test.ts contract)
      nowSec?: () => number;    // test seam
      nowMs?: () => number;     // test seam
    }
    ```
    `videoId` / `projectsDir` / `promptsDir` / `chat` are **required**. The three test seams stay optional. ComfyUI ignores `chat`/`promptsDir` and the test seams; Google Flow consumes everything.

  Add an optional `cleanup?(videoId: string, opts: { db?: DatabaseType; log?: (m: string) => void; projectsDir: string }): Promise<void> | void` field to the interface. `projectsDir` is required on the cleanup opts so the ComfyUI cleanup hook can compute the absolute path to delete (`projectsDir` is not lexically available inside `src/lib/image/comfyui.ts`).
  **Context:** This shape mirrors `GoogleFlowStepDeps` (`google-flow-common.ts:19-33`) so the Google Flow wrappers (Tasks 3, 7) become trivial pass-throughs. Today's call sites (the four legacy steps) all already know `videoId` / `projectsDir` / `promptsDir`, so the contract widening is mechanical. **There is no exported `ChatFn` named type today.** The chat field's structural shape comes from `LlmProvider.chat` (`src/lib/llm/types.ts:18-20`); use the inline arrow type as shown in the snippet, importing `ChatMessage` and `ChatOpts` from `@/lib/llm/types` (which is also re-exported from `@/lib/llm`). `pipeline.ts` and `google-flow-common.ts` both use the same inline shape today — see `pipeline.ts:30` and `google-flow-common.ts:29-32`.

- [x] **Task 2: Adapt ComfyUI image provider to the widened interface**
  **Files:** `src/lib/image/comfyui.ts`
  **What:** Update the file-local `generateBatch` (`:347-408`) signature to accept the new opts struct (it ignores `chat`, `videoId`, `projectsDir`, `promptsDir`, and the test seams — they're for parity with Google Flow). Add a `cleanup` method to `comfyuiProvider` at `:410`:
  ```ts
  cleanup: async (videoId, opts) => {
    rmSync(join(opts.projectsDir, videoId, "images/main"), { recursive: true, force: true });
  }
  ```
  `projectsDir` comes from the `cleanup` opts struct (Task 1 made it required), so no module-scope lookup is needed and the function stays pure.
  **Context:** This task is the first place the new `cleanup` hook lands; the unified step (Task 9) will call it with `ctx.projectsDir`. Keep the cleanup synchronous-ish — `rmSync` matches the orchestrator's existing failure-cleanup pattern in `recordStepFailure` (`pipeline.ts:191-198`). The orchestrator's `if (step.cleanup) … else …` rule (documented at `pipeline.ts:79-81`, enforced at `:191-198`) means a step with a custom `cleanup` skips the default `outputs`-based delete entirely — that's why Task 9's step declares `outputs: []`.

- [x] **Task 3: `src/lib/image/google-flow.ts` (new)**
  **Files:** `src/lib/image/google-flow.ts` (new)
  **What:** Export `googleFlowImageProvider: ImageProvider`. The `generateBatch(items, _targetDir, opts)` implementation:
  1. Build the `GoogleFlowStepSpec` per `google-flow-common.ts:45-58`:
     - `stepName: "generate_main_images"` (the unified slug — used for queue accounting and error messages).
     - `chunkKind: "main"`, `queueKind: "main_image"`, `mode: "createImage"`.
     - `outputDir: "images/main"`, `outputExt: ".png"`.
  2. Build the `GoogleFlowStepDeps` argument by passing through every relevant field from `opts`:
     ```
     const deps: GoogleFlowStepDeps = {
       db: opts.db ?? getDb(),
       projectsDir: opts.projectsDir,
       promptsDir: opts.promptsDir,
       log: opts.log ?? (() => {}),
       chat: opts.chat,
       pollIntervalMs: opts.pollIntervalMs,
       nowSec: opts.nowSec,
       nowMs: opts.nowMs,
     };
     ```
     All four required fields plus the three test seams thread through. `_targetDir` is unused — Google Flow computes its own paths via `projectsDir + spec.outputDir`.
  3. `return await runGoogleFlowStep(opts.videoId, deps, spec)` — propagates `DeferSignal` up to the unified step → orchestrator.

  `cleanup` is a no-op: `cleanup: async () => {}`. Deletion of `images/main` is intentionally not done — the Google Flow queue may still hold dispatched-but-unfetched items keyed off the directory contents, and clearing them mid-flight would orphan upstream queue rows.
  **Context:** This file is a thin adapter. The substantive logic stays in `runGoogleFlowStep`. Consider extracting a shared `makeGoogleFlowProvider(specPartial)` helper if the duplication with Task 7 (hook-video provider) feels noisy; a 3-line duplicate is fine if not.

- [x] **Task 4: Register `google_flow` in image registry**
  **Files:** `src/lib/image/index.ts`
  **What:** Add `google_flow: googleFlowImageProvider` to the `providers` record. Import from `./google-flow`. **Insert order matters: `comfyui` first, then `google_flow`.** `Object.keys` preserves insertion order, and Phase 3's hardcoded array (`["comfyui", "google_flow"]`) pins the order in the file-snapshot test (Task 22; snapshot at `__tests__/api/workflows/schema/__snapshots__/schema.json`). Inserting in the wrong order regenerates the snapshot with a reversed array, looking like a contract change to reviewers when it isn't. Also rename the local `providers` constant to `imageProviders` and export it (named export — see how `src/lib/tts/index.ts:6-8` does it for `ttsProviders`) so Task 16's schema endpoint can call `Object.keys(imageProviders)`. `getImageProvider` continues to read from the renamed const.
  **Context:** This is the registry change Phase 1 deferred — Phase 1's transitional mapping pre-dates the real registration. Pair with Task 12 (mapping deletion) so the runtime path actually flows through the registry now.

- [x] **Task 5: `src/lib/video/types.ts` (new)**
  **Files:** `src/lib/video/types.ts` (new)
  **What:** Export `VideoProvider` interface mirroring the post-widening `ImageProvider`:
  ```ts
  generateBatch(items, targetDir, opts): Promise<void | DeferSignal>;
  cleanup?(videoId, opts): Promise<void> | void;
  ```
  Same `items` shape (`{ id: string; prompt: string }[]`), same `opts` (the full struct from Task 1 — `db?`, `log?`, `videoId`, `projectsDir`, `promptsDir`, `chat`, plus the three test seams). The two interfaces are structurally identical today; future divergence (e.g., a video-specific `duration` field) goes here.
  **Context:** Mirror `src/lib/image/types.ts:3-12` post-widening. Defining a separate interface keeps namespacing clean (image stays in `lib/image/`, video moves to `lib/video/` — directory boundary follows the registry split). A shared base interface is cleaner in TypeScript theory but adds an indirection without payoff today.

- [x] **Task 6: `src/lib/video/comfyui.ts` (new)**
  **Files:** `src/lib/video/comfyui.ts` (new), `src/lib/image/comfyui.ts` (modify)
  **What:** Export `comfyuiVideoProvider: VideoProvider`. The `generateBatch` implementation calls the existing `generateHookVideoBatch` function (currently exported from `src/lib/image/comfyui.ts:283-345`). Two acceptable paths — implementer's choice:
  - **Wrap:** import `generateHookVideoBatch` from `src/lib/image/comfyui.ts` and call it from the new wrapper. Minimum touch; the function stays in `lib/image/`.
  - **Move:** physically move `generateHookVideoBatch` (and its companion `pollUntilCompleteVideo` at `:210-269` plus the `findVideoOutputNodeId` helper at `:82-98`) from `src/lib/image/comfyui.ts` to `src/lib/video/comfyui.ts`. Cleaner namespacing — image stays in `lib/image/`, video lives in `lib/video/`. Update any callers (today the only direct caller is `src/worker/steps/generate-hook-video-comfyui.ts:56`, which is deleted in Task 11; the existing `__tests__/unit/lib/image/comfyui.test.ts` also imports `generateHookVideoBatch` at `:21-24` — that test moves alongside).

  Both paths add `cleanup: async (videoId, opts) => rmSync(join(opts.projectsDir, videoId, "videos/hook"), { recursive: true, force: true })`. The function ignores `chat` and `videoId` from `generateBatch`'s opts (ComfyUI hook video is local, no LLM rewrite, no per-video queue state); cleanup uses `projectsDir` from its own opts (Task 1's cleanup-opts struct).
  **Context:** No behavior change in the underlying function — it's a pure code-organization move (or a wrap). The "move" path keeps the file boundary aligned with the registry boundary so future video-specific code accretes in one place.

- [x] **Task 7: `src/lib/video/google-flow.ts` (new)**
  **Files:** `src/lib/video/google-flow.ts` (new)
  **What:** Symmetric to Task 3 but for hook video:
  - `stepName: "generate_hook_video"`.
  - `chunkKind: "hook"`, `queueKind: "hook_video"`, `mode: "text"`.
  - `outputDir: "videos/hook"`, `outputExt: ".mp4"`.

  `cleanup` is a no-op (same rationale as Task 3 — preserve in-flight queue rows).
  **Context:** Same wrapping pattern as Task 3. The two Google Flow providers (image + video) are nearly identical; if a small shared helper feels right (e.g., `makeGoogleFlowProvider(specPartial)`), pull it. If not, duplication-of-three-lines is fine.

- [x] **Task 8: `src/lib/video/index.ts` (new) — registry**
  **Files:** `src/lib/video/index.ts` (new)
  **What:** Mirror `src/lib/tts/index.ts:1-16`:
  ```
  const providers: Record<string, VideoProvider> = {
    comfyui: comfyuiVideoProvider,
    google_flow: googleFlowVideoProvider,
  };
  export function getVideoProvider(name: string): VideoProvider { ... throws on unknown ... }
  export const videoProviders = providers;  // for Object.keys() in the schema endpoint
  ```
  **Insert order matters** — `comfyui` first, then `google_flow`, matching the image registry's order (Task 4) and Phase 3's hardcoded array. The Phase 3 file-snapshot diff in Task 22 should reflect *what* generates the array, not its order.
  **Context:** The named export `videoProviders` is what Task 16's schema endpoint reads via `Object.keys(videoProviders)` (Invariant D).

### Phase 5B — Unified step files

**Status:** complete. Tasks 9, 10, 11 landed plus partial Task 12 (materializer collapse) and partial Task 14 (`STEP_ARTIFACT_RULES` collapse + dead suffix-strip removal) were folded in to keep the test suite green at every commit. See "Phase 5B landing notes" below for what shifted vs. the per-task plan.

**Phase 5B landing notes (read before starting Phase 5C):**
- **Task 12 is partially done.** The `imageStepSlug` / `videoStepSlug` helpers in `src/lib/workflows.ts` are deleted; `materializeStepList` emits `"generate_main_images"` and `"generate_hook_video"` directly via `if (snapshot.image_provider !== null) out.push(...)`. The Phase 1 unit tests in `__tests__/unit/lib/workflows.test.ts` were updated alongside (the legacy `COMFYUI_LEGACY` / `GOOGLE_FLOW_LEGACY` arrays merged into a single `BUILTIN_STEPS` constant; the `transitional provider mapping (Invariant A)` describe block was removed entirely — both built-in workflows now materialize to identical step lists). **Nothing remains for Task 12 in Phase 5C.**
- **Task 13 is partially done.** `videoProvider: VideoProvider` was added to `StepContext`, `ResolvedDeps`, `buildStepContext`, and `resolveDeps` — with snapshot-driven resolution (`snapshot.video_provider ? getVideoProvider(snapshot.video_provider) : (null as unknown as VideoProvider)`). The `import { getVideoProvider, type VideoProvider } from "@/lib/video"` import is in place. **What remains for Task 13 in Phase 5C: just the `imageProvider` snapshot rewire** — replace `getImageProvider(getSetting("image_provider", db))` with `(snapshot.image_provider ? getImageProvider(snapshot.image_provider) : (null as unknown as ImageProvider))`. The `resolveDeps` JSDoc comment block needs the same rewrite Task 13 specifies. `RunPipelineDeps` already picks up `videoProvider?` from the `Partial<Omit<StepContext, "log">>` derivation — no edit needed there.
- **Task 14 is fully done.** `STEP_ARTIFACT_RULES` collapsed 4→2 rules; `humanizeStepName` reduced to the plain split/upper-case form; the dead `lib/image/provider.ts` comment block is gone.
- **Task 19 (Phase 5F) is partially done.** The four legacy step test files were deleted alongside the step files (`generate-main-images-google-flow.test.ts`, `generate-hook-video-comfyui.test.ts`, `generate-hook-video-google-flow.test.ts`). The previously-existing `generate-main-images.test.ts` was rewritten in place to test the unified step. A new `generate-hook-video.test.ts` was created. Both new files use ImageProvider / VideoProvider stubs (`{ generateBatch: vi.fn(), cleanup: vi.fn() }`) — exactly the pattern Task 19 prescribes. **Nothing remains for Task 19 in Phase 5F**; the two unified step tests already cover the contract (5 cases each: dispatch, DeferSignal pass-through, cleanup delegation, cleanup no-op, step metadata).
- **Task 22 (schema-endpoint snapshot regeneration) is partially done.** `__tests__/api/workflows/schema/__snapshots__/schema.json` was already regenerated for the unified `steps[]` (4 legacy entries → 2 unified entries). The `chunksScoped` array in the test body was updated to `["enrich_chunks", "generate_main_images", "generate_hook_video"]`. **What remains for Task 22 in Phase 5F:** the `providers.image` / `providers.video` portion of the snapshot will diff again when Task 16 switches the route to `Object.keys(imageProviders)` / `Object.keys(videoProviders)` — but only if the order or contents differ from the current hardcoded `["comfyui", "google_flow"]`. They shouldn't. Re-run `vitest -u` after Task 16 lands and verify no contentful diff.
- **Tests touched alongside the slug rename** (so a future grep for `generate_main_images_comfyui` etc. on `__tests__/` returns zero hits): `__tests__/unit/lib/workflows.test.ts`, `__tests__/unit/worker/pipeline.test.ts`, `__tests__/unit/worker/pipeline-workflow.test.ts`, `__tests__/unit/lib/workflows-edit.test.ts`, `__tests__/unit/lib/artifact-grouping.test.ts`, `__tests__/components/videos/video-detail-client.test.tsx`, `__tests__/api/workflows/schema/route.test.ts`. The `route.test.ts` comment blocks that anticipated Phase 5 churn ("Phase 5 will collapse the four `generate_*_<provider>` …") were also deleted.
- **Production code touched alongside the slug rename**: `src/app/videos/[id]/video-detail-client.tsx:108-113` — the `flowStepStarted` predicate was reading the legacy Google Flow slugs to decide whether to show the Flow progress panel. Updated to the unified `generate_main_images` / `generate_hook_video`. Panel visibility is still gated by `isFlow = video.workflow_id === "google-flow"` upstream, so the predicate just signals "any image/video module step has started".
- **Step `produces` shape:** the unified steps emit `produces: ["images/main/*.png"]` / `["videos/hook/*.mp4"]` (the glob, not the directory name). This matches what the legacy step files produced and is what the input-availability validator requires for the render step's deps to resolve. The plan-spec (Task 9 / Task 10) said `produces: ["images/main"]` — that was wrong; using the directory broke `__tests__/api/workflows/[id]/route.test.ts`'s render-input warning assertions. Future phases that touch step metadata should preserve the glob shape.
- **`*_LEGACY` constants in tests:** if you grep for `LEGACY` in `__tests__/`, you'll find a handful of remaining references — those are unrelated (e.g. legacy queue rows). The two materializer-test legacy constants merged into `BUILTIN_STEPS`.

- [x] **Task 9: `src/worker/steps/generate-main-images.ts` (new)**
  **Files:** `src/worker/steps/generate-main-images.ts` (new)
  **What:** Single `step: Step` export with:
  - `name: "generate_main_images"`, `module: "image"`, `for_each: "chunks"`.
  - `label: "Generate main images"`, `description: "Generates main images for each chunk via the workflow's image provider."`.
  - `inputs: ["chunks/chunks.json"]`, `produces: ["images/main"]`, **`outputs: []`**. The custom `cleanup` is the real cleanup path; per the `Step` interface comment at `pipeline.ts:79-81` and the `if (step.cleanup) … else …` branch at `:191-198`, when a step provides `cleanup` the orchestrator skips the default `outputs`-based delete. Setting `outputs: ["images/main"]` would be misleading documentation: the orchestrator wouldn't act on it, and Google Flow's no-op cleanup would mask it. Match today's `generate-main-images-google-flow.ts:36` shape (`outputs: []`) since that's the more conservative path now used by both providers.
  - `run(videoId, ctx)`:
    1. Read `chunks.json` from disk; filter to `kind === "main"`.
    2. Build the items array `{ id, prompt }[]`.
    3. Compute `targetDir = path.join(ctx.projectsDir, videoId, "images/main")`.
    4. `return await ctx.imageProvider.generateBatch(items, targetDir, { db: ctx.db, log: ctx.log, videoId, projectsDir: ctx.projectsDir, promptsDir: ctx.promptsDir, chat: ctx.chat })`.
    The return propagates `DeferSignal` up to the orchestrator unchanged (Google Flow's defer path).
  - `cleanup?(videoId, ctx): Promise<void>`: `await ctx.imageProvider.cleanup?.(videoId, { db: ctx.db, log: ctx.log, projectsDir: ctx.projectsDir })`. ComfyUI deletes `images/main`; Google Flow no-ops.
  **Context:** Replaces the two legacy main-image step files. The chunk-reading + filter logic at the top is the same as today's `generate-main-images-comfyui.ts:33-47` (`projectDir` / `chunksPath` / `targetDir` joins, then `JSON.parse(readFileSync(chunksPath, "utf-8"))` and `chunks.filter((c) => c.kind === "main")`). The only call-site change is dispatching through `ctx.imageProvider` instead of importing a provider-specific function.

- [x] **Task 10: `src/worker/steps/generate-hook-video.ts` (new)**
  **Files:** `src/worker/steps/generate-hook-video.ts` (new)
  **What:** Symmetric to Task 9 for hook video:
  - `name: "generate_hook_video"`, `module: "video"`, `for_each: "chunks"`.
  - `label: "Generate hook video"`, `description: "Generates the hook video via the workflow's video provider."`.
  - `inputs: ["chunks/chunks.json"]`, `produces: ["videos/hook"]`, **`outputs: []`** (same rationale as Task 9 — `pipeline.ts:79-81` + `:191-198`, custom cleanup is authoritative).
  - `run` filters `chunks.json` to `kind === "hook"`, builds items, dispatches via `ctx.videoProvider.generateBatch(...)` with the full opts struct (db, log, videoId, projectsDir, promptsDir, chat).
  - `cleanup?` delegates to `ctx.videoProvider.cleanup?.(videoId, { db: ctx.db, log: ctx.log, projectsDir: ctx.projectsDir })`.
  **Context:** Replaces the two legacy hook-video step files. Source pattern for the chunk read + filter: `generate-hook-video-comfyui.ts:38-43`.

- [x] **Task 11: Delete the four legacy step files + their imports**
  **Files:** Delete: `src/worker/steps/generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts`. Modify: `src/worker/steps/index.ts`.
  **What:** Delete the four files. In `src/worker/steps/index.ts`, replace the four legacy imports (today at `:11-14`) with two imports of the unified steps from Tasks 9 and 10. Update `REAL_STEPS` (today at `:27-43`) — drop the four legacy entries (`:37-40`), add `generateMainImagesStep` and `generateHookVideoStep`. The array shrinks by two net. `STEP_OUTPUTS` (`:50-51`) regenerates automatically via `Object.fromEntries(REAL_STEPS.map(s => [s.name, s.outputs]))`.
  **`STEP_OUTPUTS` consumer audit:** before deleting the legacy entries, grep for `STEP_OUTPUTS["generate_main_images_comfyui"]` / `_google_flow` / `generate_hook_video_*` style key lookups across `src/` and `__tests__/`. Any direct-key consumers will silently get `undefined` post-Phase-5; if hits exist, they need to be migrated to the unified slug names alongside Task 11.
  **Landing-order coupling with Task 14:** `bootValidate(db)` (Phase 1's contract, `src/worker/boot.ts:35-41`) checks every `STEP_ARTIFACT_RULES.step` resolves to a `REAL_STEPS` entry. Land Task 11 and Task 14 together (single commit) — landing 11 alone leaves rules pointing at deleted slugs and `bootValidate` fires; landing 14 alone leaves `REAL_STEPS` containing legacy entries with no rules. Either order in the same commit is fine.
  **Context:** Run `Grep -r 'generate_main_images_comfyui\|generate_main_images_google_flow\|generate_hook_video_comfyui\|generate_hook_video_google_flow' src/` post-change to confirm zero remaining hits in `src/`. Hits in `__tests__/` should be addressed by Tasks 19 (replace step tests) and 17–18 (registry tests). Hits in `docs/plans/workflow-modularization/` (this directory) stay (historical record / cross-phase invariants). The README's Invariant A table (lines 119–137) intentionally keeps the legacy slug column as historical doc.

### Phase 5C — Materializer + pipeline wiring

- [x] **Task 12: Delete the transitional provider→slug mapping in `materializeStepList`**
  **Status:** done in Phase 5B (folded in alongside Tasks 11 + 14 to keep the test suite green at every commit). `imageStepSlug` / `videoStepSlug` deleted; `materializeStepList` emits unified slugs directly; `__tests__/unit/lib/workflows.test.ts` updated. **Nothing remains here.**
  **Files:** `src/lib/workflows.ts`, `__tests__/unit/lib/workflows.test.ts`
  **What:** In `src/lib/workflows.ts`, delete the two helper functions `imageStepSlug` (`:82-86`) and `videoStepSlug` (`:88-92`) — these implement the four-row provider→slug mapping (Phase 1 Task 4 introduced them; README Invariant A documents the contract). In `materializeStepList` (`:105-129`), replace the two call-sites at `:120-124` (image slot push, video slot push) with direct emission of `"generate_main_images"` and `"generate_hook_video"`. The skip-when-null logic stays — if `snapshot.image_provider === null`, the materializer emits no image step; same for video. The cleanest rewrite of `:120-124`:
  ```ts
  if (snapshot.image_provider !== null) out.push("generate_main_images");
  if (snapshot.video_provider !== null) out.push("generate_hook_video");
  ```

  **Update Phase 1's unit tests in `__tests__/unit/lib/workflows.test.ts`** (Phase 1 Task 18 created the file) — specifically the `COMFYUI_LEGACY` / `GOOGLE_FLOW_LEGACY` arrays (`:33-63`), the `materializeStepList — transitional provider mapping (Invariant A)` block (`:142-177`, ~4 cases), and the `materializeStepList — null providers skip their slot` block at `:179-231` (assertions on legacy slugs at `:200-201`, `:206-207`, `:225-226` regenerate to the unified slugs). Rename the `transitional provider mapping` describe block to something like `unified slugs (post-Invariant-A)`. This file is **separate** from Task 19's `__tests__/unit/worker/steps/` updates and must not be missed: it's the materializer's own unit test, not a step test.
  **Context:** Mechanical removal. The seeded `comfyui` and `google-flow` workflow rows still have non-null `image_provider` / `video_provider` columns, so both materialize identically post-deletion (just under different slug names).

- [x] **Task 13: Pipeline wires `videoProvider` + reads providers from snapshot**
  **Status (post-5B):** the `videoProvider` half of this task is already done. `StepContext`, `ResolvedDeps`, `buildStepContext`, and `resolveDeps` all carry `videoProvider` with snapshot-driven resolution; `import { getVideoProvider, type VideoProvider } from "@/lib/video"` is in place. **What remains for Phase 5C:** the parallel `imageProvider` snapshot rewire.

  **Files:** `src/worker/pipeline.ts`
  **What remains (single edit + a comment update):**
  1. Inside `resolveDeps`, replace the current `imageProvider` line:
     - Old: `const imageProvider = deps?.imageProvider ?? getImageProvider(getSetting("image_provider", db));`
     - New: `const imageProvider = deps?.imageProvider ?? (snapshot.image_provider ? getImageProvider(snapshot.image_provider) : (null as unknown as ImageProvider));`
     The `getSetting` import becomes unused if no other site reads it from `resolveDeps` — leave the symbol if other consumers keep it; just don't add a new `getSetting("image_provider", …)` reference.
  2. Update the JSDoc comment block above `resolveDeps` (currently says "`tts_provider` / `image_provider` stay global-setting-driven; Phase 5 shifts image/video dispatch to the snapshot.") to: only `tts_provider` reads from settings; `image_provider` and `video_provider` read from the snapshot. (`tts_provider` snapshot rewire is explicitly Not-Doing per §Scope.)

  **Null-provider handling:** identical to the videoProvider path already in place (`null as unknown as ImageProvider` escape hatch — the materializer guarantees the image slot is skipped when `snapshot.image_provider === null`, so no step sees the null cast at runtime).
  **Context:** completes the Phase 1 deferral note. After this lands, `Grep '"image_provider"' src/worker/` (quoted form) returns zero hits — same shape as Phase 4's `llm_provider` removal verification. The `image_provider` setting key still exists in `SETTING_SCHEMAS` / `DEFAULT_SETTINGS` and the Settings UI (per §Not Doing — its removal is an Open Item for a future cleanup phase).

- [x] **Task 14: Update `STEP_ARTIFACT_RULES` + delete dead suffix-stripping logic**
  **Status:** done in Phase 5B (landed with Task 11 per the explicit landing-order coupling). Rules collapsed 4→2; `humanizeStepName` reduced to plain split/upper-case; the `lib/image/provider.ts` comment block is gone. **Nothing remains here.**
  **Files:** `src/lib/artifact-grouping.ts`
  **What:** Three coordinated edits in this file:
  1. **Replace the four rules at `:73-76`** with two:
     ```
     { step: "generate_main_images", match: (p) => p.startsWith("images/main/") },
     { step: "generate_hook_video",  match: (p) => p.startsWith("videos/hook/") },
     ```
     The path predicates were duplicate-by-design across each provider pair, so the collapse is mechanical.
  2. **Rewrite the comment block at `:43-50` and `:70-72`.** The "comfyui rows precede their google_flow siblings so the comfyui rule wins when both are theoretically registered" rationale becomes obsolete — there are no provider-paired rules anymore. Replace with a one-line comment noting that each producer step has exactly one rule.
  3. **Delete the suffix-stripping branch in `humanizeStepName` at `:9-16`.** The `name.replace(/_(comfyui|google_flow)$/, "")` regex is dead code post-Phase-5 (no step name has those suffixes anymore) and the comment block at `:3-8` references a non-existent `lib/image/provider.ts` path. Reduce to a plain `name.split("_").filter(Boolean).join(" ").replace(/^./, c => c.toUpperCase())`.

  **Landing-order coupling with Task 11:** see Task 11's note. Land 11 and 14 in the same commit.
  **Context:** `bootValidate(db)` (Phase 1 Task 10) checks every `STEP_ARTIFACT_RULES.step` resolves to `REAL_STEPS` — after Tasks 11 and 14 land together, that check passes because the slug names stay consistent. Phase 2 / Phase 3 dashboard pages that call `humanizeStepName` continue to work because the unified slugs (`generate_main_images`, `generate_hook_video`) already lack the suffix the regex stripped.

### Phase 5D — bootValidate snapshot check

- [x] **Task 15: Add Invariant C point 3 to `bootValidate`**
  **Files:** `src/worker/boot.ts`
  **What:** Extend `bootValidate(db)` with a third check **AFTER** the existing two (point 1: workflow_steps refs, point 2: STEP_ARTIFACT_RULES refs). Ordering is load-bearing — if point 1 detects a malformed `workflow_steps` row, that throw must fire before iterating snapshots, since `materializeStepList` itself depends on a consistent registry. The check:
  1. `SELECT id, workflow_snapshot, status FROM videos WHERE workflow_snapshot IS NOT NULL AND status IN ('new', 'queued', 'in_progress')`.
  2. For each row, JSON-parse the snapshot, materialize the step list via `materializeStepList(snapshot)`, and assert every emitted slug is in `REAL_STEPS` (use the existing `REAL_STEPS_BY_NAME` lookup or a fresh `Set<string>`).
  3. On first violation, throw with a message naming the offending video id, the offending slug, and the operator action: `"Video ${id}'s workflow_snapshot references step '${slug}', which is not in REAL_STEPS. This snapshot was created with a pre-Phase-5 workflow definition. Operator action: drain or restart this video before deploying. See docs/plans/workflow-modularization/phase-5.md §Migration Notes."`

  **Status enum interpretation:** README Invariant C point 3 listed `failed` alongside `new`/`queued`/`in_progress` as non-terminal. The actual `VideoStatus` enum (`src/types.ts:11`) treats `failed` as terminal — a `failed` video stays put until an operator manually clears or re-queues it. Phase 5's check **excludes `failed`** (skipping known-broken videos). A `failed` video with a legacy snapshot is dormant; if the operator later re-queues it, the snapshot re-resolution at `transitionNewToQueued` (Phase 1 Task 5) will refresh the snapshot from the live workflow row and the legacy slug will be replaced. So failed videos are safe to skip at boot. **Action item: update README Invariant C point 3 to drop `failed` from the non-terminal list** — the README's wording was speculative; this task pins the resolved interpretation.

  **Performance note:** the check is O(non-terminal-videos) at every boot. For dev DBs this is trivial. If a HistForge instance ever accumulates thousands of `in_progress` rows (unlikely under the current single-worker model), the linear scan starts to matter — at that point an index on `videos.status` would help, but it's out of scope here.
  **Context:** The §Migration Notes block below is the operator action the throw message references; Phase 5's PR description must call it out prominently. The check runs in `bootValidate` rather than in `runner.ts` because it's a cross-cutting structural assertion, not a runtime decision.

### Phase 5E — Schema endpoint

- [x] **Task 16: Schema endpoint switches to `Object.keys(<registry>)`**
  **Phase 5E landing notes:**
  - `imageProviders` was already exported from `src/lib/image/index.ts` (Task 4); no registry-side change was needed.
  - Snapshot file `__tests__/api/workflows/schema/__snapshots__/schema.json` was **not** regenerated — output is byte-identical to the pre-refactor hardcoded arrays, confirming registry insertion order matches (`comfyui` first, then `google_flow`). This satisfies the Task 22 verification clause; **nothing remains for Task 22 in Phase 5F**.
  - Two contract tests were added to `__tests__/api/workflows/schema/route.test.ts` asserting `body.providers.image === Object.keys(imageProviders)` and same for video. These are stricter than the sibling `providers.script` test (which uses `arrayContaining`) — intentional, to lock in registry-driven shape.
  - Obsolete forward-looking comments in `route.ts` (the "Hardcoded until Phase 5…" inline block and the "Phase 5 will collapse…" JSDoc paragraph) were removed and replaced with a one-line Invariant D note.
  - Strict RED-GREEN was skipped: the hardcoded arrays already happened to equal `Object.keys` of the populated registries, so the new tests passed pre-change. Treated as a contract-locking refactor, not new behavior.

  **Files:** `src/app/api/workflows/schema/route.ts`, possibly `src/lib/image/index.ts` (if `imageProviders` not already exported)
  **What:** Replace the hardcoded arrays:
  ```
  providers: {
    script: Object.keys(llmProviders),
    tts:    Object.keys(ttsProviders),
    image:  ["comfyui", "google_flow"],   // delete the hardcoded array
    video:  ["comfyui", "google_flow"],   // delete the hardcoded array
  }
  ```
  with:
  ```
  providers: {
    script: Object.keys(llmProviders),
    tts:    Object.keys(ttsProviders),
    image:  Object.keys(imageProviders),
    video:  Object.keys(videoProviders),
  }
  ```
  If `imageProviders` is not already exported from `src/lib/image/index.ts`, expose it now (mirroring the `videoProviders` export added in Task 8 and the existing `ttsProviders` export at `src/lib/tts/index.ts:6-8`).
  **Context:** Invariant D Phase 5 row. Phase 3 Task 5's file-snapshot test (`__tests__/api/workflows/schema/route.test.ts`; snapshot at `__tests__/api/workflows/schema/__snapshots__/schema.json`) regenerates — Task 22 covers that. After Task 4 and Task 8 register both new providers, the response shape is identical to the pre-Phase-5 hardcoded arrays — the diff is "code path the value comes from", not "value". The snapshot diff for the providers fields should match exactly; if it doesn't, the registry order or contents diverge and that's the bug. (The `steps[]` portion will diff — that's the unified-slug churn, expected.)

### Phase 5F — Tests

- [x] **Task 17: Image registry test extended for `google_flow`**
  **Status:** done. All three cases below plus an `Object.keys` order assertion live in `__tests__/unit/lib/image/index.test.ts` (4 tests, already passing).
  **Files:** `__tests__/unit/lib/image/index.test.ts`
  **What:** Add cases:
  - `getImageProvider("google_flow")` returns the registered provider (no throw).
  - `Object.keys(imageProviders)` returns `["comfyui", "google_flow"]` (or set-equal to that — the order may not matter to consumers, but the schema endpoint test pins it).
  - `getImageProvider("__unknown__")` throws.

- [x] **Task 18: Video registry test (new)**
  **Status:** done. Same shape as Task 17 — 4 tests in `__tests__/unit/lib/video/index.test.ts`, already passing.
  **Files:** `__tests__/unit/lib/video/index.test.ts`
  **What:** Same shape as Task 17 for the new video registry: both providers resolve, unknown throws, `Object.keys` is `["comfyui", "google_flow"]`.

- [x] **Task 19: Replace four legacy step tests with two unified ones**
  **Status:** done in Phase 5B. The four legacy step files were deleted alongside their step files (Task 11 coupling); `__tests__/unit/worker/steps/generate-main-images.test.ts` was rewritten in place and `__tests__/unit/worker/steps/generate-hook-video.test.ts` was added new. Both test the unified step against ImageProvider / VideoProvider stubs (`{ generateBatch: vi.fn(), cleanup: vi.fn() }`), 5 cases each: dispatch with full opts (videoId, projectsDir, promptsDir, chat, db, log); DeferSignal pass-through; cleanup delegation; cleanup no-op when provider has no hook; step metadata. **Nothing remains here.**

- [x] **Task 20: Pipeline integration regression for both built-in workflows**
  **Status:** done. New `runPipeline — Phase 5 snapshot-driven provider resolution (integration)` block in `__tests__/unit/worker/pipeline-workflow.test.ts` exercises the snapshot → registry → ctx wiring path **without** overriding `deps.imageProvider` / `deps.videoProvider` — a capture step records `ctx.{image,video}Provider` and the test asserts identity against the real `imageProviders` / `videoProviders` exports. Two scenarios (comfyui workflow → both ctx providers === `*.comfyui`; google-flow workflow → both === `*.google_flow`) cover the seeded built-ins. Combined with the per-step unit tests in `__tests__/unit/worker/steps/generate-{main-images,hook-video}.test.ts` (which prove the unified steps dispatch via ctx) and the snapshot-end-to-end block above (which proves `materializeStepList` emits the unified slugs), this closes the integration loop. Note: the unified-slug → REAL_STEPS lookup inside `resolveDeps` is not directly exercised end-to-end because doing so would require running the full 13-step pipeline (the materializer always emits ≥6 forced glue steps). The per-step lookup helper at `__tests__/unit/worker/pipeline-workflow.test.ts` (`materializeStepList(readSnapshot(...))` + `REAL_STEPS.find` assertion) covers the components transitively.
  **Files:** `__tests__/unit/worker/pipeline-workflow.test.ts`
  **What (original spec):**
  1. Seed the `comfyui` workflow row + steps, `createNewVideo({ workflow_id: "comfyui" })`, `transitionNewToQueued`, run pipeline through the image + video module steps. Mock the providers (image + video both stubbed via `deps.imageProvider` / `deps.videoProvider`). Assert: the orchestrator dispatches the step named `generate_main_images` (not `generate_main_images_comfyui`), and the stubbed provider receives the right items.
  2. Same for `google-flow` workflow.

- [x] **Task 21: `bootValidate` rejection test for legacy-slug snapshots**
  **Status:** done. `bootValidate — Invariant C point 3 (snapshot-validity)` block in `__tests__/unit/worker/boot.test.ts` covers all three cases below (parameterized via `it.each` over the status enum) plus a bonus case asserting the check catches *any* unknown slug, not just the legacy patterns. Already passing.
  **Files:** `__tests__/unit/worker/boot.test.ts`
  **What:** Three cases:
  1. Seed a `new`-status video with a snapshot whose `steps` includes `generate_main_images_comfyui`. `bootValidate(db)` throws with a message naming the video id, the offending slug, and the operator action.
  2. Seed a `done`-status video with the same broken snapshot. `bootValidate(db)` returns without throwing (terminal).
  3. Seed a `failed`-status video with the same broken snapshot. `bootValidate(db)` returns without throwing (terminal).

- [x] **Task 22: Phase 3 schema-endpoint file snapshot regenerated**
  **Status:** done. `steps[]` regen + test-body edits landed in Phase 5B; the providers verification clause was satisfied in Phase 5E (Task 16) — the snapshot file was unmodified after the route swap to `Object.keys(<registry>)`, confirming registry insertion order matches the legacy hardcoded arrays. **Nothing remains here.**
  **Files:** `__tests__/api/workflows/schema/route.test.ts` (test) and `__tests__/api/workflows/schema/__snapshots__/schema.json` (snapshot file regenerated by `vitest -u`).

- [x] **Task 23: Cross-provider mix integration test**
  **Status:** done. Third scenario in the new `Phase 5 snapshot-driven provider resolution (integration)` block: inserts a video with a synthetic snapshot pinning `image_provider: "comfyui"` + `video_provider: "google_flow"`, then runs `runPipeline` with a capture step (no provider overrides). Asserts `ctx.imageProvider === imageProviders.comfyui` AND `ctx.videoProvider === videoProviders.google_flow` — proving `resolveDeps` performs two independent registry lookups against two different real registry exports. The `not.toBe` cross-equality assertion rules out accidental coupling. No real ComfyUI / Google Flow contact: identity comparison against the registry exports doesn't invoke `generateBatch`.
  **Files:** `__tests__/unit/worker/pipeline-workflow.test.ts`
  **What:** Seed a custom workflow / snapshot with `image_provider: "comfyui"` + `video_provider: "google_flow"` (or the reverse). Stub both registries — `ctx.imageProvider` is the ComfyUI provider, `ctx.videoProvider` is the Google Flow provider. Assert the snapshot drives per-module registry lookup with no implicit "all-comfyui or all-google_flow" coupling.

---

## Migration Notes (Phase 5–specific)

This section is the operator-facing content Phase 5's PR description must surface — `bootValidate` (Task 15) will refuse to start the worker on a stale snapshot, so operators need this playbook before deploy.

- **Pre-deploy operator action:** drain or restart any video whose status is `new`, `queued`, or `in_progress` and whose `workflow_snapshot` was created before Phase 5. The `bootValidate(db)` snapshot-validity check (Task 15) refuses to start the worker if any such snapshot remains. The operator can run `SELECT id, status, workflow_snapshot FROM videos WHERE workflow_snapshot LIKE '%generate_main_images_comfyui%' OR workflow_snapshot LIKE '%generate_main_images_google_flow%' OR workflow_snapshot LIKE '%generate_hook_video_comfyui%' OR workflow_snapshot LIKE '%generate_hook_video_google_flow%'` to find affected rows. Options per row:
  - If status is `new`: do nothing — the next `transitionNewToQueued` re-resolves the snapshot from the live workflow row (Phase 1 Task 5 contract), which now emits unified slugs.
  - If status is `queued` or `in_progress`: cancel and re-queue the video (operator's standard procedure), or wait for it to complete to a terminal state before deploying.
- **Failed videos with legacy snapshots:** safe to skip — `bootValidate` excludes terminal status (per Task 15 resolved interpretation). If the operator later re-queues a `failed` video, the queue-time re-snapshot picks up the unified slugs.
- **Test DB:** disposable — `npm run db:init` re-seeds with the unified slugs. No migration required for fresh DBs.
- **Settings UI:** unchanged. The `image_provider` setting (today a global) is no longer read by the orchestrator after Task 13 — but stays in `DEFAULT_SETTINGS` and the UI as a structural placeholder. Removing it is an Open Item for a future cleanup phase (parallel to Phase 4's `llm_provider` deletion).

---

## Done Criteria

Closes README Invariant A (transitional mapping deletion) and adds README Invariant C point 3 (snapshot-validity enforcement).

- The four legacy step files are deleted: `Grep -r 'generate_main_images_comfyui\|generate_main_images_google_flow\|generate_hook_video_comfyui\|generate_hook_video_google_flow' src/` returns zero hits.
- `src/lib/video/{types,index,comfyui,google-flow}.ts` exist; `getVideoProvider("comfyui")` and `getVideoProvider("google_flow")` resolve.
- `src/lib/image/google-flow.ts` exists; `getImageProvider("google_flow")` resolves; `Object.keys(imageProviders) === ["comfyui", "google_flow"]`.
- `ImageProvider.generateBatch` returns `Promise<void | DeferSignal>` and accepts `{ chat, videoId, db?, log? }` opts. `VideoProvider` mirrors this exactly. Both interfaces declare an optional `cleanup`.
- `src/lib/workflows.ts` `materializeStepList` no longer contains the four-row provider→slug mapping table (Invariant A removal complete). Both seeded workflows materialize `generate_main_images` and `generate_hook_video` directly.
- `src/lib/artifact-grouping.ts` `STEP_ARTIFACT_RULES` has two entries for the unified slugs (down from four).
- `StepContext` has `videoProvider: VideoProvider`. `resolveDeps` reads `imageProvider` from `snapshot.image_provider` and `videoProvider` from `snapshot.video_provider`.
- `bootValidate(db)` rejects any non-terminal (`new` / `queued` / `in_progress`) video whose snapshot's materialized step list contains a slug not in `REAL_STEPS`. The throw message names the video id, the offending slug, and the operator action.
- `GET /api/workflows/schema` `providers.image` and `providers.video` come from `Object.keys(imageProviders)` and `Object.keys(videoProviders)` respectively (Invariant D Phase 5 row); the response payload is identical to the pre-Phase-5 hardcoded arrays.
- Workflow editor's Image and Video module slots remain `<Select>` lists — no editor change needed (Phase 2 Task 13 already wired them; the option list `["comfyui", "google_flow"]` is unchanged).
- A workflow with `image_provider: "comfyui"` + `video_provider: "google_flow"` (cross-provider mix) dispatches the unified `generate_main_images` step to the ComfyUI image provider and the unified `generate_hook_video` step to the Google Flow video provider — verified via stubbed providers in Task 23, not against real ComfyUI / Google Flow infrastructure.
- Both seeded built-in workflows' integration tests pass (Task 20).
- The Phase 3 schema-endpoint file snapshot (`__tests__/api/workflows/schema/__snapshots__/schema.json`) regenerates and the diff matches expected churn (Task 22). No other authorized snapshot diffs.
- Settings UI: ComfyUI and Google Flow tabs untouched.

---

## References

- Cross-phase invariants: [`README.md`](README.md) — Invariant A (transitional mapping deleted), Invariant B (snapshot lifecycle — materializer output changes, snapshot shape unchanged), Invariant C point 3 (snapshot-validity check, introduced this phase), Invariant D (`providers.image`/`providers.video` switch to `Object.keys`), Invariant E (`generateBatch` opts threads `ctx.chat`)
