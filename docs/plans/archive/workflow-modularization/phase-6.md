# Phase 6 — AI-Skill Drafts Integration

**Cross-phase invariants:** [`README.md`](README.md) — Invariant D (drafts dashboard surfaces the same warning shape that the import helper returns from both `/api/workflows/import` and the new `/api/workflows/drafts/[filename]/import`; AI skill consumes `GET /api/workflows/schema`), Invariant E (workflow JSON has four provider fields; `enrich_chunks_llm_provider` is **not** a workflow field and must not appear in drafts)

---

## Overview

Surface a filesystem-backed drafts pipeline for AI-skill–generated workflow JSON. The skill (out-of-codebase) writes JSON to `prompts/workflows/drafts/<slug>.json`; the dashboard's `/workflows` page lists drafts above the main workflows table; clicking Import validates the file, commits the row via Phase 2's import logic, and atomically moves the file to `prompts/workflows/imported/<slug>-<unix_timestamp>.json`. Discard removes the file without importing.

After Phase 6, the AI-skill loop is end-to-end: skill calls `GET /api/workflows/schema` (Phase 3, Invariant D) for the live catalog, writes a draft into `drafts/`, the dashboard surfaces it, the user imports. Validator warnings (Invariant D shape) ride the import response and surface in the success toast.

---

## Current State

**After Phase 5:**
- `POST /api/workflows/import` (Phase 2 Task 8) accepts `WorkflowImportSchema`-validated JSON, supports `?overwrite=1`, returns 201/200 with the camelCase row + `warnings` array (Phase 3 Task 8). The body of this route — find-existing → insert-or-overwrite-in-transaction → bumpVersion → validate post-commit — is **inline in the route file**; Task 1 below extracts it.
- `GET /api/workflows/[id]/export` (Phase 2 Task 9) emits the canonical **snake_case** JSON shape (`id`, `label`, `short_label`, `description`, four `*_provider` fields, `enabled`, `steps[]`). This is the same shape AI-skill drafts must produce; round-trip parity (export → re-import) is the contract guarantor (Phase 2 Task 16).
- `GET /api/workflows/schema` (Phase 3 Task 4) returns `{ modules, steps, providers }` per Invariant D. Phase 4 widened `providers.script` to `["openrouter", "claude_cli"]`; Phase 5 switched `providers.image`/`video` to `Object.keys(<registry>)`. Phase 6 consumes the post-Phase-5 shape unchanged.
- `WorkflowImportSchema` exposed from `src/lib/workflows-schema.ts` (Phase 2 Task 1). Identical shape to `WorkflowRowSchema`; silently strips unknown keys (Zod default).
- `validateInputAvailability` exposed from `src/lib/workflows-validator.ts` (Phase 3 Task 2); produces `ValidationWarning[]` matching Invariant D's shape.
- `prompts/` directory exists (`prompts/01_research_outline.md`, etc.); the `prompts/workflows/` subtree does NOT yet exist — Phase 6 creates it lazily.

**Draft JSON file shape (the AI-skill contract):**
The on-disk draft format is identical to Phase 2 Task 9's export shape — snake_case, flat:

```jsonc
{
  "id": "fast-narrative",                  // kebab-case slug, becomes the workflow row PK
  "label": "Fast narrative",
  "short_label": "Fast",
  "description": "Skips character research for shorter videos.",  // string | null
  "script_llm_provider": "openrouter",     // "openrouter" | "claude_cli"
  "tts_provider": "ai33",                  // "ai33" | null
  "image_provider": "comfyui",             // "comfyui" | "google_flow" | null
  "video_provider": "comfyui",             // same
  "enabled": true,
  "steps": [                               // ordered script-module steps only
    { "step_name": "research_outline" },
    { "step_name": "write_hook" },
    { "step_name": "write_chapters" }
  ]
}
```

`for_each` is NOT in the JSON — it lives as step-file metadata. `is_builtin`, `version`, `created_at`, `updated_at` are server-controlled and must not be set by drafts (Zod silently strips, but Task 3's drafts list parser surfaces them as `unknown_field` advisories so authors notice). Round-trip parity: `/api/workflows/[id]/export` produces a file in this exact shape; the AI skill writes a file in this exact shape; both go through the same `WorkflowImportSchema` on import.
- `/workflows` page (Phase 1 Task 16, Phase 2 Tasks 10–11) renders a server-component shell + a `workflows-table.tsx` client component for action handlers. Phase 6 inserts a sibling client component for drafts above the main table.

**Patterns Phase 6 reuses:**
- Filesystem reads in `prompts/`: `src/lib/prompts.ts:21,32` — `readFileSync` + `readdirSync({ withFileTypes: true })`. The `promptsDir = "prompts"` default constant is the precedent for an injectable directory.
- Generic confirm dialog: `src/app/videos/confirm-dialog.tsx` — same primitive Phase 2 Task 10 reuses for Delete/Reset. Discard and overwrite-on-collision use it here.
- `toast.success` / `toast.error` from `sonner` (`src/app/videos/use-video-poller.ts:92,94`). Sonner's `{ action: { label, onClick } }` API supports an inline action button — used for the post-import "View" link to the editor (Task 7 below).
- File-picker pattern: Phase 2 Task 11 establishes a hidden `<input type="file" accept="application/json">` triggered by a button. Phase 6 does NOT need a file picker (drafts come from the FS, not user uploads), but the JSON-parse + 409-with-overwrite-confirm flow is the same.
- API route per-id segment: `src/app/api/videos/[id]/route.ts` is the precedent. Phase 6 uses `[filename]` as the segment.

**Confirmed absent (Phase 6 introduces):**
- No `prompts/workflows/` directory — Task 2 introduces the layout contract and creates the subdirectories lazily.
- No file-rename pattern in `src/` (`renameSync` from `node:fs` is unused). Task 5 introduces it.
- No `[filename]` route segment elsewhere in the API tree — basename validation is established here.
- No drafts UI surface; the `/workflows` page currently has only the main table + action buttons.

---

## Scope

**Doing:**
- Extract Phase 2's `import/route.ts` per-row commit logic into a shared helper `importWorkflowJson(db, payload, opts): { row, status, warnings }` (`src/lib/workflows-import.ts`, new). Phase 2's existing route refactors to call the helper; the new draft-import route also calls it. Single source of truth for insert-or-overwrite + post-commit validation.
- `prompts/workflows/drafts/` and `prompts/workflows/imported/` directory contract — both created lazily by `ensureDraftsDirs()` at any drafts API entry. The `prompts/workflows/` subtree contains user-and-AI-generated content only; bundled defaults stay in code as `BUILTIN_WORKFLOWS` (Phase 1 Task 2).
- `GET /api/workflows/drafts` — lists `drafts/*.json` (basename-validated, JSON files only), parses each, returns `[{ filename, slug, label, providers, step_count, mtime, errors }, ...]` sorted by `mtime` descending then by `filename` ascending (deterministic tie-breaker). Per-file parse failure logs and yields a row with `errors: ["invalid_json"]` (array shape — supports multiple advisories per file) so the user can discard from the UI without manual FS access.
- `POST /api/workflows/drafts/[filename]/import` — basename-validates `filename` against `/^[a-z0-9-]+\.json$/`, reads the file, calls `importWorkflowJson`, then on success `renameSync`s the source file to `imported/<slug>-<unix_timestamp>.json`. Slug-collision returns 409 from the helper; the move happens **only after** a successful commit (no orphaned imports). `?overwrite=1` query param threads through to the helper.
- `DELETE /api/workflows/drafts/[filename]` — `unlinkSync` on the validated path; 200 `{ deleted: true }`.
- `/workflows` page gains a "Drafts" section above the main table (new client component `drafts-section.tsx`):
  - Header: `Drafts (N)` + Refresh button (re-fetches `/api/workflows/drafts`).
  - Table rows: `filename | label | providers (script/tts/image/video) | step count | actions (Import, Discard)`. Rows whose `errors` contain `"invalid_json"` show the error in place of metadata and disable the Import action (Discard remains available).
  - Empty state: `"No drafts here yet. The AI skill writes drafts to prompts/workflows/drafts/. See docs/histforge-spec.md § AI workflow drafts for the contract."` Phase 6 ships that spec section (see Task 12) so the link is stable.
  - Discard click → `ConfirmDialog` ("Discard draft `<filename>`? The file will be deleted.") → DELETE.
  - Import click → POST without `?overwrite=1`; on 409, open `ConfirmDialog` ("Workflow `<slug>` already exists. Overwrite?") and re-POST with `?overwrite=1`.
- Toast on successful import — `toast.success("Imported \`<slug>\`", { action: { label: "View", onClick: () => router.push("/workflows/<slug>/edit") } })`. When the import response carries `warnings.length > 0`, append the warning count to the toast message and surface the messages via `toast.warning(...)` with `description` containing `warnings.map(w => w.message).join("\n")` — same Invariant D warning shape Phase 3 wires into the response.
- Two import surfaces coexist on `/workflows`: the file-picker Import button (Phase 2 Task 11) handles one-off user uploads; the new Drafts section handles the AI-skill loop. They share the same backend helper (Task 1) and warning shape; the dual surface is intentional — the file picker stays for users who download/edit/re-upload exports without invoking the skill.
- Tests: helper extraction round-trips both code paths; drafts list parses fixture files; draft-import slug-collision (409 → `?overwrite=1` → 200); draft-import filesystem move (file disappears from `drafts/`, appears in `imported/`); discard removes file; filename validation rejects path traversal; per-file `errors: ["invalid_json"]` surfaces correctly without breaking the list.

**Not doing:**
- The AI skill itself — out of this codebase. Phase 6 documents the contract (schema endpoint + canonical JSON shape) so a future implementer can write the skill against a stable surface; writing the skill is a separate task tracked outside this plan.
- FS watching / inotify auto-refresh — explicitly out of scope. Refresh on page load + manual Refresh button is the contract; the dashboard does not poll the filesystem.
- Bundled default drafts — `prompts/workflows/` does NOT contain seed templates. Drafts are user-or-AI-generated only.
- Pre-import dry-run / "Validate this draft" button — `POST /api/workflows/validate` (Phase 3) exists but the drafts UI does not call it. Validation runs server-side at import time; warnings ride the response. A pre-import preview is deferred for v1.
- Schema endpoint changes — Phase 6 consumes `GET /api/workflows/schema` unchanged.
- `enrich_chunks_llm_provider` in workflow JSON — Invariant E excludes it. The AI-skill prompt (out-of-codebase) must omit this field. Defense in depth: the drafts list parser surfaces an `unknown_field` advisory in the per-row `errors` array when it sees `enrich_chunks_llm_provider`, `is_builtin`, `version`, `created_at`, or `updated_at` in a draft. (Zod still silently strips them on import; the warning is purely advisory so the AI-skill author notices during iteration.) The canonical reference for the JSON contract lands in `docs/histforge-spec.md § AI workflow drafts` (Task 12).
- Cleanup of `imported/` directory: it grows monotonically and v1 leaves manual pruning to the operator. Auto-prune older than N days is deferred for v1.

---

## Tasks

### Phase 6A — Shared import helper + filesystem layout

- [x] **Task 1: Extract `importWorkflowJson` helper from the existing import route**
  **Files:** `src/lib/workflows-import.ts` (new), `src/app/api/workflows/import/route.ts` (refactor).
  **What:** New helper signature:
  ```ts
  type ImportStatus = "created" | "overwritten";
  type ImportResult = { row: WorkflowRow; status: ImportStatus; warnings: ValidationWarning[] };

  // Typed error class — code-only payload; route layer maps `code` to HTTP status.
  class ImportError extends Error {
    constructor(
      public readonly code: "invalid_input" | "workflow_id_exists",
      public readonly details?: Record<string, unknown>
    ) { super(code); }
  }

  importWorkflowJson(db, payload: unknown, opts: { overwrite: boolean }): ImportResult
  ```

  Implementation lifts the body of `src/app/api/workflows/import/route.ts` (which already includes both schema validation and post-commit `validateInputAvailability`) into the helper:
  1. `WorkflowImportSchema.safeParse(payload)` (from `@/lib/workflows-schema`) → throw `new ImportError("invalid_input", { issues: parsed.error.issues })` on failure (route maps to 400).
  2. Inside `db.transaction`: `workflowsRepo.findById(db, parsed.id)`. If exists and `!opts.overwrite` → throw `new ImportError("workflow_id_exists", { current_version: current.version })` (route maps to 409). Note: `Error` thrown from inside `db.transaction(...)()` rolls back the transaction by design (better-sqlite3 contract), so a thrown `ImportError` aborts the write cleanly.
  3. Existing + overwrite: split `parsed` into row fields and steps explicitly — `const { id: _ignored, steps, ...rowFields } = parsed; workflowsRepo.update(db, parsed.id, rowFields)` + `workflowsRepo.replaceSteps(db, parsed.id, steps)` + `workflowsRepo.bumpVersion(db, parsed.id)`. The explicit split is required because `repo.update` operates on the workflows table only — passing `steps` (handled by `replaceSteps`) or `id` (slug is immutable) would be a bug. **Do NOT pass `updated_at`**: `repo.update`'s UPDATABLE_FIELDS list excludes lifecycle fields, and `bumpVersion` (called next) stamps `updated_at = Date.now()` atomically with the version bump. New-row branch: build a full `WorkflowRow` (`is_builtin: 0`, `version: 1`, `created_at` and `updated_at` both `Date.now()`, `enabled: data.enabled === false ? 0 : 1`), then `workflowsRepo.insert(db, row)` + `workflowsRepo.replaceSteps(db, parsed.id, steps)`. Capture `successStatus: 200 | 201` and `postVersion: number` inside the transaction for use in step 5.
  4. **Race fallback:** wrap the `db.transaction(...)()` call in `try/catch`. If `workflowsRepo.isPrimaryKeyCollision(err)` returns true (a concurrent import inserted the same slug between `findById` and `insert`), re-throw `new ImportError("workflow_id_exists")`. Other errors propagate. The current import route already has this fallback at the route layer (`src/app/api/workflows/import/route.ts` lines 81–89); the helper takes ownership of it.
  5. After commit: build the just-written `WorkflowSnapshot` in-memory (workflow_id from `parsed.id`, version from `postVersion`, four provider fields from `parsed`, `steps` from `parsed.steps`) and call `validateInputAvailability(snapshot)` (from `@/lib/workflows-validator`) to produce `warnings`. The existing route does this on lines 97–106; the same logic moves here unchanged.
  6. Return `{ row: workflowsRepo.findById(db, parsed.id)!, status, warnings }`. The fresh `findById` re-read picks up the canonical `WorkflowRow` (snake_case DB shape, including the just-bumped `version` / `updated_at`).

  Refactor `src/app/api/workflows/import/route.ts` to a thin shell. The route owns three things: HTTP-layer parsing (`req.json()`, query-string), `getDb()`, and `ImportError → status` mapping. Everything else delegates to the helper:
  ```ts
  // Existing imports stay; add: import { importWorkflowJson, ImportError } from "@/lib/workflows-import";
  // Existing buildDetail import (from "@/app/api/workflows/route") stays — route still maps to camelCase.

  export async function POST(req: Request): Promise<NextResponse> {
    const overwrite = new URL(req.url).searchParams.get("overwrite") === "1";
    const payload = await req.json();          // raw parse — helper does Zod validation
    const db = getDb();
    try {
      const result = importWorkflowJson(db, payload, { overwrite });
      return NextResponse.json(
        { workflow: buildDetail(db, result.row.id), warnings: result.warnings },
        { status: result.status === "created" ? 201 : 200 }
      );
    } catch (err) {
      if (err instanceof ImportError) {
        const status = err.code === "invalid_input" ? 400 : 409;
        return NextResponse.json({ error: err.code, ...err.details }, { status });
      }
      throw err;
    }
  }
  ```
  No behavior change — every existing test in `__tests__/api/workflows/import/route.test.ts` (status codes, response body shape, `is_builtin` preservation on overwrite, the `warnings: []` and `warnings.length === 2` expectations, the export → re-import round-trip) must still pass post-refactor.

  **Context:** Defining `ImportError` as a small typed-error class (not a status-code carrier) keeps the helper framework-agnostic — the route layer owns HTTP semantics. The route still calls `buildDetail(db, row.id)` from `@/app/api/workflows/route` because the helper returns `WorkflowRow` (snake_case DB shape) and the public response is `WorkflowApiDetail` (camelCase, includes `stepCount` and the `steps[]` array — see `src/app/api/workflows/route.ts:66`). Phase 6's drafts-import route is the second consumer of `importWorkflowJson`; both routes do their own `buildDetail` mapping so the helper stays DB-shape-only.

- [x] **Task 2: Filesystem layout helpers (`drafts/` + `imported/`) + test injection**
  **Files:** `src/lib/workflows-import.ts` (extend Task 1's file).
  **What:** Add four small helpers:
  - `getPromptsRoot(): string` — returns `process.env.HISTFORGE_PROMPTS_DIR ?? "prompts"`. Single read point for the prompts-root override. Tests in Tasks 9–11 set the env var in `beforeAll` to a fresh `mkdtempSync(...)` path; production calls leave it unset and get the default `"prompts"`. This mirrors the `process.env.DATABASE_URL` pattern the existing test suite uses (`__tests__/api/workflows/import/route.test.ts:17`). Helpers and route handlers always go through `getPromptsRoot()` rather than hardcoding `"prompts"`.
  - `getDraftsDir(): string` returns `join(getPromptsRoot(), "workflows", "drafts")`; `getImportedDir(): string` returns `join(getPromptsRoot(), "workflows", "imported")`. Function form (not module-load constants) so the env-var read happens at call time — required because tests set the env var after the module is first imported. Both directories are siblings under `prompts/workflows/`, which is required so `renameSync` (Task 4) stays on the same volume — `renameSync` returns EXDEV across mount points, but siblings under a shared parent are always co-located.
  - `ensureDraftsDirs(): void` — `mkdirSync(getDraftsDir(), { recursive: true })` and same for `getImportedDir()`. Idempotent. Called at the top of every drafts API entry to handle the "first-ever-call" greenfield case.
  - `validateDraftFilename(filename: string): void` — asserts `/^[a-z0-9-]+\.json$/`. Throws `new ImportError("invalid_filename")` on mismatch (extend Task 1's `ImportError.code` union to `"invalid_input" | "workflow_id_exists" | "invalid_filename"`). The route layer maps `invalid_filename` → 400. The regex is the `WorkflowRowSchema.id` slug regex (`^[a-z0-9-]+$`, defined in `src/lib/workflows-schema.ts:22`) plus the `.json` suffix, so the filename body is structurally identical to a workflow id — basis for the archived-filename naming in Task 4.

  **Note on `draft_not_found`:** the routes in Tasks 4–5 return 404 `{ error: "draft_not_found" }` directly from an `existsSync` check rather than throwing through `ImportError`. Keeping that path as a plain HTTP-layer return (not an `ImportError` code) avoids adding an error code that no helper actually throws.
  **Context:** Path traversal defense lives here, not in each route handler — single point of audit. `mkdirSync({ recursive: true })` is a no-op if the directory exists, so the per-call overhead is negligible. The directory contract is documented in this file's top-of-file comment so future maintainers can read the layout without consulting this plan. Function-form `getDraftsDir()` (vs. a module-load `const`) is what makes the env-var injection from Tasks 9–11 actually work — a `const DRAFTS_DIR = join(...)` evaluated at module load would freeze in the production path before `beforeAll` runs.

### Phase 6B — API routes

- [x] **Task 3: `GET /api/workflows/drafts` — list drafts**
  **Files:** `src/app/api/workflows/drafts/route.ts` (new).
  **What:** GET handler:
  1. `ensureDraftsDirs()`.
  2. `readdirSync(getDraftsDir(), { withFileTypes: true })` filtering to regular files (`entry.isFile()`) whose name matches `/^[a-z0-9-]+\.json$/` (silently skip files that fail the regex — they shouldn't be in `drafts/` at all; do **not** call `validateDraftFilename` here because that throws — use the regex inline).
  3. For each kept file, `statSync(join(getDraftsDir(), entry.name))` for `mtime` (in seconds: `Math.floor(stat.mtimeMs / 1000)`) and `readFileSync(..., "utf-8")` + `JSON.parse`. Each row carries an `errors: string[]` array (always present, possibly empty). On `JSON.parse` failure, push `"invalid_json"` and emit `slug: null, label: null, providers: null, stepCount: null, mtime`. On valid JSON whose `parsed.id` is missing or non-string, push `"missing_fields"` and partial-populate what's available — the slug is what makes a draft addressable, so its absence is a stable importability gate. Other absent-but-required fields (e.g. `label`, `steps`) are NOT probed here; they fall through to the import-time Zod check, which returns 400 `invalid_input` with issue details — surfacing them as advisories at list time would create a soft probe whose result doesn't agree with the server's truth at import time.
  4. Push `"unknown_field"` to `errors` when ANY of these server-controlled keys are present in the parsed JSON: `enrich_chunks_llm_provider`, `is_builtin`, `version`, `created_at`, `updated_at`. Advisory only — Zod silently strips them at import. The check runs whether or not `id` is present; multiple advisories accumulate in the same array (e.g., a draft with no `id` AND an `is_builtin` key yields `errors: ["missing_fields", "unknown_field"]` — `missing_fields` always pushed first).
  5. Sort the result by `mtime` descending, breaking ties by `filename` ascending — deterministic order so test fixtures and UI display are stable across re-fetches.
  6. Return 200 `[{ filename, slug, label, providers: { script, tts, image, video }, stepCount, mtime, errors }, ...]`. The `errors` field is always present (never optional / `undefined`) so client code doesn't branch on existence.

  Use the same camelCase boundary as the existing workflows API (`src/app/api/workflows/route.ts:18` `WorkflowApiSummary`): `step_count` → `stepCount`, `mtime` stays as a Unix timestamp (number, seconds). `providers` stays as a flat `{ script, tts, image, video }` map matching the `WorkflowImportSchema` field naming (the four `*_provider` fields collapsed to short keys, mirroring `toApiSummary`'s shape).
  **Context:** No DB access — pure FS read. The per-file parse cost is fine for v1 (drafts dir typically holds <10 files). `withFileTypes: true` avoids a per-entry `statSync` for the directory walk; `statSync` is still needed for `mtime`. `mtime` rather than `atime`/`ctime` because it's the cross-platform "content last changed" semantic the user cares about.

- [x] **Task 4: `POST /api/workflows/drafts/[filename]/import` — import a draft**
  **Files:** `src/app/api/workflows/drafts/[filename]/import/route.ts` (new).
  **What:** Route signature follows the existing `[id]` precedent:
  ```ts
  interface RouteCtx { params: { filename: string }; }
  export async function POST(req: Request, ctx: RouteCtx): Promise<NextResponse>
  ```
  Handler steps:
  1. `ensureDraftsDirs()`.
  2. `validateDraftFilename(ctx.params.filename)` → on `ImportError("invalid_filename")` return 400 `{ error: "invalid_filename" }`.
  3. `path = join(getDraftsDir(), ctx.params.filename)`. `existsSync(path)` → 404 `{ error: "draft_not_found" }` if missing. (A race where the file is deleted between the list call and the import is rare but possible; surface it explicitly rather than crashing.) **This 404 is a direct HTTP-layer return — `draft_not_found` is NOT in `ImportError.code`.** See the note at the end of Task 2.
  4. Parse: `JSON.parse(readFileSync(path, "utf-8"))` → 400 `{ error: "invalid_json" }` on syntax error.
  5. Read `?overwrite=1` from the URL → boolean: `new URL(req.url).searchParams.get("overwrite") === "1"`.
  6. `const result = importWorkflowJson(db, payload, { overwrite })`. Wrap in `try/catch` for `ImportError` and map per Task 1 (`invalid_input` → 400, `workflow_id_exists` → 409 with `current_version` in the body).
  7. **On success only**, `renameSync(path, join(getImportedDir(), `${result.row.id}-${Math.floor(Date.now() / 1000)}.json`))`. The post-rename filename uses the row's `id` (returned by the helper after a canonical post-commit `findById` re-read), not the source filename — so a draft authored with mismatched filename-vs-slug ends up with a normalized archived name. Same-volume rename is guaranteed because both dirs are siblings under `prompts/workflows/`.
  8. Return the same response shape as `/api/workflows/import`: `{ workflow: buildDetail(db, result.row.id), warnings: result.warnings }`, status `201` for `created` / `200` for `overwritten`. Import `buildDetail` from `@/app/api/workflows/route` (same precedent the existing import route uses).

  **Failure semantics:** if `renameSync` throws after a successful commit (extremely unlikely with same-volume sibling dirs — only disk full or permissions), the row is in the DB but the draft file is still in `drafts/`. Server-side `console.error` the failure with the OS error and the source path; return the normal 200/201 success body with an additional top-level `archiveError: string` field (separate from the validator `warnings` array — do NOT pollute `ValidationWarning[]` with FS-layer errors). The drafts UI surfaces this via a follow-up `toast.error("Imported but draft file remains in drafts/ — discard manually.")`. The DB commit is the source of truth; the file move is best-effort cleanup. This branch is not unit-tested (the failure modes — disk full, EPERM — are environment-specific); manual verification only.
  **Context:** The basename-validation + per-file commit-then-move ordering is the operator-safety contract: a 409 collision leaves the draft in place for the user to retry with overwrite, and a successful commit is followed by archival rather than deletion (so the user can recover the file if needed). Slug-collision UX: the route returns 409 → UI opens overwrite confirm dialog → re-POSTs with `?overwrite=1` → succeeds → archive happens.

- [x] **Task 5: `DELETE /api/workflows/drafts/[filename]` — discard a draft**
  **Files:** `src/app/api/workflows/drafts/[filename]/route.ts` (new).
  **What:** Same `interface RouteCtx { params: { filename: string }; }` as Task 4. DELETE handler:
  1. `ensureDraftsDirs()`.
  2. `validateDraftFilename(ctx.params.filename)` → 400 `{ error: "invalid_filename" }` on failure.
  3. `path = join(getDraftsDir(), ctx.params.filename)`. `existsSync(path)` check → 404 `{ error: "draft_not_found" }` if missing (same race rationale as Task 4 — and same direct-HTTP-return rationale per Task 2's note; not an `ImportError`).
  4. `unlinkSync(path)`.
  5. Return 200 `{ deleted: true }`.

  No DB interaction. No archival — the user explicitly chose to discard.
  **Context:** Symmetrically scoped with Task 4 — same filename validation, same not-found handling. `unlinkSync` on Windows can fail if another process holds the file; the route does not retry — surface the error to the user via 500 with the OS error message and let them retry.

### Phase 6C — UI

- [x] **Task 6: `<DraftsSection>` client component**
  **Files:** `src/app/workflows/drafts-section.tsx` (new), `src/app/workflows/page.tsx` (add the section above `<WorkflowsTable>`).
  **What:** Client component (`"use client"`) state-managed list of drafts.
  - On mount and on Refresh-button click, `fetch("/api/workflows/drafts")` → set list state.
  - Render a card-style section with the heading `"Drafts (${list.length})"` and a Refresh button at the right. Below: a table with columns `Filename | Label | Providers | Steps | Actions`. Empty state: `"No drafts here yet. The AI skill writes drafts to prompts/workflows/drafts/. See docs/histforge-spec.md § AI workflow drafts for the contract."`
  - Each row's Import button click handler:
    1. POST `/api/workflows/drafts/${filename}/import` (no `?overwrite=1`).
    2. On 201/200: success toast (Task 7), then refresh both this section's list AND the parent workflows table — easiest is `router.refresh()` from `next/navigation` (re-runs server components) plus a manual `setList(... fetch ...)` for the drafts state. **If the response body carries an `archiveError` field (Task 4's "commit succeeded but `renameSync` failed" branch), fire an additional `toast.error("Imported but draft file remains in drafts/ — discard manually.")` after the success toast so the operator notices the orphan.**
    3. On 409 `workflow_id_exists`: open a `ConfirmDialog` ("Workflow `<slug>` already exists. Overwrite?", `destructive: false` since data is recoverable from version history). On confirm, re-POST with `?overwrite=1` and continue at step 2.
    4. On 400 `invalid_json` / `invalid_filename`: error toast with the message.
  - Each row's Discard button click handler: `ConfirmDialog` ("Discard draft `<filename>`?", `destructive: true`) → DELETE → refresh list on success.
  - Disabled-Import case: rows with `errors` containing `invalid_json` or `missing_fields` keep the Import button disabled (the row is unimportable). `unknown_field` is advisory — Import remains enabled (Zod strips the field at import time).
  **Shared overwrite-confirm helper:** the file-picker import in `WorkflowsTable` (Phase 2 Task 11) already runs the same "POST → on 409 open ConfirmDialog → re-POST with `?overwrite=1`" dance (`workflows-table.tsx`'s `import-overwrite` confirm-state branch). Extract that flow into a small shared helper — `src/app/workflows/use-import-with-overwrite.ts` exposing `runImport(payload, urlBuilder): Promise<{ ok: boolean; status: number; body: unknown }>` with an out-param callback for "open overwrite confirm with this slug, resolve to retry-or-cancel" — and have both `WorkflowsTable` (file-picker) and `<DraftsSection>` (drafts) call it. Keeps the two import surfaces aligned on retry semantics, error mapping, and toast wiring as the response shape evolves.
  **Context:** Reuse the generic `ConfirmDialog` from `src/app/videos/confirm-dialog.tsx` (per Phase 2 Task 10's note about future relocation — leave it where it is; just import it). Table primitive: import `Table` / `TableHeader` / `TableBody` / `TableRow` / `TableHead` / `TableCell` from `@/components/ui/table` directly — same pattern `workflows-table.tsx` already uses (`src/app/workflows/workflows-table.tsx:29-36`). Mounting the drafts section above the existing `<WorkflowsTable>` requires `src/app/workflows/page.tsx` to render both as siblings:
  ```tsx
  return (
    <>
      <header>...</header>
      <DraftsSection />          {/* new — fetches its own data client-side */}
      <WorkflowsTable rows={rows} />   {/* unchanged props */}
    </>
  );
  ```
  No prop change to `WorkflowsTable` — it still gets server-side `rows`. The drafts section fetches client-side on mount. (Alternative: fetch drafts server-side for the initial render — client-fetch is simpler and aligns with the manual-Refresh contract since FS watching is out of scope, so stale-on-load is the same as stale-after-Refresh.)

- [x] **Task 7: Success toast with View action + warning surface**
  **Files:** `src/app/workflows/drafts-section.tsx`.
  **What:** Post-import success toast formatting:
  - When `warnings.length === 0`: `toast.success(\`Imported \\\`${slug}\\\`\`, { action: { label: "View", onClick: () => router.push(\`/workflows/${slug}/edit\`) } })`.
  - When `warnings.length > 0`: `toast.warning(\`Imported \\\`${slug}\\\` with ${warnings.length} warning(s)\`, { description: warnings.map(w => w.message).join("\n"), action: { label: "View", onClick: () => router.push(\`/workflows/${slug}/edit\`) }, duration: 8000 })`. The longer duration gives the user time to read the description; the View action still routes to the edit page where Phase 3 Task 10 surfaces inline warnings on the offending step rows.
  **Context:** Sonner's `action` prop accepts `{ label, onClick }` and renders an inline button at the right of the toast. Use `useRouter()` from `next/navigation` for the navigation (NOT `next/router` — this is App Router). The warning message format `"<step.label> needs '<missing_input>' but no prior step produces it"` is Phase 3 Task 2's authoritative shape; `toast.warning`'s `description` prop renders multiline strings verbatim, so the join-on-newline approach works without further formatting.

### Phase 6D — Tests

> **Note (post-6B):** Tasks 9–11 were folded into Phase 6B alongside the routes
> they cover, since `/implement-plan-tdd` drives route-and-test pairs together.
> Their checkmarks reflect work that landed in commits `965e1c2` (Task 9),
> `6bbebfc` (Task 10, plus an `archiveError`-absent sanity assertion on the happy
> path), and `66a1d65` (Task 11). Task 8 stayed in 6D — it's a helper-layer
> additive test, not a route test, so it's the only Phase 6D entry that did
> work after the 6B routes shipped.

- [x] **Task 8: Helper-layer `unknown_field` advisory test**
  **Files:** `__tests__/unit/lib/workflows-import.test.ts` (extend; created in Phase 6A).
  **What:** One additional test on top of what Phase 6A already shipped (the file already covers new-row-create / collision-without-overwrite / overwrite-bumps-version / built-in-preserves / bad-shape / warnings-on-broken-input / `is_builtin`-stripped):
  - **`unknown_field` advisory at the helper layer:** import a payload containing `enrich_chunks_llm_provider: "openrouter"` → `status: "created"`, `row.is_builtin === 0`, no `enrich_chunks_llm_provider` reaches the row (Zod strips), `warnings.length === 0`. The visible drafts-list advisory lives in Task 9's parametrized `unknown_field` case; this just nails down the "Zod silently strips on the import path" behavior at the helper layer so the `enrich_chunks_llm_provider`-specific stripping doesn't regress quietly.

  The route-refactor regression check that the original task carried is already complete: Phase 6A landed the route refactor and confirmed all 10 of `__tests__/api/workflows/import/route.test.ts`'s tests still pass post-refactor. No additional checkpoint is needed in Phase 6D.
  **Context:** Helper-level tests don't need an HTTP fixture; just `getDb()` and call the function. The unit-test file location is `__tests__/unit/lib/` per the `workflows-validator.test.ts` precedent (Phase 3 Task 3). Phase 6A already created the file; this task is purely additive.

- [x] **Task 9: Drafts list endpoint test**
  **Files:** `__tests__/api/workflows/drafts/route.test.ts` (new).
  **What:** Use a temp directory as the prompts-root override. Set `process.env.HISTFORGE_PROMPTS_DIR = mkdtempSync(join(tmpdir(), "histforge-drafts-"))` in `beforeAll`; `rmSync(..., { recursive: true, force: true })` in `afterAll`. Per-test `beforeEach` clears `<root>/workflows/drafts/` (via `rmSync(getDraftsDir(), { recursive: true, force: true })` then `mkdirSync(..., { recursive: true })`) so cases don't bleed. Mirrors the env-var pattern at `__tests__/api/workflows/import/route.test.ts:13–28`.

  Cases:
  1. Empty `drafts/` → 200 `[]`.
  2. Two valid JSON files with distinct mtimes (force the gap with `utimesSync` so the test isn't timing-sensitive) → 200 with newest first; each row has `filename`, `slug`, `label`, `providers`, `stepCount`, `mtime`, `errors: []`.
  3. **mtime-tie filename-asc tiebreaker:** two valid JSON files with `utimesSync` set to the *same* mtime — assert the result orders them by `filename` ascending. (Step 5 of Task 3's spec — "newest first, ties broken by filename ascending" — needs an explicit test or it's untested.)
  4. One file with `JSON.parse` failure → row with `errors: ["invalid_json"]`, `slug: null`, `label: null`.
  5. One file with valid JSON but missing `id` → row with `errors: ["missing_fields"]`.
  6. **`unknown_field` advisory parametrized over all five server-controlled keys.** Iterate `["enrich_chunks_llm_provider", "is_builtin", "version", "created_at", "updated_at"]`; for each, seed a draft with just that key added on top of the valid payload → assert the row has `errors` containing `"unknown_field"` and the other metadata fields populated normally. Also one combined case: a draft missing `id` AND containing `is_builtin` → `errors` is `["missing_fields", "unknown_field"]` (in that order — accumulation order matches the spec at Task 3 step 4).
  7. A file in `drafts/` named `not-a-slug.json.bak` (fails the basename regex) → silently excluded from the list (does NOT appear as an error row — files that don't match the contract aren't drafts at all).
  **Context:** The `HISTFORGE_PROMPTS_DIR` env-var injection from Task 2 is what makes this testable without polluting the real `prompts/workflows/`. The env var must be set **before** the route module is first imported (i.e., before `await import("@/app/api/workflows/drafts/route")`) — putting it in `beforeAll` before any `import()` call satisfies this. Use `await import()` in each test rather than top-level `import` so the route module reads the env var at first import time after the test setup runs.

- [x] **Task 10: Draft-import filesystem move + collision flow**
  **Files:** `__tests__/api/workflows/drafts/[filename]/import/route.test.ts` (new).
  **What:** This route writes to disk AND to the DB, so the setup combines:
  - **`beforeAll`:** `process.env.HISTFORGE_PROMPTS_DIR = mkdtempSync(...)` (Task 9's pattern) AND `process.env.DATABASE_URL = join(tempDir, "test.db")` (`__tests__/api/workflows/import/route.test.ts:13–18` is the precedent).
  - **`beforeEach`:** seed defaults: `db.exec("DELETE FROM workflow_steps; DELETE FROM workflows; ..."); seedDefaultSettings(db); seedDefaultWorkflows(db);` (`__tests__/api/workflows/import/route.test.ts:30–40` is the precedent), AND clear the temp drafts directory.
  - **`afterAll`:** close the DB and `rmSync` the temp dir.

  Each test invokes the route directly: `await POST(new Request(`http://localhost/api/workflows/drafts/${name}/import`), { params: { filename: name } })` — vitest doesn't run a Next.js router, so the `ctx` arg is constructed manually (same pattern as `__tests__/api/workflows/[id]/route.test.ts`).

  Three scenarios:
  1. **Happy path:** seed `<draftsDir>/example.json` with a valid payload (slug `"example"`, the same VALID_PAYLOAD shape as the existing import test). POST to the route → 201 with `{ workflow, warnings }`. Assert: file no longer exists at `drafts/example.json`; a file matching `/^example-\d+\.json$/` exists in `<importedDir>` with contents identical to the original; `getWorkflowFromDb(db, "example")` returns the row with `version: 1`.
  2. **Collision without overwrite:** seed both a `<draftsDir>/comfyui.json` and rely on the `comfyui` row already in DB (seeded by `seedDefaultWorkflows` in `beforeEach`). POST without `?overwrite=1` → 409 `workflow_id_exists`. Assert: the source file is **still in `drafts/`** (not moved); the DB row is unchanged (version still `1`, label still the seeded value).
  3. **Collision with `?overwrite=1`:** same fixture as (2). POST with `?overwrite=1` → 200 `overwritten`. Assert: source file moved to `<importedDir>` matching `/^comfyui-\d+\.json$/`; DB row's `version` bumped to `2`; `is_builtin` still `1` (preserved on overwrite per existing import test expectations).

  Also: filename-validation tests — these pass the bad filename **directly** as `params.filename` (no URL decoding happens because the test bypasses the router). `params.filename = "../secret.json"` → 400 `invalid_filename`. `params.filename = "valid-slug.txt"` (wrong extension) → 400. `params.filename = "no-such-file.json"` → 404 `draft_not_found`.
  **Context:** Filename validation runs before any FS read, so the traversal tests don't need fixture files — the route rejects on the regex before touching disk. Use `Math.floor(Date.now() / 1000)` for the timestamp suffix (matches the route's source); the test asserts the regex pattern, not an exact value.

- [x] **Task 11: Discard endpoint test**
  **Files:** `__tests__/api/workflows/drafts/[filename]/route.test.ts` (new).
  **What:** Same env-var prompts-root setup as Task 9 (no DB writes here, so no `DATABASE_URL` setup needed — but the env var still has to be set before importing the route). Cases:
  1. Seed `<draftsDir>/foo.json` → DELETE → 200 `{ deleted: true }`. File no longer exists at `<draftsDir>/foo.json`.
  2. DELETE on a non-existent file → 404 `draft_not_found`.
  3. DELETE with traversal filename (`params.filename = "../foo.json"`) → 400 `invalid_filename`.
  4. DELETE with wrong extension (`params.filename = "foo.txt"`) → 400 `invalid_filename`.
  **Context:** Symmetric with Task 10's filename-validation cases. Same manual `params` construction (`{ params: { filename } }` as the second arg to `DELETE`). No UI test in scope: Tasks 6–7 are exercised manually; the `__tests__/` tree has only smoke-render coverage for `app/workflows/page.tsx` (no click-through framework).

### Phase 6E — Spec

- [x] **Task 12: Permanent `docs/histforge-spec.md` § AI workflow drafts**
  **Files:** `docs/histforge-spec.md` (extend).
  **What:** Add a `## AI workflow drafts` section to the canonical spec — the link target the empty-state copy and any future operator docs reference (plan docs get archived; the spec doesn't). Section covers, briefly:
  - **Filesystem layout:** `prompts/workflows/drafts/<slug>.json` for pending drafts, `prompts/workflows/imported/<slug>-<unix_timestamp>.json` for archived ones. Slug regex `^[a-z0-9-]+$`.
  - **JSON shape:** snake_case, identical to the export shape — `id`, `label`, `short_label`, `description`, `script_llm_provider`, `tts_provider`, `image_provider`, `video_provider`, `enabled`, `steps[]`. Server-controlled fields (`is_builtin`, `version`, `created_at`, `updated_at`) and `enrich_chunks_llm_provider` are stripped on import; the drafts list surfaces them as `unknown_field` advisories.
  - **AI-skill loop:** skill calls `GET /api/workflows/schema` for the live providers/steps catalog, writes a draft to `drafts/<slug>.json`, dashboard surfaces it, user clicks Import → row commits, file moves to `imported/`.
  - **Validation:** input-availability warnings ride the import response; saves are never blocked.
  - **Forward link** from `## Workflows` (Phase 1's section) so the entry point is discoverable.
  **Context:** Doc-only task. The exact wording is at the implementer's discretion as long as it covers the schema endpoint, the JSON shape, and the directory layout. This section is what the empty-state copy in Tasks 3 and 6 links to.

---

## Done Criteria

(Consumes Invariant D from [`README.md`](README.md).)

- AI skill (out-of-codebase, mocked here by writing a fixture file) produces `prompts/workflows/drafts/example.json`. Opening `/workflows` shows "Drafts (1)" above the main table with the file's metadata.
- Clicking Import on a clean slug commits the row to DB (visible in the main workflows table after `router.refresh()`) and atomically moves the file to `imported/example-<timestamp>.json`.
- Clicking Import on a colliding slug opens an overwrite-confirm dialog; on confirm, the row is overwritten and the file is moved to `imported/`.
- Clicking Discard on a draft opens a confirm dialog; on confirm, the file is deleted and the row count drops.
- A draft containing input-availability gaps imports successfully (warnings do NOT block). The success toast shows the warning count and surfaces the messages in its description.
- A draft containing `enrich_chunks_llm_provider` (Invariant E violation) imports successfully (Zod strips the field), and the drafts list surfaces the `unknown_field` advisory before import so authors notice during the AI-skill iteration loop.
- `importWorkflowJson` is the sole owner of the insert-or-overwrite + post-commit-validation logic. `Grep "WorkflowImportSchema.safeParse" src/` returns at most one hit (inside the helper); both `/api/workflows/import` and `/api/workflows/drafts/[filename]/import` route handlers are thin shells.
- `prompts/workflows/{drafts,imported}` directories exist and are created lazily on first API call (the helper handles the greenfield case).
- Path-traversal attempts (`../`, wrong extension, uppercase, underscores) return 400 `invalid_filename` before any FS read.
- The Phase 3 schema endpoint, the validator, and the `/api/workflows/import` route are all unchanged in behavior — Phase 6 only adds new surfaces and refactors the import body into a reusable helper.
- `docs/histforge-spec.md` has a permanent `## AI workflow drafts` section (Task 12) covering the FS layout, JSON shape, AI-skill loop, and validation contract. The drafts UI empty-state copy links to it.
- All four new/extended test files pass: `__tests__/unit/lib/workflows-import.test.ts` (created in Phase 6A; extended in Task 8), `__tests__/api/workflows/drafts/route.test.ts` (Task 9), `__tests__/api/workflows/drafts/[filename]/import/route.test.ts` (Task 10), `__tests__/api/workflows/drafts/[filename]/route.test.ts` (Task 11). The existing `__tests__/api/workflows/import/route.test.ts` also passes unchanged (refactor-regression check).

---

## References

- Cross-phase invariants: [`README.md`](README.md) — Invariant D (schema endpoint + warning shape — Phase 6 consumes the warning shape from `/api/workflows/import` responses), Invariant E (workflow JSON four provider fields; `enrich_chunks_llm_provider` excluded)
