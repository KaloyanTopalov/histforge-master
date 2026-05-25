# HistForge App Overhaul

## Overview

Major overhaul that replaces Freepik with ComfyUI for hook-video generation, introduces a workflow abstraction so each video can declare its own provider chain, merges `/topics` + `/videos` into a single unified page with per-video lifecycle control (Start / Edit / Delete / Copy Path), and refactors Settings into per-provider tabs. The orchestrator transitions from a single hard-coded pipeline to a workflow-driven sequence.

User has consented to dropping all existing data, so the plan includes an explicit data wipe instead of a migration.

## Current State

**Pipeline** — 15 hard-coded steps in `src/worker/pipeline.ts:96-112` and `src/worker/steps/index.ts:24-40`. Steps 11–13 are Freepik/hook-image specific and go away.

**Freepik surface** — `src/worker/steps/12-freepik-hook-videos.ts`, `src/worker/steps/13-download-hook-videos.ts`, `src/lib/freepik/*`, `src/app/api/freepik/*`, `scripts/freepik-login.ts`, and the `freepik:login` npm script. `FreepikSessionLost` is defined in `src/lib/freepik/session.ts` (deleted with the lib in Task 1.2) and imported by 5 production files — `src/worker/runner.ts`, `src/worker/pipeline.ts`, `src/app/api/videos/route.ts`, `src/lib/repos/steps.ts`, `src/lib/repos/videos.ts` — plus 3 test files: `__tests__/unit/worker/pipeline.test.ts`, `__tests__/unit/worker/runner.test.ts`, `__tests__/unit/lib/freepik/session.test.ts`. Playwright is used exclusively by Freepik today.

**Queue pause gate** — `src/worker/pause-gate.ts` exposes `isQueueIdle(db)` which reads both `queue_state` and `freepik_relogin_needed`. Referenced by `runner.ts`, `pipeline.ts` (between-step check), `/api/videos` route envelope, and `__tests__/unit/worker/pause-gate.test.ts`.

**ComfyUI** — single provider for images; client at `src/lib/image/comfyui.ts`, workflow JSON at `prompts/comfyui/default-workflow.json`. Workflow mutation helpers (`findPromptNode`, `findLatentNode`, `findOutputNodeId`) already exist and are reusable.

**Data model** — separate `topics` (idea → in_pipeline → archived) and `videos` (queued → in_progress → done → failed) tables in `src/lib/db.ts:79-114`. `src/lib/db.ts` uses `CREATE TABLE IF NOT EXISTS`, so schema changes require an explicit file wipe to take effect.

**Queue model** — global `queue_state` setting (`running` | `paused`) + `freepik_relogin_needed` flag gate worker pickups.

**UI** — `/topics` page (list + Add/Edit modal + Queue button). `/videos` list + detail (detail is read-only w.r.t. processing). Settings form (`src/app/settings/settings-form.tsx`) is a single flat form grouped into six fieldsets. NavBar at `src/app/nav-bar.tsx:6-10` lists `/videos`, `/topics`, `/settings`.

**Tests** — live at `/workspace/__tests__/` (repo root, not under `src/`). ~20 files touched by this overhaul (full list in each phase's test task).

**Settings** — 22 keys defined in `src/lib/db.ts:12-35` and validated in `src/lib/settings.ts:12-53`.

## Scope

**Doing**
- Remove Freepik entirely (code, routes, settings, selectors, session handling, CLI script, profile dir).
- Drop the hook-images step (`generate_hook_images`) — new ComfyUI hook-video goes text-to-video directly.
- Introduce a ComfyUI hook-video step driven by a new `comfyui_hook_video_workflow_path` setting (workflow JSON is user-supplied later).
- Kill the global queue pause system (`queue_state`, `freepik_relogin_needed`, `pause-gate.ts`, `/api/queue/*`).
- Workflow abstraction: registry in code, `workflow_id` on each video, orchestrator loads the step sequence from the registry.
- Two registered workflows: `comfyui` (functional) and `google-flow` (stub steps that throw "Not implemented" — Google Flow dropdown option is selectable, fails at runtime per user decision).
- Drop the `topics` table; merge into a single `videos` table with `topic_info` + `workflow_id` + `delete_requested` columns. Explicit data wipe before schema rebuild.
- New `new` video status. Per-video Start button (list row + detail page). "Start All" button.
- Merge `/topics` + `/videos` into a single `/videos` page with two sections: "Video Queue" (new/queued/in_progress/failed) and "Finished Videos" (done).
- Add/Edit modal with Title + Topic info + workflow dropdown — all three required, no default workflow.
- Edit allowed only for `new` status. Workflow is editable in Edit mode.
- Delete with confirm dialog. Per-status behavior: `new` → row only; `queued`/`failed` → files + row; `in_progress` → mark `delete_requested=1`, orchestrator cleans up between steps, list row shows "Deleting…" cue.
- Copy Path button on Finished rows (clipboard). No modal, no folder open.
- Settings tabs: ComfyUI, Google Flow (scaffolded), OpenRouter, AI33, Render. No Queue tab.
- Keep Retry / Restart on the video detail page (unchanged behavior for `failed`).
- Sync documentation: `docs/histforge-spec.md`, domain skills, `MANUAL.md`.

**Not doing**
- Actual Google Flow Playwright automation (scaffolded only).
- Data migration — user consented to drop everything.
- Authoring a ComfyUI hook-video workflow JSON — user supplies this post-merge.
- Changing the cleanup step (15) — keep auto-cleanup of intermediates on successful render.
- Touching the `render` step — it reads `videos/hook/<chunk_id>.mp4` and that path is preserved.
- Touching `src/app/api/videos/[id]/files/[...path]/route.ts` — it serves files from `<projectsDir>/<videoId>/` and that path layout is preserved.
- Changing chunk sizing (hook chunks remain 12×10s).
- UI pagination or archival of finished videos.

## Tasks

### Phase 1: Freepik + Global Queue Teardown, Add ComfyUI Hook-Video

Goal: remove every trace of Freepik AND the global queue-pause system in the same phase (so the worker is never in a state where readers outlive their settings). Also add the ComfyUI hook-video step so the pipeline still runs end-to-end. By end of Phase 1 the pipeline works with a single hard-coded step order — workflow abstraction comes in Phase 2.

- [x] **Task 1.1: Delete Freepik step files + rename main-images**
  **Files**: `src/worker/steps/12-freepik-hook-videos.ts`, `src/worker/steps/13-download-hook-videos.ts`, `src/worker/steps/11-generate-hook-images.ts`, `src/worker/steps/10-generate-main-images.ts`, `src/worker/steps/index.ts`, `src/worker/pipeline.ts`
  **What**: Delete the three Freepik/hook-image step files. Rename `10-generate-main-images.ts` → `generate-main-images-comfyui.ts` (drop leading number) and change its `name` field from `generate_main_images` to `generate_main_images_comfyui`. Update `steps/index.ts` imports + `REAL_STEPS` entries. Update `STEP_ORDER` in `pipeline.ts:96-112` — after this task it is `research_outline`, `research_characters`, `write_hook`, `write_chapters`, `assemble_script`, `voiceover`, `align`, `chunk`, `enrich_chunks`, `generate_main_images_comfyui`, `render`, `cleanup` (12 entries). Task 1.5 inserts `generate_hook_video_comfyui` before `render`.
  **Context**: The drift guard at `src/worker/steps/index.ts:45-56` enforces `REAL_STEPS` ↔ `STEP_ORDER` parity and runs at module load — it must stay consistent at every task boundary. Task 1.5 atomically adds the new step file to `REAL_STEPS` and the new slug to `STEP_ORDER` in the same commit. Task 2.6 replaces the guard with a registry-based validator. Naming convention (intentional): provider-specific step files drop the numeric prefix because workflow registries, not file-system order, determine execution; shared steps keep their `01-…15-` prefixes.

- [x] **Task 1.2: Delete Freepik lib, API routes, CLI script, profile dir**
  **Files**: `src/lib/freepik/` (entire dir), `src/app/api/freepik/` (entire dir), `scripts/freepik-login.ts`, `package.json` (remove `freepik:login` npm script), `data/freepik-profile/` (if present on disk), `src/worker/index.ts`
  **What**: Delete all files under both source directories. Delete the CLI script. Remove the script entry from `package.json`. Remove the profile directory from disk (may not exist on a fresh checkout). In `src/worker/index.ts:5`: drop the `import { closeContext } from "@/lib/freepik/session"` line. In `src/worker/index.ts:36`: drop the `await closeContext()` call from the graceful-shutdown hook — there's no Freepik browser context to close anymore.
  **Context**: Keep `playwright` as a regular dependency in `package.json` — Google Flow will use it in a later plan. Confirm no other imports by grep before committing (Task 1.3 does the cross-sweep).

- [x] **Task 1.3: Sweep all `FreepikSessionLost` references**
  **Files (production)**: `src/worker/pipeline.ts`, `src/worker/runner.ts`, `src/app/api/videos/route.ts`, `src/lib/repos/steps.ts`, `src/lib/repos/videos.ts`, `src/app/videos/videos-client.tsx` (only the FreepikSessionLost-referencing comment at lines 75-76 — the surrounding state/prop cleanup is Task 1.4's scope)
  **Files (tests, deleted or updated in Task 1.8/1.10)**: `__tests__/unit/worker/pipeline.test.ts`, `__tests__/unit/worker/runner.test.ts`, `__tests__/unit/lib/freepik/session.test.ts`
  **What**: Remove every type import, catch branch, and helper tied to the exception. In `pipeline.ts:22-27`: drop the import. In `pipeline.ts:155-173`: delete the `recordSessionLost` function and its call site inside the orchestrator's error handler. In `runner.ts`: drop any session-lost-specific branches. In `/api/videos/route.ts`: remove the `FreepikSessionLost` import and any type-referring logic — the `freepik_relogin_needed` envelope field on this same route is Task 1.7's scope (different concern, same file, so both tasks must touch it). In `src/lib/repos/steps.ts`: if `resetRunningToPending` exists and is only used by the session-lost path, delete it. In `src/lib/repos/videos.ts`: delete `clearRunStateToQueued` (only used by session-lost).
  **Context**: `grep -r FreepikSessionLost src __tests__` must return zero hits after this task. The generic failure path at `pipeline.ts:180-216` handles every error after this change.

- [x] **Task 1.4: Tear down the global queue pause system**
  **Files**: `src/worker/pause-gate.ts` (delete), `src/worker/runner.ts`, `src/worker/pipeline.ts`, `src/app/api/queue/start/route.ts` (delete), `src/app/api/queue/pause/route.ts` (delete), `src/app/videos/videos-client.tsx`, `src/app/videos/[id]/video-detail-client.tsx`, `src/app/videos/page.tsx`
  **What**: Delete `pause-gate.ts` entirely. In `runner.ts:48-50` and `runner.ts:80-102`: remove the `isQueueIdle` call, collapse `TickResult` to `"worked" | "idle-empty"`, drop `"idle-paused"` branches and sleep-ms entries. In `pipeline.ts:278` (the between-step pause check): remove it — Phase 2 Task 2.8 reintroduces a between-step check for `delete_requested`. Delete both `/api/queue/*` route files. In `videos-client.tsx`: full cleanup of queue/relogin surface — drop `initialQueueState` and `initialReloginNeeded` props (lines 8-9), drop the `queueState` and `reloginNeeded` `useState` hooks (lines 37-38), drop `queue_state` and `freepik_relogin_needed` from the polling-payload type (lines 55-56) and from the setState calls (lines 78-79), delete `toggleQueue` (lines 95-101), delete the Pause/Resume button (lines 124-135), delete the Freepik relogin banner (lines 138-145), drop the `queueState === "paused"` badge branch (line 111). The FreepikSessionLost-referencing comment at lines 75-76 is Task 1.3's scope. In `video-detail-client.tsx`: drop the `initialQueueState` prop + `queueState` state, delete `toggleQueue` (lines 139-145), delete the Pause/Resume button (lines 179-187). In `videos/page.tsx:14-17`: drop the `getSetting("queue_state")` + `getSetting("freepik_relogin_needed")` fetches and stop passing them to `VideosClient`.
  **Context**: After this task the worker picks up any `queued` video FIFO with no global gate. `in_progress` crash-recovery (`runner.ts:40-42`) is unchanged.

- [x] **Task 1.5: Add ComfyUI hook-video step**
  **Files**: `src/worker/steps/generate-hook-video-comfyui.ts` (new), `src/worker/steps/index.ts`, `src/worker/pipeline.ts`, `src/lib/image/comfyui.ts` (may need a video-output helper)
  **What**: Create a step with slug `generate_hook_video_comfyui`. Reads `chunks/chunks.json`, filters for hook chunks, loads the workflow JSON from `comfyui_hook_video_workflow_path`, injects each chunk's enriched prompt via `findPromptNode`, submits to ComfyUI, polls `/history` for completion, downloads the output, writes to `videos/hook/<chunk_id>.mp4`. Declares `videos/hook` as its `outputs`. Register in `REAL_STEPS` at the same index in the array where the slug is inserted into `STEP_ORDER`. **Insertion point**: `STEP_ORDER` slot immediately after `generate_main_images_comfyui` and immediately before `render` (final 13-entry list: `…, generate_main_images_comfyui, generate_hook_video_comfyui, render, cleanup`). Do the `REAL_STEPS` insert + `STEP_ORDER` insert + new file creation in one commit so the drift guard at `steps/index.ts:45-56` stays satisfied.
  **Context**: Follow the existing ComfyUI image-step pattern in `src/lib/image/comfyui.ts:76-102+`. The workflow JSON may not exist in repo yet — if the path doesn't resolve, fail with a clear "drop your ComfyUI video workflow at X" error. Video output extraction differs from image; hunt the workflow for nodes whose class is `SaveVideo`, `VHS_VideoCombine`, or any class whose output is `VIDEO`. Keep the output-node detection flexible because the user's workflow choice (SVD/AnimateDiff/Wan/LTX) is unknown at build time.

- [x] **Task 1.6: Settings cleanup — drop Freepik + queue, add ComfyUI hook-video**
  **Files**: `src/lib/db.ts:12-35`, `src/lib/settings.ts:12-53`, `src/app/api/settings/route.ts` (PATCH validator), `src/app/settings/settings-form.tsx`
  **What**: Remove `freepik_style_name`, `freepik_relogin_needed`, `queue_state` from `DEFAULT_SETTINGS` and from `SETTING_SCHEMAS`. Add `comfyui_hook_video_workflow_path` as a new key in **both** places: as a `"prompts/comfyui/default-hook-video-workflow.json"` entry in `DEFAULT_SETTINGS`, and as a matching `z.string()` schema entry in `SETTING_SCHEMAS` (seed without a schema would fail on first `getSetting` read). Update the PATCH validator — drop any cross-field rules referencing removed keys. In `settings-form.tsx`: drop the Freepik text input, the `queue_state` dropdown, and the `freepik_relogin_needed` indicator; add the new text input for hook-video workflow path (placement will be reshuffled in Phase 4).
  **Context**: Safe because Tasks 1.3 and 1.4 have already removed every reader of these three settings. Phase 2 Task 2.9 adds Google Flow settings; Phase 4 re-groups everything into tabs.

- [x] **Task 1.7: Strip dead fields from API response envelopes** (merged into Task 1.6 commit — see commit note)
  **Files**: `src/app/api/videos/route.ts`, `src/app/api/videos/[id]/route.ts`, `src/app/api/health/route.ts`
  **What**: In `/api/videos` and `/api/videos/[id]`: remove `queue_state` and `freepik_relogin_needed` from the response envelope and any conditional logic feeding them. In `/api/health`: return `{ ok: true }` with no `queue_state` field.
  **Context**: Client consumers (`videos-client.tsx`, `video-detail-client.tsx`) were cleaned in Task 1.4; this task is the server-side mirror.

- [x] **Task 1.8: Delete obsolete tests**
  **Files (delete)**:
  - `__tests__/unit/lib/freepik/` (entire dir — `download.test.ts`, `selectors.test.ts`, `session.test.ts`)
  - `__tests__/api/freepik/` (entire dir — `relogin/route.test.ts`)
  - `__tests__/unit/lib/repos/topics.test.ts`
  - `__tests__/api/topics/` (entire dir — `route.test.ts`, `[id]/route.test.ts`, `[id]/queue/route.test.ts`) — topics production code is deleted in Task 1.9; tests go first so the suite stays green through 1.9.
  - `__tests__/unit/worker/steps/freepik-steps.test.ts`
  - `__tests__/unit/worker/steps/generate-hook-images.test.ts`
  - `__tests__/api/queue/` (entire dir — `start/route.test.ts`, `pause/route.test.ts`)
  - `__tests__/unit/worker/pause-gate.test.ts`
  **Context**: These test code paths that no longer exist after Tasks 1.1–1.4. If a test references a type/function that's still present, check whether that last reference should also be removed.

- [x] **Task 1.9: Delete `/topics` page + API + repo + NavBar link**
  **Files**: `src/app/topics/` (entire dir), `src/app/api/topics/` (entire dir), `src/lib/repos/topics.ts` (if present), `src/app/nav-bar.tsx`
  **What**: Delete all files under `src/app/topics/` and `src/app/api/topics/`. Delete `src/lib/repos/topics.ts`. Hunt for any remaining imports of the topics repo or `Topic` type. In `src/app/nav-bar.tsx:8`: remove the `{ href: "/topics", label: "Topics" }` entry from the `LINKS` array so the final `LINKS` is `/videos` + `/settings`.
  **Context**: Moved forward from Phase 3 to avoid a typecheck gap — Task 2.2 (Phase 2) deletes the `Topic` type from `src/types.ts`, and any surviving topics code would fail to typecheck against it. Topics tests were already deleted in Task 1.8. Before deleting `src/app/topics/topics-client.tsx`, read it once and save a mental note of its modal state-management shape — Phase 3 Task 3.6 (Add/Edit modal) mirrors that pattern, and after this task the file is only reachable via git history.

- [x] **Task 1.10: Update remaining tests for Phase 1 changes**
  **Files**:
  - `__tests__/unit/lib/db.test.ts` — remove assertions on deleted settings
  - `__tests__/unit/lib/settings.test.ts` — remove schemas for deleted settings, add for `comfyui_hook_video_workflow_path`
  - `__tests__/unit/lib/repos/videos.test.ts` — drop `clearRunStateToQueued` test
  - `__tests__/unit/lib/repos/steps.test.ts` — drop `resetRunningToPending` test if the function was deleted
  - `__tests__/unit/worker/pipeline.test.ts` — drop session-lost tests, update STEP_ORDER expectations
  - `__tests__/unit/worker/runner.test.ts` — drop idle-paused tests, update pickNextVideo expectations to reflect no-pause-gate behavior
  - `__tests__/components/settings/settings-form.test.tsx` — remove assertions for the deleted Freepik / queue fields only. Don't refactor structure — Task 4.4 rewrites this test wholesale for the tab layout; the goal here is just to keep the suite green through Phases 1–3.
  - `__tests__/components/videos/videos-client.test.tsx` — remove queue button + relogin banner assertions
  - `__tests__/api/videos/route.test.ts` — drop queue/relogin fields from response expectations
  - `__tests__/api/health/route.test.ts` — expect bare `{ ok: true }`
  - `__tests__/helpers/step-fixtures.ts` — remove any Freepik/hook-image step fixtures
  **Context**: Full vitest run passes at the end of this task. Failed tests indicate a missed edit in Tasks 1.1–1.9.

### Phase 2: Workflow Abstraction + Data Model Reset

Goal: introduce workflows as a first-class concept, attach `workflow_id` to videos, teach the orchestrator to read the step sequence from the workflow registry, and add the `new` status + `delete_requested` mechanism. Rebuild the schema without `topics` — with an explicit data wipe.

- [x] **Task 2.1: Data wipe + schema rebuild**
  **Files**: `src/lib/db.ts:79-114`, `data/histforge.db` (delete, plus any `data/histforge.db-wal` / `data/histforge.db-shm` sidecars from WAL mode), `<PROJECTS_DIR>/*` (delete all subdirs)
  **What**: **Stop the dev server first** (`npm run dev` spawns both Next.js and the worker via `concurrently` — the worker holds a SQLite WAL connection; deleting the DB file while that process is alive leaves corrupt sidecars or fails outright). Then manually delete `data/histforge.db` + its `.db-wal` / `.db-shm` sidecars, and every directory under the path configured by `PROJECTS_DIR` in `.env` (default `./projects/` per `.env.example`). User has consented to losing all data. Update the `CREATE TABLE` block in `db.ts`: drop `topics` entirely. New `videos` columns: `id TEXT PRIMARY KEY`, `title TEXT NOT NULL`, `topic_info TEXT NOT NULL`, `workflow_id TEXT NOT NULL`, `status TEXT NOT NULL`, `current_step TEXT`, `failed_step TEXT`, `failed_reason TEXT`, `started_at INTEGER`, `finished_at INTEGER`, `output_path TEXT`, `delete_requested INTEGER NOT NULL DEFAULT 0`, `created_at INTEGER NOT NULL`. `video_steps` and `settings` tables unchanged. `CREATE TABLE IF NOT EXISTS` stays — the file wipe is what makes the new schema apply.
  **Context**: `scripts/db-init.ts` works unchanged — it calls `createDb` + `seedDefaultSettings`. Document the reset in the commit message. Anyone with stale data needs to re-run `npm run db:init` and start over. `data/freepik-profile/` was already deleted in Task 1.2.

- [x] **Task 2.2: Update shared types**
  **Files**: `src/types.ts`
  **What**: Update `Video` row type: add `topic_info: string`, `workflow_id: string`, `delete_requested: 0 | 1`. Remove `topic_id`. Update `VideoStatus` to `"new" | "queued" | "in_progress" | "done" | "failed"`. Delete the `Topic` type entirely.
  **Context**: Single source of truth for DB row shapes. All consumers (API routes, pages, worker) import from here.

- [x] **Task 2.3: Rewrite step SQL to use `videos` columns directly**
  **Files**: `src/worker/steps/01-research-outline.ts`, `src/worker/steps/03-write-hook.ts`, `src/worker/steps/09-enrich-chunks.ts`
  **What**: After Task 2.1's schema rebuild the `topics` table is gone and `videos` carries `title` + `topic_info` directly. Rewrite each JOIN.
  - `01-research-outline.ts:47`: replace the JOIN with `SELECT title, topic_info FROM videos WHERE id = ?`. Update the `not found` error message to reference the video id only. Also update the file-header JSDoc at line 28 which currently says "joined via videos.topic_id".
  - `03-write-hook.ts:38`: replace with `SELECT title FROM videos WHERE id = ?`.
  - `09-enrich-chunks.ts:44-52`: drop the topic query entirely — `style_prompt_override` no longer exists on any row (Task 3.6 confirms the field is dropped from the data model). Replace the whole `stylePrompt` computation with `const stylePrompt = getSetting("style_prompt_default", db);`.
  **Context**: Step 02 (`02-research-characters.ts`) reads outputs from disk only — no schema coupling, no edits needed. After this task, `grep -rn "JOIN topics" src` returns zero hits and no step module imports the (now-deleted) `Topic` type.

- [x] **Task 2.4: Workflow registry**
  **Files**: `src/worker/workflows/index.ts` (new)
  **What**: Define `type Workflow = { id: string; shortLabel: string; label: string; steps: readonly string[] }`. Export `WORKFLOWS` array with two entries:
  - `{ id: "comfyui", shortLabel: "ComfyUI", label: "Generate Script (OpenRouter) + TTS (AI33) + Align (aeneas) + Generate Images (ComfyUI) + Hook Video (ComfyUI)", steps: [...9 shared, "generate_main_images_comfyui", "generate_hook_video_comfyui", "render", "cleanup"] }`
  - `{ id: "google-flow", shortLabel: "Google Flow", label: "Generate Script (OpenRouter) + TTS (AI33) + Align (aeneas) + Generate Images (Google Flow) + Hook Video (Google Flow)", steps: [...9 shared, "generate_main_images_google_flow", "generate_hook_video_google_flow", "render", "cleanup"] }`
  Export `getWorkflowById(id: string): Workflow | null` and `listWorkflows(): readonly Workflow[]`.
  **Context**: `label` is the verbatim string the user dictated (shown in the Add/Edit dropdown). `shortLabel` is used by the Workflow column in the Video Queue table (Task 3.6) — the full label is too long for a column cell and goes in a tooltip instead. IDs are the stable DB keys.

- [x] **Task 2.5: Google Flow stub steps**
  **Files**: `src/worker/steps/generate-main-images-google-flow.ts` (new), `src/worker/steps/generate-hook-video-google-flow.ts` (new), `src/worker/steps/index.ts`
  **What**: Each stub exports a `Step` with the correct slug, `outputs: []`, and a `run` function that throws `new Error("<slug>: Google Flow is not yet implemented")`. Register both in `REAL_STEPS`.
  **Context**: When a user picks the Google Flow workflow (Option A per user decision), the video runs through shared steps, then these stubs throw, and the generic failure path marks the video `failed`.

- [x] **Task 2.6: Orchestrator reads from workflow registry**
  **Files**: `src/worker/pipeline.ts`, `src/worker/steps/index.ts`
  **What**: Remove the hard-coded `STEP_ORDER` const (`pipeline.ts:96-112`). Update `runPipeline(videoId)` to read `video.workflow_id`, look up the workflow from the registry, throw if not found, then iterate `workflow.steps`. Replace the drift guard at `steps/index.ts:45-56` with a new validator that asserts every slug referenced by any workflow in `listWorkflows()` resolves to a real entry in `REAL_STEPS` (so a typo in the registry fails at module load, not mid-run). Put the validator in `steps/index.ts` — `steps/index.ts` imports `workflows/index.ts`, not the other way around, so steps can never form an import cycle even if a step module later pulls in workflow metadata.
  **Context**: Tests that previously imported `STEP_ORDER` now import workflow lists from the registry.

- [x] **Task 2.7: Runner simplification** (no-op — runner already matches target state; `findOldestQueuedId` filters to `status='queued'` which excludes `new`)
  **Files**: `src/worker/runner.ts`
  **What**: `pickNextVideo` (`runner.ts:39-58`) keeps priority 1 (crash recovery for `in_progress`) and returns the oldest `queued` video otherwise. `new` status is never picked up — `findOldestQueuedId` in `src/lib/repos/videos.ts:155-157` hardcodes `WHERE status = 'queued'`, so no change is needed there. `TickResult` is now `"worked" | "idle-empty"` (already reduced in Task 1.4).
  **Context**: Per-video Start (Phase 3) transitions `new` → `queued`. The runner is purely FIFO over `queued` plus `in_progress` resume.

- [x] **Task 2.8: Delete-requested handling in orchestrator**
  **Files**: `src/worker/pipeline.ts`, `src/lib/repos/videos.ts`
  **What**: Add videos-repo helper `readDeleteRequested(db, videoId): boolean` and `deleteVideoFullyRemoved(db, videoId)` (deletes `video_steps` rows then `videos` row in a transaction). In the orchestrator's main loop, before each step runs, check `readDeleteRequested`. If set: stop the loop, delete the entire project directory `projectsDir/<videoId>/` from disk, call `deleteVideoFullyRemoved`, return. No step partial state survives because the check fires before the next step starts.
  **Context**: This is the "between steps" contract the user approved. Typical step duration is seconds to a few minutes, so the UI's "Deleting…" cue resolves within that window.

- [x] **Task 2.9: Add Google Flow settings (scaffolded)**
  **Files**: `src/lib/db.ts:12-35`, `src/lib/settings.ts:12-53`
  **What**: Add `google_flow_profile_path: "./data/google-flow-profile"` and `google_flow_relogin_needed: "false"` to `DEFAULT_SETTINGS`. Add matching schemas in `SETTING_SCHEMAS`. Nothing reads these yet — Phase 4 surfaces them in the Google Flow tab.
  **Context**: Pattern mirrors the old Freepik profile/relogin pair but prefixed `google_flow_`. Since the user wiped the DB in Task 2.1, these settings seed cleanly on next `db:init`. `google_flow_relogin_needed` stays `"false"` until a later plan implements Google Flow automation — it's scaffolded now only so the Google Flow Settings tab (Task 4.2) has a key to bind to.

- [x] **Task 2.10: Update tests for Phase 2 changes**
  **Files**:
  - `__tests__/unit/worker/pipeline.test.ts` — use the registry, not `STEP_ORDER`. Add cases for `delete_requested` interruption between steps. Update the fixture (currently `INSERT INTO topics …` around line 65, followed by `INSERT INTO videos … topic_id …`) to drop the topics insert and seed the video directly with the new `title`, `topic_info`, `workflow_id` columns.
  - `__tests__/unit/worker/runner.test.ts` — add cases confirming `new`-status videos are not picked up.
  - `__tests__/unit/lib/repos/videos.test.ts` — add tests for `readDeleteRequested`, `deleteVideoFullyRemoved`, and the new schema columns.
  - `__tests__/unit/lib/db.test.ts` — assert new columns, absence of `topics` table, presence of Google Flow settings.
  - `__tests__/unit/lib/settings.test.ts` — Google Flow setting schemas.
  - `__tests__/unit/worker/workflows.test.ts` (new) — each workflow's step list resolves to real `REAL_STEPS` entries; `getWorkflowById` behavior; the registry-based validator from Task 2.6 throws at module load when a workflow references an unknown slug.
  **Context**: Full vitest run passes at the end of this task. `__tests__/api/videos/[id]/route.test.ts`, `retry/route.test.ts`, and `restart/route.test.ts` also seed topics rows today but their fixture sweep is deferred to Task 3.10 (same commit as the behavioural changes there).

### Phase 3: Merged `/videos` UI

Goal: replace the (now-empty-of-topics) `/videos` page with one that owns the full video lifecycle — `/topics` deletion was already done in Phase 1 Task 1.9.

- [x] **Task 3.1: Video API routes — create / edit / delete / start**
  **Files**:
  - `src/app/api/videos/route.ts` (add POST — route currently only exports GET — and update GET)
  - `src/app/api/videos/[id]/route.ts` (update GET, add PATCH + DELETE)
  - `src/app/api/videos/[id]/start/route.ts` (new — POST)
  - `src/app/api/videos/start-all/route.ts` (new — POST)
  **What**:
  - `POST /api/videos`: body `{title, topic_info, workflow_id}` — all required, workflow_id must match `getWorkflowById(id)` (reject with 400 otherwise). Insert row with status=`new`.
  - `PATCH /api/videos/:id`: body `{title?, topic_info?, workflow_id?}`. Reject with 409 if status ≠ `new`. If `workflow_id` is sent, validate it against the registry (reject with 400 if unknown).
  - `DELETE /api/videos/:id`: branches on status. `new` → delete row only. `queued` / `failed` → delete `projectsDir/<id>/` + `video_steps` rows + `videos` row. `in_progress` → set `delete_requested=1`, return 202 (orchestrator finishes cleanup). `done` → reject with 400.
  - `POST /api/videos/:id/start`: reject if status ≠ `new`. Transitions `new` → `queued`.
  - `POST /api/videos/start-all`: bulk `UPDATE videos SET status='queued' WHERE status='new'` in a transaction. Returns the count of affected rows.
  - `GET /api/videos`: envelope already cleaned in Task 1.7. Expose the absolute `projectsDir` at the top level so the client can build Copy Path strings without another request.
  - `GET /api/videos/[id]`: include both `workflow_label` (the full `Workflow.label` from the registry — used by the detail page header) and `workflow_short_label` (the `Workflow.shortLabel` — used wherever a compact form is needed) alongside the raw `workflow_id`.
  **Context**: Retry/Restart routes at `/api/videos/[id]/retry` and `/api/videos/[id]/restart` stay untouched.

- [x] **Task 3.2: New `/videos` page — server entry**
  **Files**: `src/app/videos/page.tsx`
  **What**: Fetch all videos. Split into `queueRows` (status ∈ {new, queued, in_progress, failed}, sort by `created_at` ASC — FIFO) and `finishedRows` (status = done, sort by `finished_at` DESC — newest first). Fetch `listWorkflows()` from the registry. Pass all three plus `projectsDir` to the client component.
  **Context**: `page.tsx` currently fetches queue_state — already removed in Task 1.4. No polling on the server.

- [x] **Task 3.3: `videos-client.tsx` — two-section layout**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**: Replace the existing single-table layout with two sections — "Video Queue" and "Finished Videos". Header has "Add Topic" button (opens Add/Edit modal) and "Start All" button (POSTs `/api/videos/start-all`, disabled when zero `new` rows). Keep the 5s polling against `/api/videos`; update done/failed transition toasts to move rows across sections. Remove all references to `queueState` / `freepik_relogin_needed` from props and state.
  **Context**: The existing polling pattern (`videos-client.tsx:22`) stays at 5s. Active polling is the only way the UI sees a video's status cross into `done` or `failed` from the worker.

- [x] **Task 3.4: Video Queue table**
  **Files**: `src/app/videos/video-queue-table.tsx` (new, or inline in `videos-client.tsx`)
  **What**: Columns: **Title**, **Workflow**, **Status**, **Actions**. Title links to `/videos/:id`. Workflow column renders `workflow.shortLabel` from Task 2.4, with `workflow.label` (the full verbatim string) in the cell's tooltip. Status: badge for `new` / `queued` / `in_progress` / `failed`. When a row has `delete_requested=1`, replace the status badge with "Deleting…" + spinner.
  **Actions column** — render Edit + Delete buttons on every row, always visible, with disabled states as follows (matches the user's spec of "two buttons: Edit and Delete"):
  - `new`: **Start** (extra button) + Edit (enabled) + Delete (enabled)
  - `queued`: Edit (disabled) + Delete (enabled)
  - `in_progress`: Edit (disabled) + Delete (enabled; replaced by "Deleting…" if `delete_requested=1`)
  - `failed`: Edit (disabled) + Delete (enabled). Retry/Restart live on the detail page only.
  **Context**: Prefer disabled state to hiding — keeps action surface visually consistent across rows. Every Delete click opens the confirm dialog (Task 3.7).

- [x] **Task 3.5: Finished Videos table**
  **Files**: `src/app/videos/finished-videos-table.tsx` (new, or inline)
  **What**: Columns: **Title**, **Finished** (formatted date/time from `finished_at`), **Actions**. Actions column has a single **Copy Path** button. On click, writes `<projectsDir>/<videoId>/` to clipboard via `navigator.clipboard.writeText` and shows "Copied!" feedback for 2 seconds. `projectsDir` is pulled from the `/api/videos` envelope (Task 3.1).
  **Context**: `navigator.clipboard.writeText` requires a secure context (localhost or https) — both hold for this app.

- [x] **Task 3.6: Add/Edit modal**
  **Files**: `src/app/videos/add-video-modal.tsx` (new)
  **What**: Modal component with three fields — **Title** (text input), **Topic info** (textarea, 6 rows), **Workflow** (select). All three required. Submit button disabled until all three have non-empty values. The Workflow select has a placeholder option ("Select a workflow…") and the workflows from `listWorkflows()` — **no default selection**. In Edit mode, prefill from the existing row; in Add mode, blank. Targets `POST /api/videos` on Add, `PATCH /api/videos/:id` on Edit. Calls `router.refresh()` on success.
  **Context**: Mirror the state-management shape from the (now-deleted) `src/app/topics/topics-client.tsx` — recover it from git history if needed, since Task 1.9 already removed it. The `style_prompt_override` field is intentionally absent (user decision).

- [x] **Task 3.7: Delete confirm dialog**
  **Files**: `src/app/videos/delete-confirm-dialog.tsx` (new, or inline)
  **What**: Modal: title "Delete video?". Message varies by status — for `in_progress`: "This video is being generated. Deletion will take effect after the current step finishes and will remove all generated files." For `queued` / `failed`: "All generated files will be permanently removed." For `new`: "This will remove the video entry." Two buttons: **Cancel** (default focus) and **Delete** (destructive variant). Block body scroll while open.
  **Context**: Same modal primitive as Add/Edit for visual consistency. Cancel closes without action; Delete issues `DELETE /api/videos/:id` and closes on success.

- [x] **Task 3.8: Detail page — Start button + Delete + action surface**
  **Files**: `src/app/videos/[id]/page.tsx`, `src/app/videos/[id]/video-detail-client.tsx`, `src/app/videos/[id]/video-actions.tsx`
  **What**: Pause/Resume queue button + `toggleQueue` already removed in Task 1.4. Update `VideoActions` to expose:
  - `new`: **Start** (POSTs `/api/videos/:id/start`, refreshes) + **Delete**
  - `queued`: **Delete**
  - `in_progress`: **Delete** (button replaced by "Deleting…" with spinner if `delete_requested=1`)
  - `failed`: **Retry** + **Restart** (unchanged from today) + **Delete**
  - `done`: **Copy Path** button (same behavior as Task 3.5)
  Delete goes through the same confirm dialog (Task 3.7) and the same `DELETE /api/videos/:id` endpoint as the list row. On successful delete of a `new`/`queued`/`failed` video, redirect the user back to `/videos` (the row no longer exists); for `in_progress`, stay on the page — polling will pick up the deletion and show the "Deleting…" state until the orchestrator finishes cleanup, at which point the next GET returns 404 and the client redirects to `/videos`. Remove `queueState` / `freepik_relogin_needed` from initial props and from the polling response handler.
  **Context**: Edit remains list-row-only (editing a row of data feels wrong from inside a detail view of that row). Delete is mirrored on the detail page per user decision — no reason to force a navigation back to the list just to delete.

- [x] **Task 3.9: Videos repo helper updates** (helpers landed in Task 3.1's commit; nothing left to add)
  **Files**: `src/lib/repos/videos.ts`
  **What**: Add helpers: `createNewVideo(db, {id, title, topic_info, workflow_id})`, `updateVideoDraft(db, id, {title?, topic_info?, workflow_id?})` (only runs when status=`new`), `transitionNewToQueued(db, id)`, `transitionAllNewToQueued(db): number`, `setDeleteRequested(db, id)`. Delete the legacy `insert(db, video: Video)` helper at `src/lib/repos/videos.ts:38-54` — its SQL writes to `topic_id` (dropped in Task 2.1) and its only production caller was `src/app/api/topics/[id]/queue/route.ts` (deleted in Task 1.9). `deleteVideoFullyRemoved(db, id)` was already added in Task 2.8. Obsolete helpers `clearRunStateToQueued` + any topic-referencing ones were deleted in Tasks 1.3 and 1.9.
  **Context**: Keep `markFailed`, `markInProgress`, `findInProgressId`, `findOldestQueuedId`, and the retry/restart helpers unchanged.

- [x] **Task 3.10: Update tests for Phase 3 changes**
  **Files**:
  - `__tests__/api/videos/route.test.ts` — new POST body schema, new response envelope with `projectsDir`.
  - `__tests__/api/videos/[id]/route.test.ts` — PATCH tests (reject when status ≠ `new`, validate workflow against registry), DELETE branching per status, 400 for `done`.
  - `__tests__/api/videos/[id]/start/route.test.ts` (new) — transitions `new` → `queued`, rejects other statuses.
  - `__tests__/api/videos/start-all/route.test.ts` (new) — bulk transition.
  - `__tests__/components/videos/videos-client.test.tsx` — two-section layout, Start All button, Add Topic modal trigger.
  - `__tests__/components/videos/video-queue-table.test.tsx` (new) — action button visibility + disabled states per status.
  - `__tests__/components/videos/finished-videos-table.test.tsx` (new) — Copy Path button writes expected string.
  - `__tests__/components/videos/add-video-modal.test.tsx` (new) — submit disabled until all three fields filled; workflow dropdown has no default.
  - `__tests__/components/videos/[id]/video-actions.test.tsx` — detail-page actions per status (Start on `new`, Delete across `new`/`queued`/`in_progress`/`failed`, Retry+Restart on `failed`, Copy Path on `done`, "Deleting…" state when `delete_requested=1`).
  - `__tests__/unit/lib/repos/videos.test.ts` — cover the new helpers from Task 3.9.
  - `__tests__/api/videos/[id]/retry/route.test.ts`, `__tests__/api/videos/[id]/restart/route.test.ts`, and `__tests__/api/videos/[id]/route.test.ts` — topics-row fixture sweep: (a) delete every `INSERT INTO topics` statement — the `topics` table no longer exists after Task 2.1; (b) update every `INSERT INTO videos` to include `title`, `topic_info`, and `workflow_id` (all `NOT NULL`, so SQLite will reject inserts that omit them). Behavioral assertions in each test stay unchanged apart from the explicit PATCH/DELETE additions above.
  **Context**: Full vitest run passes at the end of this task. After this task, `grep -rn "INSERT INTO topics" __tests__` returns zero hits (pipeline.test.ts was swept in Task 2.10).

### Phase 4: Settings Tabs

Goal: split the single settings form into five provider tabs. Pure UI refactor — all settings already exist post-Phase 2.

- [x] **Task 4.1: Tab container + active-tab persistence**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: Wrap the existing dirty-diff + PATCH logic in a tab container. Five tabs: ComfyUI, Google Flow, OpenRouter, AI33, Render. Active tab reflected in URL query (`?tab=comfyui`) so reloads preserve state. The Save button stays at the form level — single submit covers all tabs. Show a small dirty indicator (a dot) in any tab label whose fields have unsaved changes.
  **Context**: The single-save pattern avoids per-tab save buttons + dirty state juggling across tabs.

- [x] **Task 4.2: Move settings into the right tabs**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**:
  - **ComfyUI**: `image_provider`, `comfyui_base_url`, `comfyui_workflow_path`, `comfyui_hook_video_workflow_path`
  - **Google Flow**: `google_flow_profile_path`, `google_flow_relogin_needed` (read-only indicator — stays `false` until Google Flow is implemented in a later plan)
  - **OpenRouter**: `llm_provider`, `model_name`, `style_prompt_default`
  - **AI33**: `tts_provider`, `voice_id`, `voiceover_model_id`, `voice_stability`, `voice_similarity`, `voice_style`, `voice_speed`, `voice_use_speaker_boost`
  - **Render**: `aspect_ratio`, `long_edge_px`, `framerate`, `chapter_count`, `act_distribution`
  **Context**: Existing field components (number inputs with range validation, enum dropdowns) are reusable — re-parent them under tab panels. Cross-field validators (`chapter_count` + `act_distribution` sum) stay in the PATCH handler.

- [x] **Task 4.3: Settings page server fetch cleanup** (no changes — already clean from Phase 1 Task 1.4/1.6)
  **Files**: `src/app/settings/page.tsx`
  **What**: Verify it fetches `getAllSettings()` and passes to the form. Remove any references to `queue_state` / `freepik_relogin_needed` (should already be gone from Phase 1 but double-check).
  **Context**: The form handles all tab logic client-side.

- [x] **Task 4.4: Update settings-form test for tab layout**
  **Files**: `__tests__/components/settings/settings-form.test.tsx`
  **What**: Rewrite assertions to reflect tab navigation. Test: initial tab is the one in `?tab=`; switching tabs preserves unsaved changes; Save issues a PATCH with only the dirty fields across all tabs. Field-level tests (value rendering, validation) stay per-tab.
  **Context**: Full vitest run passes at the end of this task.

### Phase 5: Documentation Sync

Goal: align canonical docs with the new architecture.

- [x] **Task 5.1: Update `docs/histforge-spec.md`**
  **Files**: `docs/histforge-spec.md`
  **What**: Sections to rewrite:
  - Pipeline steps — replace the 15-step list with the shared steps + per-workflow provider steps.
  - Data model — new `videos` schema (drop topics, add `topic_info`/`workflow_id`/`delete_requested`), new statuses (`new`, ...), drop all topic sections.
  - Queue model — remove `queue_state`, `freepik_relogin_needed`, global pause flow. Describe per-video Start + Start All.
  - Settings — drop Freepik keys, add ComfyUI hook-video path + Google Flow keys. Reorganize by provider/tab.
  - API routes — drop all topics + freepik + queue routes; add `POST /api/videos`, `POST /api/videos/:id/start`, `POST /api/videos/start-all`; document `PATCH` and `DELETE` branching.
  - Freepik sections (session lost, relogin) — delete entirely.
  - Workflows — new section describing the registry and how to add a workflow.
  **Context**: CLAUDE.md declares this the canonical reference. Stale spec makes future agents misread the codebase.

- [x] **Task 5.2: Update `MANUAL.md`**
  **Files**: `MANUAL.md`
  **What**: Remove any mention of Freepik login, queue pause/resume, topics page. Add Add-Topic + Start flow, workflow selection, per-video Delete semantics, Copy Path for finished videos.
  **Context**: User-facing manual; keep concise.

## References

- Current pipeline order: `src/worker/pipeline.ts:96-112`
- Step registry: `src/worker/steps/index.ts:24-40`
- Drift guard (replaced in Task 2.6): `src/worker/steps/index.ts:45-56`
- Freepik teardown surface: `src/lib/freepik/`, `src/app/api/freepik/`, `scripts/freepik-login.ts`, `src/worker/pipeline.ts:22-27,155-173`
- `FreepikSessionLost` referencing files: see Task 1.3 list
- Queue pause gate: `src/worker/pause-gate.ts`
- ComfyUI client: `src/lib/image/comfyui.ts`
- Existing workflow JSON: `prompts/comfyui/default-workflow.json`
- Queue picker logic: `src/worker/runner.ts:39-58`
- Videos repo: `src/lib/repos/videos.ts`
- Settings schemas: `src/lib/settings.ts:12-53`
- Settings defaults: `src/lib/db.ts:12-35`
- Current schema: `src/lib/db.ts:79-114`
- Topics client (modal pattern to mirror before deletion): `src/app/topics/topics-client.tsx`
- Video detail client: `src/app/videos/[id]/video-detail-client.tsx`
- NavBar: `src/app/nav-bar.tsx:6-10`
- Root layout: `src/app/layout.tsx`
- DB init script: `scripts/db-init.ts`
- Tests root: `__tests__/` (repo root, not `src/__tests__/`)
- Spec: `docs/histforge-spec.md`
