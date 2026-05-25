# Google Flow Settings: Model Dropdowns + Advanced Group

## Overview

Convert the image model field into a dropdown, add a parallel video model dropdown, group ops-tuning fields under a collapsible "Advanced" section, drop the now-redundant `google_flow_video_quality` setting, and wire both model values end-to-end from HistForge settings → `next-task` dispatch payload → YouForge Flow executors. flow2api remains a read-only source of truth for valid model identifiers.

## Current State

- **Settings UI** — `src/app/settings/settings-form.tsx:229-281` (Google Flow tab).
  - Image model: `TextField` at 235-239.
  - `google_flow_video_quality`: `SelectField` (`fast`/`quality`) at 240-250.
  - `google_flow_aspect_ratio`: `SelectField` at 251-261.
  - `google_flow_account_cooldown_hours` / `google_flow_max_retries` / `google_flow_dispatch_timeout_minutes`: `NumberField`s at 262-279.
  - `google_flow_relogin_needed`: `ReadOnlyField` at 231-234.
  - `TAB_FIELDS["google-flow"]` registry: `src/app/settings/settings-form.tsx:50-58`.
  - `SelectField` component takes `options: string[]` (label === value): `src/app/settings/settings-form.tsx:529-559`.
- **Schema** — `src/lib/settings.ts:12-76` (`SETTING_SCHEMAS`). Image model is `z.string()` (line 33); `video_quality` is `z.enum(["fast", "quality"])` (line 34).
- **Defaults** — `src/lib/db.ts:11-42` (`DEFAULT_SETTINGS`); seeded via `seedDefaultSettings` at 44-54. Image default is `"NARWHAL"`; `video_quality` default is `"fast"`.
- **Dispatch payload** — `src/app/api/flow/next-task/[token]/route.ts:32-56` (`shapeTaskForExtension`). Currently emits `id`/`prompt`/`mode`/`videoId`/`projectTitle`/`flowProjectId`, plus mode-specific extras. No model fields.
- **Extension consumers** —
  - `extensions/youforge-flow/src/executors/image.js:18` reads `settings.imageModelSetting` (sourced from `getImageModel()` in `extensions/youforge-flow/src/settings.js`, populated by chrome.storage.local).
  - `extensions/youforge-flow/src/executors/text-to-video.js:13` reads `ctx.modelKeys.t2v` (resolved by `getVideoModelKeys` in `extensions/youforge-flow/src/account-tier.js:137-155`).
  - Per-task settings assembled in `extensions/youforge-flow/src/executors/index.js:59-66`.
  - Aspect ratio for video request body: `extensions/youforge-flow/src/executors/shared.js:51-53` (extension-side, separate from model).
- **UI primitives** — `src/components/ui/` has `select`, `dialog`, `dropdown-menu`, `tabs`, etc. **No Collapsible primitive.** `@radix-ui/react-collapsible` is **not** in `package.json`.
- **Tests** — `__tests__/api/flow/next-task/[token]/route.test.ts` covers the dispatch payload (test harness at lines 1-50: temp DB, `seedDefaultSettings`, per-test cleanup). Other test files contain `AllSettings` fixtures and direct references to `google_flow_video_quality` that must change in lockstep with the schema:
  - `__tests__/components/settings/settings-form.test.tsx:43` — `defaultSettings: AllSettings` fixture row.
  - `__tests__/unit/lib/db.test.ts:284` — `seedDefaultSettings` exact-equality assertion (line 271 onwards).
  - `__tests__/unit/lib/settings.test.ts:204` (round-trip fixture), `:273` (default-seed assertion), `:278-283` (`video_quality enum rejects unknown values` test — specific to the removed key).
  - `__tests__/unit/youforge-flow/executors-image-to-video.test.ts:59` uses `videoModelQuality` (chrome.storage cache field, not a HistForge setting) — out of scope, no change.
- **Worker steps that consume these settings** — per `docs/histforge-spec.md:725-726`, `generate_main_images_google_flow` enqueues mode=`createImage` (extension routes to `image.js` → reads `task.imageModel`) and `generate_hook_video_google_flow` enqueues mode=`text` (extension routes to `text-to-video.js` → reads `task.videoModel`). HistForge's main pipeline does **not** use I2V or frames-to-video, so the matrix-driven `i2v`/`r2v`/`i2v_fl` keys are out of scope but also unused by the main flow today.
- **Spec** — `docs/histforge-spec.md` is the canonical contract per CLAUDE.md. Settings table is at lines 248-279 (current Google Flow rows: 259-265); next-task route summary at line 629; settings UI listing at lines 932-942.
- **Operating environment** — per project memory, `/workspace` is a 9p mount of `C:\` and the operator runs `npm install` on Windows. Anything that mutates `node_modules` from the WSL side risks breaking native modules.
- **Popup UI** — `extensions/youforge-flow/popup.html` has **no** image/video model selectors today (verified). The chrome.storage.local entries `imageModel`/`videoModel` are only ever the in-memory defaults `'NARWHAL'` / `'fast'` from `extensions/youforge-flow/src/settings.js:30-31` (no UI writes them; `updateExecutorSettings` exists but is not wired). So the executor "fallback to local setting" path practically resolves to those hardcoded defaults.
- **flow2api reference** — `extensions/flow2api/src/services/generation_handler.py:22-312`. Image `model_name` enums (`NARWHAL` line 138, `GEM_PIX_2` line 35, `IMAGEN_3_5` line 126); video T2V `model_key` strings live at lines 225-312. Read-only — not modified by this plan.

## Scope

**Doing:**
- Convert `google_flow_image_model` to a 3-value enum + dropdown with display labels.
- Add new `google_flow_video_model` 5-value enum + dropdown with display labels.
- Remove `google_flow_video_quality` (schema + default + UI + tab registry).
- Add a one-time DB migration that coerces any `google_flow_image_model` value not in the new enum to `'NARWHAL'`, and deletes the orphaned `google_flow_video_quality` row.
- Group `google_flow_relogin_needed`, `google_flow_account_cooldown_hours`, `google_flow_max_retries`, `google_flow_dispatch_timeout_minutes` under a collapsible "Advanced" section (default collapsed).
- Add a Collapsible UI primitive (`@radix-ui/react-collapsible` wrapper).
- Extend `SelectField` so options can carry separate display labels.
- Send `imageModel` and `videoModel` in every `next-task` response (read fresh from settings per dispatch — Design B from planning, no queue schema change).
- Update extension `image.js` and `text-to-video.js` to prefer the per-task field, fall back to local settings.
- Update `docs/histforge-spec.md` — settings table (lines 259-265), next-task contract (line 629), and Settings UI listing (line 937).
- Update next-task tests: cover both modes (image + video), assert per-dispatch read semantics across two dispatches.
- Update other test fixtures and tests that reference `google_flow_video_quality` to match the new schema (settings-form, db, settings unit tests).
- Note: `GEM_PIX` is intentionally excluded from the image-model dropdown (older Gemini 2.5 Flash; not needed). The migration in Task 1.3 silently coerces any pre-existing `GEM_PIX` value to `NARWHAL`.

**Not doing:**
- No changes to `extensions/flow2api/` (reference only).
- No changes to `google_flow_queue` schema or repo (per-dispatch read, not per-task storage).
- No 2K/4K upsample exposure on the HistForge side (extension-side `imgUpscale`/`vidUpscale` stay untouched).
- No exposure of I2V / R2V / frames-to-video models (HistForge's main pipeline doesn't enqueue these modes, so they stay matrix-driven and untouched).
- No changes to the YouForge Flow popup UI (`extensions/youforge-flow/popup.html`/`popup.js`) — there are no image/video model selectors there to begin with; chrome.storage.local fallback stays for safety.
- No removal of `MODEL_MATRIX` (still used by I2V/R2V/frames executors that aren't reached by HistForge's main pipeline).

## Tasks

### Phase 1: Settings schema, defaults, and UI

- [x] **Task 1.1: Update setting schemas**
  **Files:** `src/lib/settings.ts`
  **What:** In `SETTING_SCHEMAS` (lines 12-76), tighten `google_flow_image_model` (currently `z.string()` at line 33) to `z.enum(["NARWHAL", "GEM_PIX_2", "IMAGEN_3_5"])`. Add a new `google_flow_video_model: z.enum(["veo_3_1_t2v_lite", "veo_3_1_t2v_fast_ultra", "veo_3_1_t2v", "veo_3_1_t2v_lite_low_priority", "veo_3_1_t2v_fast_ultra_relaxed"])`. Remove `google_flow_video_quality` (line 34).
  **Context:** Enum values are exact `model_name` (image) and `videoModelKey` (video) strings consumed by Google's API — verified against `extensions/flow2api/src/services/generation_handler.py:22-312` and `extensions/youforge-flow/src/executors/image.js:47` (`imageModelName: modelName`) and `shared.js:64` (`videoModelKey: config.videoModelKey`). The PATCH route at `src/app/api/settings/route.ts:31-74` already runs every value through its schema, so enum coercion happens automatically.

- [x] **Task 1.2: Update DB defaults**
  **Files:** `src/lib/db.ts`
  **What:** In `DEFAULT_SETTINGS` (lines 11-42), keep `google_flow_image_model: "NARWHAL"` (line 23). Add `google_flow_video_model: "veo_3_1_t2v_lite_low_priority"`. Remove `google_flow_video_quality` (line 24).
  **Context:** `seedDefaultSettings` (lines 44-54) uses `INSERT OR IGNORE`, so it inserts the new `google_flow_video_model` row on existing DBs but does **not** correct out-of-range pre-existing values for `google_flow_image_model` (which used to be a free-form `TextField` and may carry anything). That correction lives in Task 1.3.

- [x] **Task 1.3: One-time data migration in `createDb`**
  **Files:** `src/lib/db.ts`
  **What:** Inside `createDb`, after the schema-creation block and after the existing additive-column migrations (lines 161-186), add three idempotent statements:
    1. `UPDATE settings SET value = 'NARWHAL' WHERE key = 'google_flow_image_model' AND value NOT IN ('NARWHAL','GEM_PIX_2','IMAGEN_3_5')` — coerces any pre-existing value (could be `GEM_PIX`, an empty string, a typo) to a valid enum value before any `getSetting` call can ZodError on it.
    2. `DELETE FROM settings WHERE key = 'google_flow_video_quality'` — removes the now-orphaned row.
    3. `INSERT OR IGNORE INTO settings (key, value) VALUES ('google_flow_video_model', 'veo_3_1_t2v_lite_low_priority')` — seeds the new key for upgraded DBs. **Required** because `seedDefaultSettings` is only invoked from `scripts/db-init.ts`; the runtime `getDb()` path (`createDb` only) does not seed, so without this step `getSetting("google_flow_video_model", db)` would throw `"Setting not seeded"` on existing installs that didn't re-run `npm run db:init`.
  **Context:** All three statements are idempotent and run on every DB open; that mirrors the always-execute pattern of the existing column migrations. They must run before any caller can `getSetting("google_flow_image_model"|"google_flow_video_model", db)` — placing them in `createDb` (called once per process at first DB open) guarantees that. Keep the seeded default in sync with `DEFAULT_SETTINGS` (Task 1.2): if you change the default in one place, change it in both.

- [x] **Task 1.4: Add Collapsible UI primitive**
  **Files:** `package.json`, `src/components/ui/collapsible.tsx`
  **What:** Add `@radix-ui/react-collapsible` to dependencies (match the `^1.x` pin style of the existing `@radix-ui/*` entries in `package.json`). The operator runs `npm install` from the Windows side per project convention — **do not** run npm install from this WSL environment (would corrupt native modules; see project memory). Create `src/components/ui/collapsible.tsx` re-exporting `Root` (as `Collapsible`), `CollapsibleTrigger`, and `CollapsibleContent`.
  **Context:** Mirror the pattern in `src/components/ui/select.tsx` and `src/components/ui/tabs.tsx` (forward-ref components, `cn` for class merging). Trigger styling can lean on the existing `button` primitive at `src/components/ui/button.tsx`. No animations required for v1 — a chevron + label is sufficient.

- [x] **Task 1.5: Extend `SelectField` to support label/value option objects**
  **Files:** `src/app/settings/settings-form.tsx`
  **What:** Widen the `options` prop on `SelectField` (lines 529-559) so it accepts either `string[]` (existing) **or** `Array<{ label: string; value: string }>`. Internally normalise to the object form. String-array call sites (aspect_ratio at 251-261, `llm_provider` at 284-291, etc.) must keep working with no changes.
  **Context:** New image and video model dropdowns need user-friendly labels distinct from the stored values (e.g. "Nano Banana 2" → `NARWHAL`). Keep TypeScript inference clean — narrow via `typeof options[0] === 'string'` or a discriminator.

- [x] **Task 1.6: Rewrite the Google Flow tab content**
  **Files:** `src/app/settings/settings-form.tsx`
  **What:** Replace the body of `<TabsContent value="google-flow">` (lines 229-281). New visible-by-default order:
    1. `<GoogleFlowAccounts />` (unchanged).
    2. **Image model** — `SelectField` for `google_flow_image_model` with options `[{label: "Nano Banana 2", value: "NARWHAL"}, {label: "Nano Banana Pro", value: "GEM_PIX_2"}, {label: "Imagen 4", value: "IMAGEN_3_5"}]`.
    3. **Video model** — `SelectField` for `google_flow_video_model` with options in this order (per user spec): `[{label: "Veo 3.1 - Lite", value: "veo_3_1_t2v_lite"}, {label: "Veo 3.1 - Fast", value: "veo_3_1_t2v_fast_ultra"}, {label: "Veo 3.1 - Quality", value: "veo_3_1_t2v"}, {label: "Veo 3.1 - Lite [Lower Priority]", value: "veo_3_1_t2v_lite_low_priority"}, {label: "Veo 3.1 - Fast [Lower Priority]", value: "veo_3_1_t2v_fast_ultra_relaxed"}]`.
    4. **Aspect ratio** — `SelectField` for `google_flow_aspect_ratio` (move from current 251-261, unchanged options).
    5. **Advanced** — `<Collapsible defaultOpen={false}>` titled "Advanced" containing, in this order: `google_flow_relogin_needed` (ReadOnlyField), `google_flow_account_cooldown_hours` (NumberField), `google_flow_max_retries` (NumberField), `google_flow_dispatch_timeout_minutes` (NumberField).
  Remove the `google_flow_video_quality` SelectField. Update `TAB_FIELDS["google-flow"]` (lines 50-58) — remove `google_flow_video_quality`, add `google_flow_video_model`.
  **Context:** The dirty-tab indicator (lines 188-199) keys off `TAB_FIELDS`, so collapsed-state Advanced fields with unsaved edits will still flag the tab. `AllSettings` types flow from `SETTING_SCHEMAS` — Task 1.1 will make TS errors surface here automatically if anything is missed. Verify with `npm run lint` (after the operator has run npm install) that nothing else in the codebase still references `google_flow_video_quality`.

- [x] **Task 1.7: Update unit-test fixtures and remove `video_quality`-specific tests**
  **Files:** `__tests__/components/settings/settings-form.test.tsx`, `__tests__/unit/lib/db.test.ts`, `__tests__/unit/lib/settings.test.ts`
  **What:**
    1. `settings-form.test.tsx` (line 43): replace `google_flow_video_quality: "fast"` with `google_flow_video_model: "veo_3_1_t2v_lite_low_priority"` in the `defaultSettings: AllSettings` fixture.
    2. `db.test.ts` (line 284): in the `seedDefaultSettings` exact-equality assertion (block starting at line 271), replace `google_flow_video_quality: "fast"` with `google_flow_video_model: "veo_3_1_t2v_lite_low_priority"`. Values are stored as strings.
    3. `settings.test.ts`:
        - Line 204: replace `google_flow_video_quality: "fast"` with `google_flow_video_model: "veo_3_1_t2v_lite_low_priority"` in the round-trip fixture.
        - Line 273: in the `seeds image/quality/aspect/dispatch-timeout defaults` test, replace the `google_flow_video_quality` assertion with `expect(getSetting("google_flow_video_model", db)).toBe("veo_3_1_t2v_lite_low_priority")`. Rename the `it(...)` description to drop "quality".
        - Lines 278-283: delete the `video_quality enum rejects unknown values` test entirely (the key is gone). Add a parallel `video_model enum rejects unknown values` test using `setSetting("google_flow_video_model", "not_a_real_key" as never, db)` to keep enum-coercion coverage for the new key.
  **Context:** `AllSettings` is a derived type from `SETTING_SCHEMAS` (via `keyof typeof SETTING_SCHEMAS`), so missing/extra keys in `AllSettings`-typed fixtures will fail TypeScript compilation in the test build — tsc's "object literal may only specify known properties" / "missing property" errors will point at every fixture row that needs a touch. Run `npm run test` after Task 1.1 to surface them all at once.

- [x] **Task 1.8: Update `docs/histforge-spec.md` (settings table + UI listing)**
  **Files:** `docs/histforge-spec.md`
  **What:** Two edits:
    1. **Settings table (lines 259-265):** change `google_flow_image_model` row to type `enum`, default `NARWHAL`, notes `NARWHAL` / `GEM_PIX_2` / `IMAGEN_3_5` (display names: "Nano Banana 2" / "Nano Banana Pro" / "Imagen 4"). Replace the `google_flow_video_quality` row with a `google_flow_video_model` row (type `enum`, default `veo_3_1_t2v_lite_low_priority`, notes listing the 5 values + display labels). Other rows in 261-265 are unchanged.
    2. **Settings UI listing (line 937):** swap `google_flow_video_quality` for `google_flow_video_model` in the Google Flow tab field list, and note that `google_flow_relogin_needed`, `google_flow_account_cooldown_hours`, `google_flow_max_retries`, `google_flow_dispatch_timeout_minutes` are grouped in a collapsed "Advanced" subsection.
  **Context:** CLAUDE.md mandates the spec stay in sync with implementation. The next-task-contract spec edit moved to Task 2.3 in Phase 2 so the spec doesn't claim a payload field before it ships.

### Phase 2: Dispatch payload

- [x] **Task 2.1: Include `imageModel` and `videoModel` in `next-task` payload**
  **Files:** `src/app/api/flow/next-task/[token]/route.ts`
  **What:** Update `shapeTaskForExtension` (lines 32-56) and the transaction block at 102-125 so the dispatched JSON includes `imageModel` and `videoModel` on every response. Read both via `getSetting("google_flow_image_model", db)` and `getSetting("google_flow_video_model", db)` either inside the transaction (alongside the existing `setSetting("google_flow_relogin_needed", false, db)` at line 112) or after the transaction returns and before `shapeTaskForExtension` runs — implementer's call. Pass them into `shapeTaskForExtension` and emit them on every mode. Both fields will always be non-null strings (enum-validated by the Task 1.1 schema).
  **Context:** `getSetting` is already imported (line 3). Reading per-dispatch (Design B from planning) means a setting change is picked up by the next dispatch immediately without any queue schema change. The mode-specific blocks at 45-54 stay as-is. Note that `flowProjectId` is also "unconditional" but can be `null`; `imageModel`/`videoModel` differ in being guaranteed non-null after Task 1.1's enum narrowing.

- [x] **Task 2.2: Update next-task dispatch tests**
  **Files:** `__tests__/api/flow/next-task/[token]/route.test.ts`
  **What:** Add the following coverage (each as a separate `it` block):
    1. **Image-mode default** — enqueue a row with `mode='createImage'`, dispatch, assert `imageModel === 'NARWHAL'` and `videoModel === 'veo_3_1_t2v_lite_low_priority'` are both present in the response (proving "unconditional emit").
    2. **Video-mode default** — enqueue a row with `mode='text'`, dispatch, assert both fields are still present with the same values (proving emit is mode-independent).
    3. **Per-dispatch read** — enqueue two rows, dispatch the first (assert seeded defaults). Then call `setSetting('google_flow_image_model', 'GEM_PIX_2', db)` and `setSetting('google_flow_video_model', 'veo_3_1_t2v_fast_ultra', db)`. Dispatch the second row, assert the response carries the mutated values. This proves the route reads settings per dispatch rather than caching them at queue-claim time.
  **Context:** Existing scaffolding (lines 1-50) uses `seedDefaultSettings` per `beforeEach` and a temp DB; reuse `seedAccount` and any video/queue helpers already in this file. `setSetting` is exported from `@/lib/settings`. No new fixture files needed.

- [x] **Task 2.3: Update `docs/histforge-spec.md` next-task contract (deferred from Task 1.8 #3)**
  **Files:** `docs/histforge-spec.md`
  **What:** Append a sentence to the `/api/flow/next-task/[token]` row (line 629) noting that the dispatched task object always includes `imageModel` and `videoModel` (read fresh from current settings per dispatch). This was originally bundled into Task 1.8 but deferred so the spec didn't advertise a payload field before the route shipped it.
  **Context:** Land this only after Task 2.1 is merged so the spec reflects shipped behavior. CLAUDE.md mandates the spec stay in sync with implementation.

### Phase 3: Extension executors

- [x] **Task 3.1: Image executor prefers `task.imageModel`**
  **Files:** `extensions/youforge-flow/src/executors/image.js`
  **What:** Change line 18 from `const modelName = settings.imageModelSetting;` to `const modelName = task.imageModel || settings.imageModelSetting;`.
  **Context:** `task` comes from the dispatch payload built in Task 2.1; `settings.imageModelSetting` (assembled at `extensions/youforge-flow/src/executors/index.js:62`) remains a safety-net fallback. Note that this fallback is effectively the hardcoded `'NARWHAL'` from `extensions/youforge-flow/src/settings.js:30` — there is no popup UI writing to `chrome.storage.local.imageModel`. This is fine: when HistForge sends a value (the normal path post-Task 2.1) it always wins.

- [x] **Task 3.2: Text-to-video executor prefers `task.videoModel`**
  **Files:** `extensions/youforge-flow/src/executors/text-to-video.js`
  **What:** Change line 13 from `const t2vModelKey = ctx.modelKeys.t2v;` to `const t2vModelKey = task.videoModel || ctx.modelKeys.t2v;`. Update the existing `safeLog('Text-to-video mode, model:', t2vModelKey)` (or add a sibling line) so it's evident when the value came from the task vs the matrix — useful for debugging mismatched HistForge/extension states.
  **Context:** When `task.videoModel` is set, the `MODEL_MATRIX` lookup at `src/account-tier.js:76-117` is bypassed *for T2V only*. `ctx.modelKeys.paygateTier` is still consumed by `runVideoGeneration` (`shared.js:58`) — `getVideoModelKeys` always returns a `paygateTier` (verified at `account-tier.js:91/99/107/115`), so this stays well-formed regardless. Aspect ratio is independent (`shared.js:51-53` reads `settings.aspectRatioSetting`). I2V (`image-to-video.js`) and frames (`frames-to-video.js`) executors are unchanged because HistForge's main pipeline does not enqueue those modes (per spec §12b.6 / lines 725-726, only `createImage` and `text` are produced). Both `generate_main_images_google_flow` (createImage → Task 3.1) and `generate_hook_video_google_flow` (text → Task 3.2) will therefore consume the new HistForge settings end-to-end.

- [x] **Task 3.3: Extension executor tests for the new task-field preference**
  **Files:** `__tests__/unit/youforge-flow/executors-image.test.ts`, `__tests__/unit/youforge-flow/executors-text-to-video.test.ts`
  **What:** Add two `it` blocks to each file:
    1. **Task field wins** — call the executor with `task.imageModel = 'GEM_PIX_2'` (image) or `task.videoModel = 'veo_3_1_t2v_fast_ultra' ` (text-to-video) and a contradictory fallback (`settings.imageModelSetting = 'NARWHAL'` / `ctx.modelKeys.t2v = 'veo_3_1_t2v_lite'`). Assert the request body sent to `pageCall` carries the task field (`imageModelName` / `videoModelKey`).
    2. **Fallback when task field absent** — omit `task.imageModel` / `task.videoModel`. Assert the body carries the fallback value.
  **Context:** Mirror the existing test scaffolding in each file (mocked `pageCall`, fake ctx). The `pageCall` mock already inspects request bodies in sibling tests; reuse the same pattern. These tests give the extension-side change parity with the dispatch-payload coverage added in Task 2.2 — without them, a regression where the executor reverts to settings-only would only surface end-to-end in production.

## References

- flow2api source-of-truth (read-only): `extensions/flow2api/src/services/generation_handler.py:22-312`
- Extension dispatcher and ctx assembly: `extensions/youforge-flow/src/executors/index.js:39-169`
- Extension MODEL_MATRIX (untouched; out-of-pipeline executors still use it): `extensions/youforge-flow/src/account-tier.js:76-117`
- Settings PATCH validation (auto-picks up Task 1.1 enums): `src/app/api/settings/route.ts:31-74`
- Existing dispatch payload tests: `__tests__/api/flow/next-task/[token]/route.test.ts`
- Spec sections to update: `docs/histforge-spec.md:259-265` (settings table), `:629` (next-task contract), `:937` (Settings UI listing)
- Worker steps that consume the settings end-to-end: `docs/histforge-spec.md:725-726`
