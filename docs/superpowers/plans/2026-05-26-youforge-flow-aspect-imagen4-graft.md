# youforge-flow image aspect ratios + Imagen 4 graft — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 5-value `google_flow_image_aspect_ratio` setting on HistForge that drives a per-task `imageAspect` field, and graft `imageAspectToEnum()` + Imagen 4 (`IMAGEN_3_5`) reference-skip guard into `extensions/youforge-flow/`.

**Architecture:** Additive only. New HistForge setting → emitted as new field on the existing next-task DTO → youforge-flow image executor reads it (with fallbacks to popup setting → legacy 2-value aspect). Character lock, queue, accounts, reaper, and 15-route `/api/flow/*` surface untouched.

**Tech Stack:** TypeScript (Next.js + worker), vitest (existing `__tests__/api/flow/next-task/[token]/route.test.ts` test surface), better-sqlite3 string-valued settings, Chrome extension MV3 service worker (no test framework — manual verification only).

**Source spec:** `docs/superpowers/specs/2026-05-26-youforge-flow-aspect-imagen4-graft-design.md`

**Codex policy:** Stop-time review gate is OFF until ChatGPT quota recovers on 2026-06-02 10:20 AM (or user upgrades to Plus). Per-step `codex:rescue` checkpoints noted below are **deferred** — run them retroactively once quota is back.

---

## File structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/lib/settings-enums.ts` | Modify | Add `google_flow_image_aspect_ratio` enum + label overrides |
| `src/lib/db.ts` | Modify | Add default value `"16:9"` |
| `src/lib/settings.ts` | Modify | Add Zod enum entry |
| `src/lib/settings-tabs.ts` | Modify | Register key on Google Flow tab |
| `src/app/settings/google-flow-tab.tsx` | Modify | Add `<SelectField>` next to existing aspect-ratio control |
| `src/app/api/flow/next-task/[token]/route.ts` | Modify | Extend `DispatchExtras`, emit `imageAspect` |
| `__tests__/api/flow/next-task/[token]/route.test.ts` | Modify | Add tests for `imageAspect` field |
| `extensions/youforge-flow/src/settings-schema.js` | Modify | Add `imageAspectRatio` entry |
| `extensions/youforge-flow/src/settings.js` | Modify | Add accessor + bulk-load key |
| `extensions/youforge-flow/src/executors/index.js` | Modify | Add `imageAspectRatioSetting` to context |
| `extensions/youforge-flow/src/executors/image.js` | Modify | Add `imageAspectToEnum`, replace 2-branch, add Imagen 4 guard |
| `extensions/youforge-flow/README.md` | Modify | Point "Relationship to upstream" at new mirror |
| `extensions/VEO API Extension/` | Add to git | Commit as reference-only mirror (no edits) |

---

## Task 1: Register `google_flow_image_aspect_ratio` setting

**Files:**
- Modify: `src/lib/settings-enums.ts:31` (insert after existing `google_flow_aspect_ratio`)
- Modify: `src/lib/settings-enums.ts:82-87` block (add label overrides)
- Modify: `src/lib/db.ts:31` (add default)
- Modify: `src/lib/settings.ts:55` (add Zod enum)

- [ ] **Step 1: Add enum values**

In `src/lib/settings-enums.ts:31` neighborhood, add immediately after `google_flow_aspect_ratio`:

```ts
google_flow_aspect_ratio: ["landscape", "portrait"],
google_flow_image_aspect_ratio: ["16:9", "4:3", "1:1", "3:4", "9:16"],
```

- [ ] **Step 2: Add label overrides**

In `src/lib/settings-enums.ts` `SETTING_OPTION_LABELS` block (around line 82), add a new key:

```ts
google_flow_image_aspect_ratio: {
  "16:9": "Landscape 16:9",
  "4:3":  "Landscape 4:3",
  "1:1":  "Square 1:1",
  "3:4":  "Portrait 3:4",
  "9:16": "Portrait 9:16",
},
```

- [ ] **Step 3: Add default value in `src/lib/db.ts:31` neighborhood**

```diff
  google_flow_aspect_ratio: "landscape",
+ google_flow_image_aspect_ratio: "16:9",
```

- [ ] **Step 4: Add Zod enum in `src/lib/settings.ts:55` neighborhood**

```diff
  google_flow_aspect_ratio: z.enum(ENUM_VALUES.google_flow_aspect_ratio),
+ google_flow_image_aspect_ratio: z.enum(ENUM_VALUES.google_flow_image_aspect_ratio),
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: no errors. The `_assertEnumKeysAreSettingKeys` compile-time guard in `settings-enums.ts` passes because the new key is in both `ENUM_VALUES` and `SETTING_SCHEMAS`.

- [ ] **Step 6: Run unit tests**

Run: `npm run test -- __tests__/api/flow/next-task` (existing tests; should still pass with the new key added but not yet emitted in the DTO)
Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/lib/settings-enums.ts src/lib/db.ts src/lib/settings.ts
git commit -m "flow-image-aspect: register google_flow_image_aspect_ratio setting"
```

- [ ] **Step 8: Codex checkpoint #1** *(deferred until quota recovers)*

When quota is back: `node "C:/Users/User/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" review --wait --scope branch --base HEAD~1`

---

## Task 2: Wire setting into Google Flow settings tab

**Files:**
- Modify: `src/lib/settings-tabs.ts:34` (add key to Google Flow tab list)
- Modify: `src/app/settings/google-flow-tab.tsx` (add `<SelectField>` next to existing aspect-ratio one)

- [ ] **Step 1: Register on Google Flow tab in `src/lib/settings-tabs.ts:34` neighborhood**

```diff
  "google_flow_aspect_ratio",
+ "google_flow_image_aspect_ratio",
```

- [ ] **Step 2: Add `<SelectField>` in `src/app/settings/google-flow-tab.tsx`**

After the existing `google_flow_aspect_ratio` SelectField block (ending around line 73), insert:

```tsx
<SelectField
  id="google_flow_image_aspect_ratio"
  label="Image Aspect Ratio"
  value={values.google_flow_image_aspect_ratio}
  options={enumOptions("google_flow_image_aspect_ratio")}
  onChange={(v) =>
    update(
      "google_flow_image_aspect_ratio",
      v as AllSettings["google_flow_image_aspect_ratio"]
    )
  }
/>
```

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 4: Manual verification**

Run: `npm run dev`
Open: `http://localhost:3000/settings` → "Google Flow" tab.
Expected: A new "Image Aspect Ratio" dropdown appears below "Aspect Ratio" with 5 options ("Landscape 16:9", "Landscape 4:3", "Square 1:1", "Portrait 3:4", "Portrait 9:16"). Default selected is "Landscape 16:9". Pick "Portrait 9:16", reload the page; the value persists.

- [ ] **Step 5: Commit**

```bash
git add src/lib/settings-tabs.ts src/app/settings/google-flow-tab.tsx
git commit -m "flow-image-aspect: surface image aspect select on Google Flow tab"
```

- [ ] **Step 6: Codex checkpoint #2** *(deferred)*

---

## Task 3: Emit `imageAspect` in next-task DTO (TDD)

**Files:**
- Modify: `src/app/api/flow/next-task/[token]/route.ts` (extend `DispatchExtras`, emit field)
- Test: `__tests__/api/flow/next-task/[token]/route.test.ts` (add 3 tests)

- [ ] **Step 1: Write failing tests**

Open `__tests__/api/flow/next-task/[token]/route.test.ts`. Locate the existing test `"emits imageModel + videoModel with seeded defaults on a createImage dispatch"` (around line 924). Immediately after it, add three new tests:

```ts
it("emits imageAspect with default 16:9 on createImage dispatch", async () => {
  await seedAccount({ token: "T-img-aspect" });
  await seedVideo("vid_ia");
  await enqueue({
    video_id: "vid_ia",
    chunk_id: "c1",
    kind: "image",
    mode: "createImage",
    prompt: "a Roman bridge",
    output_path: "images/c1.png",
  });

  const res = await callNextTask("T-img-aspect", {
    type: "TaskRequest",
    accountToken: "T-img-aspect",
    mode: "createImage",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.imageAspect).toBe("16:9");
});

it("emits imageAspect on text-mode dispatch too (mode-independent)", async () => {
  await seedAccount({ token: "T-ta-text" });
  await seedVideo("vid_tat");
  await enqueue({
    video_id: "vid_tat",
    chunk_id: "h1",
    kind: "clip",
    mode: "text",
    prompt: "a galloping horse",
    output_path: "videos/clip/h1.mp4",
  });

  const res = await callNextTask("T-ta-text", {
    type: "TaskRequest",
    accountToken: "T-ta-text",
    mode: "text",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.imageAspect).toBe("16:9");
});

it("emits the operator-set imageAspect value when changed from default", async () => {
  // Override the seeded default before enqueueing
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare("UPDATE settings SET value = ? WHERE key = ?")
    .run("9:16", "google_flow_image_aspect_ratio");

  await seedAccount({ token: "T-img-portrait" });
  await seedVideo("vid_ip");
  await enqueue({
    video_id: "vid_ip",
    chunk_id: "c1",
    kind: "image",
    mode: "createImage",
    prompt: "a tall obelisk",
    output_path: "images/c1.png",
  });

  const res = await callNextTask("T-img-portrait", {
    type: "TaskRequest",
    accountToken: "T-img-portrait",
    mode: "createImage",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.imageAspect).toBe("9:16");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test -- __tests__/api/flow/next-task/[token]/route.test.ts -t "imageAspect"`
Expected: 3 failures. The assertions on `body.imageAspect` will report `undefined` because the route doesn't emit the field yet.

- [ ] **Step 3: Modify `src/app/api/flow/next-task/[token]/route.ts`**

**Extend `DispatchExtras`** (around line 26-41):

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

**Add to `shapeTaskForExtension` output object** (around line 64-76):

```diff
    const out: Record<string, unknown> = {
      id: row.external_task_id,
      prompt: row.prompt,
      mode: row.mode,
      videoId: row.video_id,
      projectTitle: video.title,
      flowProjectId: extras.flowProjectId,
      imageModel: extras.imageModel,
+     imageAspect: extras.imageAspect,
      videoModel: extras.videoModel,
    };
```

**Read setting in POST handler `extras` object** (around line 186-192):

```diff
    const extras: DispatchExtras = {
      flowProjectId: project?.flow_project_id ?? null,
      imageModel: getSetting("google_flow_image_model", db),
+     imageAspect: getSetting("google_flow_image_aspect_ratio", db),
      videoModel,
      origin: new URL(req.url).origin,
      token: ctx.params.token,
    };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test -- __tests__/api/flow/next-task/[token]/route.test.ts -t "imageAspect"`
Expected: 3 PASS.

- [ ] **Step 5: Run full next-task route test file to confirm no regressions**

Run: `npm run test -- __tests__/api/flow/next-task/[token]/route.test.ts`
Expected: all tests pass (previous test count + 3 new).

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | head -30`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/flow/next-task/[token]/route.ts "__tests__/api/flow/next-task/[token]/route.test.ts"
git commit -m "flow-image-aspect: emit imageAspect field in next-task DTO"
```

- [ ] **Step 8: Codex checkpoint #3** *(deferred)*

---

## Task 4: Add `imageAspectRatio` to youforge-flow settings schema + accessor

**Files:**
- Modify: `extensions/youforge-flow/src/settings-schema.js:67` neighborhood (add entry)
- Modify: `extensions/youforge-flow/src/settings.js:145` (bulk-load list), `:178` neighborhood (accessor)

- [ ] **Step 1: Add schema entry**

In `extensions/youforge-flow/src/settings-schema.js`, after the `imageModel` entry (line 67), add:

```js
{ key: 'imageAspectRatio', default: '16:9', kind: 'string' },
```

- [ ] **Step 2: Add to bulk-load list**

In `extensions/youforge-flow/src/settings.js:145`, add `'imageAspectRatio'` to the array:

```diff
- 'outputCount', 'aspectRatio', 'imageModel', 'videoModel', 'imgUpscale', 'vidUpscale',
+ 'outputCount', 'aspectRatio', 'imageAspectRatio', 'imageModel', 'videoModel', 'imgUpscale', 'vidUpscale',
```

- [ ] **Step 3: Add debug log entry**

In `extensions/youforge-flow/src/settings.js:150` neighborhood (the debug log), add:

```diff
  'aspect:', settingsCache.get('aspectRatio'),
+ 'imageAspect:', settingsCache.get('imageAspectRatio'),
  'image:', settingsCache.get('imageModel'),
```

- [ ] **Step 4: Add accessor function**

In `extensions/youforge-flow/src/settings.js:177` neighborhood, after `getAspectRatio()`:

```js
function getImageAspectRatio() { return getSetting('imageAspectRatio'); }
```

- [ ] **Step 5: Manual verification — schema loads cleanly**

Load the unpacked extension at `extensions/youforge-flow/` in `chrome://extensions` (dev mode). Open the service worker DevTools. Check console for the "[settings]" debug log — it should now show `imageAspect: '16:9'` (or whatever the default resolved to). No errors.

> **Note:** youforge-flow's popup is intentionally stripped down (Connection, concurrency, character lock, advanced numerics — no aspect/model selects). HistForge drives `imageAspect` per-task via the DTO, and the storage default `'16:9'` is purely a fallback if HistForge fails to send the field. No popup UI is added for this setting.

- [ ] **Step 6: Commit**

```bash
git add extensions/youforge-flow/src/settings-schema.js extensions/youforge-flow/src/settings.js
git commit -m "youforge-flow: add imageAspectRatio setting key"
```

- [ ] **Step 7: Codex checkpoint #4** *(deferred)*

---

## Task 5: Inject `imageAspectRatioSetting` into executor context

**Files:**
- Modify: `extensions/youforge-flow/src/executors/index.js:62-63` neighborhood

- [ ] **Step 1: Add to context object**

In `extensions/youforge-flow/src/executors/index.js`, near line 62 where `aspectRatioSetting` is read:

```diff
  aspectRatioSetting: getAspectRatio(),
+ imageAspectRatioSetting: getImageAspectRatio(),
  imageModelSetting: getImageModel(),
```

- [ ] **Step 2: Confirm `getImageAspectRatio` is globally available**

No imports needed — `executors/index.js` is loaded via `importScripts` in `background.js:15` *after* `src/settings.js`, so any function defined at top level of `settings.js` is already a global by the time `executors/index.js` runs. Sanity-check: `grep -n "function getImageAspectRatio" extensions/youforge-flow/src/settings.js` returns the accessor added in Task 4 step 4.

- [ ] **Step 3: Manual sanity check**

Reload the extension. Trigger any task that flows through the executor (manual or via HistForge). The service worker DevTools console should not show any "undefined" errors related to `imageAspectRatioSetting`.

- [ ] **Step 4: Commit**

```bash
git add extensions/youforge-flow/src/executors/index.js
git commit -m "youforge-flow: thread imageAspectRatioSetting into executor context"
```

- [ ] **Step 5: Codex checkpoint #5** *(deferred)*

---

## Task 6: Replace binary aspect branch with `imageAspectToEnum()` in image executor

**Files:**
- Modify: `extensions/youforge-flow/src/executors/image.js:32-34` (replace), `:1-26` (add helper at top of file)

- [ ] **Step 1: Add the helper at the top of `image.js`**

Above the existing `CHARACTER_LOCK_UUID_RE` constant (line 25), insert:

```js
// Map operator-friendly aspect strings ("16:9", "9:16", etc.) onto Google
// Flow's IMAGE_ASPECT_RATIO_* enum values. Source-of-truth for the 5-value
// matrix is the new VEO API Extension upstream (background.js:787-806);
// HistForge mirrors the same 5 values in `google_flow_image_aspect_ratio`.
// The `legacyAspect` fallback covers the case where neither HistForge nor
// the popup set `imageAspectRatio` yet, so the existing 2-value `aspectRatio`
// setting (shared with the video path) drives behavior unchanged.
function imageAspectToEnum(imageAspect, legacyAspect) {
  switch ((imageAspect || '').toLowerCase()) {
    case '16:9': return 'IMAGE_ASPECT_RATIO_LANDSCAPE';
    case '4:3':  return 'IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE';
    case '1:1':  return 'IMAGE_ASPECT_RATIO_SQUARE';
    case '3:4':  return 'IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR';
    case '9:16': return 'IMAGE_ASPECT_RATIO_PORTRAIT';
  }
  return legacyAspect === 'portrait' ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
                                     : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
}
```

- [ ] **Step 2: Replace the binary branch in `runImageGen()` at line 32-34**

```diff
- const imageAspect = settings.aspectRatioSetting === 'portrait'
-   ? 'IMAGE_ASPECT_RATIO_PORTRAIT'
-   : 'IMAGE_ASPECT_RATIO_LANDSCAPE';
+ const imageAspect = imageAspectToEnum(
+   task.imageAspect || settings.imageAspectRatioSetting,
+   settings.aspectRatioSetting
+ );
```

- [ ] **Step 3: Manual verification — request enum reflects setting**

1. Reload the extension. Set "Image Aspect Ratio" in the popup to "Portrait 9:16".
2. Open the service worker DevTools, then trigger any createImage task (manual dispatch from HistForge or via popup if available).
3. In the Network tab of the labs.google tab DevTools, find the `flowMedia:batchGenerateImages` POST. Inspect the request body — confirm `imageAspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT"`.
4. Set popup to "Square 1:1", redo. Expected: `IMAGE_ASPECT_RATIO_SQUARE`.
5. Set popup to "Landscape 4:3", redo. Expected: `IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE`.

- [ ] **Step 4: Manual verification — HistForge per-task wins**

The popup does not expose the image aspect ratio (HistForge owns it). To verify the HistForge → extension wire:

1. In HistForge `/settings` → Google Flow tab, set "Image Aspect Ratio" to "Portrait 3:4".
2. Trigger a real createImage dispatch from HistForge.
3. In the labs.google DevTools Network panel, find the outbound `flowMedia:batchGenerateImages` POST. Request body shows `imageAspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"`.
4. Change HistForge setting to "Square 1:1"; trigger another dispatch. Expected: `IMAGE_ASPECT_RATIO_SQUARE`.
5. Repeat for "Landscape 4:3" → `IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE`.

- [ ] **Step 5: Manual verification — extension storage fallback**

When HistForge omits `imageAspect` from the DTO (older HistForge, or a hand-crafted dispatch), the extension must fall back to its storage default `'16:9'` → `IMAGE_ASPECT_RATIO_LANDSCAPE`.

1. In the labs.google tab DevTools console (or service worker DevTools), monkey-patch the next dispatched task to strip the field before the executor sees it. Easiest: temporarily revert the route-side emit (Task 3 step 3) on the HistForge tree, run one dispatch, then restore. Or hand-craft a `chrome.storage.local`-stashed task.
2. Expected: outbound request shows `IMAGE_ASPECT_RATIO_LANDSCAPE` (default storage value `'16:9'` → LANDSCAPE).
3. Restore the route-side emit.

- [ ] **Step 6: Manual verification — legacy 2-value fallback**

When neither `task.imageAspect` nor `settings.imageAspectRatio` is set, the existing 2-value `aspectRatio` should drive behavior unchanged.

1. In service worker DevTools console: `chrome.storage.local.remove('imageAspectRatio')`.
2. With HistForge again not sending `imageAspect` (same setup as step 5), trigger a dispatch.
3. Expected: outbound request uses `IMAGE_ASPECT_RATIO_PORTRAIT` or `IMAGE_ASPECT_RATIO_LANDSCAPE` depending on the legacy `aspectRatio` storage value.
4. Restore: `chrome.storage.local.set({ imageAspectRatio: '16:9' })`.

- [ ] **Step 7: Commit**

```bash
git add extensions/youforge-flow/src/executors/image.js
git commit -m "youforge-flow: map 5 image aspect ratios via imageAspectToEnum"
```

- [ ] **Step 8: Codex checkpoint #6** *(deferred)*

---

## Task 7: Imagen 4 (`IMAGEN_3_5`) reference-skip guard in image executor

**Files:**
- Modify: `extensions/youforge-flow/src/executors/image.js:44-58` (wrap reference-upload loop)

- [ ] **Step 1: Add the guard before the upload loop**

In `extensions/youforge-flow/src/executors/image.js`, between line 38 (`outputCount` resolution) and line 44 (`const referenceImageIds = []`), insert:

```js
const isImagen4 = modelName === 'IMAGEN_3_5';
if (isImagen4 && (task.imagegenReference || task.referenceImage)) {
  log.safeLog(`[api] Skipping reference upload: Imagen 4 (${modelName}) does not support reference images. Generating from prompt only.`);
}
```

- [ ] **Step 2: Wrap the existing upload loop in `if (!isImagen4)`**

Modify lines 46-58:

```diff
  const referenceImageIds = [];
  const refUrl = task.imagegenReference || task.referenceImage;
- if (refUrl && refUrl.trim()) {
+ if (!isImagen4 && refUrl && refUrl.trim()) {
    const refUrls = refUrl.split(',').map((u) => u.trim()).filter((u) => u);
    log.safeLog('Uploading', refUrls.length, 'reference image(s)...');
    for (let i = 0; i < refUrls.length; i++) {
      try {
        const mediaId = await uploadImage(refUrls[i], `reference_${i + 1}.png`);
        if (mediaId) referenceImageIds.push(mediaId);
      } catch (e) {
        log.safeLog(`[api] Reference image ${i + 1} upload failed:`, e.message);
      }
    }
    log.safeLog('Uploaded', referenceImageIds.length, 'reference images');
  }
```

- [ ] **Step 3: Manual verification — Imagen 4 skips upload**

1. Reload the extension.
2. In HistForge settings, set image model to "Imagen 4" (`IMAGEN_3_5`).
3. Trigger a createImage task with a `referenceImage` URL attached.
4. Expected console output: `Skipping reference upload: Imagen 4 (IMAGEN_3_5) does not support reference images.`
5. Expected Network: no POST to `https://aisandbox-pa.googleapis.com/v1/flow/uploadImage`.
6. Expected request body for `flowMedia:batchGenerateImages`: `imageInputs: []`.
7. Confirm the task completes successfully (Google may produce a generation without reference matching — expected behavior).

- [ ] **Step 4: Manual verification — NARWHAL still uploads refs**

1. Switch HistForge image model back to "Nano Banana 2" (`NARWHAL`).
2. Trigger the same task.
3. Expected: upload POST fires, request body shows `imageInputs: [{ imageInputType: 'IMAGE_INPUT_TYPE_REFERENCE', name: '<mediaId>' }]`.

- [ ] **Step 5: Manual verification — character lock still applies on Imagen 4**

1. Set HistForge image model to "Imagen 4".
2. In the extension popup, set `characterLockReference` to a valid UUID (e.g., one from the auto-detected Characters list).
3. Trigger a createImage task with a reference image URL.
4. Expected request body: `imageInputs: []` AND `referenceEntities: [{ entityId: "<uuid>" }]`. Both fields present — they are independent.
5. Whether Google's Imagen 4 honors `referenceEntities` is a server-side question — confirm the request goes through; the generation result may or may not visually reflect the character lock.

- [ ] **Step 6: Commit**

```bash
git add extensions/youforge-flow/src/executors/image.js
git commit -m "youforge-flow: skip reference upload on Imagen 4 (IMAGEN_3_5)"
```

- [ ] **Step 7: Codex checkpoint #7** *(deferred)*

---

## Task 8: Commit the reference-only `VEO API Extension/` mirror + update README

**Files:**
- Add to git: `extensions/VEO API Extension/` (untouched mirror)
- Modify: `extensions/youforge-flow/README.md` (point "Relationship to upstream" at new mirror)

- [ ] **Step 1: Update `extensions/youforge-flow/README.md` "Relationship to upstream" section**

Read lines 87-91 of `extensions/youforge-flow/README.md`. Replace the existing text:

```diff
- `extensions/veo-upstream/` is kept in the repository untouched as a
- reference so future upstream patches can be diffed against it cleanly.
- Do **not** edit upstream; edit this fork only.
+ `extensions/VEO API Extension/` is kept in the repository untouched as a
+ reference mirror of a newer upstream so future graft diffs can be
+ produced cleanly. Do **not** edit the mirror; edit this fork only.
+ (An older `extensions/veo-upstream/` mirror used to play this role and
+ is no longer present.)
```

- [ ] **Step 2: Stage the mirror directory**

```bash
git add "extensions/VEO API Extension/" extensions/youforge-flow/README.md
git status --short
```

Expected: `extensions/VEO API Extension/` contents marked as new files (12 files), `youforge-flow/README.md` marked modified.

- [ ] **Step 3: Commit**

```bash
git commit -m "extensions: vendor VEO API Extension mirror as reference-only"
```

- [ ] **Step 4: Codex checkpoint #8** *(deferred — small diff but still worth a pass)*

---

## Task 9: End-to-end pipeline verification

**Files:** none — pure manual verification.

- [ ] **Step 1: Setup**

1. `npm run dev` — confirm worker + Next.js both start clean.
2. Load `extensions/youforge-flow/` as unpacked extension in Chrome.
3. In HistForge `/settings` → Google Flow tab:
   - Image model: "Nano Banana 2" (NARWHAL)
   - Image aspect ratio: "Portrait 9:16"
4. The extension popup has no aspect/model controls — HistForge per-task drives behavior.
5. Confirm character-lock UUID is configured in the popup's "Character lock" section (carry over from existing setup, no changes).

- [ ] **Step 2: Run a fresh single-video pipeline**

Create a new video via the dashboard with a short topic, kind=narrative (or whichever workflow exercises createImage). Start the queue.

- [ ] **Step 3: Observe image generation**

On each createImage dispatch, inspect the outbound request body in the labs.google tab DevTools Network panel:
- `imageAspectRatio: "IMAGE_ASPECT_RATIO_PORTRAIT"` (9:16 maps to PORTRAIT).
- `imageInputs[]` contains the uploaded per-video reference media ID (commit `166a91c` plumbing).
- `referenceEntities[]` contains the character-lock entityId.

Confirm at least 3 images are generated and saved to disk under the expected `images/` path.

- [ ] **Step 4: Switch to Imagen 4 mid-flight**

Pause the queue. Change image model to "Imagen 4" (IMAGEN_3_5). Resume.

- [ ] **Step 5: Observe Imagen 4 behavior**

On the next createImage dispatch:
- Service worker console logs: `Skipping reference upload: Imagen 4 ...`
- No `uploadImage` network call.
- Request body: `imageInputs: []`, `referenceEntities` still present with entityId.
- Generation completes (with or without visible character match — both are valid outcomes).

- [ ] **Step 6: Confirm the video reaches render**

Let the pipeline run to completion. Confirm the final rendered MP4 contains the generated images at 9:16 aspect ratio (frame dimensions in `ffprobe` output: 9:16 ratio, e.g., 1080×1920).

- [ ] **Step 7: Final commit (squash anything outstanding)**

If any verification turned up a small fix, commit it separately with a clear message. Otherwise no commit needed for this task.

- [ ] **Step 8: Final Codex checkpoint** *(deferred — full-branch sweep)*

When quota is back:

```bash
node "C:/Users/User/.claude/plugins/cache/openai-codex/codex/1.0.4/scripts/codex-companion.mjs" review --wait --scope branch --base master
```

Surface findings verbatim to the user. Address before any PR open.

---

## Spec coverage check

| Spec section | Plan task(s) |
|--------------|--------------|
| Graft 1: 5 image aspect ratios — HistForge setting | Task 1, 2 |
| Graft 1: extension-side storage key + accessor | Task 4 |
| Graft 1: `imageAspectToEnum` helper + executor branch | Task 6 |
| Graft 1: per-task `imageAspect` field on the wire | Task 3 |
| Graft 2: Imagen 4 reference-skip guard | Task 7 |
| HistForge settings tab control | Task 2 |
| Wire contract `imageAspect` field (test + impl) | Task 3 |
| youforge-flow popup UI | **Intentionally omitted** — popup is stripped down; HistForge owns this setting. Documented in Task 4 step 5. |
| Executor context plumbing (`imageAspectRatioSetting`) | Task 5 |
| VEO API Extension reference mirror committed | Task 8 |
| README "Relationship to upstream" pointer update | Task 8 |
| End-to-end pipeline test | Task 9 |
| Rollback safety (additive only, no migration) | Implicit — every commit is small and revertable |
| Codex review per step | Steps marked "Codex checkpoint #N (deferred)" |

All spec requirements are covered. The popup UI item in the spec was reconsidered during implementation planning — youforge-flow's popup deliberately doesn't expose aspect/model controls (it's a dumb runner; HistForge drives), so adding one would violate the existing design intent.
