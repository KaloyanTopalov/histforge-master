# Design: Graft VEO API Extension features into youforge-flow

**Date:** 2026-05-26
**Author:** brainstorm session (Claude + user)
**Status:** Approved by user; pending implementation plan
**Related memory:** `product-direction-tubegen-shape`, `debug-image-quality-consistency`, `research-gpt-image-2-character-sheet`, `feedback-codex-verification`

## Context

The user dropped a newer upstream extension (`extensions/VEO API Extension/`, version 13.1.0) into the repo, believing it was a wholesale upgrade over the project's existing `extensions/youforge-flow/` (a HistForge-owned fork of an earlier upstream of the same codebase). The user's stated motivation is "2D animation consistent images" — image generation only.

Investigation showed the two extensions share most image-gen capabilities:

- `IMAGE_INPUT_TYPE_REFERENCE` uploaded-reference flow — already in youforge-flow.
- Multi-reference upload (comma-separated URLs) — already in youforge-flow.
- Image upscaling — already in youforge-flow.
- Image model selection (NARWHAL / GEM_PIX_2 / IMAGEN_3_5) — already in youforge-flow.
- HistForge's `/api/flow/next-task/[token]` already emits `referenceImage` URLs for createImage mode (commit `166a91c`).

youforge-flow additionally has a feature the new VEO API Extension does **not** have: the saved-Character UUID lock via `referenceEntities`. That is a HistForge differentiator and must be preserved.

## Scope

This spec covers two surgical grafts from `extensions/VEO API Extension/` into `extensions/youforge-flow/`, plus a matching HistForge setting and task-DTO field. The wholesale architecture swap to the new extension's N8N+Baserow+MinIO contract was considered and explicitly rejected — it would discard the multi-account fleet, queue, reaper, recovery flags, the 15-route `/api/flow/*` surface, and the character-lock feature.

### In scope

1. **Five image aspect ratios** on youforge-flow's image executor (16:9, 4:3, 1:1, 3:4, 9:16), replacing today's binary portrait/landscape branch.
2. **Imagen 4 reference-skip guard** — when `imageModel === 'IMAGEN_3_5'`, skip the reference-upload loop and build the request with `imageInputs: []`. Imagen 4 does not accept reference images.
3. **HistForge `google_flow_image_aspect_ratio` setting** that drives the per-task `imageAspect` field in the extension's task DTO.

### Out of scope

- Source-image dimension auto-detect + `cropCoordinates` computation for the image-to-video / frames-to-video paths. Real fix in the new extension, but only matters for video-gen, which the user is not focused on. Revisit if/when image-to-video clips become a focus.
- Broader upstream pull (Approach B in brainstorming). Higher risk of regressing youforge-flow's stripped paths (Baserow/n8n hardcoded URLs, downloader, broad host permissions).
- N8N + Baserow + MinIO architecture (Approach C in brainstorming).
- The `extensions/VEO API Extension/` directory itself — stays in-tree as a **reference-only** mirror of the newer upstream, never loaded into Chrome. **Commit it** alongside the implementation so future graft diffs have a stable reference (the older upstream reference at `extensions/veo-upstream/` mentioned in `youforge-flow/README.md:88-91` no longer exists in tree; this new mirror replaces that role). Do not modify it. The README's "Relationship to upstream" section needs a one-line update pointing at the new mirror, but that is part of the implementation, not a separate task.
- Other character-consistency work (character bible, shot-list pipeline) tracked in `research-gpt-image-2-character-sheet`. Separate spec.

## Architecture

```
HistForge worker enqueues createImage row
            │
            ▼
HistForge /api/flow/next-task/[token]  ──── shapeTaskForExtension({
   reads: getSetting("google_flow_image_aspect_ratio")             id, prompt, mode,
                                                                   imageModel,
                                                                +  imageAspect,      // NEW
                                                                   videoModel,
                                                                   referenceImage,
                                                                   ... })
            │
            ▼
youforge-flow background.js (polling runner) — unchanged
            │
            ▼
youforge-flow src/executors/image.js
   imageAspectToEnum(task.imageAspect, settings.imageAspectRatio, settings.aspectRatio)
   if (modelName === 'IMAGEN_3_5') { imageInputs = []; safeLog warning }
   else                            { upload refs → imageInputs[] }
            │
            ▼
flowMedia:batchGenerateImages   (Google Flow API — unchanged)
```

## youforge-flow changes

### Files touched

- `extensions/youforge-flow/src/settings-schema.js` — add 1 entry.
- `extensions/youforge-flow/src/settings.js` — add 1 accessor + 1 cache key.
- `extensions/youforge-flow/src/executors/image.js` — ~10 line edit.
- `extensions/youforge-flow/popup.html` — add 1 `<select>` control.
- `extensions/youforge-flow/popup.js` — add 1 persist binding.

### Graft 1: Five image aspect ratios

**Setting:** new key `imageAspectRatio` in `settings-schema.js`, default `'16:9'`, kind `'string'`. Coexists with the existing `aspectRatio` key (which is shared with the video path in `account-tier.js`, `shared.js` and stays 2-valued: `portrait`/`landscape`).

**Accessor:** `getImageAspectRatio()` in `settings.js`, alongside `getAspectRatio()`. Add `imageAspectRatio` to the bulk-load list at line 145 and the debug log at line 150.

**Mapping helper:** port `imageAspectToEnum()` from new-ext `background.js:787-806` into `extensions/youforge-flow/src/executors/image.js` (top of file, above `runImageGen`). Inline rather than a separate `src/aspect.js` module — single call site, no reuse needed. Signature:

```js
function imageAspectToEnum(imageAspect, legacyAspect) {
  switch ((imageAspect || '').toLowerCase()) {
    case '16:9': return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    case '4:3':  return 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE';
    case '1:1':  return 'IMAGE_ASPECT_RATIO_SQUARE';
    case '3:4':  return 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR';
    case '9:16': return 'IMAGE_ASPECT_RATIO_PORTRAIT';
  }
  // Legacy fallback: existing 2-value aspectRatio key (used by video path).
  return legacyAspect === 'portrait' ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
                                     : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}
```

**Executor change:** in `src/executors/image.js`, replace lines 32-34:

```diff
- const imageAspect = settings.aspectRatioSetting === 'portrait'
-   ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
-   : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
+ const imageAspect = imageAspectToEnum(
+   task.imageAspect || settings.imageAspectRatioSetting,
+   settings.aspectRatioSetting
+ );
```

Resolution order: per-task field from HistForge wins, then extension popup setting, then legacy 2-value fallback.

**Settings context:** in `src/executors/index.js:62-63`, add `imageAspectRatioSetting: getImageAspectRatio()` alongside `aspectRatioSetting: getAspectRatio()`. The executor reads from `ctx.settings`.

**Popup UI:** in `popup.html`, add a `<select id="imageAspectRatio">` with 5 options, placed next to the existing aspect-ratio control. In `popup.js`, bind it the same way the other selects bind — load from storage on open, save on change.

### Graft 2: Imagen 4 reference-skip guard

In `src/executors/image.js`, between the prompt resolution (line 35-37) and the reference-upload loop (line 44-58), insert:

```js
const isImagen4 = modelName === 'IMAGEN_3_5';
if (isImagen4 && (task.imagegenReference || task.referenceImage)) {
  log.safeLog(`[api] Skipping reference upload: Imagen 4 (${modelName}) does not support reference images. Generating from prompt only.`);
}
```

Then wrap the reference-upload loop body in `if (!isImagen4) { ... }`. The `referenceImageIds` array stays empty when Imagen 4 is active, so `imageInputs` will be `[]` — matching the new-ext behavior at lines 1215-1218.

Character-lock `referenceEntities` is independent of `imageInputs` and **continues to apply** even on Imagen 4. The Google Flow saved-Character UUID feature works across image models per recon notes in `image.js:10-16`.

## HistForge changes

### Files touched

- `src/lib/db.ts` — add 1 default value next to `google_flow_image_model`.
- `src/lib/settings-enums.ts` — add 1 enum + 1 label-overrides block.
- `src/lib/settings.ts` — add 1 Zod enum line.
- `src/lib/settings-tabs.ts` — register the new key on the Google Flow tab.
- `src/app/api/flow/next-task/[token]/route.ts` — extend `DispatchExtras` + emit `imageAspect` in `shapeTaskForExtension`.

### Setting registration

**`db.ts:29` neighborhood** — add the default:

```diff
  google_flow_image_model: "NARWHAL",
+ google_flow_image_aspect_ratio: "16:9",
```

**`settings-enums.ts:24`** — add the enum values:

```diff
  google_flow_image_model: ["NARWHAL", "GEM_PIX_2", "IMAGEN_3_5"],
+ google_flow_image_aspect_ratio: ["16:9", "4:3", "1:1", "3:4", "9:16"],
```

**`settings-enums.ts:82` block** — add labels:

```ts
google_flow_image_aspect_ratio: {
  "16:9": "Landscape 16:9",
  "4:3":  "Landscape 4:3",
  "1:1":  "Square 1:1",
  "3:4":  "Portrait 3:4",
  "9:16": "Portrait 9:16",
},
```

**`settings.ts:53` neighborhood** — add the Zod enum line:

```diff
  google_flow_image_model: z.enum(ENUM_VALUES.google_flow_image_model),
+ google_flow_image_aspect_ratio: z.enum(ENUM_VALUES.google_flow_image_aspect_ratio),
```

**`settings-tabs.ts:32` neighborhood** — register on Google Flow tab:

```diff
  "google_flow_image_model",
+ "google_flow_image_aspect_ratio",
```

**`google-flow-tab.tsx`** — if the tab renders enum settings declaratively from `settings-tabs.ts`, no change needed. To be verified during implementation.

### Task DTO change in `next-task/[token]/route.ts`

Extend `DispatchExtras`:

```diff
  interface DispatchExtras {
    flowProjectId: string | null;
    imageModel: SettingValue<"google_flow_image_model">;
+   imageAspect: SettingValue<"google_flow_image_aspect_ratio">;
    videoModel: string;
    origin: string;
    token: string;
  }
```

Read the new setting in the POST handler:

```diff
  const extras: DispatchExtras = {
    flowProjectId: project?.flow_project_id ?? null,
    imageModel: getSetting("google_flow_image_model", db),
+   imageAspect: getSetting("google_flow_image_aspect_ratio", db),
    videoModel,
    origin: new URL(req.url).origin,
    token: ctx.params.token,
  };
```

Emit on every mode in `shapeTaskForExtension`, matching how `imageModel`/`videoModel` are emitted unconditionally (per the existing comment at lines 56-58):

```diff
  const out: Record<string, unknown> = {
    id: row.external_task_id,
    prompt: row.prompt,
    mode: row.mode,
    videoId: row.video_id,
    projectTitle: video.title,
    flowProjectId: extras.flowProjectId,
    imageModel: extras.imageModel,
+   imageAspect: extras.imageAspect,
    videoModel: extras.videoModel,
  };
```

## Wire contract

The existing `TaskRequest` request shape stays unchanged. The response gains one additive field:

```diff
  {
    "id": "...",
    "prompt": "...",
    "mode": "createImage",
    "imageModel": "NARWHAL",
+   "imageAspect": "16:9",
    "videoModel": "...",
    ...
  }
```

The extension's resolution order is `task.imageAspect → settings.imageAspectRatio → legacy aspectRatio mapping`, so the contract is both forward-compatible (extension older than HistForge ignores the field harmlessly) and backward-compatible (HistForge older than extension causes the extension to fall back to popup setting).

## Implementation steps + verification

Each step is independently committable and verifiable.

### Step 1 — HistForge setting registration

Add the enum, default, label-overrides, Zod schema entry, and settings-tab listing. No worker or route code yet.

**Verify:**
- `npm run db:init` does not error.
- `npm run dev`; open `/settings` → Google Flow tab; the new "Image aspect ratio" select appears with 5 options.
- Pick a value, refresh; the value persists.
- `npm run test` passes.

**Codex checkpoint #1** *(deferred until quota recovers)*.

### Step 2 — HistForge task DTO

Extend `DispatchExtras`, read the setting, emit `imageAspect` in `shapeTaskForExtension`.

**Verify:**
- Hand-craft a `TaskRequest` POST to `/api/flow/next-task/[token]` (with a real account token and a queued createImage row). Inspect the JSON response — `imageAspect` is present and matches the setting value.
- Existing routes / tests still pass.

**Codex checkpoint #2** *(deferred)*.

### Step 3 — youforge-flow settings + popup

Add the schema key, accessor, popup `<select>`. No executor change yet.

**Verify:**
- Load the unpacked extension in Chrome.
- Open popup; the new select appears with 5 options.
- Pick a value, close and reopen popup; value persists.
- In DevTools console: `chrome.storage.local.get('imageAspectRatio')` returns the picked value.

**Codex checkpoint #3** *(deferred)*.

### Step 4 — youforge-flow image executor

Replace the binary aspect branch with `imageAspectToEnum()`. Add the Imagen 4 ref-skip guard.

**Verify:**
- Run an end-to-end createImage task for each of the 5 ratios with model `NARWHAL` + a reference image. Inspect the outbound `flowMedia:batchGenerateImages` request in DevTools Network: `imageAspectRatio` enum matches the picked ratio; `imageInputs` contains the uploaded reference media name.
- Run the same with model `IMAGEN_3_5` + a reference image. Confirm: safeLog warning appears, the request body's `imageInputs` is `[]`, no upload network call fires, the generation completes (Imagen 4 may produce a result without the reference — that's the expected Google API behavior).
- Character-lock test: with a valid `characterLockReference` UUID, confirm `referenceEntities: [{ entityId }]` is still in the request body for both NARWHAL and IMAGEN_3_5 cases.

**Codex checkpoint #4** *(deferred)*.

### Step 5 — End-to-end

Run a real video pipeline with a non-default aspect (e.g. `9:16` for shorts) and IMAGEN_3_5 + a reference image. Confirm generated images come back at the right aspect and that the pipeline completes through to render.

**Final Codex checkpoint** *(deferred)*.

## Codex review policy

The stop-time Codex review gate is currently disabled (`feedback-codex-verification` memory) because the user's ChatGPT-tier Codex quota is exhausted until **2026-06-02 10:20 AM**. Per-step checkpoints above are deferred until the quota recovers (or the user upgrades to Plus). When checkpoints are run, surface Codex findings to the user verbatim and address them before moving to the next step.

## Rollback

Every step is reversible by reverting its commit:
- No SQLite schema migration (settings table uses string values; new keys are added by `db.ts` defaults on first read).
- No settings rename or removal.
- No extension manifest change (no new permissions, no new host permissions).
- `imageAspect` in the task DTO is additive — old extensions ignore unknown fields.
- Existing in-flight videos keep working through extension-side fallback to the popup setting → legacy `aspectRatio` mapping.

## Risks

- **Settings-tab UI may not render new enum keys automatically** — if `google-flow-tab.tsx` has a custom row layout instead of mapping declaratively from `settings-tabs.ts`, Step 1 needs an extra TSX edit. Verified during implementation.
- **Imagen 4 behavior with empty imageInputs but a present `referenceEntities`** is unverified — Google's API may or may not honor character lock on Imagen 4. If it does not, the user's character-lock workflow breaks on Imagen 4 (but they're not on Imagen 4 today; default is NARWHAL).
- **`uploadImage` calls already made before the Imagen 4 guard could leak** — verified the guard is positioned before the upload loop in Step 4, so no upload calls fire on Imagen 4.
