# Plan: Workflow Modularization

**Date**: 2026-05-01
**Status**: Proposed
**Companion research**: `docs/research/2026-05-01-workflow-modularization-analysis.md`

---

## Goal

Replace the in-code `WORKFLOWS` array with DB-authoritative workflow definitions, expose four canonical modules (`script`, `tts`, `image`, `video`) as provider registries selectable per workflow, support a Claude CLI script provider, and ship a workflow editor in the dashboard plus an AI-skill drafts pipeline. Done end-to-end, this turns workflow construction into a first-class user-facing operation while preserving the current step-runs-from-disk pipeline mechanics.

---

## Resolved Design Decisions

| | Decision |
|---|---|
| Storage | DB-authoritative (`workflows`, `workflow_steps` tables); JSON export/import as the AI-skill bridge |
| Built-ins | Code-defined `comfyui` and `google-flow` seeded into DB on init via `INSERT OR IGNORE` |
| Editing | Edits replace in place; `videos.workflow_snapshot` JSON pins the resolved step list at queue time |
| Versioning | `workflows.version` integer, optimistic locking via `expected_version` on PATCH (409 on mismatch) |
| Built-in protection | `is_builtin = 1` flag, "Reset to default" button (with confirm modal) restores seeded definition |
| Modules | Four canonical: `script` (multi-step), `tts`, `image`, `video`. Glue: `assemble_script`, `align`, `chunk`, `enrich_chunks`, `render`, `cleanup` |
| Step naming | Flat slugs with `module: ModuleId \| "glue"` metadata field, declared per step file |
| Step metadata | `module`, `label`, `description`, `inputs`, optional `for_each` declared on the `Step` interface — added in **Phase 1** |
| Loop primitive | `step.for_each: "chapters" \| "chunks" \| undefined` is step-file metadata, not a workflow_steps column. Read-only in the editor; signals multi-output behavior to users |
| Glue insertion | Automatic at resolution time; user sees module slots, not glue |
| Provider registries | All four follow the same shape: `Record<string, Provider>` + `getXProvider(name)` + Zod enum |
| Provider naming | Bare names per registry namespace: image is `["comfyui", "google_flow"]`; video is `["comfyui", "google_flow"]`. Each registry is its own namespace |
| Per-workflow params | Provider parameters stay global; only provider name lives on the workflow row |
| Settings (global) | New keys in `src/lib/settings.ts`: `enrich_chunks_llm_provider`, `claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`. Phase 4 deletes obsolete `llm_provider` |
| Workflow row schema | `script_llm_provider`, `tts_provider`, `image_provider`, `video_provider` validated by Zod schemas in `src/lib/workflows-schema.ts` (NOT in settings.ts — these are per-row, not global) |
| Workflow uniqueness | Editor allows flexibility — at most one TTS/image/video step per workflow but not enforced at DB level |
| FK | `videos.workflow_id` → `workflows.id` with `ON DELETE RESTRICT` |
| `enabled` flag | `workflows.enabled INTEGER NOT NULL DEFAULT 1` to hide retired workflows from the Add dropdown; POST `/api/videos` rejects with 400 if `enabled = 0` |
| UI placement | New top-level nav `/workflows` |
| MVP UI | Clone-and-edit form; module-slot view (Script: ordered list; TTS/Image/Video: provider Select) |
| AI-skill output | JSON file in `prompts/workflows/drafts/`, dashboard "Import" action moves to `imported/` |
| AI-skill introspection | `GET /api/workflows/schema` returns live step + provider catalog so the skill stays in sync |
| Migration | Schema rebuild on init (test DB is disposable) |
| Snapshot column | `videos.workflow_snapshot TEXT` (nullable). Set on `createNewVideo`, refreshed on every PATCH while status is `new`/`queued`, frozen at queue time |
| `enrich_chunks` provider | One-off step with global `enrich_chunks_llm_provider` setting, reuses LLM registry. Editor surfaces a help-line noting it uses global setting, not the workflow's `script_llm_provider` |
| `assemble_script` | Always-present glue, hidden from editor |
| Concurrency | Optimistic last-write-wins with `version` column; 409 + reload toast on conflict |
| Drafts behavior | Refresh on page load + manual button; no FS watching |
| Step collapsing | `generate_main_images_*` and `generate_hook_video_*` collapse into one of each in Phase 5, calling registered providers |
| Glob semantics | `step.inputs` and `step.outputs` may use glob patterns (e.g., `script/04_chapter_*.md`). The editor's input-availability validator does glob-on-glob match. Runtime failure cleanup uses literal `outputs` only — atomic-write steps keep `outputs: []` for cleanup and declare a separate `produces: ["..."]` field for validation |
| Boot validation | `validateWorkflowSteps` and `validateStepArtifactRules` move from module-load (current `steps/index.ts:70,93`) to an explicit `bootValidate(db)` called from worker startup after `getDb()` is callable |

---

## Data Model

### Schema changes (`src/lib/db.ts`)

#### New: `workflows` table

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,                          -- kebab-case slug
  label TEXT NOT NULL,                          -- long display label
  short_label TEXT NOT NULL,                    -- compact label for table cells
  description TEXT,                             -- optional, surfaces in /workflows list
  script_llm_provider TEXT NOT NULL,            -- "openrouter" | "claude_cli"
  tts_provider TEXT,                            -- "ai33" (nullable for flexibility)
  image_provider TEXT,                          -- "comfyui" | "google_flow"
  video_provider TEXT,                          -- "comfyui" | "google_flow"
  is_builtin INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Provider values are bare names; each registry (`image`, `video`) is its own namespace, so `image_provider: "comfyui"` and `video_provider: "comfyui"` are independent values resolved through different registries.

#### New: `workflow_steps` table

```sql
CREATE TABLE workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  step_name TEXT NOT NULL,                      -- references REAL_STEPS slugs (no FK; code registry)
  PRIMARY KEY (workflow_id, position)
);
CREATE INDEX idx_workflow_steps_workflow ON workflow_steps(workflow_id, position);
```

`workflow_steps` carries only the *script-module* steps the user authored. Glue (TTS/image/video module steps + always-present glue) is materialized at resolution time from the four provider columns on the parent row.

The `for_each` declaration lives on the `Step` interface (e.g., `step.for_each = "chapters"` declared in `04-write-chapters.ts`), not on the `workflow_steps` row — see Architecture below.

#### Modified: `videos` table

Add columns:
- `workflow_snapshot TEXT` (nullable) — JSON-serialized resolved step list. Populated at `createNewVideo`, refreshed on every PATCH while status is `new`/`queued`, frozen once status transitions to `queued` (treated as immutable thereafter).
- Change `workflow_id` to FK: `REFERENCES workflows(id) ON DELETE RESTRICT`.

### New global settings (Zod schemas in `src/lib/settings.ts`)

```ts
enrich_chunks_llm_provider: z.enum(["openrouter", "claude_cli"]),
claude_cli_path: z.string(),                                // default "claude" (PATH lookup)
claude_cli_model: z.string(),                               // e.g., "claude-opus-4-7"
claude_cli_extra_args: z.string(),                          // default "" — split on whitespace; quoted strings not supported in v1
```

### New workflow-row Zod schemas (`src/lib/workflows-schema.ts` — new file)

```ts
script_llm_provider: z.enum(["openrouter", "claude_cli"]),
tts_provider: z.enum(["ai33"]).nullable(),
image_provider: z.enum(["comfyui", "google_flow"]).nullable(),
video_provider: z.enum(["comfyui", "google_flow"]).nullable(),
```

These validate the workflow row fields at the API layer (POST/PATCH/import). They are NOT in `settings.ts` because they are per-row, not global.

The existing `llm_provider` global setting is **deleted** in Phase 4. Its sole consumer (`pipeline.ts:199` populating `StepContext.chat`) is replaced by per-workflow + global enrich resolution.

---

## Architecture

### Module abstraction

```
ModuleId = "script" | "tts" | "image" | "video"
ForEach  = "chapters" | "chunks"

interface Step {
  name: string;
  module: ModuleId | "glue";          // NEW (Phase 1)
  label: string;                       // NEW (Phase 1)
  description: string;                 // NEW (Phase 1)
  outputs: readonly string[];          // existing — used for failure cleanup (literal paths)
  produces: readonly string[];         // NEW (Phase 1) — for editor validation; may use globs (e.g., "script/04_chapter_*.md"). Defaults to outputs when omitted.
  inputs: readonly string[];           // NEW (Phase 1) — project-relative paths read from disk; may use globs
  for_each?: ForEach;                  // NEW (Phase 1) — read-only metadata; signals multi-output behavior
  run(videoId, ctx): Promise<void | DeferSignal>;
  cleanup?(videoId, ctx): Promise<void>;
}
```

`outputs` vs `produces`: `outputs` is the literal path list used by the orchestrator's default failure cleanup (`rmSync` per path). `produces` is the path-or-glob list the editor's input-availability validator matches against downstream `inputs`. For atomic-write steps (e.g., `write_chapters`), `outputs: []` (no default cleanup) and `produces: ["script/04_chapter_*.md", "script/04_outline_structured.json", "script/story_so_far.md"]` for validation. For most other steps, `produces` is omitted and defaults to `outputs`.

`StepContext` gains:
- `chat`: the LLM provider's `chat` method, resolved per call site from either `script_llm_provider` (script-module steps) or `enrich_chunks_llm_provider` (glue steps that need LLM).
- `imageProvider`, `videoProvider`, `ttsProvider`: resolved from the workflow snapshot's provider columns.

The resolution order:
1. Pipeline boots, reads `videos.workflow_snapshot` (NOT `workflows` directly — snapshot is authoritative for in-flight runs).
2. Snapshot is `{ script_llm_provider, tts_provider, image_provider, video_provider, steps: [{ step_name, for_each? }, ...] }`.
3. `resolveDeps` looks up each provider name in its registry, materializes the full step list (glue auto-inserted), and threads `StepContext` per step.

### Glue insertion logic (post-Phase 5 end-state)

Given a snapshot's `steps` (the user-authored script module steps + provider choices for tts/image/video), the loader produces:

```
[ ...snapshot.steps,                             // script module (user-authored, ordered)
  "assemble_script",                             // always-present glue
  "voiceover",                                   // tts module — skipped if tts_provider is NULL
  "align",                                       // glue
  "chunk",                                       // glue
  "enrich_chunks",                               // glue (uses enrich_chunks_llm_provider)
  "generate_main_images",                        // image module — skipped if image_provider is NULL
  "generate_hook_video",                         // video module — skipped if video_provider is NULL
  "render",                                      // glue
  "cleanup" ]                                    // glue
```

Steps are skipped if the corresponding provider column is NULL (per Q-C "flexibility, no enforcement" decision).

### Phase 1 transitional materializer

Until Phase 5 ships, the unified `generate_main_images` and `generate_hook_video` step files do not exist. Phase 1's `materializeStepList` uses a transitional mapping table from the workflow row's provider value to the legacy provider-specific step slug:

| Workflow row column | Value | Phase 1 step slug | Post-Phase 5 step slug |
|---|---|---|---|
| `image_provider` | `"comfyui"` | `generate_main_images_comfyui` | `generate_main_images` |
| `image_provider` | `"google_flow"` | `generate_main_images_google_flow` | `generate_main_images` |
| `video_provider` | `"comfyui"` | `generate_hook_video_comfyui` | `generate_hook_video` |
| `video_provider` | `"google_flow"` | `generate_hook_video_google_flow` | `generate_hook_video` |

This transitional mapping is removed in Phase 5 when the unified steps land and dispatch happens internally via the registry. The seeded `comfyui` and `google-flow` workflows run end-to-end starting from Phase 1.

### Provider registries

After Phase 5, all four registries share the same shape:

| Module | Interface file | Registry file | Registered values (per-namespace) |
|---|---|---|---|
| script (LLM) | `src/lib/llm/types.ts` | `src/lib/llm/index.ts` | `openrouter`, `claude_cli` |
| tts | `src/lib/tts/types.ts` | `src/lib/tts/index.ts` | `ai33` |
| image | `src/lib/image/types.ts` | `src/lib/image/index.ts` | `comfyui`, `google_flow` |
| video | `src/lib/video/types.ts` (NEW) | `src/lib/video/index.ts` (NEW) | `comfyui`, `google_flow` |

`ImageProvider.generateBatch` and `VideoProvider.generateBatch` return `Promise<void | DeferSignal>` — the deferral path the Google Flow steps already use.

### Workflow snapshot JSON shape

```json
{
  "workflow_id": "comfyui",
  "version": 3,
  "script_llm_provider": "openrouter",
  "tts_provider": "ai33",
  "image_provider": "comfyui",
  "video_provider": "comfyui",
  "steps": [
    { "step_name": "research_outline" },
    { "step_name": "research_characters" },
    { "step_name": "write_hook" },
    { "step_name": "write_chapters" }
  ]
}
```

`for_each` is not in the snapshot — it lives as step-file metadata accessed at runtime by the editor and (potentially) future loop primitives.

Stored as `videos.workflow_snapshot TEXT` (nullable). Lifecycle:

1. **`createNewVideo`**: snapshot computed and written immediately, alongside `workflow_id`. The video is `status='new'` but already has a snapshot pinned.
2. **`PATCH /api/videos/[id]`** (allowed only on `new` and `queued`): if `workflow_id` changed, recompute the snapshot.
3. **`transitionNewToQueued`** (and the bulk variant `transitionAllNewToQueued`): re-resolve the snapshot from the current `workflows` row inside the same transaction so the queue-time snapshot reflects any changes that happened to the workflow between video creation and queue.
4. After `queued`, the snapshot is treated as immutable. The orchestrator reads only the snapshot, never the live `workflows` row — so edits to a workflow do not affect already-queued or in-flight videos.

---

## Phase 1 — Workflows-as-data End-to-End + Step Metadata

**Goal:** Move `comfyui` and `google-flow` from in-code constants to DB rows. Add `module`/`label`/`description`/`inputs`/`produces`/`for_each` metadata to every step file (no behavior change yet — metadata is consumed by Phase 2's editor and Phase 3's validator). Existing pipeline runs unchanged. Read-only `/workflows` page exists. No editor yet.

### Step metadata declarations

Every file in `src/worker/steps/*.ts` gains the new `Step` interface fields. Module assignments:

| Step | `module` | `for_each` |
|---|---|---|
| `research_outline` | `script` | — |
| `research_characters` | `script` | — |
| `write_hook` | `script` | — |
| `write_chapters` | `script` | `chapters` |
| `assemble_script` | `glue` | — |
| `voiceover` | `tts` | — |
| `align` | `glue` | — |
| `chunk` | `glue` | — |
| `enrich_chunks` | `glue` | `chunks` |
| `generate_main_images_comfyui` | `image` | `chunks` |
| `generate_main_images_google_flow` | `image` | `chunks` |
| `generate_hook_video_comfyui` | `video` | `chunks` |
| `generate_hook_video_google_flow` | `video` | `chunks` |
| `render` | `glue` | — |
| `cleanup` | `glue` | — |

Inputs declarations cite project-relative paths read from disk; DB-derived data (e.g., `videos.title`, settings) is implicitly satisfied. Examples:

| Step | `inputs` | `produces` (validation) | `outputs` (cleanup) |
|---|---|---|---|
| `research_outline` | `[]` | `["script/01_outline.md"]` | `["script/01_outline.md"]` |
| `research_characters` | `["script/01_outline.md"]` | `["script/02_characters.md"]` | `["script/02_characters.md"]` |
| `write_hook` | `["script/01_outline.md", "script/02_characters.md"]` | `["script/03_hook.md"]` | `["script/03_hook.md"]` |
| `write_chapters` | `["script/01_outline.md", "script/02_characters.md"]` | `["script/04_chapter_*.md", "script/04_outline_structured.json", "script/story_so_far.md"]` | `[]` (atomic-write, no default cleanup) |
| `assemble_script` | `["script/03_hook.md", "script/04_chapter_*.md"]` | `["script/full_script.md"]` | `["script/full_script.md"]` |

`label` and `description` are short user-facing strings, e.g.:
- `research_outline.label = "Research Outline"`, `description = "Generates a chapter-by-chapter outline from title + topic."`

### Schema (`src/lib/db.ts`)

- Create `workflows` and `workflow_steps` tables (DDL above).
- Add `videos.workflow_snapshot TEXT` column (nullable).
- Change `videos.workflow_id` to have a FK constraint to `workflows.id` (`ON DELETE RESTRICT`).
- Add `seedDefaultWorkflows(db)`:

```ts
const BUILTIN_WORKFLOWS: SeedWorkflow[] = [
  {
    id: "comfyui",
    label: "ComfyUI (local images, local hook video)",
    short_label: "ComfyUI",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: "comfyui",
    video_provider: "comfyui",
    steps: [
      { step_name: "research_outline" },
      { step_name: "research_characters" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
  {
    id: "google-flow",
    label: "Google Flow (cloud images, cloud hook video)",
    short_label: "Google Flow",
    script_llm_provider: "openrouter",
    tts_provider: "ai33",
    image_provider: "google_flow",
    video_provider: "google_flow",
    steps: [
      { step_name: "research_outline" },
      { step_name: "research_characters" },
      { step_name: "write_hook" },
      { step_name: "write_chapters" },
    ],
  },
];
```

`seedDefaultWorkflows` inserts each row + steps inside a transaction with `INSERT OR IGNORE`. Called from `npm run db:init` after `seedDefaultSettings`.

### Workflow loader (`src/lib/workflows.ts` — new file, replaces `src/worker/workflows/index.ts`)

- `getWorkflowFromDb(db, id): WorkflowRow | null`
- `listWorkflows(db): WorkflowRow[]`
- `resolveSnapshot(workflow: WorkflowRow): WorkflowSnapshot` — builds the snapshot JSON shape from the row + child steps.
- `materializeStepList(snapshot: WorkflowSnapshot): string[]` — auto-inserts glue and applies the **transitional mapping table** above to translate provider values into legacy step slugs. Result for the two seeded workflows matches the old in-code `WORKFLOWS[*].steps` exactly. Phase 5 simplifies this to use the unified `generate_main_images` / `generate_hook_video` slugs instead.

### Pipeline integration (`src/worker/pipeline.ts`)

- `resolveDeps` reads `videos.workflow_snapshot` (must be non-null at run time — invariant maintained by snapshot capture rules).
- Snapshot deserialized to `WorkflowSnapshot`, passed through `materializeStepList` to get slugs, then mapped through `REAL_STEPS` as today.
- Provider columns from the snapshot drive `ttsProvider` resolution via the existing TTS registry. Image and video provider resolution remains step-internal (the existing `generate-*-comfyui.ts` / `generate-*-google-flow.ts` files keep doing what they do today) until Phase 5 collapses them.

### Snapshot capture

`src/lib/repos/videos.ts`:

- **`createNewVideo`**: extend signature to also resolve and write the initial snapshot. Reads the workflow row + child steps inside the same transaction as the video INSERT.
- **`updateVideoDraft`** (called by `PATCH /api/videos/[id]` when status is `new` or `queued`): if the patch changes `workflow_id`, recompute the snapshot inside the same transaction.
- **`transitionNewToQueued`**: re-resolve the snapshot from the current `workflows` row inside the same transaction as the status flip. Even if nothing changed since `createNewVideo`, this guarantees queue-time freshness.
- **`transitionAllNewToQueued`** (bulk variant called by `/api/videos/start-all`): same transactional resnapshot per row.

All four functions compose around a single helper `computeSnapshot(db, workflow_id): string` (returns JSON string) that reads workflow + steps and serializes to canonical JSON.

### Worker startup

- Delete `src/worker/workflows/index.ts`. The `validateWorkflowSteps(listWorkflows(), REAL_STEPS)` and `validateStepArtifactRules(...)` calls at module-load (`src/worker/steps/index.ts:70,93`) move into a new `bootValidate(db)` function.
- `bootValidate(db)` is called from the worker entry point (alongside `resetStaleRunningSteps(db)` and `gfRepo.resetAllDispatchedOnStartup(db)`) AFTER the database is open. It iterates DB workflows (via `listWorkflows`) and asserts every step slug exists in `REAL_STEPS`.
- `src/worker/steps/index.ts` no longer runs validators at module load. The exports (`REAL_STEPS`, `STEP_OUTPUTS`) remain.

### API routes

- `GET /api/workflows` — list with `{ id, label, short_label, is_builtin, enabled, version, providers, step_count }`.
- `GET /api/workflows/[id]` — full workflow with steps array.
- `POST /api/videos` (existing): add `enabled` check on the workflow — return 400 `{ error: "workflow_disabled" }` if `workflows.enabled = 0` for the requested `workflow_id`.

(Workflow POST/PATCH/DELETE deferred to Phase 2.)

### UI

- New top-level nav: `Videos | Workflows | Settings`. Add to the existing layout/nav primitive.
- New page `src/app/workflows/page.tsx` — server component that lists workflows. Read-only table: Name | Short label | Providers | Built-in? | Enabled? | Step count.
- Add Video modal's workflow `<Select>` now reads from `/api/workflows` (filtered by `enabled = 1`) instead of the static `workflows` prop.

### Tests

- Unit: `src/lib/workflows.test.ts` covers `materializeStepList` for both transitional mappings (image_provider="comfyui" → comfyui slug, image_provider="google_flow" → google-flow slug) and glue insertion.
- Unit: snapshot capture writes a non-null snapshot at `createNewVideo`, refreshes on `updateVideoDraft` when workflow_id changes, re-snapshots at `transitionNewToQueued`.
- Integration: `src/worker/pipeline.test.ts` confirms a video with a snapshot runs the same step list as the old in-code workflow did.
- Regression: existing `pipeline.test.ts` cases keep passing.

### Done criteria

- `npm run db:init` produces a database with two seeded workflows.
- `/workflows` page lists both.
- A new video queued via the dashboard runs the same 13-step pipeline as before.
- Every step file declares `module`, `label`, `description`, `inputs`, `produces` (or relies on outputs), optional `for_each`.
- The in-code `src/worker/workflows/index.ts` file is deleted.
- Boot validators run from the worker startup sequence, not at module load.

---

## Phase 2 — Workflow Editor + JSON Export/Import

**Goal:** User can clone a built-in, edit its provider columns and step list, save it, and use it for new videos. JSON export/import works manually (no AI skill yet).

### Schema

No new schema. (`is_builtin`, `enabled`, `version` already added in Phase 1.)

### Workflow row Zod schemas (`src/lib/workflows-schema.ts` — new file, used by API validation)

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

export const WorkflowPatchSchema = WorkflowRowSchema.partial().extend({
  expected_version: z.coerce.number().int().min(1),
});
```

### API routes

- `POST /api/workflows` — create. Validates against `WorkflowRowSchema`. Sets `version = 1`, `is_builtin = 0`, `created_at = updated_at = now`. Returns 201 with full row.
- `PATCH /api/workflows/[id]` — update. Validates against `WorkflowPatchSchema`. If `workflows.version != expected_version`, return 409 `{ current_version }`. On success: bump `version`, set `updated_at`, replace `workflow_steps` rows in transaction.
- `DELETE /api/workflows/[id]` — delete. Returns 409 if any video references this workflow (the `ON DELETE RESTRICT` FK enforces this; the route catches the SQLite constraint error and returns a friendly `{ error: "workflow_in_use", videos_count: N }` message).
- `POST /api/workflows/[id]/clone` — clone with a new ID (operator-supplied slug or auto-derived from new label; uniqueness check). Sets `is_builtin = 0`, `version = 1`. Returns 201.
- `POST /api/workflows/[id]/reset` — built-ins only (404 otherwise). Re-seeds the row + steps from the in-code `BUILTIN_WORKFLOWS`. Bumps `version`.
- `POST /api/workflows/import` — body is workflow JSON. Validates against `WorkflowRowSchema`, inserts (or 409 on ID collision unless `?overwrite=1` — overwrite path bumps `version`).
- `GET /api/workflows/[id]/export` — returns canonical JSON suitable for re-import (no `version`, no `created_at`, no `updated_at`, no `is_builtin`, includes `id`, `label`, `short_label`, `description`, four provider columns, `enabled`, and the `steps` array).

### UI

- `/workflows` page gains action buttons: Clone, Edit, Delete (disabled for built-ins with FK reference), Reset (built-ins only — opens confirmation modal "Reset built-in to default? Custom changes will be lost."), Export, Toggle Enabled.
- Top of page: an "Import workflow" button that opens a file picker → POSTs to `/api/workflows/import`.
- New page `src/app/workflows/[id]/edit/page.tsx`:
  - Form fields: `label`, `short_label`, `description`, `script_llm_provider`, `tts_provider`, `image_provider`, `video_provider`, `enabled`.
  - Provider Selects use bare-name values (`comfyui`, `google_flow`, etc.) per the registry namespace.
  - Step list: ordered table of `{ step_name }` rows. Up/Down buttons reorder. Add/Remove row buttons. `step_name` is a `<Select>` populated by `REAL_STEPS.filter(s => s.module === "script")` (Phase 1 added the `module` field, so this filter is available).
  - Each step row shows the step's `label`; the `description` appears in a `title` attribute. If a step has `for_each`, it surfaces as a read-only badge ("multi-output: chapters") next to the step name.
  - Save button: PATCH with `expected_version` from page load. On 409: show toast "Workflow was modified elsewhere — reload?" with reload action.
- A help-line beneath the editor: "Note: `enrich_chunks` uses the global `enrich_chunks_llm_provider` setting, not this workflow's `script_llm_provider`."

### Tests

- Unit: workflow serialization round-trip (export → modify → import) preserves shape.
- Integration: clone `comfyui`, swap `tts_provider` to a hypothetical second value (mock by adding it to the registry in the test), queue a video using the new workflow, confirm it runs.
- Concurrency: simulated dual-PATCH with stale `expected_version` returns 409.
- Validation: PATCH with a step_name not in `REAL_STEPS.filter(module === "script")` returns 400.

### Done criteria

- User clones `comfyui` and renames it to "ComfyUI (custom title)", changes `description`, saves, queues a video using it — video runs successfully.
- Export downloads a JSON file; editing it and re-importing under a new ID round-trips.
- A built-in's Reset button opens a confirmation modal and only re-seeds on confirm.
- Editing a workflow that another tab modified produces a 409 + reload toast.

---

## Phase 3 — Input-Availability Validator + Schema Endpoint

**Goal:** Add the input-availability validator to the workflow editor (using the `inputs`/`produces` metadata declared in Phase 1). Ship `GET /api/workflows/schema` so the future AI skill has live introspection.

### Validator (`src/lib/workflows-validator.ts` — new file)

`validateInputAvailability(snapshot: WorkflowSnapshot): ValidationResult`:

1. Build the materialized step list (script steps + auto-glue + module steps).
2. For each step in order, accumulate its `produces` (or `outputs` if `produces` omitted) into a "available files" set.
3. For each step, check that each entry in `inputs` is matched by some entry in the accumulated set. Glob-on-glob match: an input `script/04_chapter_*.md` is satisfied by a prior `produces` entry of `script/04_chapter_*.md` (literal match) or by a more specific glob/literal that intersects.
4. Return `{ ok: boolean, warnings: [{ step_name, missing_input, message }] }`.

DB-derived inputs (e.g., reading `videos.title`) are never declared in `inputs`, so they are implicitly satisfied.

The validator runs at workflow PATCH/POST/import time. Warnings are returned in the response body but do NOT block save (per Q-O "warnings, not hard block"). Editor surfaces them as inline alerts on the affected step rows.

### Schema endpoint

`GET /api/workflows/schema` — returns the catalog the AI skill (Phase 6) and the editor depend on:

```json
{
  "modules": ["script", "tts", "image", "video", "glue"],
  "steps": [
    {
      "name": "research_outline",
      "module": "script",
      "label": "Research Outline",
      "description": "Generates a chapter-by-chapter outline from title + topic.",
      "inputs": [],
      "produces": ["script/01_outline.md"],
      "for_each": null
    },
    ...
  ],
  "providers": {
    "script": ["openrouter", "claude_cli"],
    "tts": ["ai33"],
    "image": ["comfyui", "google_flow"],
    "video": ["comfyui", "google_flow"]
  }
}
```

The shape is stable; consumers (editor, AI skill) read it at runtime to stay in sync with code.

### Editor enhancements

- Step picker `<Select>` already shows `step.label` (Phase 2). Phase 3 wires up the validator.
- On Save: send PATCH; the route runs the validator and includes warnings in the 200 response. UI displays warnings inline next to the offending step rows.
- A "Validate now" button next to Save runs the validator without saving.

### Tests

- Unit: ordering validator catches a broken workflow ("write_chapters needs `script/02_characters.md` but no prior step produces it").
- Unit: glob-on-glob matcher behaves correctly.
- Unit: schema endpoint output shape stable across runs.

### Done criteria

- Removing `research_characters` from a cloned workflow surfaces a warning but allows save.
- `GET /api/workflows/schema` returns the live catalog.
- Editor shows inline validation warnings on save.

---

## Phase 4 — Claude CLI Script Provider + `enrich_chunks` Provider

**Goal:** A workflow can pick `claude_cli` for the script module. `enrich_chunks` reads its provider from a separate global setting.

### Files

- `src/lib/llm/claude-cli.ts` — new provider implementing `LlmProvider`.

```ts
export const claudeCliProvider: LlmProvider = {
  async chat(messages, opts = {}) {
    const db = opts.db ?? getDb();
    const cliPath = getSetting("claude_cli_path", db);    // default "claude"
    const model = opts.model ?? getSetting("claude_cli_model", db);
    const extraArgs = getSetting("claude_cli_extra_args", db);

    const prompt = messages.map(m => m.content).join("\n\n");
    const args = ["-p", prompt, "--model", model, ...parseArgs(extraArgs)];

    return await spawnAndCapture(cliPath, args);
  }
};
```

`spawnAndCapture` uses Node `child_process.spawn`, captures stdout, throws on non-zero exit with stderr in the error message. No retry loop (CLI failures are usually deterministic; the orchestrator will mark the step failed and the user can retry).

- `src/lib/llm/index.ts` — register `claude_cli`.
- `src/lib/settings.ts` — add `claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`, `enrich_chunks_llm_provider` Zod schemas. **Delete** the now-obsolete `llm_provider` schema.
- `src/lib/db.ts` `DEFAULT_SETTINGS` — add defaults: `claude_cli_path: "claude"`, `claude_cli_model: "claude-opus-4-7"`, `claude_cli_extra_args: ""`, `enrich_chunks_llm_provider: "openrouter"`. **Remove** the `llm_provider` default.

`parseArgs(extraArgs)` semantics: `extraArgs.split(/\s+/).filter(Boolean)`. Whitespace-separated tokens; quoted strings not supported in v1 (documented in the Settings UI help-text). If users need a flag value with spaces, this is an Open Item for a future `shell-quote` upgrade.

### Pipeline wiring (`src/worker/pipeline.ts`)

- `resolveDeps` resolves two LLM provider instances:
  - `chat`: from `snapshot.script_llm_provider`. Used by script-module steps (`research_outline`, `research_characters`, `write_hook`, `write_chapters`).
  - `enrichChat`: from `getSetting("enrich_chunks_llm_provider")`. Used by `enrich_chunks`.
- `StepContext.chat` is the script provider. Add `StepContext.enrichChat` for `enrich_chunks`.
- Update `09-enrich-chunks.ts` to call `ctx.enrichChat(...)` instead of `ctx.chat(...)`.
- The previous Phase 1 wiring read `getLlmProvider(getSetting("llm_provider", db))`. After Phase 4, that line is removed entirely. The `llm_provider` setting has zero remaining consumers and is deleted.

### Settings UI

- Rename the existing `openrouter` tab to `llm`. At the top, a "General" `FieldGroup` holds `enrich_chunks_llm_provider` (a `<Select>` with `["openrouter", "claude_cli"]`). Below that, two collapsibles: "OpenRouter" (`model_name`, `style_prompt_default`) and "Claude CLI" (`claude_cli_path`, `claude_cli_model`, `claude_cli_extra_args`). The old `llm_provider` field is removed.
- The "Claude CLI" collapsible has a help-line under `claude_cli_extra_args`: "Whitespace-separated; quoted strings not supported."
- `TAB_FIELDS` in `src/app/settings/settings-form.tsx` is updated to map all LLM-related keys to the renamed `llm` tab.

### Workflow editor

- `script_llm_provider` `<Select>` shows `[openrouter, claude_cli]`.

### Tests

- Mock `child_process.spawn` and verify the CLI is called with correct args.
- Integration: a workflow with `script_llm_provider: "claude_cli"` runs all four script steps via the mocked CLI.

### Done criteria

- A user can switch a workflow to `claude_cli`, queue a video, and the script steps shell out to `claude -p ... --model ...`.
- `enrich_chunks` can be set independently to `openrouter` while script uses `claude_cli`.

---

## Phase 5 — Video Provider Registry + Google Flow as Registered Provider

**Goal:** `VideoProvider` interface exists. Google Flow becomes a registered `ImageProvider` and `VideoProvider` rather than a bypass path. The four `generate-*-comfyui.ts` / `generate-*-google-flow.ts` step files collapse into two: `generate-main-images.ts` and `generate-hook-video.ts`. The Phase 1 transitional mapping table is removed.

### Files

- `src/lib/video/types.ts` (new):

```ts
export interface VideoProvider {
  generateBatch(
    items: { id: string; prompt: string }[],
    targetDir: string,
    opts: { db?: Database; log?: (m: string) => void; videoId: string }
  ): Promise<void | DeferSignal>;
}
```

- `src/lib/video/index.ts` (new): registry with `comfyui` and `google_flow`.
- `src/lib/video/comfyui.ts` (new): wraps `lib/image/comfyui.generateHookVideoBatch` into the `VideoProvider` interface. (Or move the function from `lib/image/comfyui.ts` here; image stays in image, video moves to video. Cleaner namespacing.)
- `src/lib/video/google-flow.ts` (new): a `VideoProvider` that internally calls `runGoogleFlowStep` with `chunkKind: "hook"`/`mode: "text"`. Returns `DeferSignal` when the queue defers.

- `src/lib/image/google-flow.ts` (new): an `ImageProvider` that wraps `runGoogleFlowStep` with `chunkKind: "main"`/`mode: "createImage"`. Same `DeferSignal` semantics.

- `src/lib/image/types.ts`: change `generateBatch` return to `Promise<void | DeferSignal>`. Update ComfyUI's `generateBatch` signature (just returns `void`, no behavior change; ComfyUI is sync so it never defers).

- `src/lib/image/index.ts`: register `comfyui` and `google_flow` (rename existing `comfyui` entry as needed; the old key stays the same).

- `src/worker/steps/generate-main-images.ts` (new): single step `name: "generate_main_images"`, `module: "image"`. Reads `chunks.json`, filters to `kind === "main"`, calls `ctx.imageProvider.generateBatch(...)`, returns its result (which may be `DeferSignal`).

- `src/worker/steps/generate-hook-video.ts` (new): single step `name: "generate_hook_video"`, `module: "video"`. Same but for hook chunks and `ctx.videoProvider`.

- Delete: `generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts`. Their behavior is now dispatched via the registry from inside the unified steps.

### Materializer simplification

The Phase 1 transitional mapping table (provider value → legacy step slug) is removed. `materializeStepList` now emits `generate_main_images` and `generate_hook_video` directly. Provider dispatch happens inside those steps via `ctx.imageProvider` / `ctx.videoProvider`.

### Step registry + downstream consumers

- `REAL_STEPS` loses four entries, gains two.
- `STEP_OUTPUTS` (`src/worker/steps/index.ts:100`) is regenerated automatically from the new `REAL_STEPS`.
- `STEP_ARTIFACT_RULES` (`src/lib/artifact-grouping.ts`) — find every rule keyed by `generate_main_images_comfyui` / `_google_flow` / `generate_hook_video_comfyui` / `_google_flow` and replace with `generate_main_images` / `generate_hook_video`. The `validateStepArtifactRules` boot validator catches any miss.

### Snapshot migration for in-flight videos

A new video queued at Phase 5 gets a snapshot referencing the unified slugs. **Existing in-flight videos** (rare, since Phase 5 ships well after Phase 1) snapshotted with the legacy slugs would break. Mitigation: `bootValidate(db)` rejects any `videos.workflow_snapshot` whose step list contains a slug not in `REAL_STEPS` and surfaces a clear error. Operator action: complete or restart in-flight videos before deploying Phase 5. Documented in the Phase 5 PR description.

### `step.outputs` for the new unified steps

The unified `generate_main_images` step has `outputs: ["images/main"]` and a custom `cleanup` hook that delegates to the provider. The provider decides whether to delete the directory or preserve in-flight state. The ComfyUI provider implements `cleanup()` as `rmSync("images/main", { recursive: true, force: true })`. The Google Flow provider implements `cleanup()` as a no-op (preserves in-flight queue rows). Same pattern for `generate_hook_video` with `outputs: ["videos/hook"]`.

### Settings UI

- ComfyUI tab: keep current settings (workflow paths, base URL).
- Google Flow tab: keep current settings (models, account management).
- Both still global; provider choice is per-workflow on the workflow row.

### Tests

- Unit: each new provider implements its interface correctly.
- Integration: a workflow with `comfyui` + `comfyui_video` runs the same end-to-end as before. A workflow with `google_flow_image` + `google_flow_video` also runs as before.
- Regression: full pipeline integration test passes with both built-in workflows.

### Done criteria

- The four old provider-specific step files are deleted.
- Workflow editor's Image and Video slots are uniform `<Select>` lists matching the TTS pattern.
- A user can mix providers in a workflow (e.g., `image_provider: "comfyui"` + `video_provider: "google_flow_video"` — though this combo is unlikely in practice, the architecture allows it).

---

## Phase 6 — AI-Skill Drafts Integration

**Goal:** The AI skill writes a workflow JSON to `prompts/workflows/drafts/`. The dashboard surfaces it as an importable draft. User clicks "Import" → row commits to DB and file moves to `prompts/workflows/imported/<slug>-<timestamp>.json`.

### Filesystem layout

```
prompts/workflows/
  drafts/
    <slug>.json                      # AI skill writes here
  imported/
    <slug>-<unix_timestamp>.json     # archived after import
```

(The `prompts/workflows/` directory does NOT contain bundled defaults — those live in code as the seed source.)

### API routes

- `GET /api/workflows/drafts` — lists files in `prompts/workflows/drafts/`. Returns `[{ filename, slug, label, providers, step_count, mtime }, ...]` (parses each file to extract metadata).
- `POST /api/workflows/drafts/[filename]/import` — reads the file, validates, calls the same import logic as `/api/workflows/import`, then `renameSync`s the file to `imported/<slug>-<timestamp>.json`. Returns 201 on success, 409 on slug collision (offers `?overwrite=1`).
- `DELETE /api/workflows/drafts/[filename]` — discards a draft without importing.

### UI

- `/workflows` page gains a "Drafts" section above the main table:
  - Header: "Drafts (N)" with a "Refresh" button.
  - One row per draft file: filename | label | providers | actions (Import, Discard).
  - Empty state: "No drafts. Use the AI skill to generate one — see docs."
- Toast on successful import: "Imported `<slug>`. View →" linking to the workflow's edit page.

### AI skill

(Outside this codebase — but the contract is documented here.)

The skill calls `GET /api/workflows/schema` (added in Phase 3) to retrieve the live catalog of steps + providers. It produces a JSON file matching the importable workflow shape:

```json
{
  "id": "fast-narrative",
  "label": "Fast narrative (no character research)",
  "short_label": "Fast",
  "description": "Skips character research for shorter videos.",
  "script_llm_provider": "openrouter",
  "tts_provider": "ai33",
  "image_provider": "comfyui",
  "video_provider": "comfyui",
  "enabled": true,
  "steps": [
    { "step_name": "research_outline" },
    { "step_name": "write_hook" },
    { "step_name": "write_chapters" }
  ]
}
```

`for_each` is NOT in the JSON — it's step-file metadata, not a workflow declaration. The skill picks a coherent combination from `/api/workflows/schema` and writes the file to `prompts/workflows/drafts/<slug>.json`.

### Tests

- Unit: import endpoint's slug-collision and validation paths.
- Integration: write a fixture draft file → call import endpoint → assert DB row + file move.

### Done criteria

- AI skill produces `prompts/workflows/drafts/example.json`.
- User opens `/workflows`, sees "Drafts (1)", clicks Import, the workflow appears in the main table.
- File is moved to `imported/example-<timestamp>.json`.

---

## Migration Notes

- Test DB is disposable: ship Phase 1 with a hard schema rebuild via `npm run db:init`. The new `videos.workflow_snapshot` column is nullable, so existing rows survive the rebuild — but workflow tables are new and require seed.
- Operators with prior data: documented in the Phase 1 PR — re-init required. (No production users today.)
- Built-ins re-seed: `INSERT OR IGNORE` only on init. The "Reset to default" button is the supported path for pulling updated built-in definitions. Built-in updates pushed via code do NOT propagate automatically to existing DB rows; users must hit Reset to receive them.
- `videos.workflow_id` FK is `ON DELETE RESTRICT`. The Phase 2 DELETE endpoint handles the SQLite constraint error and returns a friendly "this workflow is in use by N videos" response.
- Phase 5 in-flight videos: snapshots referencing `generate_*_comfyui`/`_google_flow` legacy slugs become invalid when the unified steps land. `bootValidate(db)` rejects them with a clear error. Operator action: drain or restart in-flight videos before deploying Phase 5.
- Dev workflow: `npm run dev` does not auto-init the schema. After pulling Phase 1, developers must run `npm run db:init` once. PR description includes this step prominently.

---

## File Change Index (cumulative through Phase 6)

### New files

- `src/lib/workflows.ts` — workflow loader, snapshot resolver, step materializer.
- `src/lib/workflows-schema.ts` — Zod schemas for workflow rows (`WorkflowRowSchema`, `WorkflowPatchSchema`).
- `src/lib/workflows-validator.ts` — input-availability validator (Phase 3).
- `src/lib/repos/workflows.ts` — DB access for `workflows` + `workflow_steps`.
- `src/lib/llm/claude-cli.ts` — Claude CLI provider.
- `src/lib/video/types.ts`, `src/lib/video/index.ts`, `src/lib/video/comfyui.ts`, `src/lib/video/google-flow.ts`.
- `src/lib/image/google-flow.ts`.
- `src/worker/steps/generate-main-images.ts`, `src/worker/steps/generate-hook-video.ts`.
- `src/worker/boot.ts` — `bootValidate(db)` (centralizes startup validators previously at module-load in `steps/index.ts`).
- `src/app/workflows/page.tsx`, `src/app/workflows/[id]/edit/page.tsx`, `src/app/workflows/[id]/edit/edit-form.tsx`.
- `src/app/api/workflows/route.ts` (GET, POST), `src/app/api/workflows/[id]/route.ts` (GET, PATCH, DELETE).
- `src/app/api/workflows/[id]/clone/route.ts`, `src/app/api/workflows/[id]/reset/route.ts`, `src/app/api/workflows/[id]/export/route.ts`.
- `src/app/api/workflows/import/route.ts`, `src/app/api/workflows/schema/route.ts`.
- `src/app/api/workflows/drafts/route.ts`, `src/app/api/workflows/drafts/[filename]/import/route.ts`, `src/app/api/workflows/drafts/[filename]/route.ts` (DELETE).

### Modified files

- `src/lib/db.ts` — schema additions, `seedDefaultWorkflows`, default settings, `llm_provider` default removed in Phase 4.
- `src/lib/settings.ts` — new global Zod schemas (`enrich_chunks_llm_provider`, `claude_cli_*`); `llm_provider` schema deleted in Phase 4.
- `src/lib/repos/videos.ts` — `createNewVideo`, `updateVideoDraft`, `transitionNewToQueued`, `transitionAllNewToQueued` all write/refresh snapshot via shared `computeSnapshot` helper.
- `src/worker/pipeline.ts` — `resolveDeps` reads snapshot, resolves script + enrich LLM providers, plus image/video/tts providers.
- `src/worker/steps/*.ts` — `module`/`label`/`description`/`inputs`/`produces`/`for_each` declarations on every step file (Phase 1).
- `src/worker/steps/09-enrich-chunks.ts` — uses `ctx.enrichChat`.
- `src/worker/steps/index.ts` — module-load validators removed (moved to `bootValidate`); `STEP_OUTPUTS` regenerated automatically when REAL_STEPS changes in Phase 5.
- `src/worker/runner.ts` (or worker entry) — calls `bootValidate(db)` on startup.
- `src/lib/image/types.ts` — `generateBatch` return type allows `DeferSignal`.
- `src/lib/image/index.ts` — register `google_flow` (alongside existing `comfyui`).
- `src/lib/llm/index.ts` — register `claude_cli`.
- `src/lib/artifact-grouping.ts` — update `STEP_ARTIFACT_RULES` step keys when Phase 5 collapses provider-specific steps (`generate_main_images_comfyui`/`_google_flow` → `generate_main_images`; same for hook video).
- `src/app/api/videos/route.ts` — POST checks `workflows.enabled = 1` before allowing create.
- `src/app/api/videos/[id]/route.ts` — PATCH triggers snapshot refresh when `workflow_id` changes.
- `src/app/settings/settings-form.tsx` — `openrouter` tab renamed to `llm`; `enrich_chunks_llm_provider` field added; `claude-cli` collapsible inside `llm` tab; `llm_provider` field removed in Phase 4.
- `src/app/videos/add-video-modal.tsx` — workflow `<Select>` reads from `/api/workflows` (filtered by `enabled = 1`).
- `src/app/layout.tsx` (or nav primitive) — `/workflows` nav link.

### Deleted files

- `src/worker/workflows/index.ts` — replaced by DB.
- `src/worker/steps/generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts` — collapsed into two unified steps in Phase 5.

---

## Open Items for Future Iterations

These are out of scope for this plan; tracked here so they don't get lost.

- **Per-workflow provider parameters.** Currently every TTS workflow shares `voice_id`, `voice_speed`, etc. If you need different voices per video, add `workflows.parameter_overrides JSON` and merge over global settings at provider-call time.
- **Drag-and-drop step reordering.** v1 uses up/down buttons. DnD is a polish-level enhancement.
- **Workflow versioning history.** Today `version` is just a conflict-detection counter. A future `workflow_history` table could store full snapshots per version for time-travel/audit.
- **Step library UI.** A future "Step library" page that documents every registered step (label, description, inputs, outputs) would help users authoring workflows without docs.
- **Multi-step modules beyond script.** If TTS/image/video ever need multi-step flows (e.g., TTS → audio enhancement → audio normalize), those would need a similar treatment to the script module — multi-step user-authored ordering inside a single module slot.
- **Validation rules at workflow save.** Phase 3 surfaces input-availability warnings. A future hard validation could enforce module-uniqueness rules at the editor (e.g., warn if a workflow has 2 voiceover steps).
- **Workflow-scoped prompts.** Today every workflow uses the same `prompts/01_research_outline.md`. Per-workflow prompt overrides could live in `prompts/workflows/<id>/01_research_outline.md` with fallthrough to the default.
- **CLI provider streaming.** Claude CLI supports streaming output. Today the provider buffers; a streaming variant could update `pipeline.log` in real time.
- **`shell-quote` for `claude_cli_extra_args`.** v1 splits on whitespace, no quoting support. If users need flag values containing spaces (e.g., `--system "You are a..."`), upgrade to a real shell-style parser.
- **Per-workflow `enrich_chunks_llm_provider`.** Today it's global. If users want different enrich providers per workflow, promote it to the workflow row alongside `script_llm_provider`.
