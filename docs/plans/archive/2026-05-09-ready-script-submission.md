# Ready Script Submission

## Overview
Allow the operator to provide a pre-written script for a video, skipping the LLM-driven script generation steps (01–05) and starting the pipeline at voiceover (step 06). A new "Add Ready Script" entry point in the Topics section opens a dedicated modal that supports paste plus a "Load from file…" button. The script is stored alongside the video; at queue time the worker writes `script/full_script.md` to disk and pre-marks the script-generation steps as `done`, which the orchestrator already honors.

## Current State

### Pipeline already supports skipping done steps
The orchestrator iterates a step list materialized from `videos.workflow_snapshot` and continues past any step whose `video_steps` row is already `done`:

- `src/worker/pipeline.ts:403` — `if (stepsRepo.getStatus(...) === "done") continue;`
- `src/lib/repos/steps.ts:67-75` — `upsertPending` uses `INSERT OR IGNORE`, so pre-inserted rows survive the orchestrator's pre-loop seeding.

This means a ready-script implementation can be additive — no orchestrator changes required.

### Script generation steps and their disk outputs
- `src/worker/steps/01-research-outline.ts` → `script/01_outline.md`
- `src/worker/steps/02-research-characters.ts` → `script/02_characters.md`
- `src/worker/steps/03-write-hook.ts` → `script/03_hook.md`
- `src/worker/steps/04-write-chapters.ts` → `script/04_chapter_*.md`
- `src/worker/steps/05-assemble-script.ts` → `script/full_script.md` (the file step 06 reads)

`topic_info` is consumed only by step 01 (`research_outline.ts`) and `prompts/01_research_outline.md`. Steps 02-09 work off downstream artifacts. So when 01 is skipped, `topic_info`'s value is irrelevant for the run.

### Voiceover input contract
- `src/worker/steps/06-voiceover.ts:34-43` reads `script/full_script.md` directly and hands it to the TTS provider.
- Step 05 sanitizes em-dashes via `sanitizeScript` (`src/worker/steps/05-assemble-script.ts:23-29`) because the TTS provider fails on `—`. The same sanitization must apply to user-provided scripts.

### Video lifecycle hooks (where the prep needs to attach)
- `src/lib/repos/videos.ts:54-77` — `createNewVideo` (insert + snapshot pin)
- `src/lib/repos/videos.ts:99-137` — `updateVideoDraft` (PATCH path)
- `src/lib/repos/videos.ts:157-178` — `transitionNewToQueued` (single-row queue)
- `src/lib/repos/videos.ts:190-206` — `transitionAllNewToQueued` (bulk queue)
- `src/app/api/videos/[id]/restart/route.ts` — wipes project dir + step rows + resets row to `queued`. Without re-prep, a restart on a ready-script video would re-run script generation against a sentinel `topic_info` (broken).
- `src/app/api/videos/[id]/retry/route.ts` — only resets the failed step row, never touches `done` rows for 01-05. **No changes required for retry.**

### Schema migration pattern
Additive `ALTER TABLE` calls inside `createDb`, with the duplicate-column error swallowed and any other error rethrown. Existing examples: `src/lib/db.ts:327-364` (`paused`, `deferred_until`, `workflow_snapshot`).

### UI surface
- `src/app/videos/videos-client.tsx:222-247` — Topics section header where the new button lives.
- `src/app/videos/videos-client.tsx:86-88` — `modal` state (discriminated union); extend with a new mode.
- `src/app/videos/add-video-modal.tsx` — pattern to mirror for the new modal.
- `src/app/videos/topics-table.tsx:67-110` — row layout for the visual indicator.

## Scope

**Doing:**
- New nullable `provided_script` column on `videos`, exposed through types and repos.
- Queue-time prep: when `provided_script` is set, write `script/full_script.md` (sanitized) and pre-insert `done` rows for the script-generation steps.
- "Add Ready Script" modal — Title + Workflow + Script (textarea + "Load from file…" button).
- Edit support for ready-script videos (PATCH plus correct modal dispatch).
- Bulk-start parity (`transitionAllNewToQueued`).
- Restart correctness (re-prep when restarting a ready-script video).
- Topics row visual indicator so the operator can tell ready-script videos apart.

**Not doing:**
- Pre-aligned or pre-chunked input — the contract is `script/full_script.md` only.
- Mid-pipeline script swap once a video has left `new` / `queued`.
- Auto-derivation of title from script content.
- Format detection beyond non-empty / size limit; we accept whatever text the user provides and let `sanitizeScript` smooth out the known TTS hazard (em-dashes).
- Switching a ready-script video back into a topic-driven video (or vice versa) via Edit. Delete and re-create.

## Tasks

### Phase 1 — End-to-end paste flow (DB → API → UI for the single-row queue path)

Goal: an operator can click "Add Ready Script", paste or load a script, click Create, click "Add to queue" on the row, and watch the pipeline run from voiceover onward.

- [x] **Task 1.1: Add `provided_script` column + type field**
  **Files**: `src/lib/db.ts`, `src/types.ts`
  **What**: Add nullable `provided_script TEXT` to `videos` via the additive-migration pattern. Add `provided_script: string | null` to the `Video` interface.
  **Context**: Migration block lives next to the `workflow_snapshot` migration at `src/lib/db.ts:356-364` — copy that shape. `Video` interface at `src/types.ts:15-31`.

- [x] **Task 1.2: Extract `sanitizeScript` to a shared module**
  **Files**: `src/lib/script-sanitize.ts` (new), `src/worker/steps/05-assemble-script.ts`
  **What**: Move `sanitizeScript` to `src/lib/script-sanitize.ts` so the queue-time prep reuses the same em-dash handling. Update step 05 to import from the new module.
  **Context**: Function at `src/worker/steps/05-assemble-script.ts:23-29`. Keep the return shape `{ text, emDashCount }` so step 05's logging behavior is unchanged.

- [x] **Task 1.3: Repo column persistence + bulk-helper signature change**
  **Files**: `src/lib/repos/videos.ts`
  **What**:
    - `createNewVideo` accepts optional `provided_script` and persists it on insert (same transaction as the snapshot pin).
    - Change `transitionAllNewToQueued` return type from `number` to `string[]` — the list of video ids it transitioned. The bulk-start route reads the count via `result.length`.
  **Context**:
    - `createNewVideo` at `src/lib/repos/videos.ts:54-77`. Add the new column to the INSERT statement and the input type.
    - `transitionAllNewToQueued` at `src/lib/repos/videos.ts:190-206`. Inside the existing transaction, push each successfully-updated id (`info.changes === 1`) into a local array and return it. The repo stays SQL-only; the route owns the FS prep loop (Task 1.5).
    - Update the bulk-start route's `count` field at `src/app/api/videos/start-all/route.ts:7-8` to read `result.length`.

- [x] **Task 1.4: New `src/lib/ready-script.ts` lib with `applyReadyScriptArtifacts`**
  **Files**: `src/lib/ready-script.ts` (new)
  **What**: A new lib module — sibling of `src/lib/workflows.ts`, NOT under `repos/` — that crosses the SQL+FS boundary. Exports:
    ```
    applyReadyScriptArtifacts(db, videoId, projectsDir?): void
    ```
    Idempotent. Sequence:
      1. SELECT `provided_script` + `workflow_snapshot` for `videoId`.
      2. If `provided_script` is null, return no-op.
      3. `mkdirSync(join(projectsDir, videoId, "script"), { recursive: true })`.
      4. Sanitize the script (Task 1.2) and `writeFileSync` to `script/full_script.md` (overwrite on every call — that's what "idempotent" means here).
      5. In one SQL transaction: for every step name in `snapshot.steps` plus the literal `"assemble_script"`, run `INSERT OR IGNORE INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'done', ?, ?)` with `Date.now()` for both timestamps.
    Failure-case story:
      - FS write fails → exception propagates to caller, no DB rows inserted, on-disk state may have a partial dir but no script. Caller (route) returns 500; user sees the error and can retry. The next call overwrites the file from scratch.
      - FS write succeeds, SQL fails → file on disk, no done rows. The orchestrator would then run script generation against the sentinel `topic_info`. Surface this as an explicit caller error path; in practice SQLite INSERT OR IGNORE on a tiny table is reliable enough that we don't add a compensating rollback.
  **Context**:
    - `WorkflowSnapshot.steps` carries only the user-authored script-module steps (`src/types.ts:159-167`); the four built-in scripts are `research_outline`, `research_characters`, `write_hook`, `write_chapters`. `assemble_script` is glue and is inserted by `materializeStepList` — it does not appear in `snapshot.steps`. Pre-mark every name in `snapshot.steps` as done **plus** the literal `"assemble_script"`.
    - `projectsDir` defaults to `process.env.PROJECTS_DIR ?? "./projects"` — same default as `src/worker/pipeline.ts:288`. The optional param is for tests.
    - `INSERT OR IGNORE` is required because the orchestrator's pre-loop `upsertPending` (`src/lib/repos/steps.ts:67-75`) runs later and must NOT overwrite the pre-marked rows.
    - Reading the snapshot: mirror `src/worker/pipeline.ts:242-258` (`readSnapshot`).

- [x] **Task 1.5: Wire prep into the queue routes**
  **Files**: `src/app/api/videos/[id]/start/route.ts`, `src/app/api/videos/start-all/route.ts`
  **What**:
    - `start/route.ts`: after `transitionNewToQueued`, call `applyReadyScriptArtifacts(db, ctx.params.id)`. The helper is a no-op for non-ready-script videos.
    - `start-all/route.ts`: capture the `string[]` return from `transitionAllNewToQueued` (Task 1.3); loop calling `applyReadyScriptArtifacts(db, id)` for each. Wrap each row's call in its own try/catch — a partial failure should not abort the loop; collect errors and surface them in the response so the operator sees which videos failed prep.
  **Context**: Routes at `src/app/api/videos/[id]/start/route.ts:9-29` and `src/app/api/videos/start-all/route.ts:5-9`. The single-row route has no per-row failure-collection complexity — let the exception propagate as a 500.

- [x] **Task 1.6: API: POST /api/videos accepts `provided_script`**
  **Files**: `src/app/api/videos/route.ts`
  **What**: Extend `CreateVideoSchema` with `provided_script: z.string().min(1).optional()`. Pass to `videosRepo.createNewVideo`.
  **Context**: Schema at `src/app/api/videos/route.ts:42-46`. `topic_info` stays required at the schema layer — the modal is responsible for auto-filling it with a sentinel.

- [x] **Task 1.7: New "Add Ready Script" modal**
  **Files**: `src/app/videos/add-ready-script-modal.tsx` (new)
  **What**: Modal with three fields:
    - `title` — text input, required.
    - `provided_script` — `<Textarea>` (rows ≈ 14), required, with a "Load from file…" button above that uses a hidden `<input type="file" accept=".txt,.md">` and `FileReader.readAsText` to populate the textarea. Selecting a file overwrites the textarea content (the user can still edit afterwards).
    - `workflow_id` — `<Select>` from the existing `workflows` prop, required.
  POST to `/api/videos` with `{ title, topic_info: SENTINEL, workflow_id, provided_script }` where `SENTINEL = "[ready script — generation skipped]"`. On success, `router.refresh()` and close.
  **Context**: Mirror the structure and hook usage of `src/app/videos/add-video-modal.tsx`. Same `useRouter` + `fetch` + `setBusy` pattern. Use existing `Dialog`, `Input`, `Textarea`, `Select`, `Label`, `Button` components.

- [x] **Task 1.8: Wire the new button into the Topics header**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**:
    - Extend the `modal` state union with `{ mode: "addReadyScript" }`.
    - Add an "Add Ready Script" button next to "Add Topic" in the section header (same `<Button>` styling, secondary variant or matching primary — keep the visual hierarchy clear).
    - Render `<AddReadyScriptModal>` when `modal.mode === "addReadyScript"`.
  **Context**: Header at `src/app/videos/videos-client.tsx:222-247`; modal mount at `:327-334`; modal state at `:86-88`.

### Phase 2 — Symmetric coverage (edit, restart, visual indicator)

Goal: ready-script videos behave consistently with topic-driven videos across the rest of the existing UX. Each task below is a self-contained vertical slice through the relevant layers.

- [x] **Task 2.1: PATCH support + Edit modal dispatch + queued-row resync**
  **Files**: `src/app/api/videos/[id]/route.ts`, `src/lib/repos/videos.ts`, `src/app/videos/videos-client.tsx`, `src/app/videos/add-ready-script-modal.tsx`
  **What**:
    - `PatchVideoSchema` accepts optional `provided_script`. `updateVideoDraft` persists it; no snapshot recompute (the script doesn't affect workflow resolution).
    - **Queued-row resync rule**: in the PATCH route, after `updateVideoDraft`, if the patch included `provided_script` AND the (post-patch) row's status is `queued`, call `applyReadyScriptArtifacts(db, id)` so the on-disk file matches the new value. For status `new`, do nothing extra — the disk file is written when the row transitions to `queued` (Task 1.5). The helper is idempotent, so it safely overwrites the prior file and re-INSERTs the done rows (already a no-op via INSERT OR IGNORE).
    - `add-ready-script-modal.tsx` grows a `mode: "add" | "edit"` prop that hydrates initial state from a passed `Video` (mirror `add-video-modal.tsx:39-51`).
    - In `videos-client.tsx`, the existing Edit handler at `:256` checks `video.provided_script !== null` — if so, open the ready-script modal in edit mode; otherwise the existing modal.
  **Context**: PATCH schema at `src/app/api/videos/[id]/route.ts:46-58`. `updateVideoDraft` at `src/lib/repos/videos.ts:99-137`. The PATCH route already 409s for status outside `new|queued`, so no in-progress race exists for the resync call.

- [x] **Task 2.2: Restart correctness**
  **Files**: `src/app/api/videos/[id]/restart/route.ts`
  **What**: After the existing `deleteAllForVideo` + `resetToQueued` transaction commits, call `applyReadyScriptArtifacts(db, ctx.params.id)` (Task 1.4). The helper is a no-op when `provided_script` is null, so non-ready-script restarts are unaffected. For ready-script restarts, this re-writes the script file (the project dir was just `rmSync`'d) and re-marks the script-generation steps as done. Without this, the orchestrator would run script generation against the sentinel `topic_info`.
  **Context**: Restart route at `src/app/api/videos/[id]/restart/route.ts:22-58`. The call goes after the `db.transaction(...)` block at `:52-55` — keep it outside the transaction so the FS write isn't entangled with SQL atomicity (same pattern as the queue-route wiring in Task 1.5).
  **Note**: Retry (`src/app/api/videos/[id]/retry/route.ts`) only resets the failed step row, never touches `done` rows for 01-05, so retry needs no changes. Confirm this with a one-line code comment in the retry route.

- [x] **Task 2.3: Visual indicator across all three lifecycle tables**
  **Files**: `src/app/videos/topics-table.tsx`, `src/app/videos/video-queue-table.tsx`, `src/app/videos/finished-videos-table.tsx`
  **What**: When `video.provided_script !== null`, render a small "Ready script" badge inline in the Title cell (same line as the title link, slight left margin). Apply identically across all three tables so the indicator follows the row through its lifecycle.
  **Context**:
    - Topics title cell: `src/app/videos/topics-table.tsx:68-75`. Sparse cell — badge sits cleanly beside the title.
    - Queue table is denser (step status, runtime, action buttons). Keep the badge confined to the Title cell — do **not** introduce a new column or attach to the step status, both of which would crowd the row.
    - Finished table: same Title-cell placement.
    - Use a `Badge` component if one exists under `src/components/ui/`; otherwise inline a small `<span>` with muted-pill Tailwind classes (e.g. `text-xs rounded-full border px-2 py-0.5 text-muted-foreground`). Subtle visual weight — this is metadata, not action.

### Phase 3 — Cross-task integration test + spec

Per-task unit tests are written inline by `/implement-plan-tdd` during the RED→GREEN→REFACTOR cycle for each task above (e.g., the `applyReadyScriptArtifacts` idempotency test sits inside Task 1.4). Phase 3 is reserved for behavior no single task fully owns and for documentation.

- [x] **Task 3.1: API + queue-route integration test**
  **Files**: existing test layout (likely `src/**/__tests__/*.test.ts` or top-level `tests/`)
  **What**: End-to-end through HTTP layer without the worker:
    1. POST `/api/videos` with `provided_script` set.
    2. POST `/api/videos/[id]/start`.
    3. Assert: `script/full_script.md` exists on disk with sanitized content, AND every script step name from the snapshot plus `assemble_script` has a `video_steps` row with `status='done'`.
  **Context**: This is the smallest test that verifies the Phase 1 vertical slice works through the route layer — not just the helpers in isolation. Use a temp DB and a temp `PROJECTS_DIR`. The bulk-start path gets the same treatment if the existing repo's bulk tests need symmetry; otherwise unit-level coverage is sufficient.

- [x] **Task 3.2: Spec update**
  **Files**: `docs/histforge-spec.md`
  **What**: Document the `provided_script` column, the queue-time prep contract (write `script/full_script.md` + pre-mark script steps `done`), and the "Add Ready Script" UX as a recognized pipeline variant. Keep terse — link to the helpers and types rather than duplicating their shapes.

## References
- Skip-done logic: `src/worker/pipeline.ts:403`
- `upsertPending` idempotency: `src/lib/repos/steps.ts:67-75`
- Voiceover input contract: `src/worker/steps/06-voiceover.ts:34-43`
- Em-dash sanitization rationale: `src/worker/steps/05-assemble-script.ts:16-29`
- Workflow snapshot shape: `src/types.ts:159-167`
- `materializeStepList` (snapshot → ordered slugs): `src/lib/workflows.ts`
- Add-Topic modal pattern: `src/app/videos/add-video-modal.tsx`
- Topics-section button layout: `src/app/videos/videos-client.tsx:222-247`
