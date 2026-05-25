# SOLID Audit — 2026-05-04 — `/settings` page

**Mode**: Focused single-page review (subset of `domain-dashboard`)
**Scope**: The `/settings` page — server shell, the client form orchestrator, the TTS sub-panel, the Google Flow accounts subtree, the `/api/settings` route, and the `lib/settings.ts` schema module.
**Domains analyzed**: `domain-dashboard`

**Files in scope (10):**
- `src/app/settings/page.tsx`
- `src/app/settings/settings-form.tsx`
- `src/app/settings/tts-settings.tsx`
- `src/app/settings/google-flow-accounts.tsx`
- `src/app/settings/google-flow-accounts-hooks.ts`
- `src/app/settings/google-flow-accounts-table.tsx`
- `src/app/settings/google-flow-account-minted-dialog.tsx`
- `src/app/settings/google-flow-account-delete-confirm.tsx`
- `src/app/api/settings/route.ts`
- `src/lib/settings.ts`

## Summary

The settings system has two distinct halves with very different SOLID health. The `lib/settings.ts` + `/api/settings` + `useFlowAccounts` + `GoogleFlowAccountsTable` slice is exemplary — Zod-per-key + TEXT storage is a clean abstraction, the accounts subtree is well-decomposed (orchestrator + data hook + edit hook + presentational table + dialogs), and the PATCH route's atomic transaction with the cross-field rule inside is deliberate per the domain skill. The other half — `settings-form.tsx` — is a 756-line god-component that owns tab metadata, the orchestrator, all five tab panels, and seven field primitives in one file. The TTS panel has already been carved out and points the way; converging the remaining tabs on that shape is the headline work. A second smaller theme is **enum drift**: the form hand-maintains `<Select>` options that duplicate the Zod `z.enum` members in `lib/settings.ts`, and the TTS `PROVIDERS` array duplicates the `tts_provider` enum plus the worker-side registry.

## Findings Overview

| ID  | Domain           | Principle | Severity | Effort | Files                                    |
|-----|------------------|-----------|----------|--------|------------------------------------------|
| 1   | domain-dashboard | SRP       | high     | medium | `src/app/settings/settings-form.tsx`     |
| 2   | domain-dashboard | SRP       | medium   | small  | `src/app/settings/settings-form.tsx`, `src/lib/settings.ts` |
| 3   | domain-dashboard | OCP       | medium   | small  | `src/app/settings/settings-form.tsx`, `src/app/settings/tts-settings.tsx`, `src/lib/settings.ts` |
| 4   | domain-dashboard | OCP/DIP   | medium   | medium | `src/app/settings/tts-settings.tsx`, `src/lib/settings.ts`, `src/lib/tts/` |
| 5   | domain-dashboard | ISP       | low      | small  | `src/app/settings/tts-settings.tsx` (and future panels) |
| 6   | domain-dashboard | SRP       | low      | small  | `src/app/api/settings/route.ts`          |

## Findings Detail

### #1 — `settings-form.tsx` is a 756-line god-component
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** high | **Effort:** medium
**Files:** `src/app/settings/settings-form.tsx`

This single file owns six separate concerns: (a) tab metadata (`TABS`, `TAB_FIELDS`), (b) the orchestrator (state, dirty-diff, save, query-param tab sync), (c) the ComfyUI tab body, (d) the Google Flow tab body (with its inlined Advanced/Account/Dispatch/Content-moderation field groupings), (e) the LLM tab body (with its OpenRouter / Claude CLI collapsibles), (f) the Render tab body, plus (g) seven field primitive components (`TextField`, `NumberField`, `SelectField`, `BoolField`, `ReadOnlyField`, `TextArea`, `FieldLabel`) and two layout helpers (`FieldGroup`, `FieldGrid`).

Each of those is a separate axis of change: adding a Google Flow setting, adding a render preset, renaming a primitive, or restyling the tab dirty-dot all touch this same file. Tests of the orchestrator have to render every panel's fields. The TTS tab has already been extracted into `tts-settings.tsx` and is a clean reference for what the rest should look like.

**Recommendation:** Three-step extraction.
1. Move the field primitives + layout helpers to `src/app/settings/field-primitives.tsx`. Pure mechanical move; behavior-preserving.
2. Extract each tab body to its own file (`comfyui-tab.tsx`, `google-flow-tab.tsx`, `llm-tab.tsx`, `render-tab.tsx`) following the `tts-settings.tsx` shape — each file exports a `<Tab>` component that takes the values it needs and an `update` callback.
3. The orchestrator file becomes ~150-200 lines: tab list, the `<Tabs>` wiring, dirty-diff save logic, error/saved banners, the submit button.

**Why:** Adding a setting today means edit the schema, edit the default, scroll through 750 lines of JSX to find the right tab and the right field group. After the split, adding a Google Flow setting is a one-file edit in `google-flow-tab.tsx` + the two settings module edits. The tab-roster file (see #2) becomes the only orchestration point, and tests for one panel don't need fixtures for unrelated panels. Same shape as the videos detail / queue split that `domain-dashboard` already documents as the project's preferred pattern.

---

### #2 — `TAB_FIELDS` + `TABS` defined inside the form drift from the `domain-dashboard` anchor
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** medium | **Effort:** small
**Files:** `src/app/settings/settings-form.tsx`, `src/lib/settings.ts`

`domain-dashboard` SKILL.md anchors `TAB_FIELDS` as part of the **Settings module** alongside `getSetting`, `setSetting`, `getAllSettings`, `DEFAULT_SETTINGS`, and `seedDefaultSettings`. Today `TAB_FIELDS` and the `TABS` tuple are defined inside `settings-form.tsx` (a client component), which means the form owns both presentation and the schema-key-to-tab partition. The anchor expects them in `lib/settings.ts`, so the form is the only consumer that knows the partition exists.

Practical consequence: any non-form code that ever needs to know "which tab does setting X belong to" (audit log, future settings export, deep-link generator) cannot import it. It also splits one logical change across two unrelated modules — the tab roster and the schemas have to stay in lockstep but live in different concerns.

**Recommendation:** Move the metadata to `lib/settings.ts` — `TABS` (the `{id, label}` tuple and the derived `TabId` type), `TAB_FIELDS` (the key partition), and the `isTabId` guard. The form imports them. The visual concerns (label rendering, dirty-dot styling, the per-tab `<TabsContent>` JSX) stay in the form. Scope is metadata only; turning the `<TabsContent>` chain into a registry-driven iteration is a separate change and not part of this finding.

**Why:** Realigns with the documented anchor; turns "add a setting key" into a one-module edit that already encodes the tab assignment alongside the schema. Eliminates the chance of `TAB_FIELDS` referencing a key that no longer exists in `SETTING_SCHEMAS` (today nothing enforces consistency between the two).

---

### #3 — `<Select>` option lists across panels duplicate the Zod enum members
**Domain:** domain-dashboard | **Principle:** OCP | **Severity:** medium | **Effort:** small
**Files:** `src/app/settings/settings-form.tsx`, `src/app/settings/tts-settings.tsx`, `src/lib/settings.ts`

Multiple `<Select>` instances hand-maintain options that mirror the Zod `z.enum` members of the same key:
- `image_provider` options vs `z.enum(["comfyui"])`
- `google_flow_image_model` options vs `z.enum(["NARWHAL", "GEM_PIX_2", "IMAGEN_3_5"])`
- `google_flow_video_model` options vs the five-variant enum
- `google_flow_aspect_ratio` options vs `z.enum(["landscape", "portrait"])`
- `voiceover_model_id` options vs the four-variant enum
- `aspect_ratio` options vs `z.enum(["16:9", "9:16", "1:1", "4:5"])`
- `framerate` options (`["30", "60"]`) vs the same enum
- `enrich_chunks_llm_provider` options vs `z.enum(["openrouter", "claude_cli"])`
- `tts_provider` options vs `z.enum(["ai33", "genaipro"])`

Adding a new variant requires editing both files. If the schema gains a value the form doesn't expose, the operator can't pick it; if the form gains a value the schema doesn't allow, save throws on PATCH.

The OpenRouter `model_name` `<Select>` is **out of scope** for this finding — `model_name` is a `z.string()`, not an enum, and the form's curated list is intentionally an allowlist disconnected from the schema. Treat it separately if it's worth doing at all.

**Recommendation:** Add a small helper alongside the schemas — e.g., `enumOptions(key)` that reads the underlying Zod schema's `.options` (for `z.enum`-typed keys only) and returns `readonly { value, label }[]`. Operator-friendly labels (`"Nano Banana Pro"` for `GEM_PIX_2`) belong in a sibling label map keyed by `(key, value)` so the schema stays the source of truth for *what's allowed* and the label map is the source of truth for *what to call it*.

**Why:** Closes a silent drift surface and makes "add a new Veo model" a one-file edit (the schema enum + the label map entry). The form's `SelectField` accepts `options` as data already, so the wiring is cosmetic.

---

### #4 — TTS `PROVIDERS` catalogue duplicates the `tts_provider` enum and the worker provider registry
**Domain:** domain-dashboard | **Principle:** OCP / DIP | **Severity:** medium | **Effort:** medium
**Files:** `src/app/settings/tts-settings.tsx`, `src/lib/settings.ts`, `src/lib/tts/`

`tts-settings.tsx` defines a `PROVIDERS` array of `{id, label, tagline, envKey, endpoint}` for the two known TTS providers (`genaipro`, `ai33`). The same provider identity also lives in:
- `lib/settings.ts` as `tts_provider: z.enum(["ai33", "genaipro"])`
- `lib/tts/` as the provider registry (per `domain-media`)

Adding a third TTS provider is a three-file edit, and the provider's operator-facing metadata (env-var name, endpoint URL) is maintained alongside the styling rather than the provider registry that authoritatively knows about it. `domain-media` describes the TTS provider registry as the central plug-point; the settings UI bypasses it.

**Recommendation:** Introduce a tiny abstraction — either expose a `getProviderMeta(id): { label, envKey, endpoint }` helper from the TTS provider registry, or add a `providerMeta` field on each registry entry that the settings UI consumes. The `tagline` (UI flavor) can stay in `tts-settings.tsx` since it's not used by the worker. The `id` list itself derives from the schema enum (per #3). Severity is medium because the drift is currently silent: nothing fails if `envKey` is wrong, the operator just sees the wrong env var name.

**Why:** Realigns the UI with the project's existing provider-registry pattern (the project does this well for image providers — `domain-workflows` and `domain-media` both lean on it). Adds genuine OCP: registering a new TTS provider in `lib/tts/` is sufficient for the settings UI to surface it.

---

### #5 — Tab panels accept full `AllSettings` and full polymorphic `update` callback
**Domain:** domain-dashboard | **Principle:** ISP | **Severity:** low | **Effort:** small
**Files:** `src/app/settings/tts-settings.tsx` (and future extracted panels per #1)

`TtsSettings` takes `values: AllSettings` and `update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void`, but it only reads ~9 keys and only writes to those same keys. Once the other panels are extracted, each will face the same shape. A test of `TtsSettings` has to construct a full `AllSettings` even though the panel reads less than half of it, and a typo (e.g., `update("voice_speedy", ...)`) is caught only by the schema's runtime parse.

**Recommendation:** Constrain panel props to the panel's key slice using `TAB_FIELDS`. Depends on #2 landing first — `TAB_FIELDS` must be in `lib/settings.ts` (or another shared module the panels can import) for these types to live next to it. Specifically:

```
type TabKeys<T extends TabId> = (typeof TAB_FIELDS)[T][number];
type TabValues<T extends TabId> = Pick<AllSettings, TabKeys<T>>;
type TabUpdate<T extends TabId> = <K extends TabKeys<T>>(k: K, v: AllSettings[K]) => void;
```

Then `TtsSettings` takes `TabValues<"tts">` and `TabUpdate<"tts">`. Cross-tab key mistakes become compile errors, and tests construct only what's read. The orchestrator's `update` widens transparently when calling each panel.

**Why:** Small but real ISP win — and it composes naturally with #2 since `TAB_FIELDS` becomes the source of these types. Low severity because today's wrong-key error surfaces at PATCH time anyway via Zod, but the compile-time guarantee is essentially free once #1 and #2 have landed.

---

### #6 — `parseActDistribution` lives in the route file alongside the cross-field rule
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** low | **Effort:** small
**Files:** `src/app/api/settings/route.ts`

The PATCH transaction body mixes per-key writes with the `act_distribution` cross-field rule, and the helper that parses the comma-separated string is defined at module level in the same file. Today this is fine — `domain-dashboard` explicitly notes the cross-field rule belongs in the route (the per-key Zod schemas have no access to other keys), there is exactly one such rule, and it's small.

**Recommendation:** No action today. Flag for revisit if a second cross-field rule is added — at that point a `crossFieldRules.ts` module that exports an array of `(allValues) => void | throw` checks lets the route iterate without growing a chain of inline `if` blocks. Single rule today doesn't justify the abstraction.

**Why:** Documenting the threshold — one is fine, two is the trigger. Logged so a future change knows to make the move and not bury a second rule in another inline block.

---

## Priority Action Plan

### Immediate (high severity, small-medium effort)
- **#1** — Split `settings-form.tsx` into per-tab panels + `field-primitives.tsx`; orchestrator stays slim. Use the existing `tts-settings.tsx` as the reference shape.
- **#2** — Move `TABS` + `TAB_FIELDS` to `lib/settings.ts` to align with the `domain-dashboard` anchor and unify settings metadata in one module.

### Next Sprint (medium severity)
- **#3** — Derive `<Select>` options from the Zod `z.enum` members; add a `(key, value) → label` map for operator-friendly names. Eliminates the form↔schema drift surface.
- **#4** — Source TTS provider metadata (`envKey`, `endpoint`) from the worker provider registry rather than maintaining a parallel `PROVIDERS` array. Pair with #3 so the `id` list also derives from the schema.

### Backlog (low severity)
- **#5** — Tighten panel prop types to `Pick<AllSettings, TabKeys<T>>` plus a constrained `update`. Requires #1 and #2 to have landed first.
- **#6** — Leave the route's cross-field rule inline; revisit only if a second rule appears.

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #2 from docs/refactoring/solid-audit-2026-05-04-settings-page.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

**Positive patterns worth preserving:**
- The Google Flow accounts subtree (`google-flow-accounts.tsx` + `*-hooks.ts` + `*-table.tsx` + the two dialogs) is a textbook orchestrator-plus-data-hook-plus-presentational-table split. Each file has one responsibility, dialogs are dumb, the table has zero fetch logic. This is the shape `domain-dashboard` documents as the project pattern, and it's the reference for how the rest of the form should converge.
- The `lib/settings.ts` Zod-per-key + TEXT-storage system is a clean DIP: high-level callers (route, form, worker) all depend on `getSetting` / `setSetting` / `getAllSettings`, never on the storage shape. The `db` parameter accepts an optional override so transactional callers compose cleanly.
- The PATCH route's all-or-nothing transaction with the cross-field rule executed inside the `db.transaction()` callback is deliberate per the domain skill — keep it.

**Anchor coverage:**
- `TAB_FIELDS` is anchored under `domain-dashboard`'s **Settings module** but lives in `settings-form.tsx`. Finding #2 realigns this. No other anchor drift detected in the audited scope.
