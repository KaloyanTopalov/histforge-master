# Ambient-Video Thumbnail Generation (Magnific reference-image flow)

## Overview

Add an automated thumbnail step to the `ambient-video` workflow. It takes the album's video title + the max-resolution generated cover, asks a vision-capable LLM (via OpenRouter) to produce a Magnific title-overlay prompt, drives Magnific Seedream 5 Lite with the cover uploaded as an **image reference** (not a saved style), generates 4 candidates, downloads **all 4**, then post-processes each to **4K with no black bars (zoom/crop-to-fill) + vibrance +30 + saturation +10**.

Why: ambient-video produces no thumbnail today (the hardcoded step 05b uses Flow, which ambient-video doesn't have). The operator currently does this entire flow by hand (separate Claude project for the prompt, manual Magnific reference-image upload, manual download, manual Photoshop grade). This automates it as a pipeline step.

## Current State

- **OpenRouter client is text-only.** `src/lib/llm/openrouter.ts` — `PostInput.user` is `string` (lines ~117–123); the messages array is built as `{ role, content: string }` (lines ~195–199); only `chatCompletionJSON` is exported (line ~65); model resolves from `settings.model_name`, fallback `anthropic/claude-haiku-4.5` (lines ~156–162). No image/vision content support, no plain-text completion.
- **Freepik client/bridge/extension only do saved-style + single pick.** `src/lib/freepik/client.ts` `submit()` sends `mode:'imagegen'` + optional `styleName` (lines ~257–274); `submitVideo()` adds `sourceImagePath` for image-to-video (lines ~275–296). Bridge `extensions/freepik-runner/bridge.ts` Task model + `/submit` (lines ~270–315), `/poll` returns `{status}` only (~317–334), `/download/:taskId` returns one body (~336–349), `/result` consumes only `mediaFiles[0]` (~377–412). No image-reference mode, no multi-image return.
- **Extension content.js** (`extensions/freepik-runner/content.js`, build marker line ~26): `executeImageGen()` (~line 88) drives page → model `[data-cy="tti-mode-selector-v3-trigger"]` → aspect `[data-cy="image-aspect-ratio-input"]` → count `[data-cy="increase-number-images-button"]` → resolution `[data-cy="image-resolution-input"]` → prompt `[data-cy="image-prompt-input"]` → optional `addSavedStyle()` (~455) → `[data-cy="generate-button"]` → `waitForOperatorPick()` (~551, single pick). CDP file-upload primitive exists and is reusable: `ensureEndFrameMatchesStart()` (~1245) tags the modal's `input[type=file]`, sends `freepik:set-file-input-files`; background.js `setFileInputFiles()` (~361–380) does CDP `DOM.setFileInputFiles`; modal hooks `[data-cy="advanced-selection-modal"]`, `[data-cy="upload-button"]`, `[data-cy="upload-use-selected-button"]`. **No code touches `[data-cy="edit-reference-button"]`** — the operator-supplied DOM hook for the image-reference "Edit" button. The post-Edit-click modal DOM is not yet captured.
- **WorkflowDefinition has no step05b slot.** `src/worker/workflows/types.ts` (~21–43) has optional `step01?` / `step05a?`, required `branchB`, `preflightChecks`. `src/worker/runner.ts` hardcodes `step05b: step05bThumbnail` (~line 95). `src/worker/pipeline.ts` calls `deps.step05b` unconditionally (~231–236). ambient-video.ts (78–90) overrides step01/step05a/branchB only.
- **Album/title fields.** `album.sceneTitle` set by step 01b (`src/worker/steps/01b-scene-generator.ts:88`), already overrides ytTitle in step 10 for ambient-video (the single permitted workflow conditional). `source.jpg` (max-res original from Magnific) lives at `projects/<ch>/<alb>/source.jpg`; `cover.png` is the square 3000×3000 crop; `ytImage.png` is 1920×1080. step 05a writes coverImagePath/ytImagePath (`05a-ambient-video-cover.ts`).
- **Template loader pattern.** Step 01b bypasses `resolveChannelPrompt` for a non-`PromptKind` template: hardcoded kind `ambient-video-scene`, loaded `prompts/channel-templates/<ch>/<kind>.md` → `prompts/defaults/<kind>.md` (`01b-scene-generator.ts:144–177`). `prompts/channel-templates/` is currently empty.
- **FFmpeg image helpers.** `src/lib/audio/ffmpeg.ts`: `resizeWithMode(in,out,w,h,'crop')` already = `scale=W:H:force_original_aspect_ratio=increase,crop=W:H` (lines ~265–279) — exactly "no black bars / zoom to fill". `cropAndScaleSquare`, `compressToJpeg` exist. **No color-grade (saturation/vibrance) helper exists.**
- **Iteration mechanics (memory `reference-freepik-step08-validation`):** freepik-runner changes are blind-iterated via distinct error codes per failure path, a bumped `content.js build` marker, and always-on smoke buttons. **Memory `project-ambient-video-magnific`:** any `background.js` change needs the launch-time `chrome.runtime.reload()` (already in `scripts/freepik-login.ts`) to actually run the new SW code — the `content.js build` marker is NOT proof the SW is current. **Memory `feedback-dom-evidence`:** the operator pasted `[data-cy="edit-reference-button"]` — drive that exact element, do not work around it.

## Scope

**Doing**: vision support in the OpenRouter client; a thumbnail-spec template (the operator's exact Knight/Vortalania prompt) + channel-override loader; a new freepik `imagegen-thumbnail` mode (reference-image upload via `edit-reference-button`, no operator pick, return all 4) across client + bridge + extension; a 4K no-bars + vibrance/saturation grade helper; a new `step05b?` workflow slot wired so ambient-video runs a new automated thumbnail step; tests + blind-iteration affordances.

**Not doing**: selecting/promoting one of the 4 into `album.thumbnailPath` (deferred — "the rest"); changing ambient/rap step 05b (they keep the Flow path via fallback); YouTube upload; the cover-pick popup for thumbnails. The 4 graded files are the deliverable of this plan.

## Tasks

### Phase 1: Vision-capable LLM call

- [x] **Task 1: Add image content + plain-text completion to the OpenRouter client**
  **Files**: `src/lib/llm/openrouter.ts`
  **What**: The client must accept an attached image and return raw text (the Knight prompt output is a formatted TITLE_BLOCK/STYLING spec pasted verbatim into Magnific — not JSON). Add the ability to pass image content alongside text in the user message, and a text (non-JSON) completion entry point. Preserve the existing `chatCompletionJSON` behavior and the `apiKey === 'mock'` sentinel unchanged.
  **Context**: Extend the message-content type and request-body builder at openrouter.ts:~117–123 and ~195–199 to the OpenRouter/OpenAI-compatible content-block array (text block + image_url block with a base64 data URL). Mirror the existing error/retry/mock structure (lines 5–24, 65+). Model still comes from `settings.model_name` (~156–162) — Claude 4.x models on OpenRouter are vision-capable, so no model-list change is required, but document that `model_name` must be a vision model for this path. Keep the change additive; do not rewrite `chatCompletionJSON`.

- [x] **Task 2: Downscale the reference image for the vision call**
  **Files**: `src/worker/steps/05b-ambient-video-thumbnail.ts` (new, created in Phase 5), `src/lib/audio/ffmpeg.ts`
  **What**: `source.jpg` is multi-MB 4K; the vision call needs a bounded JPEG (longest edge ≤ ~1568px) to keep tokens/latency sane. Produce a temp downscaled JPEG from `source.jpg` for the LLM image block.
  **Context**: Reuse `compressToJpeg` / a scale helper in `src/lib/audio/ffmpeg.ts` (used the same way by step 05a at `05a-ambient-video-cover.ts:145`). Temp file in the album build dir; not persisted.

### Phase 2: Thumbnail-spec prompt template

- [x] **Task 3: Add the thumbnail-spec default template + channel-override loader**
  **Files**: `prompts/defaults/thumbnail-spec.md` (new), `src/worker/steps/05b-ambient-video-thumbnail.ts` (new, Phase 5)
  **What**: Store the operator's exact pasted Knight/Vortalania prompt as the default template, with the title placeholder (`{{HERE PASTE THE TITLE OF THE VIDEO}}` / `{{TITLE}}`) interpolated from `album.sceneTitle`. Resolve a per-channel override before the default.
  **Context**: Follow step 01b's non-`PromptKind` loader exactly: hardcoded kind (e.g. `thumbnail-spec`), `prompts/channel-templates/<channelId>/thumbnail-spec.md` → `prompts/defaults/thumbnail-spec.md`, throw a distinct code if the default is missing (`01b-scene-generator.ts:144–177`). The medieval channel's prompt is the default content here (it is the only ambient-video thumbnail consumer); a different channel can override via a channel-templates file later. The rendered template is sent as the user text block; the downscaled `source.jpg` as the image block.

### Phase 3: Freepik contract — reference image + return-all-4

- [x] **Task 4: Add `submitThumbnail` / multi-result poll+download to the freepik client**
  **Files**: `src/lib/freepik/client.ts`
  **What**: New client surface for the thumbnail flow: submit with the Magnific prompt + a local reference-image path + image count 4, poll until ready (with a result count), and download each of the N results to a destination. Keep `submit`/`submitVideo`/`poll`/`download` byte-for-byte unchanged; add the new methods alongside (mirror the `submitVideo` addition shape, lines ~275–296). Mock client returns the fixture for each index.
  **Context**: New request fields `mode:'imagegen-thumbnail'`, `referenceImagePath`, count. Mirror `FreepikVideoSubmitInput`/`submitVideo` (client.ts:48–60, 275–296) and the mock at 108–137. Errors via `FreepikError` with existing retriable semantics.

- [x] **Task 5: Bridge — new mode, multi-media storage, download-by-index**
  **Files**: `extensions/freepik-runner/bridge.ts`
  **What**: Accept `mode:'imagegen-thumbnail'` + `referenceImagePath` on `/submit`; store **all** `mediaFiles[]` (not just `[0]`) on the task; `/poll` reports a result count when ready; add download-by-index so the worker can pull all 4. Existing single-image imagegen/video paths must stay backward-compatible (array length 1, old `/download/:taskId` returns index 0).
  **Context**: Task type + `/submit` at bridge.ts:35–69, 270–315; `/result` currently `mediaFiles[0]` at 395–412 (change to store the array); `/poll` at 317–334 (add optional `count`); `/download/:taskId` at 336–349 (add an indexed variant, keep the old one defaulting to 0). Dispatch `referenceImagePath` + `mode` to the extension in `/poll` (extension face, 353–375) the same way `sourceImagePath`/`styleName` are passed.

### Phase 4: Extension — drive the Edit-reference button, no-pick, return all 4

- [x] **Task 6: Probe + record the post-`edit-reference-button` modal DOM** (probe tooling built; live DOM capture = operator hand-off, see below)
  **Files**: `extensions/freepik-runner/content.js` (an always-on smoke button), `docs/plans/2026-05-18-ambient-video-thumbnail-magnific.md` (record findings here)
  **What**: The operator gave `[data-cy="edit-reference-button"]` but the modal that opens after clicking it (upload-an-image path, file input, confirm button) is not captured. Add a temporary always-on smoke button that clicks `[data-cy="edit-reference-button"]` and dumps the resulting modal's structure to the page console so the real selectors can be recorded before wiring the flow.
  **Context**: Mirror the existing always-on smoke buttons + `[freepik-runner][pick]`-style diagnostics described in memory `reference-freepik-step08-validation`. Likely the same `[data-cy="advanced-selection-modal"]` + `[data-cy="upload-button"]` + `[data-cy="upload-use-selected-button"]` machinery as the end-frame upload (content.js ~1245–1328) — confirm, don't assume.

- [x] **Task 7: Implement the `imagegen-thumbnail` content.js path** (works e2e — CDP trusted-click recipe; see "Task 7 — RESOLVED" below)
  **Files**: `extensions/freepik-runner/content.js`, `extensions/freepik-runner/background.js` (only if a new message is needed)
  **What**: New mode that reuses the imagegen setup (page check, model, aspect 16:9, count 4, resolution 4K, fill prompt) but **replaces saved-style with the add-reference-image flow recorded in "Task 6 — Captured DOM"**: `[data-cy="upload-image-button"]` → `[data-cy="advanced-selection-modal"]` → `[data-cy="reference-sidebar-upload"]` → CDP-set `source.jpg` on `input[data-cy="upload-file-input-button"]` → wait for the uploaded thumb to render + select it → `[data-cy="upload-use-selected-button"]` ("Add") → verify `[data-cy="image-references-input"]` counter incremented. Then Generate, wait for 4 results, **skip `waitForOperatorPick` entirely**, collect all 4 candidate URLs, fetch each as base64 (existing `freepik:cdn-fetch` SW path), and POST all 4 in `mediaFiles[]` to `/result`. Bump the `content.js build` marker. Give each failure path a distinct error code (`REFERENCE_UPLOAD_BUTTON_NOT_FOUND`, `UPLOAD_TAB_NOT_FOUND`, `REF_FILE_INPUT_NOT_FOUND`, `REF_UPLOAD_NOT_APPLIED` (counter didn't increment), `THUMB_GEN_TIMEOUT`, `THUMB_RESULTS_INCOMPLETE`, …).
  **Context**: Reuse the CDP upload primitive verbatim — `freepik:set-file-input-files` (content.js ~1283–1308, background.js `setFileInputFiles` ~361–380); the imagegen setup helpers (`ensureModelSelected`, `setAspectRatio`, `setImageCountToFour`, `setResolutionTo4K`, `fillPrompt`, `clickGenerate`, content.js ~88–145). The result-collection should reuse `collectResultImageUrls()` + `fetchAsMediaResult()` (content.js ~898–921) but for **all** 4 rather than one. Do NOT alter `executeImageGen`/`waitForOperatorPick`/`addSavedStyle` (style/cover-pick paths must stay intact). The select-then-Add step (item 4 of the captured flow) is the one unknown — iterate it live with `scripts/probe-editref.ts` (committed) rather than blind content.js edits. If background.js gains a handler, note the launch-time `chrome.runtime.reload()` requirement (memory `project-ambient-video-magnific`).

### Phase 5: Post-process — 4K, no black bars, vibrance +30, saturation +10

- [x] **Task 8: Add a color-grade FFmpeg helper**
  **Files**: `src/lib/audio/ffmpeg.ts`
  **What**: New helper that takes an image and applies vibrance and saturation by configurable amounts (defaults mapping the operator's "vibrance +30, saturation +10"). Separate from resize so grade params are tunable independently.
  **Context**: No color helper exists today; add one next to `resizeWithMode` (~265–279) following the `runFfmpeg([... '-vf', filter ...])` single-frame pattern. Use the FFmpeg `vibrance` filter + `eq=saturation=`. The "+30 / +10" → filter-value mapping is a visual-tuning judgment call (Photoshop scales are non-linear); make the numeric mapping explicit and configurable, and flag that the defaults must be eyeballed on a real thumbnail, not assumed correct.

- [x] **Task 9: 4K crop-to-fill for each downloaded thumbnail** (no standalone unit — composition realized in Task 11)
  **Files**: `src/worker/steps/05b-ambient-video-thumbnail.ts` (new, Phase 6)
  **What**: Scale+crop each downloaded image to 3840×2160 with **no padding** (zoom/crop-to-fill), then `gradeImage`. Both primitives now exist and are tested — `resizeWithMode(in,out,3840,2160,'crop')` (ffmpeg.ts) and `gradeImage` (Task 8). Task 9 is pure composition with no independent testable unit (same plan/reality pattern as Tasks 2/3 — the consuming step file is Phase 6); it is implemented + tested as part of **Task 11**'s `step05bAmbientVideoThumbnail` (chain: downloadThumbnail → resizeWithMode('crop') → gradeImage → ffprobe-verify 3840×2160). No separate work or commit; checked off to reflect that the deliverable is fully covered by existing tested helpers + Task 11.

### Phase 6: Pipeline wiring

- [x] **Task 10: Add the optional `step05b` workflow slot**
  **Files**: `src/worker/workflows/types.ts`, `src/worker/runner.ts`
  **What**: Add an optional `step05b?: PipelineStep` to `WorkflowDefinition`; the runner uses `workflow.step05b ?? step05bThumbnail` so ambient/rap are unchanged (fall back to the Flow thumbnail) and ambient-video can override.
  **Context**: Mirror the existing `step01?`/`step05a?` slot + `workflow.step05a ?? step05aCoverImage` pattern exactly (types.ts:21–43, runner.ts:~89–104). pipeline.ts already calls `deps.step05b` unconditionally (~231–236) — no orchestrator change needed.

- [x] **Task 11: Implement `step05bAmbientVideoThumbnail` and register it**
  **Files**: `src/worker/steps/05b-ambient-video-thumbnail.ts` (new), `src/worker/workflows/ambient-video.ts`
  **What**: The composed step: resolve channel + `source.jpg` (max-res original — fail with a distinct code if absent) → render thumbnail-spec template with `album.sceneTitle` → downscaled-image vision LLM call → Magnific via `submitThumbnail` (reference image = `source.jpg`) → poll → download all 4 → 4K crop-to-fill + grade each → write `projects/<ch>/<alb>/thumbs/thumb-1.png … thumb-4.png`. Idempotent (noop when the 4 graded files already exist + valid dims, mirroring 05a's noop). Do **not** set `album.thumbnailPath` (selection is deferred). Register `step05b: step05bAmbientVideoThumbnail` in `ambientVideoWorkflow`.
  **Context**: Compose like ambient-video's `step01Composed` (ambient-video.ts:18–21); resolve source like `resolveSourceImage` (`05a-ambient-video-cover.ts:187–294`) but the album-folder `source.jpg` is the required input (no regeneration here — step 05a already produced it). Error codes per memory `reference-freepik-step08-validation` so blind iteration is tractable. Poll timeout sized like 05a's 15-min window (`05a-ambient-video-cover.ts:41–46`). `sceneTitle` is guaranteed by step 01b before 05b runs.

- [x] **Task 12: Surface the 4 thumbnails in the album dashboard (read-only)**
  **Files**: `src/app/channels/[id]/page.tsx`
  **What**: Show the 4 generated thumbnails so the operator can eyeball grade/zoom correctness (needed to validate Task 8's tuning). Read-only tiles; no selection action (deferred).
  **Context**: Reuse the existing `ImageTile` component used for the cover/thumbnail at `src/app/channels/[id]/page.tsx:~392`. Point at the new `thumbs/thumb-N.png` paths. Keep it minimal.

### Phase 7: Tests & validation

- [x] **Task 13: Unit/integration tests**
  **Files**: `src/lib/llm/__tests__/`, `src/lib/freepik/__tests__/` (or existing freepik client test), `src/worker/steps/__tests__/step-05b-ambient-video-thumbnail.test.ts` (new)
  **What**: Cover: OpenRouter image-content body shape + text completion + mock sentinel; freepik `submitThumbnail`/multi-download against a mock bridge; the new step end-to-end with mocked freepik + mocked LLM (no real Magnific/OpenRouter), asserting 4 graded 3840×2160 files and idempotent noop.
  **Context**: Follow existing step test patterns (`src/worker/steps/__tests__/step-05a-ambient-video.test.ts`, `step-08-seedance.test.ts`) — inject `freepikClient` mock + `FREEPIK_MODE=mock`, mock LLM via `apiKey:'mock'`. `npm run test`, `npm run lint`, and `tsc` must be clean for changed files (3 known unrelated pre-existing errors in dk-probe/manual-rap scripts may remain).

- [x] **Task 14: End-to-end on a cached album, no Suno re-bill** — VALIDATED 2026-05-18 via direct `step05bAmbientVideoThumbnailInternal` invoke on album `01KRX5VXE4XM8HZ6X3VMWS2PR8` (real OpenRouter vision 496-char prompt → live Magnific reference flow → 4× graded 3840×2160 thumbs, ~92s, zero Suno). NOTE: the initial full-pipeline requeue attempt mis-used the 4-track smoke `amv-requeue.ts` (forces `tracks_per_album_override=4`) which made step 02 clobber the album's 30 cached track rows; recovered separately. Direct-invoke is the correct 05b validation path.
  **Files**: (validation only)
  **What**: Validate the live extension path on an existing medieval ambient-video album whose Suno tracks are already downloaded, so steps 01–04 noop and there is zero Suno spend. Confirm: vision LLM returns a sane Magnific prompt; the upload-modal flow lands `source.jpg` as a reference (counter increments); 4 images generate and download; the 4 graded 4K files look right (zoom, no bars, color). Iterate via `scripts/probe-editref.ts` + the build-marker + distinct-error-code loop; remove the Task 6 probe button once selectors are locked.
  **Context**: Use the runbook in memory `reference-freepik-step08-validation` (isolate branch B with `DISTROKID_MODE=mock`/`FLOW_MODE=mock`, requeue a cached album, monitor worker stdout, post-run cleanup: kill worker by PID, `queue_state=paused`, `tracks_per_album_override=0`). This is operator-triggered (real Magnific automation) per memory `feedback-stop-and-gate-costly-automation` — do not auto-run during dev.

## Task 7 — RESOLVED (2026-05-18): imagegen-thumbnail works end-to-end

`content.js` build `2026-05-18f` + a new `background.js` `freepik:trusted-click` (CDP `Input.dispatchMouseEvent`) handler. Verified via the real SW→content relay (`scripts/probe-thumb-flow.ts`): `advanced-selection-modal open` → `upload landed as feed-image-item-…` → **`reference add: counter 0→1/8`** → Generate → all candidates returned (`mediaCount=2`). Working recipe (`addReferenceImageViaUpload`): `reference-add-button` → `advanced-selection-modal` → tag `input[data-cy="advanced-selection-upload-file-input"]` + click `advanced-selection-upload-button` + CDP-set the file → poll for the upload as a NEW `feed-image-item-*` → `advanced-selection-clear-all-button` → select the new tile → `advanced-selection-add-images-button` → verify the references counter incremented. **Every click is a CDP trusted click** — Magnific's Radix reference cards / controls gate on `event.isTrusted` (same constraint as distrokid), so synthetic `.click()` and even a full synthetic pointer sequence are ignored; only `chrome.debugger Input.dispatchMouseEvent` works. The launcher's `chrome.runtime.reload()` (freepik-login.ts) loads the new background.js SW from disk. Historical investigation notes below.

## Task 7 — Investigation history (2026-05-18): the BLOCKED-then-resolved path

`content.js` build `2026-05-18c` ships `executeImageThumbnail` + `addReferenceImageViaUpload` + the `imagegen-thumbnail` dispatch (committed). Verified live via `scripts/probe-thumb-flow.ts` (SW→content relay, the real production path): the model/aspect/count/resolution/prompt setup runs, the reference modal opens, the file input is tagged and the CDP `freepik:set-file-input-files` call returns OK — **but the upload never starts**: `scripts/probe-upload-timeline.ts` sampled the modal every 2s for 26s and the state is completely static (counter `0/8`, no progress spinner, the 32 modal imgs are pre-existing History-feed items, our `source.jpg` never appears). Clicking "Add" then just closes the modal → distinct error `REF_UPLOAD_NOT_APPLIED` (the instrumentation worked exactly as designed).

**Flow fully mapped (7 headful probe iterations, reproducible):**
1. `[data-cy="upload-image-button"]` → opens `[data-cy="advanced-selection-modal"]`.
2. `[data-cy="reference-sidebar-upload"]` → `[data-cy="individual-upload-panel"]`.
3. `[data-cy="upload-button"]` ("Upload an image") → fires a **native file chooser bound to `input[data-cy="upload-file-input-button"]`** (`scripts/probe-upload-strategy.ts` proved S1: filechooser fires; the input's handler only arms via this button click — direct CDP-set without the click is inert, which is why the original approach failed).
4. Setting the file on that chooser → a **`blob:` preview `<img alt="Add">` lands inside `individual-upload-panel`** at imgCount+1 (`scripts/probe-upload-grid.ts` / `probe-blob-select.ts`: the upload IS read locally; the panel then shows `clear-selection-button` "Clear" + its own `upload-use-selected-button` "Add").

**UNRESOLVED — committing the blob preview to a reference (`counter 0/8 → 1/8`).** Every interaction tried leaves the counter at `0/8` (`scripts/probe-panel-add.ts` etc.): the modal-footer `upload-use-selected-button`, the **panel-scoped** `upload-use-selected-button` (there are two in the modal — disambiguated, still no effect), selecting a `feed-image-item-*`, clicking the blob `<img>`'s clickable wrapper. **No progress/spinner element ever renders** — the server-side upload likely never completes under synthetic automation (Playwright filechooser / CDP setFileInputFiles), or there is a human gesture/timing not observable from the DOM. This is the single open gap; everything before and after it (`executeImageThumbnail`'s setup, Generate, collect-all, return) is wired and independently sound.

**Operator-demo capture (`scripts/probe-capture-demo.ts`, 2026-05-18) — the proven reference-commit path:**
1. `[data-cy="reference-add-button"]` (references-grid "Add" card) → opens `[data-cy="advanced-selection-modal"]` on the **feed-grid picker view**.
2. Click an image tile (`nearCy="feed-image-item-<id>"`) in that grid to select it.
3. Click **`[data-cy="advanced-selection-add-images-button"]`** ("Add") → `counter 0/8 → 1/8` ★. (Same commit button `addSavedStyle` uses, content.js ~492.)

**Definitively ruled out (10 headful probe iterations, all committed):** the `[data-cy="upload-image-button"]` → Uploads tab → `[data-cy="upload-button"]` → filechooser → blob preview → `[data-cy="upload-use-selected-button"]` path is a **DEAD END for references** — `upload-use-selected-button` closes the modal and discards the upload (counter never moves; `advanced-selection-add-images-button` does not exist in that `individual-upload-panel` view). The single-upload panel and the feed-grid picker are different, non-interoperating views.

**Precise remaining unknown (one narrow gap):** the operator demo selected a *pre-existing library* image. For an automated run, `source.jpg` is novel and must first enter the **feed-grid** as a selectable `feed-image-item-*`. How a fresh upload lands in that grid (vs. the dead-end single-upload panel) is not yet captured — it likely requires opening via `reference-add-button` (feed view) and using *that* view's own Uploads tab/grid (which differs from the `upload-image-button` entry's `individual-upload-panel`). This needs a **fresh-image** operator demo (upload a never-before-used image and add it as a reference while `probe-capture-demo.ts` records), NOT more blind iteration.

Task 7 status: foundation + instrumentation committed; the proven commit selectors are known (`advanced-selection-add-images-button` + feed-tile select); the fresh-upload→feed-grid ingress is the single open item. **Phases 5–7 are fully unblocked and do not depend on this.**

**Superseded recommendation (kept for history):** capture ONE real human upload (operator does the manual upload while a console/network trace records the exact element + the upload XHR), OR treat Magnific reference-upload as a known automation limitation and revisit with a different mechanism (e.g. drag-drop onto `reference-add-button`'s "Drop here" zone, or a real `chrome.debugger Input.dispatchDragEvent`). Phases 5–7 are fully unblocked and do not depend on this.

Task 7 is **NOT checked off** — foundation + instrumentation + complete mechanism map are committed; the upload-commit step is an open problem. Reusable probe harness (committed dev tooling): `scripts/probe-thumb-flow.ts` (SW→content e2e), `probe-upload-timeline.ts`, `probe-upload-strategy.ts`, `probe-upload-grid.ts`, `probe-blob-select.ts`, `probe-panel-buttons.ts`, `probe-panel-add.ts`.

## Task 6 — Captured DOM (recorded 2026-05-18, automated via `scripts/probe-editref.ts`)

Driven live against the signed-in `magnific.com/app/ai-image-generator` (logged-in `data/freepik-profile`). **Correction to the original plan: `[data-cy="edit-reference-button"]` is NOT the path** — it only *edits an already-added* reference and does not exist until one is present. The operator's "add my image as reference" flow is the **upload modal**, and it reuses the *same* `advanced-selection-modal` + CDP-file-input primitive the end-frame flow already uses.

**Add-reference-image flow (Task 7 target):**
1. `[data-cy="upload-image-button"]` (a `<button>` in `[data-cy="image-references-input"]`) → opens `[data-cy="advanced-selection-modal"]` (sidebar defaults to the History tab).
2. `[data-cy="reference-sidebar-upload"]` ("Uploads" tab) → renders `[data-cy="individual-upload-panel"]`.
3. `input[data-cy="upload-file-input-button"]` — `type=file class=hidden accept=".jpg,.jpeg,.png,.webp,.avif,.heic,.heif,…"`. **CDP `DOM.setFileInputFiles` here** (identical primitive to the end-frame `freepik:set-file-input-files` in `background.js`; also two `input[type=file][data-debug="temporal-input"]` exist as fallbacks). `[data-cy="upload-button"]` ("Upload an image") is the human trigger that opens the native dialog — the extension bypasses it via CDP.
4. After the file is set + uploaded, the modal footer exposes `[data-cy="upload-use-selected-button"]` ("Add") and `[data-cy="clear-selection-button"]` ("Clear"). The uploaded thumbnail must finish uploading and be **selected** in the panel grid before "Add" applies it (clicking "Add" with nothing selected just closes the modal — observed: counter stayed `0/8`). **This select-then-Add step is the one detail Task 7's blind-iterate loop must lock down live.**
5. Success signal: `[data-cy="image-references-input"]` header counter `N/8` increments (`0/8`→`1/8`) and a populated reference card replaces a placeholder.

**Other confirmed hooks:** `reference-style-placeholder` / `reference-character-placeholder` / `reference-add-button` (empty-slot drop targets, Radix `data-grace-area-trigger` — need *trusted* events, synthetic `.click()` is a no-op), `video-modal-close-button-desktop` (modal close), `reference-sidebar-history` / `reference-sidebar-stockImages` (other tabs). The image prompt box + model/aspect/count/resolution/Generate hooks are unchanged from the imagegen path (`tti-mode-selector-v3-trigger`, `image-prompt-input`, etc.).

**Tooling:** `scripts/probe-editref.ts` (committed) is the reusable Playwright driver — launches the persistent profile + extension (with the MV3 SW reload-from-disk fix), navigates, drives the flow, and dumps bounded DOM. Reuse it for Task 7 iteration instead of blind content.js edits (mirrors the `debug-pick-driver.ts` approach).

## References

- LLM client: `src/lib/llm/openrouter.ts:117–123, 195–199, 156–162, 5–24, 65`
- Freepik client: `src/lib/freepik/client.ts:48–60, 257–296, 108–137`
- Freepik bridge: `extensions/freepik-runner/bridge.ts:35–69, 270–349, 377–412`
- Extension: `extensions/freepik-runner/content.js` (build marker ~26; `executeImageGen` ~88; `addSavedStyle` ~455; `waitForOperatorPick` ~551; CDP upload ~1245–1328); `extensions/freepik-runner/background.js:361–380`
- Workflow slots: `src/worker/workflows/types.ts:21–43`; `src/worker/runner.ts:~89–104`; `src/worker/pipeline.ts:~231–236`; `src/worker/workflows/ambient-video.ts:18–21, 78–90`
- Step 01b template loader (pattern to copy): `src/worker/steps/01b-scene-generator.ts:88, 144–177`
- Step 05a (source/freepik/postprocess pattern): `src/worker/steps/05a-ambient-video-cover.ts:41–46, 125–164, 187–294`
- FFmpeg helpers: `src/lib/audio/ffmpeg.ts:228–242 (cropAndScaleSquare), 265–279 (resizeWithMode 'crop'), 339+ (compressToJpeg)`
- Dashboard tile: `src/app/channels/[id]/page.tsx:~392`
- Memory: `project-ambient-video-magnific`, `reference-freepik-step08-validation`, `feedback-dom-evidence`, `feedback-stop-and-gate-costly-automation`
