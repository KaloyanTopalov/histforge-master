# Phase 2 — Workflow Editor + JSON Export/Import

**Cross-phase invariants:** [`README.md`](README.md) — Invariant B (workflow snapshot lifecycle: PATCH on a workflow does NOT cascade to existing snapshots)

---

## Overview

Make workflow rows editable. After Phase 2, a user can clone a built-in workflow, edit its label/description/provider columns/script-step list, save with optimistic-version protection, export to JSON, import from JSON, delete (with FK protection), and reset built-ins to their seeded definition.

No input-availability validation yet (Phase 3) — Phase 2's only structural check is "step_name belongs to a `module: 'script'` step." The editor allows flexible compositions: at most one TTS/image/video step per workflow is the convention, but it is not enforced at the DB level.

---

## Current State

**After Phase 1:**
- `workflows` + `workflow_steps` tables exist; seeded with `comfyui` and `google-flow` built-ins.
- `videos.workflow_snapshot` populated at create/queue per Invariant B.
- `src/lib/workflows.ts` exposes `getWorkflowFromDb`, `listWorkflows`, `resolveSnapshot`, `materializeStepList`.
- `src/lib/repos/workflows.ts` exposes read-only `findById`, `list`, `findStepsByWorkflow`. **No write helpers yet — added in this phase.**
- `GET /api/workflows` and `GET /api/workflows/[id]` exist (camelCase response boundary).
- `/workflows` page lists workflows read-only; nav entry exists between Videos and Settings.
- Every step file declares `module`/`label`/`description`/`inputs`/`produces`/`for_each`. Phase 2 reads `module === "script"` to populate the step picker.

**Patterns Phase 2 reuses:**
- PATCH with Zod `safeParse`: `src/app/api/videos/[id]/route.ts:46,60,79`.
- Transactional batch UPDATE: `src/app/api/settings/route.ts:31-39`.
- Multi-tab form with dirty-diff PATCH: `src/app/settings/settings-form.tsx:93,124,165,191-526`. Local helpers `FieldGroup` (`:550`), `FieldGrid` (`:567`), `FieldLabel` (`:586`); hint pattern at `:644,698`.
- Confirmation dialog (generic, reused by Phase 2): `src/app/videos/confirm-dialog.tsx` — props `title`/`message`/`confirmLabel`/`destructive`/`busy`/`onCancel`/`onConfirm`. Wraps `src/components/ui/alert-dialog.tsx`. The video-specific `delete-confirm-dialog.tsx` is NOT the pattern Phase 2 uses (it has hardcoded video-status logic).
- Toasts: `import { toast } from "sonner"` (Toaster mounted at `src/app/layout.tsx:55`); existing call sites `src/app/videos/use-video-action.ts:5`, `use-video-poller.ts:4`, `flow-failure-banner.tsx:5`.
- POST returning 201: `src/app/api/videos/route.ts:48,78`.
- Per-id route handlers: `src/app/api/videos/[id]/route.ts` (GET `:20`, PATCH `:60`, DELETE `:104`).
- Server-component page reading directly via `getDb()`: `src/app/videos/page.tsx:14-30`.
- Tabs primitive: `src/components/ui/tabs.tsx` (used inside `settings-form.tsx:192`).
- File I/O against `prompts/`: `src/lib/prompts.ts:1,21`.
- Repo write helpers + transactional pattern: `src/lib/repos/videos.ts:42-61` (createNewVideo), `:77-122` (updateVideoDraft), `:345` (db.transaction usage).

**Confirmed absent (Phase 2 introduces):**
- No `expected_version` / `If-Match` / optimistic-concurrency anywhere in `src/`.
- No `[id]/edit/page.tsx`-style route exists yet.
- No `<input type="file">` / `FormData` upload UI exists in the dashboard.
- No drag-and-drop or reorder-button primitives (Phase 2 uses up/down buttons).

---

## Scope

**Doing:**
- `src/lib/workflows-schema.ts` (new) — `WorkflowRowSchema` and `WorkflowPatchSchema` Zod schemas, including `expected_version` on PATCH.
- Extend `src/lib/repos/workflows.ts` with write helpers: `insert`, `replaceSteps`, `update`, `bumpVersion`, `deleteById`, `countVideosUsingWorkflow`.
- API: `POST /api/workflows`, `PATCH /api/workflows/[id]`, `DELETE /api/workflows/[id]`, `POST /api/workflows/[id]/clone`, `POST /api/workflows/[id]/reset`, `POST /api/workflows/import`, `GET /api/workflows/[id]/export`.
- Editor page: `src/app/workflows/[id]/edit/page.tsx` (server) + `edit-form.tsx` (client) with provider Selects, ordered step list (up/down + add/remove), optimistic-version save flow.
- Action buttons on `/workflows` list page: Clone, Edit, Delete (FK-aware 409 → toast), Reset (built-ins only, with confirmation), Export (file download), Toggle Enabled.
- Import button on `/workflows` (file picker → `POST /api/workflows/import`).
- Help-line under provider selects: "`enrich_chunks` uses the global `enrich_chunks_llm_provider` setting (added in Phase 4), not this workflow's `script_llm_provider`."
- API response boundary keeps the camelCase mapping established in Phase 1 (Task 14).

**Not doing:**
- Input-availability validator (Phase 3).
- `GET /api/workflows/schema` endpoint (Phase 3).
- `claude_cli` script provider — Phase 4 adds it; Phase 2's `script_llm_provider` Zod enum includes both `"openrouter"` and `"claude_cli"`, but only `"openrouter"` resolves at runtime until Phase 4. The editor lists both; selecting `claude_cli` and queueing a video before Phase 4 will fail the LLM registry lookup. Document this in the editor (a "(coming in Phase 4)" suffix on the option).
- `enrich_chunks_llm_provider` setting (Phase 4).
- Unified `generate_main_images` / `generate_hook_video` step files (Phase 5). Phase 2's editor never shows these slugs in the step picker (they don't exist yet) — only `module === "script"` slugs are pickable, and image/video module slots are filled by the four `*_provider` columns plus the Phase 1 transitional mapping (README Invariant A).
- Drag-and-drop step reordering — v1 uses up/down buttons.
- Drafts UI / AI-skill integration (Phase 6).
- Per-workflow validation rules (e.g., warn on duplicate TTS step) — explicitly deferred.
- Workflow-snapshot cascading on workflow PATCH — by design (Invariant B point 4): edits to a workflow do not affect already-queued or in-flight videos. Only `new`-status videos that re-resolve their snapshot at queue time pick up the changes.
- No changes to `src/app/videos/page.tsx` or `src/app/videos/add-video-modal.tsx` — Phase 1 Task 17 already wired these to the DB-driven workflow list. Phase 2 does not need to touch them.
- No changes to `src/app/api/videos/[id]/route.ts` — Phase 1 Task 13 added the `enabled` check on workflow_id PATCH. Phase 2 does NOT propagate `enabled=0` to existing `new`-status videos: they retain their already-pinned workflow_id and can still be queued. The `enabled` flag only blocks new POSTs and PATCH workflow_id changes.

---

## Tasks

### Phase 2A — Zod schemas + repo write helpers

- [x] **Task 1: `src/lib/workflows-schema.ts` (new)**
  **Files**: `src/lib/workflows-schema.ts` (new)
  **What**: Export three Zod schemas:
  - `WorkflowRowSchema` — `{ id (kebab-case slug regex), label (1..120), short_label (1..40), description (≤500, nullable), script_llm_provider (enum: openrouter|claude_cli), tts_provider (enum: ai33, nullable), image_provider (enum: comfyui|google_flow, nullable), video_provider (enum: comfyui|google_flow, nullable), enabled (coerced bool, optional), steps (array of { step_name: enum derived from REAL_STEPS where module === "script" }, min 0) }`. Used by POST and Import.
  - `WorkflowPatchSchema = WorkflowRowSchema.omit({ id: true }).partial().extend({ expected_version: z.coerce.number().int().min(1) })`. The explicit `.omit({ id: true })` removes `id` from the schema entirely; Zod's default mode (`.strip()`) silently drops unknown keys, so `parsed.id` is always `undefined` even if the body sent it. Slug is URL-only — handler must never write a slug change.
  - `WorkflowImportSchema = WorkflowRowSchema` — same shape; the import endpoint reuses it. **`is_builtin` is intentionally NOT in `WorkflowRowSchema`** — it's a server-controlled flag, set to `0` for user-created/imported rows and to `1` only by `seedDefaultWorkflows` (Phase 1). If a JSON import contains `is_builtin: 1`, Zod's default mode (`.strip()`, NOT `.strict()`) silently drops unknown keys, so `parsed.is_builtin` is `undefined`; the import endpoint hardcodes `is_builtin = 0` for new rows and preserves the existing value on overwrite.

  **Reference Zod shape:**

  ```ts
  import { z } from "zod";
  import { REAL_STEPS } from "@/worker/steps";

  const SCRIPT_STEP_NAMES = REAL_STEPS.filter(s => s.module === "script").map(s => s.name);

  export const WorkflowRowSchema = z.object({
    id: z.string().regex(/^[a-z0-9-]+$/, "kebab-case slug"),
    label: z.string().min(1).max(120),
    short_label: z.string().min(1).max(40),
    description: z.string().max(500).nullable().optional(),
    script_llm_provider: z.enum(["openrouter", "claude_cli"]),
    tts_provider: z.enum(["ai33"]).nullable(),
    image_provider: z.enum(["comfyui", "google_flow"]).nullable(),
    video_provider: z.enum(["comfyui", "google_flow"]).nullable(),
    enabled: z.coerce.boolean().optional(),
    steps: z.array(z.object({
      step_name: z.enum(SCRIPT_STEP_NAMES as [string, ...string[]]),
    })).min(0),
  });

  export const WorkflowPatchSchema = WorkflowRowSchema
    .omit({ id: true })
    .partial()
    .extend({ expected_version: z.coerce.number().int().min(1) });

  export const WorkflowImportSchema = WorkflowRowSchema;
  ```

  **Description nullability:** `description: z.string().max(500).nullable().optional()` lets the field be `string`, `null`, or `undefined`. The form (Task 13) sends `null` to clear, omits to keep, sends a string to set. The repo `update` helper (Task 2) must distinguish `undefined` (skip) from `null` (write SQL NULL).
  **Context**: This file is **per-row, NOT global** — these schemas validate columns on individual workflow rows, unlike global keys in `src/lib/settings.ts`. Do NOT add them to `src/lib/settings.ts`. Derive `SCRIPT_STEP_NAMES` at module load via `REAL_STEPS.filter(s => s.module === "script").map(s => s.name)` — Phase 1 (Task 6) already added `module` to the `Step` interface. The Zod enum needs `[string, ...string[]]` casting because Zod requires a non-empty tuple type. **Cross-phase consistency check:** Phase 1 Task 4a's `WorkflowRow` type must have `description: string | null` (nullable) to match this schema. If Phase 1 typed it as `string`, fix Phase 1 first.

- [x] **Task 2: Extend `src/lib/repos/workflows.ts` with write helpers**
  **Files**: `src/lib/repos/workflows.ts`
  **What**: Add atomic SQL wrappers (no business logic):
  - `insert(db, row: WorkflowRow): void` — inserts a single workflow row (sets `created_at`/`updated_at`/`version=1` at the call-site, not here — repo helpers are atomic). On `id` collision, `better-sqlite3` throws a constraint error which the route handler catches → 409.
  - `replaceSteps(db, workflow_id, steps: { step_name: string }[]): void` — DELETE + bulk INSERT inside the caller's transaction. Set `position` from the array index; the exact base (0- or 1-based) **must match Phase 1's `seedDefaultWorkflows` convention** (Phase 1 Task 2). Read Phase 1's seed code to confirm before implementing — getting this wrong silently breaks `findStepsByWorkflow`'s `ORDER BY position` reads.
  - `update(db, id, fields: Partial<WorkflowRow>): void` — partial UPDATE on the workflows row. Caller is responsible for setting `updated_at` and bumping `version`. **Field semantics:** `undefined` = skip the field (no change); `null` = write SQL NULL (only meaningful for nullable columns: `description`, `tts_provider`, `image_provider`, `video_provider`); a value = write the value. Build the `SET ...` clause dynamically over only the fields with `!== undefined` keys.
  - `bumpVersion(db, id): { version: number }` — atomic `UPDATE workflows SET version = version + 1, updated_at = ? WHERE id = ?` returning new version.
  - `deleteById(db, id): { deleted: boolean }` — DELETE; the FK `videos.workflow_id → workflows.id ON DELETE RESTRICT` (Phase 1 Task 1) raises a SQLite constraint error on in-use rows; the route handler catches it.
  - `countVideosUsingWorkflow(db, id): number` — for the friendly DELETE 409 response. Single `SELECT COUNT(*) FROM videos WHERE workflow_id = ?`.
  **Context**: Atomic-statement convention per `src/lib/repos/videos.ts:1-36` header. Multi-statement composition (insert workflow + insert steps in one go) happens at API-route call sites inside `db.transaction(...)`. Phase 1 added `findById` / `list` / `findStepsByWorkflow`; Phase 2 only adds the write side.

### Phase 2B — API routes

- [x] **Task 3: `POST /api/workflows`**
  **Files**: `src/app/api/workflows/route.ts` (extend — Phase 1 added GET)
  **What**: Add `POST` handler. Validates body with `WorkflowRowSchema`. Inside `db.transaction`:
  1. `repo.insert(db, { ...parsed, is_builtin: 0, version: 1, created_at: now, updated_at: now })` — let the PK constraint enforce uniqueness; catch the SQLite constraint error and return 409 `{ error: "workflow_id_exists" }`.
  2. `repo.replaceSteps(db, id, parsed.steps)`.

  Return 201 with the camelCase-mapped full row (same shape as Phase 1's GET).
  **Context**: 201 + body pattern at `src/app/api/videos/route.ts:48,78`. Phase 1 (Task 14) defined the camelCase mapping at the response boundary — reuse the same mapper helper. `is_builtin = 0` for all user-created workflows (built-ins are only seeded by `seedDefaultWorkflows` in Phase 1). The PK-collision-as-409 pattern avoids a TOCTOU pre-check; in `better-sqlite3`'s synchronous model, the race is theoretical, but relying on the constraint is cleaner. Same pattern applies to clone (Task 6).

- [x] **Task 4: `PATCH /api/workflows/[id]` with optimistic version**
  **Files**: `src/app/api/workflows/[id]/route.ts` (extend — Phase 1 added GET)
  **What**: Add `PATCH` handler. Validates body with `WorkflowPatchSchema`. Inside `db.transaction`:
  1. `repo.findById(db, id)` — 404 if missing.
  2. Compare `current.version !== parsed.expected_version` → return 409 `{ error: "version_conflict", current_version: current.version }`.
  3. Destructure `parsed` to separate the workflow-row fields from the non-column fields: `const { steps, expected_version, ...rowFields } = parsed;`. Then `repo.update(db, id, rowFields)` if `rowFields` has any keys. (Do NOT pass `expected_version` or `steps` into `repo.update` — neither maps to a `workflows` column. Don't pass `updated_at` either — `bumpVersion` (step 5) sets it as part of its atomic statement.)
  4. If `parsed.steps` present: `repo.replaceSteps(db, id, parsed.steps)`.
  5. `repo.bumpVersion(db, id)` — atomically increments `version` and sets `updated_at = now`; returns new version.

  Return 200 with the camelCase-mapped updated row (including new `version`).
  **Context**: Optimistic concurrency is new — confirmed absent in `src/` (no `expected_version` matches anywhere). The 409 response shape `{ current_version }` lets the client decide whether to reload. The PATCH guard does NOT distinguish editing built-ins vs. customs — both are editable. The "Reset" path (Task 7) is the supported way to revert built-in customizations. **`id` is excluded from the PATCH body** — slug is derived from the URL param. The `WorkflowPatchSchema.omit({ id: true })` plus Zod's default `.strip()` mode means `parsed.id` is always `undefined`, so the handler doesn't need an explicit guard.

  **Snapshot non-cascade reminder (Invariant B point 4):** PATCH on a workflow does NOT touch `videos.workflow_snapshot`. Only `new`-status videos pick up the change at their next `transitionNewToQueued`. Already-queued/in-flight videos continue to run their pinned snapshot. Do not add cascade logic here.

- [x] **Task 5: `DELETE /api/workflows/[id]` with FK 409 + built-in protection**
  **Files**: `src/app/api/workflows/[id]/route.ts`
  **What**: Add `DELETE` handler. Inside `db.transaction`:
  1. `repo.findById(db, id)` — 404 if missing.
  2. **Built-in protection:** if `current.is_builtin === 1`, return 400 `{ error: "cannot_delete_builtin" }`. Built-ins must be Reset (Task 7), not deleted. This makes the API symmetric with the UI (Task 10 hides the Delete button on built-ins).
  3. `repo.countVideosUsingWorkflow(db, id)` — if > 0, return 409 `{ error: "workflow_in_use", videos_count: N }` without attempting the delete.
  4. `repo.deleteById(db, id)` — should always succeed at this point (step 3 prevented in-use). `workflow_steps` rows cascade via Phase 1's `ON DELETE CASCADE` FK.

  Return 200 `{ deleted: true }`.
  **Context**: Do the explicit `countVideosUsingWorkflow` check rather than relying on the `videos.workflow_id` FK's `ON DELETE RESTRICT` to fire — explicit count gives a deterministic message and the video count for the UI. The built-in protection is added here to match Reset's `is_builtin` check (Task 7) and prevents a user from deleting `comfyui`/`google-flow` and then having to re-seed via `npm run db:init`. Customs (`is_builtin = 0`) are deletable when not in use.

- [x] **Task 6: `POST /api/workflows/[id]/clone`**
  **Files**: `src/app/api/workflows/[id]/clone/route.ts` (new)
  **What**: Body is `{ new_id: string, new_label?: string, new_short_label?: string }`. Validate `new_id` against the kebab-case regex from `WorkflowRowSchema`. Inside `db.transaction`:
  1. `repo.findById(db, id)` — 404 if source missing.
  2. Reject if `new_id === id` (cloning into self) → 409 `{ error: "workflow_id_exists" }`.
  3. Read source steps via `repo.findStepsByWorkflow(db, id)`.
  4. Build the new row: same provider columns + description as source. `label` = `new_label ?? "<source.label> (copy)"`. `short_label` = `new_short_label ?? source.short_label`. `is_builtin = 0`, `enabled = 1`, `version = 1`, fresh timestamps.
  5. Insert via `repo.insert` — let PK collision throw → 409 `workflow_id_exists` (same pattern as Task 3).
  6. Insert step rows for the new id.

  Return 201 with the new row.
  **Context**: `is_builtin = 0` always — clones are user workflows even when cloned from a built-in. The default label suffix `(copy)` makes it visually distinct in the list table; `new_short_label` is offered for users who clone to maintain a parallel variant and care about queue-table compactness.

- [x] **Task 7: `POST /api/workflows/[id]/reset` (built-ins only)**
  **Files**: `src/app/api/workflows/[id]/reset/route.ts` (new)
  **What**: Inside `db.transaction`:
  1. `repo.findById(db, id)` — 404 if missing.
  2. If `current.is_builtin === 0`, return 400 `{ error: "not_a_builtin" }`.
  3. Look up the seed in `BUILTIN_WORKFLOWS` from `src/lib/db.ts` (Phase 1 Task 2). If not found in seeds (somehow built-in flag is set but no seed exists), return 500 `{ error: "no_seed_for_builtin" }`.
  4. Replace all editable fields from the seed: `label`, `short_label`, `description`, four `*_provider` columns. Explicitly set `enabled = 1` (the seed structure does not include this field — it's defaulted to 1 by the schema; reset always restores to enabled). Bump `updated_at`.
  5. `repo.replaceSteps(db, id, seed.steps)`.
  6. `repo.bumpVersion(db, id)`.

  Return 200 with the reset row.
  **Context**: The "Reset to default" button surfaces this endpoint behind a confirmation modal (Task 10). Phase 1 seeds built-ins via `INSERT OR IGNORE`, which means seed-code updates do not propagate to existing rows — Reset is the supported path for pulling updated built-in definitions when seed code changes. Must export `BUILTIN_WORKFLOWS` from `src/lib/db.ts` (Phase 1 had it as an internal const) — the cleanest route is to keep it in `db.ts` and re-export from `src/lib/workflows.ts` for callers, so reset-route imports the seed via the lib not the DB module.

- [x] **Task 8: `POST /api/workflows/import` (with `?overwrite=1`)**
  **Files**: `src/app/api/workflows/import/route.ts` (new)
  **What**: Body is workflow JSON matching `WorkflowImportSchema` (same as `WorkflowRowSchema`). Query param `?overwrite=1` opts in to overwrite an existing row.
  1. Validate body with `WorkflowImportSchema`.
  2. Inside `db.transaction`:
     - If `repo.findById(db, parsed.id)` exists:
       - No `?overwrite=1` → 409 `{ error: "workflow_id_exists", current_version: current.version }`.
       - With `?overwrite=1`: destructure `const { id: _id, steps, ...rowFields } = parsed;` (drop the slug — it's the PK and equals the URL/lookup id; drop `steps` — handled by `replaceSteps`). Then `repo.update(db, parsed.id, rowFields)` + `repo.replaceSteps(db, parsed.id, steps)` + `repo.bumpVersion(db, parsed.id)`. **Built-ins are overwritable via Import** — symmetric with PATCH (Task 4 explicitly allows editing built-ins). The `is_builtin` flag itself is preserved because `rowFields` doesn't include it (it's not in the schema; Zod strips it).
     - Else: insert as new (same as POST flow), `is_builtin = 0`, `version = 1`.
  3. Return 201 (created) or 200 (overwrote) with the row.

  **Context**: Phase 6 will reuse this endpoint from the drafts pipeline. The `?overwrite=1` query parameter is opt-in to make accidental overwrites impossible — the default behavior on collision is 409. Symmetry rationale: PATCH on a built-in is allowed (Task 4); blocking Import would be inconsistent. Reset (Task 7) remains the way to *restore* a built-in to its seeded definition; Import is just bulk-PATCH-by-JSON.

- [x] **Task 9: `GET /api/workflows/[id]/export`**
  **Files**: `src/app/api/workflows/[id]/export/route.ts` (new)
  **What**:
  1. `repo.findById(db, id)` + `repo.findStepsByWorkflow(db, id)` — 404 if missing.
  2. Build the canonical export shape:
     ```jsonc
     {
       "id": "string",
       "label": "string",
       "short_label": "string",
       "description": "string | null",  // nullable — emit literal null when unset, do not omit the key
       "script_llm_provider": "openrouter | claude_cli",
       "tts_provider": "ai33 | null",   // nullable
       "image_provider": "comfyui | google_flow | null",
       "video_provider": "comfyui | google_flow | null",
       "enabled": true,                  // boolean (always present)
       "steps": [{ "step_name": "string" }]
     }
     ```
     Excluded: `version`, `created_at`, `updated_at`, `is_builtin`. Re-importing produces a clean v1 row. **Nullable fields emit literal `null`** (not omit) so re-import via `WorkflowRowSchema.nullable()` accepts them without ambiguity.
  3. Return 200 with `Content-Type: application/json` and `Content-Disposition: attachment; filename="<id>.json"` so browsers offer a download.

  **Context**: The export shape is **snake_case** (matches the JSON-on-disk format that Phase 6's AI skill produces). This is a deliberate divergence from the camelCase API response boundary — the exported file is a portable artifact, not an API response. A user editing a downloaded JSON and re-importing should see the same shape going in and out. Document this in a code comment so it doesn't get "consistency-fixed" later.

### Phase 2C — `/workflows` list page actions

- [x] **Task 10: Action buttons + Reset confirmation modal on `/workflows`**
  **Files**: `src/app/workflows/page.tsx`, `src/app/workflows/workflows-table.tsx` (new — extracted client component for action handlers)
  **What**:
  - Extract the read-only table from Phase 1's `page.tsx` into a new client component `workflows-table.tsx`. The page.tsx stays a server component that does the DB read and passes rows as props.
  - Add an "Actions" column with: Edit (link to `/workflows/[id]/edit`), Clone (opens slug input dialog), Delete (confirmation dialog — **hidden for `isBuiltin === true` rows**, since Task 5 returns 400 `cannot_delete_builtin`), Reset (built-ins only), Export (anchor `download` attribute pointing at `/api/workflows/[id]/export`), Toggle Enabled (PATCH with current version + flipped `enabled`).
  - **Toggle Enabled version handling:** the row data from `GET /api/workflows` (Phase 1 Task 14) includes `version`. Capture this client-side per row and send `expected_version: row.version` in the PATCH body alongside `enabled: !row.enabled`. On 200, update the local row's `version` from the response. On 409 `version_conflict` (rare — race with another tab), show "Workflow was modified elsewhere — refresh page" toast and trigger `router.refresh()`.
  - Action handlers use `import { toast } from "sonner"` for success/failure feedback.
  - For Delete and Reset, **reuse the generic `ConfirmDialog` at `src/app/videos/confirm-dialog.tsx`** (props: `title`, `message`, `confirmLabel`, `destructive`, `busy`, `onCancel`, `onConfirm`) — do NOT clone `delete-confirm-dialog.tsx` (which is video-specific with hardcoded video status logic). Delete flow: open dialog with "Delete workflow `<id>`? This cannot be undone." → on confirm, fire DELETE; if response is 409 `workflow_in_use`, close the dialog and toast "This workflow is used by N videos. Delete or reassign them first." (no client-side pre-check — single round trip; the 409 path is the source of truth). Reset: `destructive: true`, message "Reset built-in to default? Any customizations to its label, providers, or step list will be lost."
  - For Clone, use the generic `Dialog` primitive (`src/components/ui/dialog.tsx`) with `<Input>`s for `new_id` (required) and optional `new_label` / `new_short_label` (Task 6 accepts both). Server validates the slug regex.
  **Context**: Pattern reference for table-with-actions: `src/app/videos/video-queue-table.tsx`. Generic confirm primitive: `src/app/videos/confirm-dialog.tsx`. Built-ins are identifiable by `isBuiltin === true` from the API response (Phase 1 Task 14 established the camelCase boundary — `is_builtin → isBuiltin`). The `confirm-dialog.tsx` should ideally move to `src/components/ui/` since it's now reused outside `videos/` — note for the implementer: leave it where it is for Phase 2 (avoid scope creep), import it via `@/app/videos/confirm-dialog`.

- [x] **Task 11: Import button (file picker → POST `/api/workflows/import`)**
  **Files**: `src/app/workflows/workflows-table.tsx`
  **What**: Header-row "Import workflow" button opens a hidden `<input type="file" accept="application/json">`. On file select:
  1. `await file.text()`.
  2. `JSON.parse` (catch errors → toast "Invalid JSON file").
  3. `fetch("/api/workflows/import", { method: "POST", body: JSON.stringify(parsed), headers: { "Content-Type": "application/json" } })`.
  4. On 400 `{ error: "invalid_input", issues }` (Zod schema rejection): toast `"Invalid workflow JSON: " + (issues[0]?.message ?? "schema mismatch")`.
  5. On 409 `workflow_id_exists`: secondary `ConfirmDialog` "A workflow with this ID exists. Overwrite?" → if confirmed, retry with `?overwrite=1`. Built-ins use the same overwrite confirm flow as customs (Task 8 allows built-in overwrite).
  6. On success: toast "Imported `<id>`" and `router.refresh()`.
  **Context**: No existing file-upload UI in the codebase (confirmed). Use a hidden `<input type="file" ref={...}>` triggered by a button click — minimal-surface approach, no drag-and-drop. The retry-with-overwrite flow uses the generic `ConfirmDialog` (Task 10).

### Phase 2D — Edit page

- [x] **Task 12: `/workflows/[id]/edit` server-component shell**
  **Files**: `src/app/workflows/[id]/edit/page.tsx` (new)
  **What**: Server component. Calls `getDb()`, then:
  - `getWorkflowFromDb(db, params.id)` from `src/lib/workflows.ts` (Phase 1 Task 4) for the row metadata (`label`, `short_label`, `description`, four provider columns, `enabled`, `version`). 404 page if missing.
  - `resolveSnapshot(db, params.id).steps` from the same lib for the ordered `[{ step_name }]` array. (Phase 1 Task 3's `findStepsByWorkflow` is in `src/lib/repos/workflows.ts` and is internal; the lib is the public boundary, and `resolveSnapshot` already returns the steps in the right shape — extra snapshot fields like `script_llm_provider` are present but harmless when the page only reads `.steps`.)

  Passes the row + steps + the catalog of script-step metadata (`REAL_STEPS.filter(s => s.module === "script")` materialized into `{ name, label, description, for_each? }[]`) to the client `<EditForm>`.
  **Context**: Server-component pattern at `src/app/videos/page.tsx:14-30`. Phase 3 will introduce `GET /api/workflows/schema` for the AI skill, but the edit page does not need an HTTP fetch — it imports `REAL_STEPS` directly server-side and serializes the script subset into the page payload. (The edit form is a client component, so the script catalog must traverse the server→client serialization boundary as plain props.)

- [x] **Task 13: `EditForm` client component — provider Selects + step list reorder**
  **Files**: `src/app/workflows/[id]/edit/edit-form.tsx` (new)
  **What**: Client component (`"use client"`). Form fields:
  - **Top section** (mirrors Phase 1's read-only display layout):
    - `id` — read-only text (slugs are immutable post-create); excluded from the PATCH body (the slug comes from the URL).
    - `label` — `<Input>` (max 120 chars).
    - `short_label` — `<Input>` (max 40 chars).
    - `description` — `<Textarea>` (max 500 chars, nullable). The form must explicitly transform `""` → `null` before sending in the PATCH body — Zod won't coerce empty string to null automatically. Match the schema's `nullable().optional()` shape: send `null` for empty, omit the field if unchanged.
    - `enabled` — checkbox.
  - **Provider section** — four `<Select>` components:
    - `script_llm_provider`: options `[{ value: "openrouter", label: "OpenRouter" }, { value: "claude_cli", label: "Claude CLI (coming in Phase 4)" }]`.
    - `tts_provider`: options `[{ value: "ai33", label: "AI33" }, { value: "__none__", label: "(none)" }]` — the radix Select primitive **rejects empty-string values at runtime**, so use a sentinel `"__none__"` and map it to SQL NULL on submit. Same pattern for `image_provider` and `video_provider`.
    - `image_provider`: `[{ value: "comfyui", ... }, { value: "google_flow", ... }, { value: "__none__", label: "(none)" }]`.
    - `video_provider`: same shape as image_provider.
    - Help-line (Task 15) under the provider section.
  - **Step list section** — ordered table, columns: position, step label, for_each badge (if present), up/down/remove buttons. Below the table: an Add Step `<Select>` populated with the script-catalog (label as display text, name as value), plus an Add button that appends to the list.
    - Up/Down buttons swap with neighbor; disabled at boundaries.
    - Remove button removes the row.
    - Each row's tooltip (`title` attribute) shows the step's `description`.
    - For_each badge text: `"multi-output: chapters"` or `"multi-output: chunks"`.
  - **Submit row** — Save button + "Validate now" button (Phase 3 wires this; Phase 2 hides it — do not render until Phase 3 ships). Save submits PATCH (Task 14).
  - **Dirty tracking** — match the `dirtyDiff` pattern from `settings-form.tsx:93,124`. Submit only changed fields. The `steps` array uses **deep equality** comparison (e.g., `JSON.stringify(steps) !== JSON.stringify(originalSteps)`) — reference equality is insufficient because reorder/add/remove mutates a new array each render. Include `steps` in the PATCH body whenever the deep-equality check fails.
  **Context**: Form primitives at `src/components/ui/{input,textarea,select,checkbox,button,label}.tsx`. No `Switch` component exists — use `<Checkbox>` for the `enabled` flag (matches existing settings-form usage). `FieldGroup`/`FieldGrid`/`FieldLabel` are local helpers in `settings-form.tsx:550,567,586` — copy them into a small local helpers block at the top of `edit-form.tsx` rather than extracting (Phase 2 should not touch settings-form; an extraction is out of scope here).

- [x] **Task 14: Optimistic version save flow**
  **Files**: `src/app/workflows/[id]/edit/edit-form.tsx`
  **What**: Form holds a `currentVersion` state, initialized from the server-rendered `version` (Task 12 passes it as a prop). Save submits `fetch("/api/workflows/[id]", { method: "PATCH", body: JSON.stringify({ ...dirtyFields, expected_version: currentVersion }) })`.
  - 200 → `toast.success("Saved")`, set `currentVersion` to the server-returned new version, reset dirty flags, `router.refresh()` so the list page re-reads on next nav. Subsequent saves in the same session use the updated `currentVersion`.
  - 409 `version_conflict` → `toast.error("Workflow was modified elsewhere", { action: { label: "Reload", onClick: () => location.reload() } })`. Do not silently merge — explicit reload preserves the operator's mental model.
  - 400 → `toast.error(<message>)`. **API error response shape (define this consistently across all Phase 2 routes that use Zod):** `{ error: "invalid_input", issues: ZodIssue[] }`. The toast extracts `issues[0]?.message ?? "Invalid input"`. Phase 2's only validation surface beyond schema shape is "step_name in script catalog" — Phase 3 adds input-availability warnings.
  **Context**: Sonner `action` API supports inline action buttons in toasts. Crucial: the second save in a session uses the *response's* version, not the page-load version — otherwise every second-save would 409 itself. The `{ error, issues }` shape is the convention all Phase 2 write routes (POST/PATCH/import/clone/reset) use for Zod failures so client-side toast logic is uniform.

- [x] **Task 15: Help-line under the provider section**
  **Files**: `src/app/workflows/[id]/edit/edit-form.tsx`
  **What**: Small text under the four provider Selects: "Note: `enrich_chunks` uses the global `enrich_chunks_llm_provider` setting (added in Phase 4), not this workflow's `script_llm_provider`."
  **Context**: Help-text style at `settings-form.tsx:644,698` — `<p className="text-xs text-muted-foreground">`. Reads as a forward-looking note; once Phase 4 ships, the parenthetical "(added in Phase 4)" is removed.

### Phase 2E — Tests

> Tests run after the implementation tasks in 2A–2D. Within 2E: Tasks 16, 17, and 21 are independent (each owns its own files). Tasks 18, 19, and 20 all live in the same file (`__tests__/api/workflows/[id]/route.test.ts`) — Task 18 creates it; 19 and 20 extend it. Within that group, the order doesn't matter beyond "create the file before extending it."

> **Already covered during 2B:** Tests for the routes were written alongside each route during Phase 2B, so several tasks below are already satisfied by existing test files. Status as of end of 2B:
> - **Task 16** — partial. `__tests__/api/workflows/import/route.test.ts` covers insert / 409-without-overwrite / overwrite-with-version-bump / `is_builtin` preservation / Zod failure / `is_builtin` strip-from-body. `__tests__/api/workflows/[id]/export/route.test.ts` covers the canonical snake_case shape, literal-null nullables, `Content-Disposition` header, and 404. **Missing:** the end-to-end `export → re-import-under-different-id` round-trip in a single test.
> - **Task 17** — **not started.** This is the only Phase 2E task with no existing coverage. It belongs in `src/lib/workflows-edit.test.ts` (or pipeline integration), not in `__tests__/api/`.
> - **Task 18** — covered by `[id]/route.test.ts` "returns 409 version_conflict on stale expected_version".
> - **Task 19** — covered by `[id]/route.test.ts` "rejects non-script step_name with 400 invalid_input".
> - **Task 20** — covered by `[id]/route.test.ts` "returns 400 cannot_delete_builtin for built-in rows" / "returns 409 workflow_in_use with videos_count when used by videos" / "deletes a custom unused workflow + cascades workflow_steps".
> - **Task 21** — covered by `[id]/reset/route.test.ts` "restores a heavily-customized built-in to its seeded definition" / "returns 400 not_a_builtin for custom workflows".
>
> When picking up 2E, the remaining work is: (a) one round-trip test for Task 16, and (b) the full Task 17 integration scenarios.


- [x] **Task 16: Unit — round-trip JSON export/import**
  **Files**: `__tests__/api/workflows/import/route.test.ts` (new), `__tests__/api/workflows/[id]/export/route.test.ts` (new)
  **What**: Seed a custom workflow (cloned from `comfyui`). Call the export endpoint → assert response shape excludes `version`/`created_at`/`updated_at`/`is_builtin` and `Content-Disposition: attachment` header is set. Re-import the JSON under a different `id` → row appears with `is_builtin = 0`, `version = 1`. Re-import the same JSON under the same `id` without `?overwrite=1` → 409. Re-import with `?overwrite=1` → 200, `version` bumped.
  **Context**: Existing API-route tests live under `__tests__/api/...` mirroring the route path (`__tests__/api/videos/route.test.ts`, `__tests__/api/videos/[id]/route.test.ts`, etc.) — follow that convention. Use the same `getDb()` + seeded fixtures pattern as `__tests__/api/videos/route.test.ts`.

- [x] **Task 17: Integration — clone + customize + snapshot lifecycle**
  **Files**: `src/worker/pipeline.test.ts` (extend) or new `src/lib/workflows-edit.test.ts`
  **What**: Two scenarios.

  **Scenario A — basic plumbing:**
  1. Clone `comfyui` to `comfyui-trimmed`.
  2. PATCH `comfyui-trimmed` to remove `research_characters` from the step list.
  3. `createNewVideo({ workflow_id: "comfyui-trimmed" })` — assert snapshot contains the trimmed step list.
  4. `transitionNewToQueued` — assert snapshot is preserved.
  5. Call `resolveDeps` — assert the returned step list matches the trimmed list materialized through `materializeStepList`.

  **Scenario B — re-snapshot semantics (Invariant B point 3):**
  1. Clone `comfyui` to `comfyui-edit-after`.
  2. `createNewVideo({ workflow_id: "comfyui-edit-after" })` — capture the initial snapshot (full step list).
  3. PATCH `comfyui-edit-after` to remove `research_characters` (workflow now has trimmed step list, but the video's snapshot still has full).
  4. `transitionNewToQueued` — assert the snapshot was *re-resolved* and now contains the trimmed step list (matches the post-edit workflow, NOT the pre-edit snapshot).
  5. PATCH the workflow again to remove `write_hook`. Assert the video's snapshot still has the trimmed-but-not-double-trimmed list (immutability after queued).

  **Context**: This exercises the Phase 1 Invariant B contract end-to-end with a customized workflow. Scenario A tests plumbing only — the trimmed step list creates an input gap in `write_hook`, but the test asserts only that the right slugs flow through, not pipeline runtime success. Scenario B is the critical re-snapshot test that proves the queue-time freshness rule (Invariant B point 3) and post-queue immutability (Invariant B point 4) — without it, a regression in the `transitionNewToQueued` snapshot rebuild would silently break the contract.

- [x] **Task 18: Concurrency — stale `expected_version` returns 409**
  **Files**: `__tests__/api/workflows/[id]/route.test.ts` (new)
  **What**: Two PATCH calls in sequence with the same `expected_version`. First returns 200; second returns 409 `{ current_version }`. Verify `current_version` matches the post-first-PATCH value.
  **Context**: New territory — no existing test covers optimistic concurrency. The test fixture must seed a workflow, read its current version, then issue both PATCHes with the captured value.

- [x] **Task 19: Validation — non-script step_name returns 400**
  **Files**: `__tests__/api/workflows/[id]/route.test.ts` (extend Task 18's file)
  **What**: PATCH a workflow with `steps: [{ step_name: "voiceover" }]` (a `module: "tts"` step, not script). Zod enum rejection → 400. Verify error message identifies the offending step.
  **Context**: The `script` subset enum is derived at module load via `REAL_STEPS.filter(s => s.module === "script").map(s => s.name)`. Test fixture must include the seeded built-in workflows so the script catalog is correct.

- [x] **Task 20: DELETE 400 on built-in + 409 when workflow in use**
  **Files**: `__tests__/api/workflows/[id]/route.test.ts` (extend)
  **What**: Three cases:
  1. DELETE `/api/workflows/comfyui` (built-in) → 400 `{ error: "cannot_delete_builtin" }`. The row remains.
  2. Clone `comfyui` to `custom`; seed a video with `workflow_id = "custom"`. DELETE `/api/workflows/custom` → 409 `{ error: "workflow_in_use", videos_count: 1 }`. The row remains.
  3. Clone `comfyui` to `unused`. DELETE `/api/workflows/unused` → 200 `{ deleted: true }`. Row + `workflow_steps` rows gone.
  **Context**: The test must exercise the explicit count-check branch (Task 5), not just the FK-constraint catch path. Case 1 is the new built-in protection (Task 5 step 2). Cases 2 and 3 cover the in-use and clean delete paths.

- [x] **Task 21: Reset built-in restores seeded definition**
  **Files**: `__tests__/api/workflows/[id]/reset/route.test.ts` (new)
  **What**: PATCH `comfyui` to a heavily customized state (different label, removed script step, flipped `enabled`). Call `POST /api/workflows/comfyui/reset` → row matches the seed exactly (label, providers, full original step list, `enabled = 1`), `version` bumped from the customized value. Also verify `POST /api/workflows/<some-non-builtin>/reset` returns 400 `{ error: "not_a_builtin" }`.
  **Context**: Validates the Invariant — built-in code updates do not auto-propagate (Phase 1's `INSERT OR IGNORE` only seeds on init), but Reset is the supported pull-from-code path.

---

## Done Criteria

Implementation completion = all of these hold.

- User can clone `comfyui` to `comfyui-custom` → rename label → change `description` → save → queue a video using it → video runs successfully (the cloned workflow's step list is unchanged from the source, so all input dependencies are satisfied).
- Export downloads a JSON file. Editing it (e.g., changing the label) and re-importing under a new `id` round-trips cleanly. Re-importing under the same `id` without `?overwrite=1` returns 409; with `?overwrite=1` succeeds and bumps `version`. Nullable fields export as literal `null` and re-import accepts them.
- Built-in's "Reset" button opens a confirmation modal and only re-seeds on confirm. `POST /reset` on a non-built-in returns 400 `not_a_builtin`. Import `?overwrite=1` on a built-in is allowed (symmetric with PATCH). DELETE on a built-in returns 400 `cannot_delete_builtin`.
- Editing a workflow that another tab modified produces a 409 `version_conflict` + reload-prompt toast. A second save in the same session (after a successful first save) succeeds because the form tracks `currentVersion` from the response, not the page-load version.
- Deleting a custom workflow used by a video returns 409 `workflow_in_use` with the video count.
- Editor's `script_llm_provider` Select shows both `"openrouter"` and `"claude_cli (coming in Phase 4)"`. Selecting `claude_cli` saves successfully but queueing a video fails the LLM-registry lookup (documented; Phase 4 wires it).
- The help-line about `enrich_chunks` is visible under the provider section.
- The integration test (Task 17 Scenario B) verifies that a workflow edit between `createNewVideo` and `transitionNewToQueued` is reflected in the queued snapshot, but a subsequent edit after `queued` is NOT (Invariant B points 3 + 4).
- `expected_version` / `version_conflict` are referenced only in Phase 2 sites (`workflows-schema.ts`, the workflow route handlers, the edit form, the workflows table action handlers) — no leakage into `settings.ts` or unrelated code.
