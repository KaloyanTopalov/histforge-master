# Settings page SOLID refactor — items #3 & #4

## Overview
Address findings #3 and #4 from `docs/refactoring/solid-audit-2026-05-04-settings-page.md`. #3 closes the silent drift surface between the form's hand-maintained `<Select>` option lists and the `lib/settings.ts` Zod `z.enum` members, by introducing a single source of truth for both the allowed values and their operator-friendly labels. #4 closes the parallel `PROVIDERS` catalogue in `tts-settings.tsx` by sourcing the TTS provider's operator-facing metadata (`label`, `envKey`, `endpoint`) from a sibling registry that the worker `ai33`/`genaipro` providers also consume — so the env-var name is one source of truth.

**Phase ordering rationale**: Phase 1 (#3) lands first because it introduces `lib/settings-enums.ts` — the home of `TTS_PROVIDERS = ["genaipro", "ai33"] as const`. Phase 2 (#4) imports `TTS_PROVIDERS` and the derived `TtsProviderId` from there to type the new `TTS_PROVIDER_META` registry, so #4 cleanly consumes #3's output. The audit itself sequences them this way: "Pair with #3 so the `id` list also derives from the schema" (audit line 148).

## Current State

**`src/app/settings/comfyui-tab.tsx`** — `image_provider` `<SelectField>` with hand-maintained `options={["comfyui"]}` (line 18). Single-value enum today; still needs to converge for OCP consistency when a second image provider lands.

**`src/app/settings/google-flow-tab.tsx`** — three hand-maintained option arrays (lines 37-65, 73-83):
- `google_flow_image_model`: `[{label: "Nano Banana 2", value: "NARWHAL"}, {label: "Nano Banana Pro", value: "GEM_PIX_2"}, {label: "Imagen 4", value: "IMAGEN_3_5"}]`
- `google_flow_video_model`: 5 entries with labels like `"Veo 3.1 - Lite [Lower Priority]"`
- `google_flow_aspect_ratio`: `["landscape", "portrait"]` (no label override)

**`src/app/settings/llm-tab.tsx`** — `enrich_chunks_llm_provider` options (lines 30-33): `[{label: "OpenRouter", value: "openrouter"}, {label: "Claude CLI", value: "claude_cli"}]`. The `model_name` `<Select>` (lines 57-62) is **out of scope** per audit line 84 — `model_name` is `z.string()`, not an enum, and the curated allowlist is intentionally disconnected from the schema.

**`src/app/settings/render-tab.tsx`** — two hand-maintained option arrays:
- `aspect_ratio`: `["16:9", "9:16", "1:1", "4:5"]` (line 18)
- `framerate`: `["30", "60"]` (line 33). Critical: `framerate` round-trip uses `value={String(values.framerate)}` and `onChange={(v) => update("framerate", Number(v) as AllSettings["framerate"])}` — the storage form is "30"/"60" but the type is `30 | 60` (number), because the schema is `z.enum(["30","60"]).transform(Number)`.

**`src/app/settings/tts-settings.tsx`** — two surfaces hit by these findings:
1. `voiceover_model_id` inline `<Select>` (lines 98-126) with four hand-maintained `<SelectItem value="eleven_…">` entries — uses inline `Select`/`SelectContent`/`SelectItem` primitives (not `SelectField`) because the TTS panel uses its own `FieldShell` styling, not `field-primitives.FieldLabel`.
2. `PROVIDERS` array (lines 38-53) — the `tts_provider` catalogue duplicating both the enum and the worker registry. Fields per entry: `id`, `label`, `tagline`, `envKey`, `endpoint`. Used by:
   - `ProviderSwitch` (line 225) for the radio group order
   - `ActiveProviderBanner` (lines 307-362) for label/envKey/endpoint display
   - `TtsSettings` itself (line 71-72) for the active-provider lookup

**`src/lib/settings.ts`** — Zod-per-key schemas. Enum-typed Select-rendered keys (audit list, line 71-81):
- `image_provider: z.enum(["comfyui"])` (line 15)
- `google_flow_image_model: z.enum(["NARWHAL", "GEM_PIX_2", "IMAGEN_3_5"])` (line 33)
- `google_flow_video_model: z.enum([5 veo variants])` (lines 34-40)
- `google_flow_aspect_ratio: z.enum(["landscape", "portrait"])` (line 41)
- `aspect_ratio: z.enum(["16:9", "9:16", "1:1", "4:5"])` (line 51)
- `framerate: z.enum(["30","60"]).transform(Number)` (line 53) — the only transform-wrapped enum in scope
- `voiceover_model_id: z.enum([4 eleven model ids])` (lines 76-81)
- `tts_provider: z.enum(["ai33", "genaipro"])` (line 70)
- `enrich_chunks_llm_provider: z.enum(["openrouter", "claude_cli"])` (line 71)

Boolean enums (`["true","false"]`) like `voice_use_speaker_boost`, `google_flow_relogin_needed`, `google_flow_content_moderation_enabled` and the runtime-state `queue_state` enum are **out of scope** — they render as checkboxes / aren't form-exposed, not `<Select>`s.

**`src/lib/settings-tabs.ts`** — already a client-safe sibling to `lib/settings.ts` (no `db` import); existing precedent for splitting client-safe metadata out of `lib/settings.ts`. Phase 1's new `settings-enums.ts` follows the same pattern.

**`src/lib/tts/index.ts`** — registers `ai33Provider` and `genaiproProvider` (line 7-10). The `TtsProvider` interface in `types.ts` is `{ synthesize }` only — no metadata field today.

**`src/lib/tts/ai33.ts`** — hardcodes `BASE_URL = "https://api.ai33.pro/v1"` (line 27); reads `process.env.AI33_API_KEY` (line 317); error message `"AI33_API_KEY is not set..."` (line 319).

**`src/lib/tts/genaipro.ts`** — hardcodes `BASE_URL = "https://genaipro.vn/api"` (line 27); reads `process.env.GENAIPRO_API_KEY` (line 412); error message `"GENAIPRO_API_KEY is not set..."` (line 414).

**Test surfaces** (regression nets — pass unmodified through every phase):
- `__tests__/components/settings/settings-form.test.tsx`:
  - Lines 296-299 — `tts_provider` radios match `name: /AI33/i` and `name: /GenAIPro/i` (Phase 2 must preserve labels).
  - Line 302 — `getByDisplayValue("eleven_multilingual_v2")` (Phase 1 voiceover_model_id rendering).
  - Lines 327-385 — Google Flow image/video model dropdown tests assert `name: /Nano Banana 2/`, `/Nano Banana Pro/`, `/Imagen 4/`, the five Veo labels.
  - Lines 387-409 — picking "Nano Banana Pro" PATCHes `{google_flow_image_model: "GEM_PIX_2"}` (storage value, not label — Phase 1 must preserve the value/label split).
  - Lines 559-569 — picking "Claude CLI" in `enrich_chunks_llm_provider` PATCHes `{enrich_chunks_llm_provider: "claude_cli"}`.
- `__tests__/unit/lib/tts/ai33.test.ts` line 237 and `genaipro.test.ts` line 241 — the missing-API-key error message must still match `/AI33_API_KEY/` and `/GENAIPRO_API_KEY/` regexes after Phase 2's envKey change. Derived error message `\`${envKey} is not set...\`` still matches.

**SKILL.md anchors** (`.claude/skills/domain-dashboard/SKILL.md` line 16) — `Settings tabs module` line currently lists `TABS, TabId, isTabId, TAB_FIELDS`. Phase 1 adds a sibling `Settings enums module` line for `enumOptions`, `EnumSettingKey`, and the named const arrays.

## Scope

**Doing**:
- **Phase 1 (#3)**: Introduce `src/lib/settings-enums.ts` (client-safe — no `getDb` / node imports) holding `as const` arrays for the nine enum-typed Select-rendered setting keys, plus an operator-friendly `SETTING_OPTION_LABELS` map for the three keys that need pretty labels (`google_flow_image_model`, `google_flow_video_model`, `enrich_chunks_llm_provider`), plus an `enumOptions(key)` helper returning `ReadonlyArray<{value: string, label: string}>` (label defaults to value when no override). Update `lib/settings.ts` so the existing `z.enum([...])` calls reference the new const arrays — same allowed values, same parse behaviour. Convert each tab file to consume `enumOptions(key)` instead of hand-maintained option arrays. Update SKILL.md anchor.
- **Phase 2 (#4)**: Introduce `src/lib/tts/meta.ts` (client-safe — no node imports) exporting `TTS_PROVIDER_META: Record<TtsProviderId, { label, envKey, endpoint }>` and a `getTtsProviderMeta(id)` helper, with `TtsProviderId` derived from `TTS_PROVIDERS` in `settings-enums.ts`. Drop the in-file `PROVIDERS` array in `tts-settings.tsx`; consume meta + a local `TAGLINES: Record<TtsProviderId, string>` map (taglines stay UI-only per audit line 102). Update `ai33.ts` and `genaipro.ts` to derive their env-var name and the missing-key error message from `TTS_PROVIDER_META[…].envKey` — closes the load-bearing drift surface. `BASE_URL` constants stay put (cosmetic-only `endpoint` is informational; the audit's high-priority drift is `envKey`).
- After each phase: `npm run lint`, `npm run test`, and `npm run build` must pass. `npm run build` runs at every phase gate because both phases introduce a new client-safe module (`settings-enums.ts`, `tts/meta.ts`); a stray `getDb` / `node:fs` import would surface only at build time, the same failure mode that bit the prior plan's Phase 1 gate (see prior plan Task 3.7). After Phase 2: a manual `/settings` smoke check (TTS tab provider switch + active-provider banner).

**Why phases are horizontal here**: this is a behaviour-preserving DRY refactor with no DB / API / contract changes, so vertical-slice phasing doesn't apply. Each phase is a self-contained move that ends with all tests passing.

**Tab-file granularity**: within Phase 1, each tab file is converted in its own task (1.3-1.7) so a casting issue in one place doesn't ripple. Per-tab tasks are independently testable through `settings-form.test.tsx`.

**Not doing** (called out explicitly):
- **#5** Tighten panel prop types to `Pick<AllSettings, TabKeys<T>>` — backlog, separate plan.
- **#6** Extract cross-field rule from the route — leave inline; revisit only if a second rule appears.
- The OpenRouter `model_name` `<Select>` allowlist — out of scope per audit line 84 (`model_name` is `z.string()`, not an enum).
- Boolean `z.enum(["true","false"]).transform(...)` keys — those render as checkboxes, not Selects. Out of scope per audit's "z.enum-typed keys only" framing (line 86).
- Standardising the worker's `BASE_URL` (with protocol) onto `meta.endpoint` (no protocol). The audit calls out `envKey` as the load-bearing drift — `endpoint` is cosmetic. Keeping `BASE_URL` literals in `ai33.ts` / `genaipro.ts` minimizes Phase 2 scope. (Listed here so a future "fully DRY the URL too" change is a deliberate decision, not an oversight.)
- Adding a `meta` field to the `TtsProvider` interface in `lib/tts/types.ts`. Approach A (sibling `meta.ts` module) is preferred over Approach B (interface field) because `lib/tts/index.ts` imports the providers, which import `node:fs` — a `meta` field on the interface would still couple the client bundle to those imports unless we restructured the registry. Sibling module avoids the restructure.
- Renaming `tts-settings.tsx` to `tts-tab.tsx` for naming consistency — out of scope from the prior plan and unchanged here.
- Any DOM-structural change. Tests pass unmodified through every phase.

## Tasks

### Phase 1: Introduce `lib/settings-enums.ts` and converge tabs (#3)

- [x] **Task 1.1: Create `src/lib/settings-enums.ts`**
  **Files**: `src/lib/settings-enums.ts` (new)
  **What**: New client-safe module (no `getDb` / `node:` imports — must be importable from client components without dragging `lib/db.ts` into the bundle). Export named `as const` arrays for the nine enum-typed Select-rendered keys:
  - `IMAGE_PROVIDERS = ["comfyui"] as const`
  - `GOOGLE_FLOW_IMAGE_MODELS = ["NARWHAL", "GEM_PIX_2", "IMAGEN_3_5"] as const`
  - `GOOGLE_FLOW_VIDEO_MODELS = ["veo_3_1_t2v_lite", "veo_3_1_t2v_fast_ultra", "veo_3_1_t2v", "veo_3_1_t2v_lite_low_priority", "veo_3_1_t2v_fast_ultra_relaxed"] as const`
  - `GOOGLE_FLOW_ASPECT_RATIOS = ["landscape", "portrait"] as const`
  - `VOICEOVER_MODEL_IDS = ["eleven_multilingual_v2", "eleven_turbo_v2_5", "eleven_flash_v2_5", "eleven_v3"] as const`
  - `ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:5"] as const`
  - `FRAMERATES = ["30", "60"] as const`
  - `ENRICH_CHUNKS_LLM_PROVIDERS = ["openrouter", "claude_cli"] as const`
  - `TTS_PROVIDERS = ["genaipro", "ai33"] as const` — order is the visual order on the TTS tab (GenAIPro first, AI33 second). Phase 2 Task 2.2 maps over this array directly, so the source-of-truth order matches the rendered order without an inline reverse. `tts_provider`'s Zod parse behaviour is unaffected by member order; both orderings accept the same string set.

  Define `EnumSettingKey` as the union of those nine `SettingKey` literals (import `SettingKey` via `import type` from `./settings` to stay client-safe). Define `SETTING_OPTION_LABELS: Partial<Record<EnumSettingKey, Record<string, string>>>` (outer `Partial` because only three of the nine keys carry overrides) populated only for the three keys with operator-friendly labels:
  - `google_flow_image_model`: `{NARWHAL: "Nano Banana 2", GEM_PIX_2: "Nano Banana Pro", IMAGEN_3_5: "Imagen 4"}`
  - `google_flow_video_model`: `{veo_3_1_t2v_lite: "Veo 3.1 - Lite", veo_3_1_t2v_fast_ultra: "Veo 3.1 - Fast", veo_3_1_t2v: "Veo 3.1 - Quality", veo_3_1_t2v_lite_low_priority: "Veo 3.1 - Lite [Lower Priority]", veo_3_1_t2v_fast_ultra_relaxed: "Veo 3.1 - Fast [Lower Priority]"}`
  - `enrich_chunks_llm_provider`: `{openrouter: "OpenRouter", claude_cli: "Claude CLI"}`

  Export `enumOptions(key: EnumSettingKey): ReadonlyArray<{value: string, label: string}>` returning the matching const array mapped through the label map (label falls back to value when no override). Internally `enumOptions` switches on `key` to pick the right const array — no separate `ENUM_VALUES` aggregate needed; the named consts are imported directly by both `enumOptions` (within the same file) and `lib/settings.ts` (for `z.enum(...)`).

  Naming: helper is `enumOptions` (matches audit line 86). Verbatim copy of the operator-friendly labels currently in the per-tab files — preserve casing, punctuation, and bracket style on the Veo labels (e.g. `"Veo 3.1 - Fast [Lower Priority]"`, not `"Veo 3.1 — Fast [Lower priority]"`).
  **Context**: Sibling module pattern mirrors `lib/settings-tabs.ts` (already client-safe — see line 1, only imports `SettingKey` as a type). The framerate const must be string `"30"` / `"60"` even though the schema is `z.enum([...]).transform(Number)` — the *storage* form is what `<Select>` renders and what the schema parses. The numeric type only emerges after the transform on read; on write the form converts back via `Number(v) as AllSettings["framerate"]` (see render-tab.tsx:35).

- [x] **Task 1.2: Wire `lib/settings.ts` to consume the const arrays**
  **Files**: `src/lib/settings.ts`
  **What**: Replace each in-line `z.enum([literal, …])` for the nine Select-rendered enum keys with a reference to the corresponding const array exported from `./settings-enums`. Concretely: `image_provider: z.enum(IMAGE_PROVIDERS)`, etc. If TypeScript balks at the `readonly [string, ...string[]]` mismatch, use `z.enum(GOOGLE_FLOW_IMAGE_MODELS as unknown as [string, ...string[]])` — the cast is unavoidable given Zod's `[string, ...string[]]` requirement vs. `as const`'s `readonly` tuple; the runtime values are identical and the compile-time narrowing on `SettingValue<K>` is preserved because the input tuple's literal types still propagate. Verify by spot-checking `SettingValue<"google_flow_image_model">` infers to `"NARWHAL" | "GEM_PIX_2" | "IMAGEN_3_5"` (same as today). Keep `framerate`'s `.transform(Number)` chain intact — only the enum tuple changes.

  The boolean `z.enum(["true","false"])` keys (`voice_use_speaker_boost`, `google_flow_relogin_needed`, `google_flow_content_moderation_enabled`) and the `queue_state: z.enum(["running","paused"])` runtime-state key are **left untouched** — they're not Select-rendered and out of #3's scope.
  **Context**: Pure refactor — same allowed values, same Zod parse output, same `AllSettings` type. The settings-form test (`__tests__/components/settings/settings-form.test.tsx`) is the regression net for the form-side; `__tests__/unit/lib/settings.test.ts` is the regression net for the schema parse round-trip. Both must pass unmodified.

- [x] **Task 1.3: Converge `comfyui-tab.tsx` on `enumOptions`**
  **Files**: `src/app/settings/comfyui-tab.tsx`
  **What**: Replace the `options={["comfyui"]}` literal at line 18 with `options={enumOptions("image_provider")}`. Add an import: `import { enumOptions } from "@/lib/settings-enums"`. Single-value enum today, but converging here keeps the OCP recipe consistent across the four tab files for when a second image provider lands.
  **Context**: `<SelectField>` already accepts `string | {label, value}` options — `enumOptions` returns the latter shape, no API change. The settings-form test (lines 208-230, "renders all four ComfyUI fields…") must pass unmodified — `getByDisplayValue("comfyui")` still resolves because the trigger renders the value.

- [x] **Task 1.4: Converge `google-flow-tab.tsx` on `enumOptions` for the three Selects**
  **Files**: `src/app/settings/google-flow-tab.tsx`
  **What**: Replace the three hand-maintained option arrays (lines 37-65 and 73-83) with `options={enumOptions("google_flow_image_model")}`, `options={enumOptions("google_flow_video_model")}`, `options={enumOptions("google_flow_aspect_ratio")}`. Add the `enumOptions` import from `@/lib/settings-enums`. Verify the resulting label strings match exactly: "Nano Banana 2", "Nano Banana Pro", "Imagen 4", and the five Veo labels including the bracketed "[Lower Priority]" annotations.
  **Context**: This is the highest-test-density task. Acceptance: existing tests must pass unmodified —
  - "renders the image_model dropdown with display labels for all three models" (matches `name: /Nano Banana 2/`, `/Nano Banana Pro/`, `/Imagen 4/`)
  - "renders the video_model dropdown with display labels for all five Veo variants" (matches `name: /^Veo 3\.1 - Lite$/`, `/^Veo 3\.1 - Fast$/`, etc., including `/^Veo 3\.1 - Lite \[Lower Priority\]$/`)
  - "PATCHes the storage value (not the display label) when picking an image model" (storage form `"GEM_PIX_2"` survives the round-trip)
  - "PATCHes the storage key when picking a video model"

  A label typo would break ~10 assertions at once — strong test signal. The storage-value PATCH tests are the load-bearing guarantee that `enumOptions` returns `{value: storageValue, label: prettyLabel}` and not the inverse.

- [x] **Task 1.5: Converge `llm-tab.tsx` on `enumOptions` for `enrich_chunks_llm_provider`**
  **Files**: `src/app/settings/llm-tab.tsx`
  **What**: Replace the `options={[{label:"OpenRouter",value:"openrouter"},{label:"Claude CLI",value:"claude_cli"}]}` array at lines 30-33 with `options={enumOptions("enrich_chunks_llm_provider")}`. Add the `enumOptions` import. Leave `model_name` (lines 57-62) untouched — out of scope per audit line 84.
  **Context**: Acceptance: tests "PATCHes a changed enrich_chunks_llm_provider in the General section" (line 559-569 — picks "Claude CLI" by label, asserts PATCH body `{enrich_chunks_llm_provider: "claude_cli"}` by storage value) and "LLM tab: General section shows enrich_chunks_llm_provider" must pass unmodified.

- [x] **Task 1.6: Converge `render-tab.tsx` on `enumOptions` for `aspect_ratio` and `framerate`**
  **Files**: `src/app/settings/render-tab.tsx`
  **What**: Replace `options={["16:9", "9:16", "1:1", "4:5"]}` (line 18) with `options={enumOptions("aspect_ratio")}`, and `options={["30", "60"]}` (line 33) with `options={enumOptions("framerate")}`. Add the `enumOptions` import. Critical: do **not** touch the `framerate` round-trip glue (`value={String(values.framerate)}` and `onChange={(v) => update("framerate", Number(v) as AllSettings["framerate"])}`) — the transform-based number/string boundary is unrelated to the option list and must stay verbatim. The `as AllSettings["framerate"]` cast is load-bearing (see prior plan task 3.4 for the rationale).
  **Context**: Acceptance: test "renders all five Render fields when the Render tab is active" (test line 316-325, asserts `getByDisplayValue("16:9")` and `getByDisplayValue("30")`) must pass unmodified.

- [x] **Task 1.7: Converge `tts-settings.tsx` voiceover_model_id Select on `enumOptions`**
  **Files**: `src/app/settings/tts-settings.tsx`
  **What**: Replace the four inline `<SelectItem value="eleven_*">` entries (lines 113-124) with `{enumOptions("voiceover_model_id").map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}`. Add the `enumOptions` import. Keep the surrounding `<Select>` / `<SelectTrigger>` / `<SelectContent>` shell — this panel's custom `FieldShell` styling differs from `field-primitives.SelectField` and converting wholesale is out of scope.

  The `tts_provider` `PROVIDERS` array stays untouched in this task — it's the subject of **Phase 2 (#4)**. Phase 1 only addresses the `voiceover_model_id` Select on the TTS tab.
  **Context**: `enumOptions("voiceover_model_id")` returns `[{value: "eleven_multilingual_v2", label: "eleven_multilingual_v2"}, …]` — no operator-friendly labels are defined for this key (the model id IS the label). Acceptance: test "renders all eight TTS fields when the TTS tab is active" (line 290-314, includes `getByDisplayValue("eleven_multilingual_v2")` at line 302) must pass unmodified.

- [x] **Task 1.8: Update domain-dashboard SKILL.md anchor**
  **Files**: `.claude/skills/domain-dashboard/SKILL.md`
  **What**: Add a new anchor line below the existing `Settings tabs module` line (line 16):
  ```
  - **Settings enums module** (client-safe — no `db` import): `enumOptions`, `EnumSettingKey`, `SETTING_OPTION_LABELS`
  ```
  This documents the new module's public contract alongside the existing Settings module / Settings tabs module entries. No body or path-trigger updates needed — the description still covers the settings system broadly.
  **Context**: Anchors are the skill's stable contract list. Adding the new helper + type + label-map names makes the canonical home of the option-derivation cluster visible to future audits — same framing the previous plan used for `TABS` / `isTabId` (prior plan task 1.3).

- [x] **Task 1.9: Verification gate for Phase 1**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, and `npm run build`. All three must pass — `npm run build` specifically catches the "client-safe" guarantee (a stray `getDb` / `node:fs` import in `settings-enums.ts` would surface as a webpack `UnhandledSchemeError`, the same failure mode that bit the prior plan and required Task 3.7's `lib/settings-tabs.ts` split). The settings-form test file (`__tests__/components/settings/settings-form.test.tsx`) is the regression net — confirm zero failures across the field-distribution and dirty-diff PATCH suites that exercise these Selects. The 19 unrelated workflows table/page failures the prior plan flagged (reproduce on `master`) are still expected and not a regression for this work.
  **Context**: Phase 1 must produce zero behavioural diff. Both the per-key Zod parse round-trip and the form's display labels / PATCH bodies are byte-equivalent to before.

### Phase 2: Source TTS provider metadata from a registry (#4)

- [x] **Task 2.1: Create `src/lib/tts/meta.ts`**
  **Files**: `src/lib/tts/meta.ts` (new)
  **What**: New client-safe module (no `node:` imports — required so `tts-settings.tsx` can import it without dragging `ai33.ts` / `genaipro.ts` into the client bundle). Export:
  - `interface TtsProviderMeta { label: string; envKey: string; endpoint: string }`
  - `type TtsProviderId = (typeof TTS_PROVIDERS)[number]` — derived from the `TTS_PROVIDERS` const array in `./settings-enums` (cross-module dependency on Phase 1's output, per audit line 148)
  - `TTS_PROVIDER_META: Record<TtsProviderId, TtsProviderMeta>` populated with the values currently in `tts-settings.tsx` PROVIDERS:
    - `genaipro: {label: "GenAIPro", envKey: "GENAIPRO_API_KEY", endpoint: "genaipro.vn/api/v1"}`
    - `ai33: {label: "AI33", envKey: "AI33_API_KEY", endpoint: "api.ai33.pro/v1"}`
  - `getTtsProviderMeta(id: TtsProviderId): TtsProviderMeta` — simple indexed lookup; throws if id is unknown (mirrors `getTtsProvider` in `index.ts:12-18`).

  Naming: follow the audit's first option ("a `getProviderMeta(id)` helper from the TTS provider registry"). The literal name is `getTtsProviderMeta` for clarity at the import site (`tts-settings.tsx` is far from `lib/tts/`). Module path is `lib/tts/meta.ts` — it's part of the TTS subtree even though the worker doesn't import it.

  The `tagline` field is **not** in this module — taglines stay in `tts-settings.tsx` as a local map per audit line 102.
  **Context**: This is Approach A from the audit ("expose a `getProviderMeta(id)` helper" — line 102). Approach B ("add a `providerMeta` field on each registry entry") is rejected because `lib/tts/index.ts` imports `ai33Provider` / `genaiproProvider`, which import `node:fs`, so adding `meta` to the `TtsProvider` interface wouldn't make the metadata reachable from the client bundle without restructuring the registry. Sibling module avoids the restructure. The "registry" framing in the audit is satisfied by `meta.ts` living next to the providers and being the canonical source consumed by both the workers (Tasks 2.3-2.4) and the UI (Task 2.2).

- [x] **Task 2.2: Drop the in-file `PROVIDERS` array in `tts-settings.tsx`**
  **Files**: `src/app/settings/tts-settings.tsx`
  **What**: Remove the `PROVIDERS` array (lines 38-53) and the in-file `interface ProviderMeta` (lines 25-31). Add imports: `import { TTS_PROVIDERS } from "@/lib/settings-enums"` (the id list, derived from Phase 1's TTS_PROVIDERS const) and `import { TTS_PROVIDER_META, type TtsProviderId } from "@/lib/tts/meta"`.

  Add a local `const TAGLINES: Record<TtsProviderId, string> = { genaipro: "Flat-body labs API with opt-in subtitle export.", ai33: "ElevenLabs-compatible cloud with nested voice settings." }` — taglines stay UI-only per audit line 102. Move the `// Provider catalogue. Order is the visual order…` doc comment (lines 33-37) to `TAGLINES`'s declaration — it documents the order semantics the comment describes. (Order itself is now owned by `TTS_PROVIDERS` in `settings-enums.ts` per Task 1.1; the `TAGLINES` map is keyed by id and order-agnostic.)

  Update consumers (the `PROVIDERS` array's `id` field is gone — callers pass `id` from the loop variable, and `meta` from `TTS_PROVIDER_META[id]`):
  - `ProviderSwitch` iteration (current line 225, `PROVIDERS.map((p) => <ProviderPill … meta={p} … />)`): switch to `TTS_PROVIDERS.map((id) => <ProviderPill key={id} meta={TTS_PROVIDER_META[id]} tagline={TAGLINES[id]} isActive={id === active} onSelect={() => onChange(id)} />)`. `TTS_PROVIDERS` order (`["genaipro", "ai33"]`, set in Task 1.1) lands the visual order directly — no inline reverse needed.
  - `ProviderPill` (current lines 238-303): change the local props interface from `{meta: ProviderMeta; isActive; onSelect}` to `{meta: TtsProviderMeta; tagline: string; isActive: boolean; onSelect: () => void}`. Inside the body, the existing `meta.tagline` read becomes a `tagline` prop read; `meta.label` stays as `meta.label` (still on `TtsProviderMeta`).
  - `ActiveProviderBanner` (current lines 307-362): same split — change props to `{meta: TtsProviderMeta; tagline: string}`, replace the `meta.tagline` reads inside the body with `tagline`. Other reads (`meta.label`, `meta.envKey`, `meta.endpoint`) stay unchanged.
  - `TtsSettings` `active` lookup (current line 71-72): change `const active = PROVIDERS.find((p) => p.id === values.tts_provider) ?? PROVIDERS[0]` to `const active = TTS_PROVIDER_META[values.tts_provider]`. The fallback is dead — `values.tts_provider` is the Zod-narrowed `TtsProviderId`, so the indexed lookup always succeeds. Pass `tagline={TAGLINES[values.tts_provider]}` to `<ActiveProviderBanner>`.
  - `ProviderSwitch`'s `active` prop (current line 77 `active={values.tts_provider}`): unchanged — already a `TtsProviderId`. Inside `ProviderSwitch`, the `isActive` predicate becomes `id === active` (loop var compared to the prop).

  Net effect: the file no longer maintains the PROVIDERS catalogue; the registry (`meta.ts`) and the schema enum (`settings-enums.ts`) are the single sources of truth. Taglines (UI flair) remain locally because the worker doesn't consume them.
  **Context**: Acceptance: existing settings-form tests (lines 296-299) must pass unmodified — `getByRole("radio", { name: /AI33/i })` and `name: /GenAIPro/i` match `meta.label` from `TTS_PROVIDER_META`, which holds byte-identical strings to the previous in-file `PROVIDERS` labels. The `aria-checked` assertion on the active radio is preserved by the `id === active` predicate flowing into `ProviderPill`.

- [x] **Task 2.3: Wire `lib/tts/ai33.ts` to `meta.envKey`**
  **Files**: `src/lib/tts/ai33.ts`
  **What**: Replace `process.env.AI33_API_KEY` (line 317) with `process.env[TTS_PROVIDER_META.ai33.envKey]`. Replace the error message string `"AI33_API_KEY is not set. Copy .env.example to .env and fill it in."` (line 319) with a derived form: `\`${TTS_PROVIDER_META.ai33.envKey} is not set. Copy .env.example to .env and fill it in.\``. Add `import { TTS_PROVIDER_META } from "./meta"`. Leave `BASE_URL` (line 27) untouched — the audit's load-bearing drift is `envKey`; `endpoint` is cosmetic.
  **Context**: Acceptance: `__tests__/unit/lib/tts/ai33.test.ts` line 222-240 ("throws immediately when AI33_API_KEY is missing") asserts the error message matches `/AI33_API_KEY/`. Derived `\`${envKey} is not set...\`` with `envKey === "AI33_API_KEY"` still matches — test passes unmodified.

- [x] **Task 2.4: Wire `lib/tts/genaipro.ts` to `meta.envKey`**
  **Files**: `src/lib/tts/genaipro.ts`
  **What**: Same change as Task 2.3, mirrored: `process.env.GENAIPRO_API_KEY` (line 412) → `process.env[TTS_PROVIDER_META.genaipro.envKey]`; error message (line 414) → derived form using `TTS_PROVIDER_META.genaipro.envKey`. Import `TTS_PROVIDER_META` from `./meta`. Leave `BASE_URL` (line 27) untouched.
  **Context**: Acceptance: `__tests__/unit/lib/tts/genaipro.test.ts` line 226-242 ("throws immediately when GENAIPRO_API_KEY is missing") asserts `/GENAIPRO_API_KEY/`. Derived message preserves the substring — test passes unmodified.

- [x] **Task 2.5: Verification gate for Phase 2**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, and `npm run build`. The TTS provider unit tests (`__tests__/unit/lib/tts/{ai33,genaipro,index}.test.ts`) and the settings-form test (`__tests__/components/settings/settings-form.test.tsx`) are the regression nets. After tests pass, `npm run dev` and confirm `/settings` → TTS tab renders identically: provider switcher (GenAIPro first, AI33 second), active-provider banner shows the correct label / env-var name / endpoint string for the active provider, and switching the radio updates the banner.
  **Context**: Highest-risk change is the visual ordering — `TTS_PROVIDERS` is set to `["genaipro", "ai33"]` in Task 1.1 specifically to preserve the rendered order, so the smoke check verifies that ordering survived the source-of-truth migration. The radiogroup tests assert role+name presence, not DOM order, so the smoke check is the only catch for an order regression.

## References
- `docs/refactoring/solid-audit-2026-05-04-settings-page.md` — finding #3 (lines 67-89), finding #4 (lines 92-105), priority action plan (lines 146-148), positive-pattern reference (lines 165-170).
- `docs/plans/2026-05-04-settings-solid-1-2.md` — prior plan; same code shape, especially Task 3.7's lib/settings-tabs.ts split (the precedent for keeping client-safe metadata out of `lib/settings.ts`). Phase 1 here follows the same module-split pattern.
- `.claude/skills/domain-dashboard/SKILL.md` — anchors block (lines 15-16: `Settings module` and `Settings tabs module`); §"Settings System / Tabs" (lines 113-145) for the storage/coercion + tabs framing the new helper sits inside.
- `src/lib/settings-tabs.ts` — reference for the client-safe sibling module pattern; `settings-enums.ts` mirrors its shape (no `db`, only `import type` from `./settings`).
- `src/lib/tts/index.ts` — existing TTS provider registry; Task 2.1's `meta.ts` is its sibling.
- `__tests__/components/settings/settings-form.test.tsx` — regression net for Phase 1 + Phase 2 UI changes.
- `__tests__/unit/lib/tts/ai33.test.ts`, `__tests__/unit/lib/tts/genaipro.test.ts` — regression net for Phase 2 worker changes (env-var error messages).
- `__tests__/unit/lib/settings.test.ts` — regression net for Phase 1 schema parse round-trip.
