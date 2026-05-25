# YouForge Flow: Executor Registry + Video-Executor Consolidation

## Overview

Three linked SOLID refactors to `extensions/youforge-flow`'s executor layer,
from `docs/refactoring/solid-audit-2026-04-22-youforge-flow.md`:
finding **#4** (split prelude from dispatch in `executeTaskViaAPI`),
finding **#1** (replace the mode if-chain with a registry, matching the
house pattern from `src/lib/tts/index.ts` / `src/lib/image/index.ts`),
and finding **#2** (extract `runVideoGeneration` so the three video
executors stop duplicating ~70% of their scaffolding).

Doing them together makes sense because each change reduces the surface
area of the next one: extracting the context prelude shrinks the
dispatcher enough that swapping it for a registry is one small edit, and
the registry then becomes the natural place for the video executors to
be registered as thin configs.

## Current State

**Platform.** The extension is a Chrome MV3 service worker loaded via
classic `importScripts` (see `extensions/youforge-flow/background.js`).
All modules share a single global scope; there are no ES imports. Files
are loaded leaves-first — `src/executors/shared.js` already loads before
`text-to-video.js` / `image-to-video.js` / `frames-to-video.js` /
`image.js` / `index.js`, so adding a new helper to `shared.js` is safe.

**`executeTaskViaAPI` does two jobs.** `src/executors/index.js:27-132` is
a single 105-line function with two phases joined by
`const ctx = { ... }`:
- **Prelude (lines 29-103):** token fetching, storage reads, account-tier
  detection, helper-closure creation, ctx assembly. Changes when
  auth/storage/tier concerns evolve.
- **Dispatch (lines 105-131):** if-chain over `taskMode`. Changes when a
  new Flow mode is added.

**Mode-to-recaptcha mapping is duplicated.** Lines 34-36 pick the
recaptcha action from the mode; lines 105-131 pick the executor from the
mode. Both are mode-keyed lookups that must agree. Adding a mode
requires editing both places.

**Unknown-mode fallback.** Line 130-131 sends unknown modes to
`runTextToVideo`. Line 115-118 has a separate "no-images" guard: any
non-image-gen mode that arrived without reference images also falls
through to `runTextToVideo` regardless of declared mode. These are two
different routing rules and must remain distinct after the refactor.

**Video executors duplicate scaffolding.** All three of
`src/executors/text-to-video.js`,
`src/executors/image-to-video.js`,
`src/executors/frames-to-video.js` carry the same shape:
1. Destructure from `ctx`.
2. Pick `videoAspect` from `settings.aspectRatioSetting`.
3. Optionally upload reference/start/end images.
4. Build a request body wrapping `{ mediaGenerationContext: { batchId:
   crypto.randomUUID() }, clientContext: buildClientContext({ ... }),
   requests: [{ aspectRatio, seed, textInput, videoModelKey, metadata:
   {}, ... }], useV2ModelConfig: true }`.
5. Call `pageCall(endpoint, body)`.
6. `toMediaIds` → throw if empty → `pollVideo` → throw if empty →
   `upscaleVideos` → return `{ taskId, resultUrl, mode }`.

Only steps 3 and the per-request fields in step 4 differ between
executors. Steps 1-2 and 5-6 are verbatim-identical boilerplate, just
drifted slightly during the modularization — compare the "returned no
media IDs" error wording at `text-to-video.js:42`,
`image-to-video.js:88`, `frames-to-video.js:109`.

**Shared helpers already in place.** `src/executors/shared.js` already
owns `toMediaIds` and `upscaleVideos`. It's the right home for the new
helper. `src/executors/upscale.js`'s `upscaleWithFallback` is the
positive reference for the design the new helper should mirror: caller
supplies the parts that differ, helper owns the parts that don't.

**Image generation is outside Finding #2.** `runImageGen`
(`src/executors/image.js`) shares some boilerplate with the video
executors but uses a different endpoint shape (no `mediaGenerationContext`
at the top level, per-request `clientContext`, `useNewMedia`). It stays
as-is and is only touched by the registry change (#1).

**Testing.** The extension has no automated tests (vitest covers the
Next.js project only). Per `README.md:39-52`, it is loaded unpacked in
Chrome developer mode and tested end-to-end against a live Flow session.
Smoke test plan is in the Verification section below.

**House pattern for registries.** `src/lib/tts/index.ts:6-16` and
`src/lib/image/index.ts:6-16` are the canonical examples in the
HistForge tree. Use them as style references for the `EXECUTORS`
registry.

## Scope

**Doing**:
- Extract `buildExecutorContext(task, tabId)` in `src/executors/index.js`.
- Add an `EXECUTORS` registry keyed by mode, with `{ run, recaptchaAction }`.
- Preserve both routing rules: no-images-fallback guard and unknown-mode fallback.
- Extract `runVideoGeneration(task, ctx, config)` in `src/executors/shared.js`.
- Migrate `runTextToVideo`, `runImageToVideo`, `runFramesToVideo` to the new helper.
- Smoke-test the extension end-to-end against a live Flow tab.

**Not doing**:
- Touching `runImageGen` internals (only its registry entry changes).
- Finding #3 (`pollForTasksFIFO` split) — separate plan.
- Finding #5 (`getVideoModelKeys` matrix) — separate plan.
- Other audit findings (#6-#11).
- Any change to upstream files under `extensions/veo-upstream/`.
- Converting the service worker to ES modules or adding a bundler.
- Adding automated tests for the extension (manual smoke only).

## Tasks

### Phase 1: Executor dispatch refactor (findings #4 + #1)

- [x] **Task 1.1: Extract `buildExecutorContext(task, tabId)`**
  **Files**: `src/executors/index.js`
  **What**: Move the prelude (token fetching, storage reads, account-tier
  detection, helper closures, ctx assembly — currently lines 29-103 of
  `executeTaskViaAPI`) into a new top-level function
  `buildExecutorContext(task, tabId)` that returns `{ ctx, taskMode }`.
  The `executeTaskViaAPI` dispatcher keeps only mode-routing logic.
  Behavior must be identical — this is a pure extraction.
  **Context**: Classic service-worker script — declare at top level, no
  exports. Recaptcha-action calculation at `src/executors/index.js:34-36`
  stays inside `buildExecutorContext` for now (Task 1.2 will move it
  into the registry). The `onUpscaleStart` closure at
  `src/executors/index.js:81-87` must stay inside `buildExecutorContext`
  because it closes over ctx-build-time state. The file's docstring
  (lines 1-25) needs updating to describe the new split.

- [x] **Task 1.2: Replace mode if-chain with `EXECUTORS` registry**
  **Files**: `src/executors/index.js`
  **What**: Add a top-level `EXECUTORS` object. Keys are mode strings
  (`createimage`, `imagegen`, `text`, `image`, `ingredients`, `frames`),
  values are `{ run, recaptchaAction, isImageGen }`. The `createimage`
  and `imagegen` entries set `isImageGen: true`; the others omit it (or
  set it to `false`). Update `buildExecutorContext` to take
  `recaptchaAction` as a parameter instead of deriving it from
  `taskMode` — the dispatcher now owns that decision. Rewrite
  `executeTaskViaAPI` to:
    1. Look up `entry = EXECUTORS[taskMode]`. If undefined, log
       `Unknown mode: <taskMode> - falling back to text-to-video`
       (matches `src/executors/index.js:130`) and set `entry =
       EXECUTORS.text`.
    2. Call `const ctx = await buildExecutorContext(task, tabId,
       entry.recaptchaAction)`.
    3. Apply the no-images guard only when `!entry.isImageGen`: if no
       `referenceImage` / `startFrame` / `Start Frame` / `Image URL`
       is present on the task, reassign `entry = EXECUTORS.text` and
       log the existing "No images on non-image-gen task, routing to
       text-to-video" message.
    4. `return await entry.run(task, ctx)`.
  **Context**: The positive precedent for registry style is
  `src/lib/tts/index.ts:6-16` and `src/lib/image/index.ts:6-16`. Keep
  the two routing rules distinct and in this order: (a) mode-lookup
  with the unknown-mode log + `text` fallback, (b) no-images fallback
  applied only to non-image-gen entries. Both routing branches must
  still log their existing messages so operators can trace which path
  a task took. Update the module's docstring (the "Dispatch rules"
  block at lines 7-15) to describe the registry-based flow and the
  `isImageGen` flag. `buildExecutorContext`'s internal removal of the
  recaptcha-action ternary is part of this task — after Task 1.1 those
  lines live inside `buildExecutorContext`; 1.2 deletes them and adds
  the `recaptchaAction` parameter.

### Phase 2: Video executor consolidation (finding #2)

- [x] **Task 2.1: Add `runVideoGeneration(task, ctx, config)` helper**
  **Files**: `src/executors/shared.js`
  **What**: New top-level async function that owns the full video-
  generation shape shared by the three video executors — wrapper,
  common per-request fields, *and* tail. Helper responsibilities:
    - Destructure `{ projectId, sessionId, recaptchaToken, modelKeys,
      settings, pageCall, pollVideo, authToken }` from `ctx`.
    - Compute `videoAspect` from `settings.aspectRatioSetting` (the
      existing portrait/landscape ternary).
    - Mint a fresh `batchId` via `crypto.randomUUID()` on every call
      (do not hoist or memoize — each generation is its own batch).
    - Build the body: `mediaGenerationContext: { batchId }`,
      `clientContext: buildClientContext({ projectId, recaptchaToken,
      sessionId, paygateTier: modelKeys.paygateTier })`, a single-
      element `requests` array whose entry is `{ aspectRatio:
      videoAspect, seed: Math.floor(Math.random() * 100000),
      textInput: { structuredPrompt: { parts: [{ text: task.prompt
      }] } }, videoModelKey: config.videoModelKey, metadata: {},
      ...config.perRequestExtras }`, and `useV2ModelConfig: true`.
    - Call `pageCall(config.endpoint, body)`.
    - `toMediaIds` → throw with the existing "Video generation
      returned no media IDs. Raw: …" message if empty → `pollVideo` →
      throw with "Video generation failed - no results after polling"
      if empty → `upscaleVideos` → return `{ taskId: task.id,
      resultUrl: videoUrls.join(','), mode: config.mode }`.

  Caller supplies `config`: `{ endpoint: string, videoModelKey: string,
  perRequestExtras: object, mode: string }`. `perRequestExtras` holds
  the per-executor bits that vary (`{}` for text-only, `{ startImage }`
  or `{ referenceImages }` for image-to-video, `{ startImage, endImage
  }` / `{ startImage }` / `{ referenceImages }` for frames-to-video) —
  the helper spreads it into the one `requests[0]` object.
  **Context**: The canonical reference for "caller supplies what's
  different, helper owns what isn't" is `upscaleWithFallback` in
  `src/executors/upscale.js`. The audit finding (#2) targets the body
  *scaffolding* duplication — not just the tail — so the helper owns
  the wrapper and the common per-request fields, not merely the
  post-`pageCall` sequence. All three current video executors emit
  exactly one request per call, so the single-element `requests: [...]`
  array is hard-coded (no multi-request branch needed). Error wording
  already matches verbatim across the three executors' current
  messages, so centralizing them here does not change log output. Add
  the new helper to the module docstring at
  `src/executors/shared.js:1-8` alongside `toMediaIds` / `upscaleImages`
  / `upscaleVideos`.

- [x] **Task 2.2: Migrate `runTextToVideo` to `runVideoGeneration`**
  **Files**: `src/executors/text-to-video.js`
  **What**: Replace the function body with a single call:
  `runVideoGeneration(task, ctx, { endpoint: AISANDBOX_BASE +
  '/video:batchAsyncGenerateVideoText', videoModelKey:
  ctx.modelKeys.t2v, perRequestExtras: {}, mode: (task.mode ||
  'text').toLowerCase() || 'text' })` and return its result. Keep the
  existing "Text-to-video mode, model: …" `safeLog` line before the
  call so operators still see which model key was selected. Done first
  because text-to-video is the simplest case and validates the
  helper's design before the more complex migrations. Update the
  file's docstring (lines 1-9) to reflect that the executor is now a
  thin config over `runVideoGeneration`.
  **Context**: Current file is `src/executors/text-to-video.js` (60
  lines). The redundant `|| 'text'` double-fallback on the mode label
  is a historical safety net — preserve verbatim.

- [x] **Task 2.3: Migrate `runImageToVideo` to `runVideoGeneration`**
  **Files**: `src/executors/image-to-video.js`
  **What**: Keep the image-upload loop
  (`src/executors/image-to-video.js:20-33`) and the quality-warning
  log (lines 35-37). Replace the Lite-vs-non-Lite body-building branch
  (lines 39-84) with a decision that picks `{ endpoint, videoModelKey,
  perRequestExtras }`:
    - **Lite**: endpoint
      `AISANDBOX_BASE + '/video:batchAsyncGenerateVideoStartImage'`,
      videoModelKey `modelKeys.i2v`, perRequestExtras `{ startImage: {
      mediaId: refImageIds[0], cropCoordinates: { top: 0, left: 0,
      bottom: 1, right: 1 } } }`.
    - **Non-Lite**: endpoint
      `AISANDBOX_BASE + '/video:batchAsyncGenerateVideoReferenceImages'`,
      videoModelKey `modelKeys.r2v`, perRequestExtras `{
      referenceImages: refImageIds.map(id => ({ mediaId: id,
      imageUsageType: 'IMAGE_USAGE_TYPE_ASSET' })) }`.
  Then call `runVideoGeneration(task, ctx, { endpoint, videoModelKey,
  perRequestExtras, mode: (task.mode || 'image').toLowerCase() })`.
  Do this after Task 2.2 lands so the helper design is validated on
  the simple case first. Update the file's docstring (lines 1-10).
  **Context**: Current file is `src/executors/image-to-video.js` (105
  lines). The two branch-identifying `safeLog` lines (`:42` "VEO Lite
  image-to-video, image: …" and `:63` "Image-to-video, refs: …") stay
  at the branch decision so they still print before the helper call.

- [x] **Task 2.4: Migrate `runFramesToVideo` to `runVideoGeneration`**
  **Files**: `src/executors/frames-to-video.js`
  **What**: Keep the start/end-frame upload block
  (`src/executors/frames-to-video.js:25-34`). Replace the three-way
  body-building branch (lines 41-105) with a decision that picks `{
  endpoint, videoModelKey, perRequestExtras }`:
    - **Has end frame**: endpoint
      `AISANDBOX_BASE + '/video:batchAsyncGenerateVideoStartAndEndImage'`,
      videoModelKey `modelKeys.i2v_fl`, perRequestExtras `{
      startImage: { mediaId: startImageId, cropCoordinates: { top: 0,
      left: 0, bottom: 1, right: 1 } }, endImage: { mediaId:
      endImageId } }`.
    - **Start-only, Lite**: endpoint
      `AISANDBOX_BASE + '/video:batchAsyncGenerateVideoStartImage'`,
      videoModelKey `modelKeys.i2v`, perRequestExtras `{ startImage: {
      mediaId: startImageId, cropCoordinates: { top: 0, left: 0,
      bottom: 1, right: 1 } } }`.
    - **Start-only, non-Lite**: endpoint
      `AISANDBOX_BASE + '/video:batchAsyncGenerateVideoReferenceImages'`,
      videoModelKey `modelKeys.r2v`, perRequestExtras `{
      referenceImages: [{ mediaId: startImageId, imageUsageType:
      'IMAGE_USAGE_TYPE_ASSET' }] }`.
  Then call `runVideoGeneration(task, ctx, { endpoint, videoModelKey,
  perRequestExtras, mode: (task.mode || 'frames').toLowerCase() })`.
  Update the module docstring (lines 1-11) — the three-way branch is
  still documented, but now it references `runVideoGeneration`.
  **Context**: Current file is `src/executors/frames-to-video.js` (126
  lines). The two branch-identifying `safeLog` lines (`:64` "VEO Lite
  frames, using StartImage endpoint" and `:85` "Only start frame,
  using ReferenceImages endpoint") stay at the branch decision so
  they still print before the helper call.

## Verification

No automated tests cover this extension. After Phase 1 and Phase 2 each
complete, reload the unpacked extension in Chrome (per
`extensions/youforge-flow/README.md:39-52`) and verify:

1. **Registry routing (Phase 1).** Send test tasks through HistForge
   with each mode: `createimage`, `imagegen`, `text`, `image`,
   `ingredients`, `frames`. Confirm each reaches the expected executor
   (check the `[YouForge Flow]` log lines in the service-worker
   devtools) and returns a result.
2. **Routing rules (Phase 1).** Send a `frames` task with no start/end
   frames — confirm it falls through to text-to-video (missing-images
   guard). Send a task with `mode: "gibberish"` — confirm it falls
   through to text-to-video (unknown-mode fallback). Both fallbacks
   should log their existing messages.
3. **Shared helper (Phase 2).** After each migration task, send at
   least one task through the migrated executor and confirm the full
   lifecycle (generation → poll → upscale if configured → webhook
   submission). Compare a before-and-after log to make sure no lines
   went missing.
4. **Upscale path (Phase 2).** Run at least one video task with
   `vidUpscale` set to `"4k"` and one with `"1080p"` — confirm
   `upscaleVideos` still receives the correct `startResult.raw` /
   `mediaIds` / `ctx.onUpscaleStart` values after the helper change.
5. **Stop flag (both phases).** Hit Stop mid-task — confirm
   `STOP_REQUESTED` still propagates cleanly through the new helper
   layer via `assertNotStopped` call sites that are already woven
   through `apiCallViaPage` / `pollVideoUntilDone`.

## References

- Audit source: `docs/refactoring/solid-audit-2026-04-22-youforge-flow.md` (findings #1, #2, #4)
- Prior modularization plan (context for the current file split): `docs/plans/2026-04-21-youforge-flow-audit-modularize.md`
- Registry style precedent: `src/lib/tts/index.ts:6-16`, `src/lib/image/index.ts:6-16`
- Helper design precedent: `src/executors/upscale.js` (`upscaleWithFallback`)
- Extension README (load/smoke-test instructions): `extensions/youforge-flow/README.md`
- Key files touched:
  - `extensions/youforge-flow/src/executors/index.js`
  - `extensions/youforge-flow/src/executors/shared.js`
  - `extensions/youforge-flow/src/executors/text-to-video.js`
  - `extensions/youforge-flow/src/executors/image-to-video.js`
  - `extensions/youforge-flow/src/executors/frames-to-video.js`
