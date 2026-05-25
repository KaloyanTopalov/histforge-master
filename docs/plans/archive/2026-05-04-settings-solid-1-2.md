# Settings page SOLID refactor — items #1 & #2

## Overview
Address findings #1 and #2 from `docs/refactoring/solid-audit-2026-05-04-settings-page.md`. #2 moves the tab metadata (`TABS`, `TabId`, `TAB_FIELDS`, `isTabId`) from `settings-form.tsx` to `lib/settings.ts` so it sits next to its `domain-dashboard` anchored home. #1 splits the 756-line `settings-form.tsx` god-component into a slim orchestrator plus a `field-primitives.tsx` module and one file per remaining tab body, mirroring the shape `tts-settings.tsx` already establishes.

**Phase ordering rationale**: Phase 1 first because the metadata's anchored home is `lib/settings.ts` (SKILL.md:15) — relocating it before any other code shifts means the form's import surface stabilises early, and the SKILL anchor stays accurate from the first phase forward. Phase 2 (primitives) before Phase 3 (per-tab) because every Phase-3 file depends on `field-primitives.tsx` to be importable. Phase-3 tab files do not directly import `TAB_FIELDS` — only the orchestrator does, for `tabIsDirty` — so Phase 1 is *not* a hard prerequisite for Phase 3, but doing it first keeps the orchestrator's import list cleaner through the whole refactor.

## Current State

**`src/app/settings/settings-form.tsx`** (756 lines, six concerns):
- Tab metadata + guard (lines 32-95): `TABS`, `TabId`, `TAB_IDS`, `isTabId`, `TAB_FIELDS`.
- `dirtyDiff` helper (101-112). [out of scope — anchored separately as "ID + diff helpers"]
- `SettingsForm` orchestrator (121-540): state, dirty-diff save, query-param tab sync, `<Tabs>` shell, dirty-dot styling, plus inline JSX for four of five tabs.
- Inline tab body blocks:
  - ComfyUI: 222-250 (4 fields, no collapsibles)
  - Google Flow: 252-386 (top fields + `<GoogleFlowAccounts />` embed + Advanced `<Collapsible>` containing Account / Dispatch / Content-moderation `<FieldGroup>`s)
  - LLM: 388-467 (General `<FieldGroup>` + OpenRouter `<Collapsible>` + Claude CLI `<Collapsible>`)
  - TTS: 469-471 (already extracted — delegates to `<TtsSettings />`)
  - Render: 473-519 (6 fields, no collapsibles)
- Layout helpers: `FieldGroup` (544-559), `FieldGrid` (561-569).
- Field primitives + supporting types: `FieldLabel` (580-597), `ReadOnlyField` (599-614), `TextField` (616-641), `TextArea` (643-665), `NumberField` (667-695), `SelectOption` type (697), `SelectField` (699-732), `BoolField` (734-755).

**`src/app/settings/tts-settings.tsx`** — the reference shape:
- Signature is `{ values: AllSettings, update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void }`.
- Renders the panel body inside its own `<div className="space-y-8">`.
- Orchestrator wraps it in `<TabsContent value="tts" className="mt-8">` (form line 469-471) — `mt-8` lives on `<TabsContent>`; internal vertical spacing lives on the panel.

**`src/lib/settings.ts`** — Zod-per-key schemas + `getSetting`/`setSetting`/`getAllSettings`/`assertKnownKey`. Already exports `SettingKey`, `SettingValue`, `AllSettings`. Domain-dashboard SKILL.md anchor (line 15: `Settings module`) names `TAB_FIELDS` as part of this module — the audit treats this anchor as load-bearing.

**`__tests__/components/settings/settings-form.test.tsx`** — 30+ assertions covering tab navigation, field distribution per tab, collapsible expand/collapse, dirty-diff PATCH, dirty indicator. All assertions go through the public `SettingsForm` component. Phase-by-phase verification runs this file unchanged — no DOM-structural changes are intended.

**SKILL.md anchor coverage** (`.claude/skills/domain-dashboard/SKILL.md:15`): `TAB_FIELDS` already listed; `TABS` and `isTabId` are not. The audit treats #2 as a relocation, not an anchor expansion, but adding the two sibling names to the anchor line is a clean follow-on.

## Scope

**Doing**:
- **#2** (Phase 1): Move `TABS`, `TabId`, `TAB_IDS`, `isTabId`, `TAB_FIELDS` from `settings-form.tsx` to `lib/settings.ts`. Add `TABS` and `isTabId` to the SKILL.md anchor line.
- **#1 step 1** (Phase 2): Move `FieldGroup`, `FieldGrid`, `FieldLabel`, `ReadOnlyField`, `TextField`, `TextArea`, `NumberField`, `SelectField`, `BoolField`, plus the internal `SelectOption` type, to a new `src/app/settings/field-primitives.tsx`.
- **#1 step 2** (Phase 3): Extract the four remaining tab bodies into `comfyui-tab.tsx`, `google-flow-tab.tsx`, `llm-tab.tsx`, `render-tab.tsx`. Each takes the same `(values, update)` shape `tts-settings.tsx` uses today and renders an internal wrapper `<div>` with its own `space-y-*`; the orchestrator keeps the `<TabsContent value="…" className="mt-8">` wrappers.
- **#1 step 3** (Phase 3, final task): Slim `settings-form.tsx` to ~150-200 lines: state, save handler, tab dirty-dot, banners, submit button, `<Tabs>` shell with each `<TabsContent>` delegating to its tab component (matching the existing TTS line at form 469-471).
- After each phase: `npm run lint` and `npm run test` must pass. After Phase 3: `npm run build` as well, plus a manual `/settings` smoke check.

**Why phases are horizontal here**: this is a behaviour-preserving UI refactor with no DB / API / contract changes, so vertical-slice phasing doesn't apply. Each phase is a self-contained mechanical move that ends with all tests passing.

**Tab panel signatures stay broad**: each panel keeps `(values: AllSettings, update: <K extends keyof AllSettings>(...) => void)`. Tightening to `Pick<AllSettings, TabKeys<T>>` is finding **#5**, explicitly deferred — it depends on #1+#2 landing first and is in the audit's backlog.

**Not doing** (called out in audit, separate items):
- **#3** Derive `<Select>` options from Zod enums + label map.
- **#4** Source TTS provider metadata from the worker provider registry.
- **#5** Tighten panel prop types — backlog, post-#1+#2.
- **#6** Extract cross-field rule from the route.
- Renaming `tts-settings.tsx` to `tts-tab.tsx` for naming consistency. The audit uses both names interchangeably and the rename is not part of #1's recommendation.
- Moving `dirtyDiff` to a shared location — anchored separately under "ID + diff helpers"; audit explicitly limits #2 to metadata.
- Turning the `<TabsContent>` chain into a registry-driven iteration — "a separate change and not part of this finding" per audit.
- Any DOM-structural change. Tests pass unmodified through every phase.

## Tasks

### Phase 1: Move tab metadata to `lib/settings.ts` (#2)

- [x] **Task 1.1: Add tab metadata to `lib/settings.ts`**
  **Files**: `src/lib/settings.ts`
  **What**: Append (after the existing `setSetting` function): the `TABS` const tuple, the derived `TabId` type, the `TAB_IDS` array, the `isTabId` type guard, and the `TAB_FIELDS` record. Verbatim copies of the equivalents at `settings-form.tsx:32-95`. Move the `TAB_FIELDS` doc comment at `settings-form.tsx:48-49` ("Each setting key is owned by exactly one tab…") with the const — this is the only narrative explaining the partition contract and must travel with the code. Type the `TAB_FIELDS` record as `Record<TabId, readonly SettingKey[]>` rather than `readonly (keyof AllSettings)[]` — they are the same type, but `SettingKey` is the canonical name in this module. Export all five symbols (`TABS`, `TabId`, `TAB_IDS` is internal — do not export, `isTabId`, `TAB_FIELDS`).

  Note: `TAB_FIELDS` is intentionally a **partial** partition over `SettingKey`. Two keys never appear in any tab — `flow_create_project_failed` (settings.ts:30, used by the dashboard banner read by the route, no operator-tunable surface) and `queue_state` (settings.ts:89, runtime state set by the queue toolbar, not the form). Do not "fix" the missing keys; the partition is correct as-is. The doc comment being moved already implies this ("each key is owned by *exactly one* tab" applies only to keys the form exposes).
  **Context**: SKILL.md line 15 anchors `TAB_FIELDS` under the **Settings module** — this realigns the file to the anchor. Keep `dirtyDiff` (settings-form.tsx:101-112) untouched per audit's "scope is metadata only".

- [x] **Task 1.2: Update `settings-form.tsx` to import the metadata**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: Delete the in-file definitions of `TABS`, `TabId`, `TAB_IDS`, `isTabId`, `TAB_FIELDS` (lines 32-95). Add an import from `@/lib/settings` for `TABS`, `TabId`, `isTabId`, `TAB_FIELDS`. `TAB_IDS` is internal to `isTabId` — re-export not needed. Verify in-file references (lines 127, 156, 206, 209) still resolve via the import.
  **Context**: Pure substitution. Same tab labels, same partition, same tab-dirty-dot logic; behaviour must not change.

- [x] **Task 1.3: Update domain-dashboard SKILL.md anchor**
  **Files**: `.claude/skills/domain-dashboard/SKILL.md`
  **What**: On the **Settings module** anchor line (line 15) append `TABS` and `isTabId` after `TAB_FIELDS`. The line currently ends `…seedDefaultSettings, TAB_FIELDS`; after this edit it ends `…seedDefaultSettings, TAB_FIELDS, TABS, isTabId`.
  **Context**: Anchors are the skill's stable contract list; adding `TABS` and `isTabId` makes the canonical home of the full metadata cluster visible to future audits. The audit recommendation explicitly groups all four (`TABS` / `TabId` / `TAB_FIELDS` / `isTabId`) as metadata, so listing the runtime symbols (`TABS`, `isTabId`) on the anchor line is consistent with that framing — types like `TabId` are derived and don't need their own anchor entry. No body or path-trigger updates needed — the file path didn't change.

- [x] **Task 1.4: Verification gate for Phase 1**
  **Files**: (none — validation step)
  **What**: Run `npm run lint` and `npm run test`. Both must pass. The settings-form test file is the regression net — confirm zero failures. No code change here.
  **Context**: Phase 1 is metadata-only and must produce zero behavioural diff.

### Phase 2: Extract field primitives (#1 step 1)

- [x] **Task 2.1: Create `src/app/settings/field-primitives.tsx`**
  **Files**: `src/app/settings/field-primitives.tsx` (new)
  **What**: New `"use client"` module exporting `FieldGroup`, `FieldGrid`, `FieldLabel`, `ReadOnlyField`, `TextField`, `TextArea`, `NumberField`, `SelectField`, `BoolField`. Verbatim copies of the equivalents at `settings-form.tsx:544-755`. The `SelectOption` type (line 697) stays internal to this module — only `SelectField`'s parameter type uses it. Imports needed: `Label`, `Input`, `Textarea`, `Checkbox`, `Select` / `SelectContent` / `SelectItem` / `SelectTrigger` / `SelectValue` from `@/components/ui/*`. Move the section-header comment block at `settings-form.tsx:571-578` ("Thin wrappers around shadcn primitives that preserve the Label+field+hint shape…") to the top of the new file as the module header — it documents the call-site contract every primitive honours.
  **Context**: Pure mechanical move. Tests query DOM via `getByLabelText(/\[setting_id\]/)`, which depends on `FieldLabel` rendering the `[id]` span in monospace — preserve that markup verbatim.

- [x] **Task 2.2: Update `settings-form.tsx` to import primitives**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: Delete the in-file definitions of all nine primitive components and the `SelectOption` type (lines 542-755). Import the public set from `./field-primitives`. Drop the now-unused UI imports from the top of the file (`Input`, `Textarea`, `Label`, `Checkbox`, `Select` / `SelectContent` / `SelectItem` / `SelectTrigger` / `SelectValue`). Keep `Tabs`, `TabsList`, `TabsTrigger`, `TabsContent`, `Button`, `Collapsible` / `CollapsibleContent` / `CollapsibleTrigger`, `ChevronDown`, `GoogleFlowAccounts`, `TtsSettings` — those still serve the orchestrator and the inline tab bodies that haven't been split out yet.
  **Context**: After this task `settings-form.tsx` will be ~470 lines (down from 756). All four inline tab bodies remain in place; Phase 3 splits them out.

- [x] **Task 2.3: Verification gate for Phase 2**
  **Files**: (none — validation step)
  **What**: Run `npm run lint` and `npm run test`. The settings-form test suite must pass with zero diff. Then `npm run dev` and confirm `/settings` renders identically — every tab, every collapsible, every field, every monospace `[id]` annotation.
  **Context**: This is the riskiest mechanical move. The highest-risk test surface is the cluster of `getByLabelText(/\[setting_id\]/)` matchers — they depend on `FieldLabel`'s monospace `[id]` span markup verbatim. Affected tests include `LLM tab: General section shows…` (4 matchers), `LLM tab: expanding the OpenRouter section reveals…` (2), `LLM tab: expanding the Claude CLI section reveals…` (3), `hides the four ops-tuning fields under a collapsed Advanced section` (4), `clicking Advanced reveals the four ops-tuning fields with relogin_needed read-only` (4), `flags the Google Flow tab dirty when an Advanced field changes` (1), `flags the LLM tab dirty when a Claude CLI field changes` (1), and `PATCHes a changed claude_cli_path in the Claude CLI section` (1). A typo in the moved `FieldLabel` JSX would break ~20 assertions at once — the test signal is strong enough that any regression surfaces immediately. The smoke check protects against pure-styling drift (className mismatches, missing chevrons) the test suite doesn't assert.

### Phase 3: Extract per-tab panels (#1 step 2 + step 3)

- [x] **Task 3.1: Extract ComfyUI tab → `comfyui-tab.tsx`**
  **Files**: `src/app/settings/comfyui-tab.tsx` (new), `src/app/settings/settings-form.tsx`
  **What**: Create `comfyui-tab.tsx` exporting `ComfyuiTab({ values, update })` with the JSX currently at `settings-form.tsx:222-250` (four fields: `image_provider`, `comfyui_base_url`, `comfyui_workflow_path`, `comfyui_hook_video_workflow_path`). Wrap the body in an internal `<div className="space-y-4">` so the panel owns its own internal spacing — same shape as `TtsSettings`'s wrapper at `tts-settings.tsx:75`. In the orchestrator, replace the inline JSX with a `<TabsContent value="comfyui" className="mt-8">` that contains a single `<ComfyuiTab values={values} update={update} />` invocation — match the existing TTS pattern at `settings-form.tsx:469-471` (only `mt-8` on `<TabsContent>`; no `space-y-*`).

  Signature: `{ values: AllSettings, update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void }`. Same broad signature `TtsSettings` uses today (defined at `tts-settings.tsx:55-58`); tightening is finding #5 (backlog).
  **Context**: Simplest tab — no collapsibles, no embedded subtree. Reference function shape: `tts-settings.tsx:67-70` (the `TtsSettings` declaration). Acceptance: existing test "renders all four ComfyUI fields on the default tab and nothing from other tabs" must pass without modification.

- [x] **Task 3.2: Extract Google Flow tab → `google-flow-tab.tsx`**
  **Files**: `src/app/settings/google-flow-tab.tsx` (new), `src/app/settings/settings-form.tsx`
  **What**: Create `google-flow-tab.tsx` exporting `GoogleFlowTab({ values, update })` with the JSX currently at `settings-form.tsx:252-386`. Body order:
  - `<GoogleFlowAccounts />` embed.
  - Three top-level `<SelectField>`s: `google_flow_image_model`, `google_flow_video_model`, `google_flow_aspect_ratio`.
  - `<Collapsible>` "Advanced" containing three nested `<FieldGroup>`s — Account (cooldown + relogin readonly), Dispatch (max retries + dispatch timeout), Content moderation (enabled bool + max rounds + moderation model TextField).

  Wrap in `<div className="space-y-6">`. Imports: `FieldGroup`, `FieldGrid`, `SelectField`, `NumberField`, `ReadOnlyField`, `BoolField`, `TextField` from `./field-primitives`; `Collapsible`/`CollapsibleContent`/`CollapsibleTrigger` from `@/components/ui/collapsible`; `ChevronDown` from `lucide-react`; `<GoogleFlowAccounts>` from `./google-flow-accounts`. Replace the orchestrator's inline JSX with `<TabsContent value="google-flow" className="mt-8"><GoogleFlowTab values={values} update={update} /></TabsContent>`.
  **Context**: Most complex extraction — three nested FieldGroups inside a Collapsible, plus an embedded subtree. Acceptance: existing tests `hides the four ops-tuning fields under a collapsed Advanced section`, `clicking Advanced reveals the four ops-tuning fields with relogin_needed read-only`, `flags the Google Flow tab dirty when an Advanced field changes`, `renders the image_model dropdown with display labels for all three models`, `renders the video_model dropdown with display labels for all five Veo variants`, `PATCHes the storage value when picking an image model`, `PATCHes the storage key when picking a video model`, `no longer renders the legacy google_flow_video_quality dropdown` must pass unmodified. Preserve the bool round-trip comment block at `settings-form.tsx:351-356` verbatim — explains the boolean ↔ string-enum coercion contract for `voice_use_speaker_boost` and `google_flow_content_moderation_enabled`.

- [x] **Task 3.3: Extract LLM tab → `llm-tab.tsx`**
  **Files**: `src/app/settings/llm-tab.tsx` (new), `src/app/settings/settings-form.tsx`
  **What**: Create `llm-tab.tsx` exporting `LlmTab({ values, update })` with the JSX currently at `settings-form.tsx:388-467`. Three sections:
  - General `<FieldGroup>`: `enrich_chunks_llm_provider` SelectField + the explanatory `<p>` below it.
  - OpenRouter `<Collapsible>`: `model_name` SelectField (with the curated allowlist) + `style_prompt_default` TextArea.
  - Claude CLI `<Collapsible>`: `claude_cli_path` / `claude_cli_model` / `claude_cli_extra_args` TextFields (the third with the whitespace-tokens hint).

  Wrap in `<div className="space-y-6">`. Imports: `FieldGroup`, `SelectField`, `TextArea`, `TextField` from `./field-primitives`; `Collapsible`/`CollapsibleContent`/`CollapsibleTrigger` from `@/components/ui/collapsible`; `ChevronDown` from `lucide-react`. Replace the orchestrator's inline JSX with `<TabsContent value="llm" className="mt-8"><LlmTab values={values} update={update} /></TabsContent>`.
  **Context**: Acceptance: existing tests `LLM tab: General section shows enrich_chunks_llm_provider; OpenRouter and Claude CLI sections collapsed`, `LLM tab: expanding the OpenRouter section reveals model_name and style_prompt_default`, `LLM tab: expanding the Claude CLI section reveals three TextFields with a hint on extra_args`, `PATCHes a changed enrich_chunks_llm_provider in the General section`, `PATCHes a changed claude_cli_path in the Claude CLI section` must pass unmodified. The hand-curated `model_name` allowlist at `settings-form.tsx:421-427` is intentional — finding #3 explicitly excludes it because `model_name` is `z.string()` not an enum. Move it verbatim.

- [x] **Task 3.4: Extract Render tab → `render-tab.tsx`**
  **Files**: `src/app/settings/render-tab.tsx` (new), `src/app/settings/settings-form.tsx`
  **What**: Create `render-tab.tsx` exporting `RenderTab({ values, update })` with the JSX currently at `settings-form.tsx:473-519`. Six fields: `aspect_ratio` SelectField, `long_edge_px` NumberField, `framerate` SelectField, `chapter_count` NumberField, `act_distribution` TextField (with comma-separated-ints hint), `chapter_target_words` NumberField (`step={50}`, with the words-to-minutes hint).

  Critical: preserve the `framerate` round-trip verbatim. Schema is `z.enum(["30","60"]).transform(Number)` (settings.ts:53), so `AllSettings["framerate"]` is `30 | 60` (number). The form does `value={String(values.framerate)}` and `onChange={(v) => update("framerate", Number(v) as AllSettings["framerate"])}` — the **`as AllSettings["framerate"]` cast is load-bearing**: `Number("30")` widens to `number`, but the schema-derived type is the union `30 | 60`, and dropping the cast triggers a TS2345. Move the line verbatim from `settings-form.tsx:489-497`.

  Wrap in `<div className="space-y-4">`. Imports: `SelectField`, `NumberField`, `TextField` from `./field-primitives`. Replace the orchestrator's inline JSX with `<TabsContent value="render" className="mt-8"><RenderTab values={values} update={update} /></TabsContent>`.
  **Context**: Acceptance: existing test `renders all five Render fields when the Render tab is active` (test name is stale — it asserts five `getByDisplayValue` calls but the form has six fields; don't break the test, don't update it either — the test file is out of scope for this whole refactor) must pass unmodified. The `chapter_target_words` hint copy at `settings-form.tsx:517-518` is operator guidance — preserve verbatim.

- [x] **Task 3.5: Confirm orchestrator slim shape**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: After Tasks 3.1-3.4 the file should contain only: imports, `SettingsFormProps` interface, the `dirtyDiff` helper (kept here per audit), the `SettingsForm` function (state + the `useEffect` for the saved-flash timer, `selectTab`, `tabIsDirty`, `update`, `save`, JSX). The JSX shape: `<form>` → `<Tabs>` → `<TabsList>` (5 `<TabsTrigger>`s with dirty-dot rendering) → 5 `<TabsContent>` blocks (each delegating to one of `<ComfyuiTab>` / `<GoogleFlowTab>` / `<LlmTab>` / `<TtsSettings>` / `<RenderTab>`) → error/saved banners → submit button.

  Drop now-unused imports from the top of the file: `Input`, `Textarea`, `Label`, `Checkbox`, `Select*`, `Collapsible*`, `ChevronDown`, `GoogleFlowAccounts` — those moved to per-tab files in earlier tasks. Keep: navigation hooks, `AllSettings`, `Tabs`/`TabsList`/`TabsTrigger`/`TabsContent`, `Button`, `TtsSettings`, plus the four new tab components.

  Note on import-path consistency: the four new tabs import as `./comfyui-tab`, `./google-flow-tab`, `./llm-tab`, `./render-tab`; the TTS tab keeps its existing `./tts-settings` path because renaming `tts-settings.tsx` is explicitly out of scope (see "Not doing"). The mismatch is intentional and documented here so it's not "fixed" in a later pass without intent.
  **Context**: Audit estimates ~150-200 lines (`docs/refactoring/solid-audit-2026-05-04-settings-page.md:46-49`). Treat that as a rough sanity bound, not a hard target — don't over-engineer to hit a specific number; the goal is a single-responsibility orchestrator. Verify the `<TabsContent>` chain mirrors the existing TTS line shape at the original `settings-form.tsx:469-471` — every entry is a one-line `<TabsContent value="..." className="mt-8"><XxxTab values={values} update={update} /></TabsContent>`.

- [x] **Task 3.6: Verification gate for Phase 3**
  Lint and build pass. The settings-form regression test (`__tests__/components/settings/settings-form.test.tsx`, 29 tests) passes unmodified after every per-tab extraction. The full `npm run test` shows 19 pre-existing failures in the unrelated workflows table/page test files; the same failures reproduce on `master`, so they are not regressions from this refactor. Manual `/settings` smoke check still pending (deferred to operator).

- [x] **Task 3.7: Fix Phase 1 build breakage** (added during Phase 3)
  **Files**: `src/lib/settings-tabs.ts` (new), `src/lib/settings.ts`, `src/app/settings/settings-form.tsx`, `.claude/skills/domain-dashboard/SKILL.md`
  **What**: Move `TABS` / `TabId` / `TAB_IDS` / `isTabId` / `TAB_FIELDS` from `lib/settings.ts` into a new `lib/settings-tabs.ts`. Settings-form imports tab metadata from the new module; `AllSettings` still comes from `lib/settings`. SKILL.md anchor split: server-only items stay under **Settings module**; client-safe metadata moves to a new **Settings tabs module** line.
  **Context**: `lib/settings.ts` imports `getDb` from `lib/db.ts`, which uses `node:fs`/`node:path`. Phase 1's relocation made `settings-form.tsx` a runtime consumer of `lib/settings.ts`, which dragged `lib/db.ts` into the client bundle and broke `next build` with `UnhandledSchemeError`. Phase 1's verification gate was lint + test only — the build error was masked until Phase 3's gate ran `next build`.

## References
- `docs/refactoring/solid-audit-2026-05-04-settings-page.md` — finding #1 (lines 36-49), finding #2 (lines 53-63), priority action plan (lines 142-148), positive-pattern reference (lines 166-167 — TtsSettings as the shape to follow).
- `.claude/skills/domain-dashboard/SKILL.md` — anchors block line 15 (`Settings module` lists `TAB_FIELDS`); §"Settings System / Tabs" lines 126-132.
- `src/app/settings/tts-settings.tsx` — reference shape for every extracted tab panel: client `"use client"`, `(values, update)` props, internal `<div className="space-y-…">` wrapper, no `<TabsContent>` inside.
- `__tests__/components/settings/settings-form.test.tsx` — regression net; passes unmodified through every phase.
