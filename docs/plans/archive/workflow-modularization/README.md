# Workflow Modularization — Per-Phase Plans

This directory holds actionable per-phase plans for `/implement-plan`. Each phase file is intended to be self-contained: read the phase file plus this README, and the phase is implementable without consulting other documents.

## Phases

- [Phase 1](phase-1.md) — Workflows-as-data + step metadata
- [Phase 2](phase-2.md) — Workflow editor + JSON export/import
- [Phase 3](phase-3.md) — Input-availability validator + schema endpoint
- [Phase 4](phase-4.md) — Claude CLI script provider + `enrich_chunks` provider
- [Phase 5](phase-5.md) — Video provider registry + Google Flow as registered provider
- [Phase 6](phase-6.md) — AI-skill drafts integration

---

## Architecture (introduced in Phase 1, stable through later phases)

These sections describe the data model, step interface, and step-list materialization mechanism Phase 1 introduces. Later phases extend but do not break them. Phase files reference these definitions rather than duplicating.

### Schema additions

Two new tables and one column addition. Phase 1 introduces them; Phases 2–6 add no further schema.

#### `workflows` table

```sql
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,                          -- kebab-case slug
  label TEXT NOT NULL,                          -- long display label
  short_label TEXT NOT NULL,                    -- compact label for table cells
  description TEXT,                             -- optional, surfaces in /workflows list
  script_llm_provider TEXT NOT NULL,            -- "openrouter" today; "claude_cli" registered Phase 4
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

#### `workflow_steps` table

```sql
CREATE TABLE workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  step_name TEXT NOT NULL,                      -- references REAL_STEPS slugs (no FK; code registry)
  PRIMARY KEY (workflow_id, position)
);
CREATE INDEX idx_workflow_steps_workflow ON workflow_steps(workflow_id, position);
```

`workflow_steps` carries only the *script-module* steps the user authored. Glue (TTS/image/video module steps + always-present glue) is materialized at resolution time from the four provider columns on the parent row. The `for_each` declaration lives on the `Step` interface (e.g., `step.for_each = "chapters"` on `04-write-chapters.ts`), not on the `workflow_steps` row.

#### `videos` table modifications

- `workflow_snapshot TEXT` (nullable) — JSON-serialized resolution per Invariant B.
- FK `workflow_id REFERENCES workflows(id) ON DELETE RESTRICT` (greenfield only — SQLite cannot retrofit FK constraints via ALTER on an existing column; existing-DB users get the column but no FK enforcement).

### `Step` interface (extended in Phase 1)

```ts
type ModuleId = "script" | "tts" | "image" | "video";
type ForEach  = "chapters" | "chunks";

interface Step {
  name: string;
  module: ModuleId | "glue";          // NEW (Phase 1)
  label: string;                       // NEW (Phase 1) — short user-facing display name
  description: string;                 // NEW (Phase 1) — one-line user-facing summary
  inputs: readonly string[];           // NEW (Phase 1) — project-relative paths read from disk; may use globs
  outputs: readonly string[];          // existing — literal paths used for failure cleanup
  produces: readonly string[];         // NEW (Phase 1) — for editor validation; may use globs. Defaults to `outputs` when omitted.
  for_each?: ForEach;                  // NEW (Phase 1) — read-only metadata; signals multi-output behavior
  run(videoId, ctx): Promise<void | DeferSignal>;
  cleanup?(videoId, ctx): Promise<void>;
}
```

**`outputs` vs `produces`**: `outputs` is the literal path list used by the orchestrator's default failure cleanup (`rmSync` per path). `produces` is the path-or-glob list the editor's input-availability validator (Phase 3) matches against downstream `inputs`. For atomic-write steps (e.g., `write_chapters`), set `outputs: []` (no default cleanup) and `produces: ["script/04_chapter_*.md", ...]` for validation. For most other steps, omit `produces` and consumers default it to `outputs`.

`inputs` cite project-relative paths read from disk; DB-derived data (e.g., `videos.title`, settings) is implicitly satisfied and NOT declared in `inputs`.

**Phase consumers:**
- Phase 1 only declares the metadata; not yet consumed at runtime.
- Phase 2 editor reads `module` (step picker filter), `label` and `description` (display), `for_each` (read-only badge).
- Phase 3 validator reads `inputs` and `produces` for input-availability checking.

### Glue insertion logic

Given a workflow snapshot's `steps` (the user-authored script-module steps + provider choices for tts/image/video), `materializeStepList` produces:

```
[ ...snapshot.steps,                             // script module (user-authored, ordered)
  "assemble_script",                             // always-present glue
  "voiceover",                                   // tts module — skipped if tts_provider is NULL
  "align",                                       // glue
  "chunk",                                       // glue
  "enrich_chunks",                               // glue (Phase 4 wires per-step LLM provider)
  "<image-step>",                                // image module — skipped if image_provider is NULL
  "<video-step>",                                // video module — skipped if video_provider is NULL
  "render",                                      // glue
  "cleanup" ]                                    // glue
```

`<image-step>` and `<video-step>` are resolved via Invariant A's transitional mapping (Phases 1–4: `generate_main_images_comfyui` etc.); Phase 5 simplifies to unified `generate_main_images` / `generate_hook_video` slugs. Steps are skipped if the corresponding provider column is NULL.

---

## Cross-Phase Invariants

The sections below apply across multiple phases. Phase files reference them rather than duplicating the rules.

### Invariant A — Transitional provider→slug mapping (introduced Phase 1, deleted Phase 5)

Phase 1 introduces `image_provider` and `video_provider` columns on the `workflows` row, but the unified `generate_main_images` / `generate_hook_video` step files do not exist yet — the four legacy provider-specific step files are still the runtime targets. To bridge that gap, Phase 1's `materializeStepList` translates provider values into legacy step slugs via a fixed table:

| Workflow row column | Value | Phase 1 step slug | Post-Phase 5 step slug |
|---|---|---|---|
| `image_provider` | `"comfyui"` | `generate_main_images_comfyui` | `generate_main_images` |
| `image_provider` | `"google_flow"` | `generate_main_images_google_flow` | `generate_main_images` |
| `video_provider` | `"comfyui"` | `generate_hook_video_comfyui` | `generate_hook_video` |
| `video_provider` | `"google_flow"` | `generate_hook_video_google_flow` | `generate_hook_video` |

**Lifetime:** Lives in `src/lib/workflows.ts` from Phase 1 through Phase 4. **Phase 5 deletes the table** when the unified steps land and dispatch happens internally via the registry. The seeded `comfyui` and `google-flow` workflows must run end-to-end starting from Phase 1.

Phase 5 actions tied to this mapping:
- Delete the mapping table from `materializeStepList`; emit `generate_main_images` / `generate_hook_video` directly.
- Delete the four legacy step files (`generate-main-images-comfyui.ts`, `generate-main-images-google-flow.ts`, `generate-hook-video-comfyui.ts`, `generate-hook-video-google-flow.ts`).
- Update `STEP_ARTIFACT_RULES` keys that referenced the legacy slugs.
- Existing in-flight videos snapshotted with legacy slugs become invalid — `bootValidate` must reject them with a clear error (see Invariant C).

### Invariant B — Workflow snapshot lifecycle

`videos.workflow_snapshot TEXT` (nullable column added in Phase 1) holds a JSON-serialized resolution of the workflow row + steps as of capture time. Snapshot shape:

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

The snapshot stores only the **script-module** steps (the user-authored part). Glue and module steps (TTS/image/video) are inserted at materialization time from the four provider columns. `for_each` is NOT in the snapshot — it lives as step-file metadata.

**Lifecycle rules** (enforced by `src/lib/repos/videos.ts` via the shared `computeSnapshot(db, workflow_id)` helper):

1. **`createNewVideo`** — snapshot computed and written immediately, in the same transaction as the row INSERT. A `new` video already has a non-null snapshot.
2. **`updateVideoDraft`** (PATCH `/api/videos/[id]`, allowed only on `new`/`queued`) — if the patch changes `workflow_id`, recompute the snapshot in the same transaction.
3. **`transitionNewToQueued`** and **`transitionAllNewToQueued`** — re-resolve the snapshot from the current `workflows` row in the same transaction as the status flip. This guarantees queue-time freshness even if nothing changed since `createNewVideo`.
4. After `queued`, the snapshot is **immutable**. The orchestrator reads only the snapshot, never the live `workflows` row — edits to a workflow do not affect already-queued or in-flight videos.

**Authority:** the snapshot is the source of truth for in-flight runs. `pipeline.ts` `resolveDeps` reads `videos.workflow_snapshot` and never re-reads `workflows`.

**Phases that touch this:**
- Phase 1 introduces the column, the helper, and the four call-sites; pipeline reads it.
- Phase 2's PATCH on a workflow does NOT cascade to existing snapshots (by design).
- Phase 4 wires `resolveDeps` to read `snapshot.script_llm_provider` for `ctx.chat`, replacing the previously-global `llm_provider` setting (deleted in Phase 4). Snapshots created Phase 1-onward already populate this field, so existing queued videos continue running unchanged when Phase 4 lands. The lifecycle rules (1–4 above) don't change.
- Phase 5 changes what `materializeStepList` produces from a snapshot, but the snapshot shape itself is unchanged.

### Invariant C — `bootValidate(db)` behavior

A new function `bootValidate(db: DatabaseType): void` in `src/worker/boot.ts` (Phase 1, new file) replaces the module-load validators currently at `src/worker/steps/index.ts:70` and `src/worker/steps/index.ts:93`.

**Why move from module-load to explicit boot call:**
- Module-load runs the moment any code imports `steps/index.ts`. Phase 1 needs `listWorkflows()` to read from the DB, which requires `getDb()` to have been called — that's a runtime ordering problem at module-load.
- `bootValidate(db)` runs explicitly from the worker entry point AFTER the database is open, and **before** any state-mutating call (`resetStaleRunningSteps(db)`, `gfRepo.resetAllDispatchedOnStartup(db)`, `startReaper(db, ...)`, `runLoop(db, ...)`). Failing fast prevents partial cleanup on a structurally inconsistent DB.

**What it validates:**

1. **Workflow steps exist** — for every workflow returned by `listWorkflows(db)`, every slug in its `workflow_steps` rows resolves to a `REAL_STEPS` entry. (Replaces today's `validateWorkflowSteps`.)
2. **Step artifact rules exist** — every `STEP_ARTIFACT_RULES.step` resolves to a `REAL_STEPS` entry. (Replaces today's `validateStepArtifactRules`.)
3. **(Phase 5 addition)** Every `videos.workflow_snapshot` whose status is `new` / `queued` / `in_progress` lists only step slugs present in `REAL_STEPS`. Phase 5 adds this check to surface in-flight videos snapshotted with legacy slugs after the unified steps land. `failed` is excluded — a failed video is dormant, and a future re-queue triggers `transitionNewToQueued`'s snapshot re-resolution (Phase 1 Task 5) which refreshes the snapshot from the live workflow row. `done` is terminal. Operator action: drain or restart in-flight (non-`failed`) videos before deploying Phase 5.

**Failure mode:** throws on first violation, killing the worker boot. Same fail-loud-at-boot rationale as today's module-load validators.

**Module-load coupling removed:** `src/worker/steps/index.ts` no longer calls `validateWorkflowSteps` or `validateStepArtifactRules` at import time. The functions themselves can move into `boot.ts` or stay exported from `steps/index.ts` and be called from `boot.ts` — implementer's choice.

**Phases that touch this:**
- Phase 1 introduces `boot.ts`, moves both validators in, wires it into `worker/index.ts`.
- Phase 5 adds the snapshot-validity check.

### Invariant D — Workflow schema endpoint + validator-warning shape (introduced Phase 3, consumed Phase 6)

`GET /api/workflows/schema` (Phase 3) returns a deterministic JSON catalog the editor and the AI skill (Phase 6) read at runtime to stay in sync with code. The four write paths (`POST /api/workflows`, `PATCH /api/workflows/[id]`, `POST /api/workflows/import`, `POST /api/workflows/validate`) all return warnings using the same shape. The validate route is intentionally flat (no `[id]`) because its body is self-contained and persists nothing.

**Schema endpoint shape:**

```jsonc
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
      "for_each": null              // always present; null when unset (never undefined / omitted)
    }
    // ... one entry per REAL_STEPS member
  ],
  "providers": {
    "script": ["openrouter"],       // Phase 4 adds "claude_cli"
    "tts":    ["ai33"],
    "image":  ["comfyui", "google_flow"],
    "video":  ["comfyui", "google_flow"]
  }
}
```

**Provider-array sources:** `script` and `tts` come from `Object.keys(<registry>)` at runtime. `image` and `video` are **hardcoded to `["comfyui", "google_flow"]` until Phase 5** because the workflow row's `image_provider`/`video_provider` columns accept both values via the transitional mapping (Invariant A), even though only `comfyui` is registered as a real `ImageProvider` and no `VideoProvider` registry exists yet. Phase 5 deletes the hardcoded lists and switches both to `Object.keys(<registry>)`.

**Validator-warning shape (returned by all four write paths and the dedicated validate route):**

```jsonc
{
  // ...the other response fields (row data, etc.)...
  "warnings": [
    { "step_name": "write_hook", "missing_input": "script/02_characters.md", "message": "Write hook needs 'script/02_characters.md' but no prior step produces it" }
  ]
}
```

**Semantics:**
- Warnings are advisory — saves are never blocked ("warnings, not hard block" is the resolved design decision for this surface).
- `step_name` is the slug (`REAL_STEPS[].name`); the editor maps it to the row position when surfacing inline alerts.
- `missing_input` is verbatim from `step.inputs` (may be a literal path or a glob).
- `message` is human-readable and uses the step's `label` for clarity.

**Phases that touch this:**
- Phase 3 introduces the endpoint, the validator, and the four write-path wirings.
- Phase 4 widens `providers.script` to `["openrouter", "claude_cli"]` simply by registering the new provider — no endpoint code change needed (`Object.keys(llmProviders)` picks it up automatically). The Phase 3 inline-snapshot test (Phase 3 Task 5) is updated to reflect the new shape.
- Phase 5 simplifies the materializer (Invariant A removal); `Object.keys(imageProviders)` and `Object.keys(videoProviders)` replace the hardcoded `image` / `video` arrays.
- Phase 6's AI skill calls the schema endpoint to draft workflow JSON; Phase 6's drafts dashboard surfaces the same warning shape from `/api/workflows/import` responses.

### Invariant E — Per-module LLM resolution (introduced Phase 4)

`StepContext` carries two LLM-provider entry points; which one a step uses depends on the step's module:

| Step's module | `StepContext` field | Resolved from | Mutability per video |
|---|---|---|---|
| `script` (`research_outline`, `research_characters`, `write_hook`, `write_chapters`) | `ctx.chat` | `snapshot.script_llm_provider` | **Pinned at queue time** — immutable for the lifetime of the run (Invariant B point 4) |
| `enrich_chunks` (glue, LLM-using) | `ctx.enrichChat` | global setting `enrich_chunks_llm_provider` | **Live** — read at the moment the step executes; an operator can flip the global mid-run between videos |
| `image` / `video` module steps that rewrite prompts (today: `generate-main-images-google-flow.ts`, `generate-hook-video-google-flow.ts`) | `ctx.chat` | same as script — these steps borrow the script provider | Pinned alongside the script provider |

**Rationale:**
- The script provider is a workflow-defining choice the user makes per workflow; pinning it in the snapshot keeps a queued video reproducible.
- `enrich_chunks` is a global enrichment glue step that should be tunable independent of any one workflow (e.g., flip from OpenRouter to a cheaper model without touching every workflow row).
- Image/video providers that rewrite prompts borrow the script provider so a workflow's script + image-prompt + video-prompt are written in a single coherent voice. Promoting a separate `image_prompt_llm_provider` is deferred.

**Phases that touch this:**
- Phase 4 introduces `StepContext.enrichChat`, deletes the global `llm_provider` setting and its sole consumer at `src/worker/pipeline.ts:198-199`, registers `claude_cli` in the LLM registry, and rewires `resolveDeps` to populate `chat` from `snapshot.script_llm_provider` and `enrichChat` from `getSetting("enrich_chunks_llm_provider")`. Step `09-enrich-chunks.ts` switches from `ctx.chat` to `ctx.enrichChat`; the four script-module steps and the two Google Flow image/video steps continue using `ctx.chat`.
- Phase 5 collapses `generate-*-comfyui.ts` / `generate-*-google-flow.ts` into unified `generate-main-images.ts` / `generate-hook-video.ts` that dispatch via `ImageProvider` / `VideoProvider` registries. The `generateBatch` opts struct must thread `ctx.chat` (the script provider) into provider implementations that rewrite prompts — otherwise Google Flow's prompt-rewriting access disappears. Phase 5's `VideoProvider` / `ImageProvider` interfaces do **not** include `chat` in `opts` by default — Phase 5 must widen them.
- Phase 6's AI skill writes workflow JSON whose four provider fields are `script_llm_provider`, `tts_provider`, `image_provider`, `video_provider`. `enrich_chunks_llm_provider` is **not** a workflow field — it's a separate global setting and must not appear in workflow JSON. The schema endpoint (Invariant D) does not list `enrich_chunks_llm_provider` under `providers`; Phase 6's AI skill prompt should treat enrich-chunks LLM choice as out of scope for workflow drafts.
