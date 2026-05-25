# Phase 1 — Workflows-as-Data End-to-End + Step Metadata

**Cross-phase reference:** [`README.md`](README.md) — Architecture sections (schema additions, `Step` interface, glue insertion logic) and Invariants A (transitional mapping), B (snapshot lifecycle), C (`bootValidate`).

---

## Overview

Move the two existing workflows (`comfyui`, `google-flow`) from in-code constants to DB rows. Add `module`/`label`/`description`/`inputs`/`produces`/`for_each` metadata to every step file (consumed by Phase 2's editor and Phase 3's validator — no behavior change in Phase 1). Pipeline reads from per-video `workflow_snapshot` (Invariant B). Read-only `/workflows` page exists. No editor.

After Phase 1, queuing a video runs the same 13-step pipeline as before, but the workflow definition lives in the database, the per-video snapshot is the orchestrator's source of truth, and every step file is annotated with the metadata Phases 2/3 will consume.

---

## Current State

**Workflow registry (in-code, deleted by this phase):**
- `src/worker/workflows/index.ts:11-16` — `Workflow` interface
- `src/worker/workflows/index.ts:18-28` — `SHARED_STEPS` constant
- `src/worker/workflows/index.ts:30-57` — `WORKFLOWS` array (`comfyui`, `google-flow`)
- `src/worker/workflows/index.ts:59-65` — `getWorkflowById`, `listWorkflows`

**Step contract (extended by this phase):**
- `src/worker/pipeline.ts:63-68` — current `Step` interface (4 fields)
- `src/worker/steps/index.ts:30-46` — `REAL_STEPS` array (15 entries: 9 shared + 4 provider-specific image/video + render + cleanup)
- `src/worker/steps/index.ts:54-93` — `validateWorkflowSteps` + `validateStepArtifactRules`, both invoked at module-load (lines 70, 93)

**Pipeline integration (rewired by this phase):**
- `src/worker/pipeline.ts:190-242` — `resolveDeps`: reads `videos.workflow_id`, dynamically imports `getWorkflowById`, materializes `Step[]` from slug list

**Video repo (extended by this phase to capture snapshots):**
- `src/lib/repos/videos.ts:42-61` — `createNewVideo`
- `src/lib/repos/videos.ts:77-122` — `updateVideoDraft`
- `transitionNewToQueued`, `transitionAllNewToQueued` (later in same file)

**Schema:**
- `src/lib/db.ts:90-177` — table DDLs (videos, video_steps, settings, google_flow_*)
- `src/lib/db.ts:184-219` — additive migrations
- `src/lib/db.ts:11-46` — `DEFAULT_SETTINGS`

**Add Video modal:**
- `src/app/videos/add-video-modal.tsx` — workflow `<Select>` populated from in-code `WORKFLOWS` prop
- `src/app/api/videos/route.ts:42-63` — POST validates `workflow_id` against in-code registry

**Worker entry:**
- `src/worker/index.ts:34-52` — `main()`. Calls `getDb()`, then `resetStaleRunningSteps(db)`, then `gfRepo.resetAllDispatchedOnStartup(db)`, then `startReaper(db, ...)`, then `runLoop(db, ...)`. `bootValidate(db)` slots in at the start of this sequence (right after `getDb()`).

**Legacy workflow step lists** (used as the regression-target for `materializeStepList`):

```
comfyui:     [ research_outline, research_characters, write_hook, write_chapters,
               assemble_script, voiceover, align, chunk, enrich_chunks,
               generate_main_images_comfyui, generate_hook_video_comfyui,
               render, cleanup ]

google-flow: [ research_outline, research_characters, write_hook, write_chapters,
               assemble_script, voiceover, align, chunk, enrich_chunks,
               generate_main_images_google_flow, generate_hook_video_google_flow,
               render, cleanup ]
```

The first nine steps (`SHARED_STEPS`) are identical; positions 10–11 are provider-specific; 12–13 are shared again.

---

## Scope

**Doing:**
- Create `workflows` and `workflow_steps` tables; add `videos.workflow_snapshot`; FK `videos.workflow_id → workflows.id` (`ON DELETE RESTRICT`) on greenfield init only — see Task 1 for SQLite-ALTER limitations.
- Seed `comfyui` and `google-flow` rows + their script-module steps via `INSERT OR IGNORE` from `db:init`.
- Add `module`/`label`/`description`/`inputs`/`produces`/`for_each` metadata to every step file.
- Build `src/lib/workflows.ts` with `getWorkflowFromDb` / `listWorkflows` / `resolveSnapshot` / `materializeStepList`. The transitional mapping table for image/video providers lives here (see README Invariant A).
- Build `src/lib/repos/workflows.ts` for DB access (internal — callers use `src/lib/workflows.ts`).
- Wire `pipeline.ts` `resolveDeps` to read `videos.workflow_snapshot` and pass it through `materializeStepList`.
- Snapshot capture in `videos.ts` repo — single helper `computeSnapshot` reused by all four lifecycle hooks (see README Invariant B).
- Move boot-time validators into `bootValidate(db)` (see README Invariant C). Delete `src/worker/workflows/index.ts` and update **all seven** files that import from it (see Task 13).
- API: `GET /api/workflows`, `GET /api/workflows/[id]`. Migrate `POST /api/videos` and `PATCH /api/videos/[id]` to DB-driven workflow validation; add `enabled` check on POST.
- UI: New `/workflows` nav entry; read-only `/workflows` page; videos list page reads workflows server-side from the new lib (no HTTP fetch).

**Not doing:**
- Workflow editor UI (Phase 2).
- POST/PATCH/DELETE/clone/reset/import/export workflow routes (Phase 2).
- Workflow row Zod schemas (`src/lib/workflows-schema.ts`) — created in Phase 2 when needed by API write paths.
- Input-availability validator (Phase 3).
- `GET /api/workflows/schema` endpoint (Phase 3).
- Claude CLI provider (Phase 4) — `script_llm_provider` column accepts `"openrouter"` and `"claude_cli"` values today, but Phase 1 only seeds `"openrouter"` and the LLM registry only resolves `"openrouter"`. Phase 4 adds `claude_cli` to the registry and removes the old `llm_provider` global setting.
- `enrich_chunks_llm_provider` setting + `StepContext.enrichChat` (Phase 4). In Phase 1, `09-enrich-chunks.ts` keeps using `ctx.chat`.
- Unified `generate_main_images` / `generate_hook_video` step files (Phase 5). The transitional mapping (README Invariant A) keeps the legacy four step files in use.
- `tts_provider` resolution from snapshot vs. global setting — Phase 1 keeps the existing `getSetting("tts_provider", db)` lookup (the snapshot column will have the same value, but rewiring is deferred to keep this phase scoped). Document this gap in the implementation.
- `chat` provider resolution — Phase 1 keeps `pipeline.ts:199` `getLlmProvider(getSetting("llm_provider", db)).chat` exactly as today. The snapshot's `script_llm_provider` column is captured but unconsumed at runtime in Phase 1. Phase 4 deletes the global `llm_provider` setting and rewires `chat` to read from `snapshot.script_llm_provider` (and adds `enrichChat` from the new `enrich_chunks_llm_provider` global). **Do not delete `llm_provider` in Phase 1.**

---

## Phase 1 Reference Material

The DDL, the `Step` interface, and the glue insertion logic live in [`README.md`](README.md) (Architecture section). The constants and tables below are Phase 1-specific implementation inputs.

### `BUILTIN_WORKFLOWS` seed data

`seedDefaultWorkflows(db)` inserts these two rows + their `workflow_steps` children inside a transaction with `INSERT OR IGNORE` against both tables. Both seeds use `script_llm_provider: "openrouter"` and `tts_provider: "ai33"`.

`SeedWorkflow` carries only the user-authored fields; `seedDefaultWorkflows` is responsible for stamping the lifecycle/identity columns on the INSERT — explicitly: `is_builtin = 1`, `enabled = 1`, `version = 1`, `created_at = updated_at = Date.now()`. The DDL defaults cover `is_builtin`/`enabled`/`version` for user-created rows, but built-ins MUST set `is_builtin = 1` so Phase 2's "Reset to default" button can identify them.

```ts
type SeedWorkflow = {
  id: string;
  label: string;
  short_label: string;
  description: string;
  script_llm_provider: "openrouter" | "claude_cli";
  tts_provider: "ai33" | null;
  image_provider: "comfyui" | "google_flow" | null;
  video_provider: "comfyui" | "google_flow" | null;
  steps: { step_name: string }[];
  // is_builtin, enabled, version, created_at, updated_at: stamped by seedDefaultWorkflows
};

const BUILTIN_WORKFLOWS: SeedWorkflow[] = [
  {
    id: "comfyui",
    label: "ComfyUI (local images, local hook video)",
    short_label: "ComfyUI",
    description: "Local image generation and hook video via a self-hosted ComfyUI server.",
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
    description: "Cloud image generation and hook video via the Google Flow extension queue.",
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

### Step metadata declarations

Every step file gets the new `Step` interface fields. `module`, `for_each`, `inputs`, `outputs`, `produces` per the table below. `label` is a short display name (e.g., "Research Outline"); `description` is a one-line summary (e.g., "Generates a chapter-by-chapter outline from title + topic.").

`produces` defaults to `outputs` when omitted (per the README "`Step` interface" section). The "`produces`" column below is empty (`—`) for steps where you can omit the declaration; for steps where the column shows an explicit list, declare it on the step constant.

| Step | `module` | `for_each` | `inputs` | `outputs` (existing — failure cleanup) | `produces` (Phase 3 validation) |
|---|---|---|---|---|---|
| `research_outline` | `script` | — | `[]` | `["script/01_outline.md"]` | — (defaults to `outputs`) |
| `research_characters` | `script` | — | `["script/01_outline.md"]` | `["script/02_characters.md"]` | — |
| `write_hook` | `script` | — | `["script/01_outline.md", "script/02_characters.md"]` | `["script/03_hook.md"]` | — |
| `write_chapters` | `script` | `chapters` | `["script/01_outline.md", "script/02_characters.md"]` | `[]` (atomic-write, no default cleanup) | `["script/04_chapter_*.md", "script/04_outline_structured.json", "script/story_so_far.md"]` |
| `assemble_script` | `glue` | — | `["script/03_hook.md", "script/04_chapter_*.md"]` | `["script/full_script.md"]` | — |
| `voiceover` | `tts` | — | `["script/full_script.md"]` | `["audio/narration.mp3", "audio/narration.srt", "audio/narration.json", "audio/.tts_task_id"]` | `["audio/narration.mp3", "audio/narration.srt", "audio/narration.json"]` (sidecar excluded — not consumed downstream) |
| `align` | `glue` | — | `["script/full_script.md", "audio/narration.mp3"]` | `["alignment/sentences.txt", "alignment/alignment.json"]` | `["alignment/alignment.json"]` (sentences.txt is intermediate, not consumed downstream) |
| `chunk` | `glue` | — | `["alignment/alignment.json"]` | `["chunks/chunks.json"]` | — |
| `enrich_chunks` | `glue` | `chunks` | `["chunks/chunks.json"]` | `[]` (atomic in-place rewrite, no default cleanup) | `["chunks/chunks.json"]` |
| `generate_main_images_comfyui` | `image` | `chunks` | `["chunks/chunks.json"]` | `["images/main"]` | `["images/main/*.png"]` |
| `generate_main_images_google_flow` | `image` | `chunks` | `["chunks/chunks.json"]` | `[]` (Google Flow queue rows preserved on failure) | `["images/main/*.png"]` |
| `generate_hook_video_comfyui` | `video` | `chunks` | `["chunks/chunks.json"]` | `["videos/hook"]` | `["videos/hook/*.mp4"]` |
| `generate_hook_video_google_flow` | `video` | `chunks` | `["chunks/chunks.json"]` | `[]` (Google Flow queue rows preserved on failure) | `["videos/hook/*.mp4"]` |
| `render` | `glue` | — | `["chunks/chunks.json", "audio/narration.mp3", "images/main/*.png", "videos/hook/*.mp4"]` | `["render", "final.mp4"]` | `["final.mp4"]` (`render/` is transient, not produced for downstream) |
| `cleanup` | `glue` | — | `[]` | `[]` (custom enumerate-and-delete; KEEP set defined inside the step) | — |

`outputs` values match what each step file already declares — do not change them. `inputs` and `produces` are new declarations. `inputs` is what the step body reads from disk; `produces` is what downstream steps may consume (path-or-glob).

DB-derived inputs (e.g., reading `videos.title`, `videos.topic_info`, settings, prompt templates from `prompts/`) are NOT declared in `inputs`.

### Project directory layout

`inputs` and `produces` paths are relative to `projects/<videoId>/`. Canonical layout:

```
projects/<videoId>/
  pipeline.log
  script/
    01_outline.md                 (research_outline)
    02_characters.md              (research_characters)
    03_hook.md                    (write_hook)
    04_outline_structured.json    (intermediate, write_chapters)
    04_chapter_01.md … 04_chapter_NN.md  (write_chapters)
    story_so_far.md               (intermediate, write_chapters)
    full_script.md                (assemble_script)
  audio/
    narration.mp3                 (voiceover)
    narration.srt                 (voiceover)
    narration.json                (voiceover)
    .tts_task_id                  (resume sidecar; listed in voiceover.outputs)
  alignment/
    sentences.txt                 (align — intermediate)
    alignment.json                (align)
  chunks/
    chunks.json                   (chunk; rewritten by enrich_chunks)
  images/main/
    <chunk_id>.png                (generate_main_images_*)
  videos/hook/
    <chunk_id>.mp4                (generate_hook_video_*)
  render/                         (transient, recreated by render)
  final.mp4                       (render)
```

After `cleanup`, only `final.mp4`, `script/full_script.md`, and `pipeline.log` remain.

### Workflow snapshot JSON shape (recap from Invariant B)

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

Snapshot stores only the script-module steps (the user-authored part). Glue and module steps (TTS/image/video) are inserted at materialization time from the four provider columns. `for_each` is NOT in the snapshot — it lives as step-file metadata.

---

## Tasks

### Phase 1A — Schema, seed, and the workflow loader

- [x] **Task 1: DDL for `workflows` and `workflow_steps`**
  **Files**: `src/lib/db.ts`
  **What**:
  - Add `workflows` and `workflow_steps` `CREATE TABLE IF NOT EXISTS` blocks to the schema DDL (`src/lib/db.ts:90-177`). Schema columns and the `idx_workflow_steps_workflow` index per README "Schema additions".
  - In the `videos` `CREATE TABLE` block (greenfield), add `workflow_snapshot TEXT` and change `workflow_id TEXT NOT NULL` → `workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE RESTRICT`.
  - In the additive-migration block (`src/lib/db.ts:184-219`), add an `ALTER TABLE videos ADD COLUMN workflow_snapshot TEXT` wrapped in the existing `try/catch (duplicate column name)` pattern. **The FK is NOT added via ALTER** — SQLite cannot retrofit constraints on an existing column. Existing-DB users get the column but no FK enforcement; greenfield (`db:init` against a missing/empty file) gets both.
  **Context**: Inline DDL pattern at `src/lib/db.ts:90-177` for prior tables. Additive-migration pattern at `src/lib/db.ts:183-204` (paused, deferred_until). Test DB is disposable (greenfield rebuild on init), so test-side coverage of the FK comes from greenfield. The PR description must call out: developers re-run `npm run db:init` to pick up the FK enforcement on a clean DB.

- [x] **Task 2: `seedDefaultWorkflows(db)` + `db:init` integration**
  **Files**: `src/lib/db.ts`
  **What**: Add the `BUILTIN_WORKFLOWS` constant (see "Phase 1 Reference Material" above) listing the two seeds (`comfyui`, `google-flow`) with their four provider columns, descriptions, and four script-module step rows. Implement `seedDefaultWorkflows(db)` using transactional `INSERT OR IGNORE` against both tables. On the `workflows` INSERT, **explicitly stamp `is_builtin = 1`, `enabled = 1`, `version = 1`, `created_at = updated_at = Date.now()`** — these are not on `SeedWorkflow`. Call from the same place `seedDefaultSettings` is called at init.
  **Context**: `INSERT OR IGNORE` semantics: on re-init, existing rows are preserved — built-in updates pushed via code do NOT propagate to existing DB rows. The Phase 2 "Reset to default" button is the supported path for receiving updated built-in definitions, and it relies on `is_builtin = 1` to identify which rows it can reset — forgetting this flag would silently break Phase 2's reset feature. Both seeds use `script_llm_provider: "openrouter"`, `tts_provider: "ai33"`, and provider-pair columns matching their legacy step lists.

- [x] **Task 3: Workflow repository (`src/lib/repos/workflows.ts`)**
  **Files**: `src/lib/repos/workflows.ts` (new)
  **What**: Atomic SQL wrappers per the existing repo pattern: `findById(db, id)`, `list(db)`, `findStepsByWorkflow(db, workflow_id)` (ordered by `position`). No write-path helpers in Phase 1 — POST/PATCH come in Phase 2.
  **Context**: Pattern at `src/lib/repos/videos.ts:1-36` (header comment, atomic-statement convention). Multi-statement composition happens at call sites inside `db.transaction`.

- [x] **Task 4: Workflow loader (`src/lib/workflows.ts`)**
  **Files**: `src/lib/workflows.ts` (new)
  **What**: Public surface (types come from `src/types.ts`, see Task 4a):
  - `getWorkflowFromDb(db, id): WorkflowRow | null`
  - `listWorkflows(db): WorkflowRow[]`
  - `resolveSnapshot(db, workflow_id): WorkflowSnapshot` — reads workflow row + steps inside the caller's transaction (caller passes `db`); returns the snapshot JSON shape from README Invariant B (recapped above).
  - `computeSnapshot(db, workflow_id): string` — calls `resolveSnapshot` and `JSON.stringify`s for storage.
  - `materializeStepList(snapshot): string[]` — auto-inserts glue per the README "Glue insertion logic" section + applies the transitional provider→slug mapping from README Invariant A. Result for the two seeded workflows must match the legacy step lists in the "Current State" section of this document exactly.
  **Context**: This file replaces the deleted `src/worker/workflows/index.ts`. The `materializeStepList` mapping table is the artifact Phase 5 will delete (README Invariant A). Glue insertion order per README "Glue insertion logic" (script steps → `assemble_script` → `voiceover` → `align` → `chunk` → `enrich_chunks` → image module → video module → `render` → `cleanup`). `tts`/`image`/`video` slots skip if the provider column is NULL.

- [x] **Task 4a: Shared types in `src/types.ts`**
  **Files**: `src/types.ts`
  **What**: Add three exported types that mirror the new schema and snapshot JSON shape:
  - `WorkflowRow` — mirrors the `workflows` table row: `id: string`, `label: string`, `short_label: string`, `description: string | null` (DDL allows null), `script_llm_provider: string` (NOT NULL), three nullable `*_provider` columns (`tts_provider`, `image_provider`, `video_provider`: `string | null`), `is_builtin: number` (0/1), `enabled: number` (0/1), `version: number`, `created_at: number`, `updated_at: number`. Use snake_case to match the SQLite columns directly (per CLAUDE.md "DB row types mirror the SQLite schema"). Numeric flags as `number` (0/1) match the `videos.paused` precedent.
  - `WorkflowStepRow` — mirrors `workflow_steps` row (`workflow_id: string`, `position: number`, `step_name: string`).
  - `WorkflowSnapshot` — the JSON shape from README Invariant B / "Workflow snapshot JSON shape" recap above (object with `workflow_id`, `version`, four provider fields nullable where the schema allows, and `steps: { step_name: string }[]`).
  **Context**: Existing types in `src/types.ts` cover `Video`, `VideoStep`, etc. Tasks 3, 4, 5, 12, and 14 import these. Defining them in `types.ts` keeps the cross-cutting types in one place rather than scattered across `repos/workflows.ts` and `lib/workflows.ts`.

- [x] **Task 5: Snapshot capture in videos repo**
  **Files**: `src/lib/repos/videos.ts`
  **What**: Extend four functions per README Invariant B. All write to `videos.workflow_snapshot` via `computeSnapshot(db, workflow_id)` in the same transaction as the existing INSERT/UPDATE.
  - **`createNewVideo`** (`:42-61`) — compute snapshot, include `workflow_snapshot` in the INSERT.
  - **`updateVideoDraft`** (`:77-105`) — only recompute when `fields.workflow_id !== undefined`. **Also widen the SQL guard from `WHERE id = ? AND status = 'new'` to `WHERE id = ? AND status IN ('new','queued')`** to match the Invariant B contract that PATCH is allowed on both. (Today's code only allows `new`; the API route at `src/app/api/videos/[id]/route.ts:69-97` already permits `queued`, so the repo is the narrower of the two — fix now while touching this function.)
  - **`transitionNewToQueued`** (`:123-131`) — re-resolve snapshot, then UPDATE both `status` and `workflow_snapshot` in a single statement. Keep the `AND status = 'new'` guard.
  - **`transitionAllNewToQueued`** (`:137-142`) — currently a single bulk UPDATE. **Rewrite as a transaction-wrapped per-row loop**: SELECT all `id, workflow_id WHERE status='new'`, then for each row compute the snapshot and UPDATE it + status. Return the row count. The bulk-UPDATE shortcut cannot stand because the snapshot is per-row.
  **Context**: All four sites must run inside `db.transaction(...)` so a partial failure (e.g., `computeSnapshot` throws on a deleted workflow) leaves no row half-updated. `computeSnapshot` itself reads `workflows` + `workflow_steps`, so the caller's transaction covers the full read+write window. Failure mode: if `workflow_id` doesn't resolve, throw with a clear "unknown workflow" message — the FK would also reject (on greenfield DBs), but throwing earlier gives a better error before the INSERT runs.

### Phase 1B — Step metadata declarations

- [x] **Task 6: Extend the `Step` interface**
  **Files**: `src/worker/pipeline.ts`
  **What**: Update the `Step` interface (lines 63-68) to match the README "`Step` interface (extended in Phase 1)" section. Add five fields: `module: ModuleId | "glue"`, `label: string`, `description: string`, `inputs: readonly string[]`, `produces: readonly string[]` (consumers default to `outputs` when omitted), and optional `for_each?: "chapters" | "chunks"`. Define `ModuleId = "script" | "tts" | "image" | "video"`. The existing `outputs` field stays — it's still the literal-path list used by default failure cleanup.
  **Context**: Phase 1 only needs the interface change + the field declarations on each step file (Tasks 7-9). The metadata is not yet consumed at runtime — Phase 2 reads `module` for the editor's step picker filter, Phase 3 reads `inputs`/`produces` for the input-availability validator. `outputs` vs `produces` rationale is in the README "`Step` interface" section.

- [x] **Task 7: Annotate script-module steps**
  **Files**: `src/worker/steps/01-research-outline.ts`, `02-research-characters.ts`, `03-write-hook.ts`, `04-write-chapters.ts`
  **What**: On each `step` constant, add `module: "script"`, `label`, `description`, `inputs`, `produces`, and `for_each` per the "Step metadata declarations" table above. `04-write-chapters` has `for_each: "chapters"` and uses `outputs: []` + `produces: ["script/04_chapter_*.md", "script/04_outline_structured.json", "script/story_so_far.md"]` (atomic-write step — no default cleanup, glob produces).
  **Context**: Existing step files export a named `step: Step` constant. The `outputs` arrays already exist on each (`01-research-outline.ts:99` etc.) and match the table; do not change them. `inputs` cite project-relative paths read from disk; DB-derived data (e.g., `videos.title`, settings, prompt templates) is implicitly satisfied and NOT declared in `inputs`.

- [x] **Task 8: Annotate glue + module steps**
  **Files**: `src/worker/steps/05-assemble-script.ts`, `06-voiceover.ts`, `07-align.ts`, `08-chunk.ts`, `09-enrich-chunks.ts`, `14-render.ts`, `15-cleanup.ts`
  **What**: Annotations per the "Step metadata declarations" table above:
  - `assemble_script` → `module: "glue"`
  - `voiceover` → `module: "tts"`
  - `align`, `chunk`, `render`, `cleanup` → `module: "glue"`
  - `enrich_chunks` → `module: "glue"`, `for_each: "chunks"`
  Each gets a one-line `label` and a short `description`. `inputs` / `produces` per the table; existing `outputs` arrays stay as declared in the files today.
  **Context**: `enrich_chunks` is glue (not script) because it's a one-off enrichment step with a global LLM provider setting (Phase 4 wires the separate `enrich_chunks_llm_provider` global). Phase 1 only stamps the metadata.

- [x] **Task 9: Annotate provider-specific image/video steps**
  **Files**: `src/worker/steps/generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts`
  **What**: ComfyUI image + Google Flow image → `module: "image"`, `for_each: "chunks"`. ComfyUI hook + Google Flow hook → `module: "video"`, `for_each: "chunks"`. Labels distinguishing provider in display text (e.g., "Generate main images (ComfyUI)"). `inputs`/`produces`/`outputs` per the table above. These four files are deleted in Phase 5; metadata exists for Phase 2's editor to label them correctly while they live.
  **Context**: Provider-specific files exist because today's workflow definition is a flat slug list — provider choice is encoded by selecting `generate_main_images_comfyui` vs `generate_main_images_google_flow` (and the matching hook step) at workflow-definition time. Phase 1's transitional mapping (README Invariant A) translates the workflow row's provider value into one of these four slugs at materialization time; Phase 5 collapses the four into two unified steps.

### Phase 1C — Pipeline integration + bootValidate

- [x] **Task 10: `bootValidate(db)`**
  **Files**: `src/worker/boot.ts` (new)
  **What**: New function `bootValidate(db: DatabaseType): void` that runs the two existing validators against `listWorkflows(db)` and `STEP_ARTIFACT_RULES`. Phase 1 scope per README Invariant C, points 1 and 2 (snapshot validity in point 3 is Phase 5's addition).
  **Context**: README Invariant C explains why this moves out of module-load. The implementer can either move the existing `validateWorkflowSteps` / `validateStepArtifactRules` functions into `boot.ts` or keep them exported from `steps/index.ts` and call them from `boot.ts` — either is fine. The key change is that `steps/index.ts:70` and `:93` (the bare invocations) are deleted.

- [x] **Task 11: Wire `bootValidate` into worker startup**
  **Files**: `src/worker/index.ts`
  **What**: In `main()` (`:34-52`), call `bootValidate(db)` immediately after `getDb()` (line 35) and before `resetStaleRunningSteps(db)` (line 36). Final order:
  1. `getDb()` — open DB.
  2. `bootValidate(db)` — fail-fast schema/registry consistency check. Goes first because it throws on inconsistency, and we want that throw before any state-mutating call (resets, reaper, runner) has a chance to run on a broken DB.
  3. `resetStaleRunningSteps(db)`.
  4. `gfRepo.resetAllDispatchedOnStartup(db)`.
  5. `startReaper(db, ...)`.
  6. `runLoop(db, ...)`.
  **Context**: A throw from `bootValidate` propagates to the top-level `.catch` at `:54-60`, which logs and `process.exit(1)`s — same supervisor-noticed boot failure as today's module-load throw. The pre-state-mutation placement means a corrupted DB (e.g., a workflow row referencing a deleted slug) doesn't get partial runtime cleanup before the operator sees the error.

- [x] **Task 12: Pipeline reads snapshot**
  **Files**: `src/worker/pipeline.ts`
  **What**: Rewrite `resolveDeps` (lines 190-242) to read `videos.workflow_snapshot` (must be non-null per Invariant B), JSON-parse to `WorkflowSnapshot`, pass through `materializeStepList`, then map slugs to `Step` objects via `REAL_STEPS` keyed by `step.name`. Throw on null snapshot ("video has no workflow snapshot — invariant violation"). Throw on unknown slug, same as today.
  **Context**: Today's `resolveDeps` dynamically imports `getWorkflowById` (line 213). Replace with a static import of `materializeStepList` + `getDb`-driven snapshot read. **Provider-resolution lines stay unchanged in Phase 1**:
  - `chat` (`:198-199`) keeps `getLlmProvider(getSetting("llm_provider", db)).chat`. Phase 4 rewires to snapshot.
  - `ttsProvider` (`:200-201`) keeps `getTtsProvider(getSetting("tts_provider", db))`. The snapshot's `tts_provider` is unconsumed at runtime in Phase 1.
  - `imageProvider` (`:202-203`) keeps `getImageProvider(getSetting("image_provider", db))`. Image/video dispatch stays step-internal — the legacy four step files keep doing what they do today; Phase 5 collapses them and shifts dispatch to snapshot.

- [x] **Task 13: Delete the in-code workflow registry + migrate all seven importers**
  **Files**: `src/worker/workflows/index.ts` (delete), and the seven files that import from it:
  - `src/worker/pipeline.ts:213-214` — covered by Task 12 (snapshot-driven `resolveDeps`).
  - `src/worker/steps/index.ts:2` — drop import; bare invocations at `:70`/`:93` deleted; `validateWorkflowSteps`/`validateStepArtifactRules` move to (or are called from) `boot.ts` per Task 10. `REAL_STEPS` / `STEP_OUTPUTS` exports stay.
  - `src/app/videos/page.tsx:6` — covered by Task 17.
  - `src/app/api/videos/route.ts:8, 56` — covered by Task 15 (POST validation).
  - `src/app/videos/[id]/page.tsx:9, 30` — replace `getWorkflowById(video.workflow_id)` with `getWorkflowFromDb(db, video.workflow_id)` from `src/lib/workflows.ts`. Same `Workflow | null` shape; the page consumes only `label` (verify) — if it consumes `shortLabel` add the same `short_label → shortLabel` mapping pattern as Task 17.
  - `src/lib/repos/steps.ts:3, 25` — replace `getWorkflowById(video.workflow_id)` with `getWorkflowFromDb(db, video.workflow_id)`. The repo's `findByVideo` uses the workflow's step ordering as the orphan-safe sort; a DB-driven lookup is functionally equivalent. **Note:** for already-queued videos, the orchestrator runs the snapshot's step list — but `findByVideo` is dashboard-side rendering of historical step rows, which still uses the live `workflows` row to order. Acceptable: a workflow edit in `new` state would re-sort the dashboard view, matching the snapshot already pinned to the row.
  - `src/app/api/videos/[id]/route.ts:10, 34, 88` — PATCH path also uses `getWorkflowById` (twice: once in `findByVideo`-shaped 200-response build at `:34`, once for `workflow_id` patch validation at `:88`). Replace both with `getWorkflowFromDb(db, ...)`. Add the same `enabled` check Task 15 applies to POST (a PATCH that switches `workflow_id` to a disabled workflow should also reject with 400 `workflow_disabled`).
  **What**: Delete `src/worker/workflows/index.ts` entirely after the seven importers are migrated. Run `Grep '@/worker/workflows'` post-change to confirm zero remaining hits.
  **Context**: This task is the consolidation point for the registry deletion; it has the most cross-cutting touch surface in Phase 1. Sequence with Task 12 carefully — Task 12 removes the `pipeline.ts` import, Task 13 removes the rest. The repo lookup pattern via `getWorkflowFromDb(db, ...)` is the public lib-layer abstraction over `workflowsRepo.findById` (Task 3).

### Phase 1D — API + UI

- [x] **Task 14: `GET /api/workflows` and `GET /api/workflows/[id]`**
  **Files**: `src/app/api/workflows/route.ts` (new), `src/app/api/workflows/[id]/route.ts` (new)
  **What**:
  - `GET /api/workflows` — returns `[{ id, label, shortLabel, isBuiltin, enabled, version, providers: { script, tts, image, video }, stepCount }, ...]`. Optional `?enabled=1` filter.
  - `GET /api/workflows/[id]` — returns full workflow with `steps: [{ step_name }, ...]` array, plus the same camelCase-mapped fields as the list response.
  **Context**: Existing API patterns at `src/app/api/videos/route.ts`. Use `listWorkflows(db)` / `getWorkflowFromDb(db, id)` from `src/lib/workflows.ts` (Task 4) — not the repo directly; the lib is the public boundary, the repo is internal.

  **Naming convention (chosen):** the API uses **camelCase consistently** at the response boundary. Internal types (`WorkflowRow` in `src/types.ts`) keep snake_case to match SQLite columns directly. A single mapper at the API layer converts `{ id, label, short_label, is_builtin, enabled, version, ... }` → `{ id, label, shortLabel, isBuiltin, enabled, version, ... }`. Rationale: existing TS consumers (`src/app/videos/page.tsx:34`, `videos-client.tsx`, `video-queue-table.tsx`, `topics-table.tsx`, `__tests__/components/videos/*`) read `shortLabel`; mixing snake_case and camelCase in the same response would be jarring. The `step_name` value inside `steps: [{ step_name }]` is a kebab-cased step slug (e.g., `"research_outline"`) — it's an opaque ID, not a JS field name, so it stays as-is. Phase 2's editor consumes this same shape.

- [x] **Task 15: DB-driven workflow validation in `POST /api/videos`**
  **Files**: `src/app/api/videos/route.ts`
  **What**: At `:8`, drop `import { getWorkflowById } from "@/worker/workflows"` and import `getWorkflowFromDb` from `src/lib/workflows.ts` instead. At `:56`, replace `getWorkflowById(parsed.data.workflow_id)` with `getWorkflowFromDb(db, parsed.data.workflow_id)`. After the existence check, also check `workflow.enabled === 1`:
  - Row not found → 400 `{ error: "workflow_not_found" }`.
  - `enabled = 0` → 400 `{ error: "workflow_disabled" }`.
  **Context**: The PATCH route at `src/app/api/videos/[id]/route.ts` has the same two `getWorkflowById` call-sites and is migrated by Task 13 (which also adds the same `enabled` check on the PATCH `workflow_id` field). The `enabled = 0` rejection on POST is the mechanism by which retired workflows are hidden from the Add dropdown without breaking historical references.

- [x] **Task 16: `/workflows` page (read-only) + nav entry**
  **Files**: `src/app/workflows/page.tsx` (new), `src/app/nav-bar.tsx`
  **What**:
  - `src/app/workflows/page.tsx` — server component. Calls `getDb()` and `listWorkflows(db)` from `src/lib/workflows.ts` directly (no HTTP fetch — same pattern as `src/app/videos/page.tsx:14-30`). Renders a read-only table: Name | Short label | Providers (script / tts / image / video) | Built-in? | Enabled? | Step count. Step count comes from a join (or a separate per-row count); Task 3's repo can expose `countSteps(db, workflow_id)` if needed.
  - `src/app/nav-bar.tsx:11-14` — append `{ href: "/workflows", label: "Workflows" }` to the `LINKS` array. Position between Videos and Settings.
  **Context**: No interactivity in Phase 1 — Phase 2 adds Clone/Edit/Delete/Reset/Export/Import/Toggle action buttons. The page consumes `WorkflowRow` directly (snake_case); the camelCase mapping is API-layer-only and doesn't apply to server-component reads.

- [x] **Task 17: Videos list page reads workflows from the DB**
  **Files**: `src/app/videos/page.tsx`, `src/app/videos/add-video-modal.tsx` (no change)
  **What**: At `src/app/videos/page.tsx:6`, drop `import { listWorkflows } from "@/worker/workflows"` and import `listWorkflows` from `src/lib/workflows.ts` (Task 4). At `:32-36`, call `listWorkflows(db)` (with `db` arg now), filter `row.enabled === 1`, and map each `WorkflowRow` to `{ id, shortLabel: row.short_label, label: row.label }` — the shape the existing `VideosClient` / `add-video-modal` / `video-queue-table` props already expect.
  **Context**: This page is a server component (uses `getDb()` at `:15`). No HTTP fetch needed; reading the lib directly is consistent with the existing pattern at `:16-30`. The `shortLabel` mapping handled here keeps the four downstream consumers (`videos-client.tsx`, `video-queue-table.tsx`, `topics-table.tsx`, `add-video-modal.tsx`) and their tests untouched. The Add Video modal itself is unchanged — it still consumes the `workflows` prop in its existing shape.

### Phase 1E — Tests

- [x] **Task 18: Unit tests for `materializeStepList`**
  **Files**: `src/lib/workflows.test.ts` (new)
  **What**: Cover the transitional mapping (Invariant A) — `image_provider="comfyui"` snapshot produces a step list with `generate_main_images_comfyui` at the right position; `image_provider="google_flow"` produces `generate_main_images_google_flow`. Same for `video_provider`. Verify glue insertion order matches the legacy step lists in "Current State" for both seeded workflows (regression guard).
  **Context**: Use seeded `BUILTIN_WORKFLOWS` data as test fixtures. Phase 5 will delete the transitional-mapping branch of these tests when the unified steps land.

- [x] **Task 19: Unit tests for snapshot lifecycle + widened guard**
  **Files**: `src/lib/repos/videos.test.ts` (extend existing or new)
  **What**: Per Invariant B + Task 5:
  - `createNewVideo` writes a non-null snapshot.
  - `updateVideoDraft({ workflow_id })` on a `new` video refreshes the snapshot.
  - `updateVideoDraft({ workflow_id })` on a `queued` video also refreshes the snapshot (regression test for the SQL-guard widening from `status='new'` to `status IN ('new','queued')`).
  - `updateVideoDraft({ title })` (no workflow change) leaves the snapshot untouched.
  - `updateVideoDraft({ workflow_id })` on `in_progress`/`failed`/`done` is rejected by the guard (no-op, no change to the row).
  - `transitionNewToQueued` re-resolves the snapshot from the current row even if nothing changed.
  - `transitionAllNewToQueued` re-snapshots every row in a multi-row fixture.
  - After queued, the snapshot is not refreshed by the orchestrator (verified separately in Task 20).
  **Context**: Existing repo test patterns under `src/lib/repos/*.test.ts`. The test fixture must seed the new `workflows` and `workflow_steps` tables before exercising `createNewVideo` (otherwise the FK on greenfield rejects).

- [x] **Task 20: Integration test — pipeline runs from snapshot**
  **Files**: `src/worker/pipeline.test.ts` (extend)
  **What**: Seed the new `workflows`/`workflow_steps` tables, create a video via `createNewVideo` (which writes the snapshot), then verify `resolveDeps` produces the expected slug list (matching the legacy step lists in "Current State" for both seeded workflows). Add a second case: edit the workflow's step list AFTER queueing, confirm the orchestrator still uses the pinned snapshot (snapshot immutability after `queued`). Existing pipeline tests should keep passing — no behavior change for an unmodified workflow.
  **Context**: Existing tests use mock `Step[]` and a fake `db`. The new fixtures must include both `workflows` rows and `workflow_steps` rows; `videos.workflow_snapshot` is populated by going through `createNewVideo` rather than seeded directly (exercises the snapshot-capture path end-to-end).

- [x] **Task 21: `bootValidate` smoke test**
  **Files**: `src/worker/boot.test.ts` (new)
  **What**: With seeded built-ins, `bootValidate(db)` returns without throwing. With a workflow row whose `workflow_steps` references an unknown slug, it throws with a clear message.
  **Context**: Same shape as today's `validateWorkflowSteps` invariant — just driven from DB now.

---

## Done Criteria

Implementation plan completion = all of these hold.

- `npm run db:init` produces a database with two seeded workflows (`comfyui`, `google-flow`).
- `/workflows` page lists both, read-only.
- A new video queued via the dashboard runs the same 13-step pipeline as before (matches the legacy step lists in "Current State").
- Every step file declares `module`, `label`, `description`, `inputs`, `produces` (or relies on the `outputs` default), and optional `for_each`.
- `src/worker/workflows/index.ts` is deleted; `Grep '@/worker/workflows'` returns zero hits across the repo (all seven importers migrated per Task 13).
- Boot validators run from the worker startup sequence (`bootValidate(db)` in `src/worker/index.ts`), not at module load.
- `videos.workflow_snapshot` is non-null for every video created via `createNewVideo`, refreshed on every `updateVideoDraft` that changes `workflow_id`, and re-resolved on every `transitionNewToQueued` / `transitionAllNewToQueued`.
- `updateVideoDraft` accepts patches on both `new` and `queued` videos (matching the API route's existing 409 guard).
- The global `llm_provider` setting is preserved and still drives `pipeline.ts` `chat` resolution (Phase 4 deletes it).

---

## References

- Cross-phase invariants and architecture: [`README.md`](README.md)
