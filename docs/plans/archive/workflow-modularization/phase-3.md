# Phase 3 — Input-Availability Validator + Schema Endpoint

**Cross-phase invariants:** [`README.md`](README.md) — Invariant A (transitional provider→slug mapping consulted by `materializeStepList`), Invariant D (schema endpoint shape, introduced here)

---

## Overview

Add a **non-blocking** input-availability validator that walks a workflow snapshot in materialized order and flags steps whose declared `inputs` are not produced by any prior step. Ship `GET /api/workflows/schema` so Phase 6's AI skill reads the live step + provider catalog instead of re-deriving it. Wire the validator into the existing write paths (POST / PATCH / import — added in Phase 2) plus a dedicated `/validate` endpoint behind the editor's "Validate now" button. Warnings surface inline; saves are never blocked.

After Phase 3, removing `research_characters` from a cloned workflow saves successfully but produces inline warnings on both `write_hook` and `write_chapters` (both declare `script/02_characters.md` as input per Phase 1's metadata table).

---

## Current State

**After Phase 2:**
- Step files declare `module` / `label` / `description` / `inputs` / `produces` / `for_each` (Phase 1 Tasks 6–9). `produces` defaults to `outputs` when omitted.
- `src/lib/workflows.ts` exposes `materializeStepList(snapshot)` — auto-inserts glue + applies the transitional provider→slug mapping (README Invariant A). `resolveSnapshot(db, id)` returns the JSON shape (README Invariant B).
- `src/lib/workflows-schema.ts` exposes `WorkflowRowSchema` / `WorkflowPatchSchema` / `WorkflowImportSchema` (Phase 2 Task 1).
- API routes: `POST /api/workflows`, `PATCH /api/workflows/[id]`, `POST /api/workflows/import` (Phase 2 Tasks 3, 4, 8). Each commits the row before responding; Phase 3 inserts validation post-commit.
- Edit form has Save (Phase 2 Task 13). Phase 2 deferred the "Validate now" button to Phase 3 — do not assume an existing DOM placeholder; Task 11 adds it fresh next to Save.

**Patterns Phase 3 reuses:**
- Zod `safeParse` + 400 on failure: `src/app/api/videos/route.ts`, `src/app/api/videos/[id]/route.ts`.
- Atomic-write `outputs: []` + glob `produces`: `04-write-chapters` is the canonical example (`outputs: []` + `produces: ["script/04_chapter_*.md", ...]`); see README's `Step` interface section for the rationale.
- `materializeStepList` walks Phase 1's transitional mapping (README Invariant A) so the validator already sees the same slug list the runtime uses. Phase 5's mapping deletion changes what slugs come out, but the validator's logic does not change.

**Confirmed absent (Phase 3 introduces):**
- No glob-matching utility or library in the codebase (`package.json` does not include `minimatch`/`picomatch`/`micromatch`/`glob`).
- No `/api/workflows/schema` endpoint.
- No validator. `bootValidate(db)` (Phase 1 Task 10) is structural-consistency only — input-availability is a write-time concern, not a runtime invariant.

---

## Scope

**Doing:**
- `src/lib/workflows-validator.ts` (new) — `validateInputAvailability(snapshot): ValidationResult` walking the materialized step list, accumulating produced files into an "available" set, matching each step's `inputs` against that set with glob-on-glob semantics. Returns `{ ok, warnings: [{ step_name, missing_input, message }] }`. Per the resolved design, validation produces warnings only — saves are never blocked.
- A small inline glob helper used only by the validator. No new dependency — the patterns step files actually use are narrow (`*` segments inside path components, no `**`, no character classes, no braces).
- `GET /api/workflows/schema` — returns the live `{ modules, steps, providers }` catalog from `REAL_STEPS` and the four provider registries. Stable shape: see README Invariant D.
- Wire the validator into `POST /api/workflows`, `PATCH /api/workflows/[id]`, `POST /api/workflows/import`. Validator runs **post-commit**; warnings appended to the response body alongside the row. Warnings never block save.
- New `POST /api/workflows/validate` for the editor's "Validate now" button (runs validator on a body-supplied snapshot without persisting; flat URL — no `[id]` because the body is self-contained).
- Editor: inline warnings under offending step rows + "Validate now" button (Phase 2 deferred).
- Tests: validator unit + glob unit + schema endpoint shape + integration.

**Not doing:**
- Hard validation / save block — by resolved design, this surface is "warnings, not hard block."
- Module-uniqueness rules (e.g., warn on two TTS steps in one workflow) — explicitly deferred.
- Validator on snapshot reads at orchestrator boot — `bootValidate(db)` (README Invariant C) stays structural-consistency only.
- AI skill itself (Phase 6) — Phase 3 ships only the endpoint Phase 6 depends on.
- Re-validation cascade on workflow PATCH against existing video snapshots — by design (Invariant B point 4): edits do not affect already-queued or in-flight videos.

---

## Tasks

### Phase 3A — Validator core

- [x] **Task 1: Minimal glob-on-glob matcher**
  **Files:** `src/lib/workflows-validator.ts` (new — define inline at the top of the file)
  **What:** A `globMatches(provided: string, required: string): boolean` that returns true when a `produces` entry plausibly satisfies an `inputs` entry. Convert `provided` to a `RegExp` **anchored with `^` and `$`** (`*` → `[^/]*`, escape other regex metacharacters; reject `**` for now — throw with a clear message so the validator surfaces unsupported patterns rather than silently mismatching). Return `regex(provided).test(required)`. Anchoring is required so `"script/01_outline.md"` does not match `"prefix/script/01_outline.md"` — Task 3's "different prefix" negative case asserts this.

  This single operation covers all three cases: literal==literal (string equality through the anchored regex), literal-provided vs glob-required (`*` is a valid `[^/]*`-matching character so identical-glob comparisons succeed), and glob-provided vs literal-required (the standard case). Document the supported subset in a code comment ("`*` within a path segment; no `**`, no character classes, no braces"). Step files only use `*` segments today.
  **Context:** No glob library in `package.json`. A ~10-line hand-rolled converter avoids a dep. The test surface (Task 3) is the authoritative spec — keep the implementation as small as the tests require.

- [x] **Task 2: `validateInputAvailability(snapshot)`**
  **Files:** `src/lib/workflows-validator.ts`
  **What:** Public surface:
  ```
  type ValidationWarning = { step_name: string; missing_input: string; message: string }
  type ValidationResult  = { ok: boolean; warnings: ValidationWarning[] }
  validateInputAvailability(snapshot: WorkflowSnapshot): ValidationResult
  ```
  Algorithm:
  1. Materialize the step list via `materializeStepList(snapshot)` (Phase 1's `src/lib/workflows.ts`) and resolve each slug to a `Step` object via `REAL_STEPS`.
  2. Walk in order; maintain `available: string[]` (or `Set<string>`) of accumulated `produces` patterns. For each step:
     - For each entry in `step.inputs`, check whether any entry in `available` satisfies it via `globMatches`. If none, push `{ step_name, missing_input, message: "<step.label> needs '<missing_input>' but no prior step produces it" }`.
     - After the input check, append each entry from `step.produces ?? step.outputs` to `available`. **Produces accumulate even when the step's inputs warned** — the walk does not abort on a missing input. This is what limits the empty-`steps` test (Task 3) to 2 warnings on `assemble_script` rather than cascading warnings into voiceover/align/etc., because `assemble_script.outputs = ["script/full_script.md"]` still leaks into `available` and satisfies later glue.
  3. Return `{ ok: warnings.length === 0, warnings }`.

  DB-derived inputs (e.g., `videos.title`) are never in `step.inputs`, so they're implicitly satisfied. Glue/module steps participate in the walk because Phase 1 Tasks 7 (script), 8 (glue + tts module), and 9 (provider-specific image/video) collectively declare `inputs`/`produces` across every step file.
  **Context:** `materializeStepList` already applies the Phase 1 transitional mapping (README Invariant A), so the validator sees the runtime slug list. Phase 5's collapse of `generate_*_comfyui`/`_google_flow` into unified slugs flows through automatically — no change needed here.

- [x] **Task 3: Unit tests for validator + glob matcher**
  **Files:** `__tests__/unit/lib/workflows-validator.test.ts` (new)
  **What:**
  - Glob: literal == literal, glob == glob (same pattern), literal-satisfies-glob, negative cases (different prefix, different extension, `**` rejection).
  - Validator on the seeded `comfyui` snapshot: `ok: true`, no warnings.
  - Validator on the seeded `google-flow` snapshot: `ok: true`, no warnings (regression guard — both built-ins must be valid).
  - Validator on a snapshot with `research_characters` removed: `ok: false`, exactly **two** warnings — one on `write_hook` and one on `write_chapters`, both citing missing `script/02_characters.md`. (Both steps declare it in their `inputs` per Phase 1's metadata table; removing the producer affects both consumers.)
  - Validator on a snapshot with both `research_characters` and `write_hook` removed: `ok: false` with exactly **two** warnings — `write_chapters` (still missing `script/02_characters.md`) and `assemble_script` (which depends on `script/03_hook.md`, no longer produced). This proves the walk continues into the auto-inserted glue — not just script-module steps — and that warnings on multiple distinct steps coexist.
  - Validator on an empty `steps` array: `ok: false` with exactly **two** warnings, both on `assemble_script`, citing missing `script/03_hook.md` and `script/04_chapter_*.md`. `materializeStepList` still emits the always-present glue (`assemble_script`, `align`, `chunk`, `enrich_chunks`, `render`, `cleanup`), the tts-module step (`voiceover`), and the image/video-module steps per the snapshot's provider columns. `assemble_script.inputs` references the two missing paths (Phase 1 Task 8 metadata) which no script step now produces. The walk does NOT cascade further: `assemble_script.outputs = ["script/full_script.md"]` still accumulates into `available` (per Task 2's "produces accumulate even when inputs warn" rule), so `voiceover` and downstream glue/module steps find their inputs satisfied. Glue is NOT self-consistent — it depends on script-module produces — but the cascade is bounded by the produces-leak semantic.
  **Context:** Construct `WorkflowSnapshot` objects directly in-memory; do not require a DB fixture for the validator tests. The materializer is a pure function over the snapshot once `REAL_STEPS` is in scope.

### Phase 3B — Schema endpoint

- [x] **Task 4: `GET /api/workflows/schema`**
  **Files:** `src/app/api/workflows/schema/route.ts` (new)
  **What:** Returns the catalog per README Invariant D:
  ```
  {
    modules: ["script", "tts", "image", "video", "glue"],
    steps: [{ name, module, label, description, inputs, produces, for_each: <"chapters" | "chunks" | null> }, ...],
    providers: { script: string[], tts: string[], image: string[], video: string[] }
  }
  ```
  - `for_each: undefined` from a step file → emit `null` in JSON (Invariant D requires the key always present).
  - `produces` is `step.produces ?? step.outputs` (resolve the default at the endpoint, not at consumer time).
  - `providers.script`: `Object.keys(llmProviders)` from `src/lib/llm/index.ts`. Phase 1 has only `["openrouter"]`; Phase 4 registers `claude_cli` and `Object.keys` picks it up automatically — no endpoint code change needed when Phase 4 lands.
  - `providers.tts`: `Object.keys(ttsProviders)` from `src/lib/tts/index.ts`.
  - `providers.image`: `Object.keys(imageProviders)` from `src/lib/image/index.ts`. Phase 1 has only `["comfyui"]`; the snapshot column accepts `"google_flow"` via the transitional mapping. **Until Phase 5**, the `image` array is hardcoded to `["comfyui", "google_flow"]` to match the editor's option list (which surfaces both values that the workflow row accepts). Document this as a temporary divergence in a code comment; Phase 5 switches to `Object.keys(imageProviders)` once `google_flow` is registered.
  - `providers.video`: same hardcoded `["comfyui", "google_flow"]` until Phase 5 introduces the video registry; then `Object.keys(videoProviders)`.

  Read-only, stateless — no DB access. Returns 200 always.
  **Context:** The hardcoded image/video arrays are the cleanest way to keep the endpoint's published shape stable from Phase 3 onward; consumers (the editor in Phase 2 + the AI skill in Phase 6) see the same provider list before and after Phase 5. Pattern reference: `src/app/api/health/route.ts` for trivial GETs.

- [x] **Task 5: Schema endpoint test**
  **Files:** `__tests__/api/workflows/schema/route.test.ts` (new)
  **What:** GET the endpoint, assert top-level keys exist (`modules`, `steps`, `providers`), assert each step entry has the seven documented fields, assert `for_each` is either `null` or one of the literal strings (never `undefined`). Use a Vitest inline snapshot of the full JSON as a regression guard — Phase 6 depends on stable shape, so any change should be a deliberate diff.

  **Expected snapshot churn across phases:** the inline snapshot is intentionally brittle. Phase 4's `claude_cli` registration extends `providers.script` to `["openrouter", "claude_cli"]` automatically (no endpoint code change — `Object.keys(llmProviders)` picks it up). Phase 5 will replace the four `generate_*_<provider>` step entries with two unified entries (`generate_main_images`, `generate_hook_video`) and switch `providers.image`/`video` to live registry keys. Both updates are deliberate — the snapshot diff is the surface where reviewers see the contract change. Document this expectation in a comment above the inline snapshot so future diffs aren't dismissed as a regression.
  **Context:** "Snapshot the response" here means a Vitest `toMatchInlineSnapshot()`, distinct from the `videos.workflow_snapshot` concept. Existing API-route tests under `__tests__/api/...` are the structure to follow.

### Phase 3C — Wire into write paths

- [x] **Task 6: PATCH `/api/workflows/[id]` runs validator post-commit**
  **Files:** `src/app/api/workflows/[id]/route.ts`
  **What:** After Phase 2's PATCH transaction commits (existing order: `update` row fields → `replaceSteps` if `steps` present → `bumpVersion`), build the post-PATCH `WorkflowSnapshot` in-memory from the values just written (the partially-merged row + the new steps array), call `validateInputAvailability(snapshot)`, then append the `warnings` array to the existing 200 body: `{ ...camelCaseRow, warnings: ValidationWarning[] }`. Save is **not blocked** by warnings.

  **In-memory snapshot construction (not `resolveSnapshot(db, id)`):** the route already knows the post-PATCH provider-column values and step list because it just wrote them. Synthesizing the snapshot in memory avoids a redundant DB round-trip back to `workflows` + `workflow_steps`. Use the same `WorkflowSnapshot` shape from README Invariant B; placeholder `version` from the just-bumped value.
  **Context:** Adding validation post-commit (outside the transaction) avoids extending the lock window and keeps Phase 2's existing 409 / Zod 400 paths simple. The `warnings` field is additive — Phase 2's existing tests assert other fields and won't break when `warnings: []` appears.

- [x] **Task 7: POST `/api/workflows` runs validator post-commit**
  **Files:** `src/app/api/workflows/route.ts`
  **What:** Same post-commit pattern as Task 6: after the insert + replaceSteps transaction (Phase 2 Task 3), call validator and append `warnings` to the 201 response body.
  **Context:** Symmetric with PATCH so the editor's create-flow and edit-flow consume the same response shape.

- [x] **Task 8: Import endpoint runs validator**
  **Files:** `src/app/api/workflows/import/route.ts`
  **What:** Wire validator post-commit for both the new-row and `?overwrite=1` paths (Phase 2 Task 8). Append `warnings` to the response body whether status is 201 or 200.
  **Context:** Cross-phase contract — Phase 6's drafts import flows through this endpoint; the dashboard's drafts toast/dialog surfaces these `warnings`. Keep the warning shape stable: `{ step_name, missing_input, message }`. README Invariant D documents this shape.

- [x] **Task 9: `POST /api/workflows/validate` (no persistence)**
  **Files:** `src/app/api/workflows/validate/route.ts` (new)
  **What:** Body matches a partial workflow shape (the editor's in-progress dirty state): four provider columns + `steps: [{ step_name }]`. Run `materializeStepList` on a synthetic snapshot built from the body, then `validateInputAvailability`. Return `{ warnings: ValidationWarning[] }` with status 200.

  The route does **not** read or write the `workflows` table — it operates on the body alone. The synthetic snapshot uses a placeholder `workflow_id: "__validate__"` and `version: 0` for shape compatibility; the validator does not consume either field.

  **Body validation:** reuse Phase 2's `WorkflowRowSchema` from `src/lib/workflows-schema.ts` via `.pick({ script_llm_provider: true, tts_provider: true, image_provider: true, video_provider: true, steps: true })` rather than redefining the shape inline. Single source of truth — when Phase 4 widens `script_llm_provider`'s enum or Phase 5 simplifies the materializer, only `WorkflowRowSchema` needs editing. Reject malformed bodies with 400 + first Zod issue message.

  **URL choice:** the route is **not** under `[id]` because the body is self-contained and the URL parameter would be functionally unused. A flat `POST /api/workflows/validate` matches the body-only contract.
  **Context:** This is the route the editor's "Validate now" button (Task 11) calls. Keeping `materializeStepList` server-only (rather than refactoring it for client import) matches Phase 2's route-driven pattern. ~25 lines.

### Phase 3D — Editor surface

- [x] **Task 10: Inline warnings on step rows after Save**
  **Files:** `src/app/workflows/[id]/edit/edit-form.tsx`
  **What:** Phase 2 Task 14's save flow already returns 200 with body. Extend the form's submit handler to read `response.warnings` and store it in component state (`warnings: ValidationWarning[]`). In the step-list rendering (Phase 2 Task 13), each row whose `step_name` matches any `warning.step_name` gets an inline warning element below the row — use a styled `<p className="text-xs text-amber-700 mt-1">` with the message text (no need to introduce an `<Alert>` primitive if one isn't already in `src/components/ui/`). Warnings persist until the next Save or Validate-now click clears them.

  Multiple warnings on the same step (rare — one missing input per warning) render as a stacked list under the row.
  **Context:** Form-state shape: warnings are tied to the last completed validation pass, not stale data. On 409 `version_conflict` (Phase 2 Task 14), do not touch warnings — the user reloads and starts fresh.

- [x] **Task 11: "Validate now" button**
  **Files:** `src/app/workflows/[id]/edit/edit-form.tsx`
  **What:** Add the "Validate now" button next to Save (Phase 2 Task 13 deferred this button to Phase 3 — there is no existing DOM placeholder; render it fresh in the submit row). Click handler:
  1. Build the request body from the form's current state: `{ script_llm_provider, tts_provider, image_provider, video_provider, steps }` (only the columns the validator consumes).
  2. `fetch("/api/workflows/validate", { method: "POST", body, headers: { "Content-Type": "application/json" } })`.
  3. On 200: set the same `warnings` form-state field used by Task 10.
  4. On 400: toast first Zod issue (rare — body always built from form state).
  Button is **always enabled** — even an empty `steps` array is interesting to validate, because the auto-inserted glue (`assemble_script` etc.) depends on script-module produces and will warn loudly when none exist. Disabling on empty would hide that signal.
  **Context:** The button does NOT save. It surfaces validator output for the in-progress dirty state. After clicking, the user can keep editing or hit Save; saving runs the validator again server-side (Task 6) and refreshes warnings from that response.

### Phase 3E — Integration test

- [x] **Task 12: PATCH returns warnings end-to-end**
  **Files:** `__tests__/api/workflows/[id]/route.test.ts` (extend Phase 2 Task 18's file)
  **What:** Three cases:
  1. Clone `comfyui` to `comfyui-broken` (clone returns version=1). PATCH it with `expected_version: 1` to remove `research_characters` from steps. Assert response is 200, post-PATCH version is 2, `warnings.length === 2`, with warnings on **both** `write_hook` and `write_chapters` (each citing missing `script/02_characters.md` per Phase 1's metadata table).
  2. PATCH `comfyui-broken` again with `expected_version: 2` to also remove `write_hook`. Assert post-PATCH version is 3, `warnings.length === 2`: `write_chapters` (still missing `script/02_characters.md`) and `assemble_script` (now missing `script/03_hook.md` because `write_hook` is gone). The missing-input chain propagates into glue — do NOT assert `warnings.length === 0`.
  3. Clone `comfyui` to `comfyui-clean` (version=1). PATCH a no-op label change with `expected_version: 1`. Assert response is 200 and `warnings.length === 0`.

  **`expected_version` reminder:** Phase 2 Task 4's PATCH contract requires `expected_version` on every PATCH; Task 14's edit form tracks it client-side. Tests must do the same — capture the version returned by clone/previous-PATCH and pass it in the next request, or every step after the first 409s before the validator ever runs.
  **Context:** Validates that the validator runs on the post-commit snapshot (not the request body) and that warnings reflect the materialized order including auto-inserted glue. Same fixture pattern as Phase 2 Task 17.

- [x] **Task 13: Schema endpoint covers post-Phase-1 metadata**
  **Files:** `__tests__/api/workflows/schema/route.test.ts` (extend Task 5's file)
  **What:** Beyond the inline snapshot from Task 5, assert:
  - Every entry in `REAL_STEPS` (post-Phase 1) appears in the response's `steps` array.
  - `steps[].for_each` is `"chapters"` for `write_chapters`, `"chunks"` for `enrich_chunks` and the four `generate_*_<provider>` steps (Phase 3 timing — Phase 5 collapses these to two unified `generate_main_images` / `generate_hook_video` steps; update this assertion when Phase 5 lands), `null` for everything else.
  - `providers.script` includes `"openrouter"` (and `"claude_cli"` post-Phase 4 — gate this assertion behind a Phase-4-or-later check, or skip until then).
  **Context:** This catches metadata regressions — e.g., a developer adding a script step without setting `module: "script"` would silently drop it from the schema's `steps[]`. The test fails loudly.

  **Phase 1 dependency:** the validator and this test rely on the four provider-specific image/video step files (`generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts`) declaring `inputs` and `produces` accurately. Phase 1 Task 9 stamps these per the Phase 1 metadata table (`inputs: ["chunks/chunks.json"]`, image steps `produces: ["images/main/*.png"]`, video steps `produces: ["videos/hook/*.mp4"]`). Verify the four files match the table when arriving at Phase 3 — if Phase 1 shipped without these declarations, the validator silently underreports and this test won't catch it.

---

## Done Criteria

- Removing `research_characters` from a cloned workflow saves successfully and surfaces inline warnings on **both** `write_hook` and `write_chapters` (each citing missing `script/02_characters.md`) — Tasks 6, 10, 12.
- `GET /api/workflows/schema` returns the live catalog matching README Invariant D's shape (Task 4); shape is regression-tested via inline snapshot (Task 5).
- Editor shows inline validation warnings after Save (Task 10) and after clicking "Validate now" (Task 11).
- Both seeded built-in workflows (`comfyui`, `google-flow`) pass the validator with zero warnings (Task 3).
- `validateInputAvailability` is referenced only by `src/lib/workflows-validator.ts`, the four route files (`POST /api/workflows`, `PATCH /api/workflows/[id]`, `POST /api/workflows/import`, `POST /api/workflows/validate`), and the edit form. No leakage into the orchestrator, `bootValidate`, or step files (input-availability is a write-time concern).
- The validator's warning shape `{ step_name, missing_input, message }` is documented in README Invariant D and consumed unchanged by Phase 6's drafts UI.

---

## References

- Cross-phase invariants: [`README.md`](README.md) — Invariant A (transitional mapping consulted by `materializeStepList`), Invariant D (schema endpoint shape, introduced this phase)
