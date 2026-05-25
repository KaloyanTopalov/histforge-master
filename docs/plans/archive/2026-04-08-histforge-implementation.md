# histforge — Full Implementation

## Overview
Build histforge v1 from scratch: a single-operator Next.js + worker pipeline that turns a topic line into a finished 2-hour historical YouTube video, unattended. Implementation follows the suggested build order in `docs/histforge-spec.md:810` (section 21) — skeleton first, then dashboard, then pipeline steps in dependency order, finishing with render and cleanup.

## Current State
- Repo is green-field. Only `README.md` and `docs/histforge-spec.md` exist; no `package.json`, no source.
- Authoritative spec: `docs/histforge-spec.md` (sections referenced throughout this plan).
- System dependencies (Node 20, ffmpeg on PATH, WSL2 + Ubuntu + aeneas, Playwright Chromium) are documented in `README.md:9-128` — assume the operator has installed these per README before running anything; the plan does NOT include OS-level setup tasks.
- The spec references source prompt files (`research_prompt.txt`, `characters.txt`, `hook.txt`, `hook_2.txt`, `rest_of_story.txt`) that must be adapted into `prompts/`. These are NOT in the repo — the implementer will need them from the operator before Phase 3 can produce real output (stub prompts are fine until then).

### Open decisions (resolve before or during the relevant phase)

These are spec ambiguities or missing details that the implementer must decide once and apply consistently across all tasks. Each is also noted in its task, but listing them here so they are not re-decided per file.

1. **GenAI Pro task-status GET endpoint** (Phase 4). Spec `:386, :801` — not in the docs screenshot. Look it up before coding step 6; almost certainly `GET /api/v1/labs/task/{task_id}`.
2. **Freepik image-to-video source mechanism** (Phase 7). Spec `:510-515` — library reference vs re-upload. Verify on first manual run before writing step 12.
3. **Hook video prompt source** (Phase 7, step 12). The spec defines image-prompt enrichment in step 9 (`:455-463`) but never says where the *video* prompt for step 12 comes from. **Decision: reuse the chunk's enriched image prompt as the video prompt.** Rationale: the chunk's narrative context is the same; Freepik image-to-video uses the prompt as motion guidance, which the existing visual prompt already implies. Revisit only if first-run output is visibly bad.
4. **Prompt loader mechanism** (Phase 3). Spec `:358` says the loader "inlines shared fragments at load time and substitutes `{{var}}` placeholders" but the variables list per prompt (`:321, :329`) only ever names *specific* shared fragments (`{{audience_profile}}`, `{{banned_words}}`, `{{numbers_as_letters}}`), and `_shared/format_guidelines.md` is never in any variables list (`:355`). **Decision: every file in `prompts/_shared/` is auto-loaded into a named variable matching its basename (`audience_profile.md` → `{{audience_profile}}`), then `{{var}}` substitution runs.** `format_guidelines` is then injected by adding `{{format_guidelines}}` to whichever prompt files want it (the implementer adds it to the stub prompts as appropriate). Single mechanism, no special-case `{{include:...}}` syntax.
5. **Topic archive UX** (Phase 2). Spec line 209 says "Topic status flips to `archived` only on user action" but the Topics page row actions (`:705`) only list Edit/Delete/Queue — no Archive button. **Decision: rename the "Delete" row action to "Archive" (sets `status='archived'`). Hard delete is only available on archived topics, and only if no `videos` row references them.** This satisfies the spec's "user action" requirement and avoids `FOREIGN KEY` violations.
6. **align.py Python interpreter** (Phase 5). README `:122-128` installs aeneas into a venv at `python/.venv` (inside WSL); spec `:407-415` invokes bare `python3`, which will only work if aeneas is installed system-wide in WSL. **Decision: use the venv. `lib/align.ts` invokes `wsl -d $WSL_DISTRO <wslPath>/python/.venv/bin/python3 <wslPath>/python/align.py ...`.** This matches the README install steps and avoids polluting the WSL system Python.
7. **Re-login flow process ownership** (Phase 7). The worker owns the long-lived Playwright context for Freepik steps. The `/api/freepik/relogin` endpoint runs in the Next.js process and cannot share that context. **Decision: the API endpoint spawns its own short-lived headed Chromium against the same persistent profile dir (`./data/freepik-profile/`). This is safe because `freepik_relogin_needed=true` forces `queue_state='paused'`, so the worker is guaranteed not to be using the profile concurrently.** The `/api/freepik/relogin/done` endpoint closes the API-owned Chromium and clears `freepik_relogin_needed`; the operator separately clicks Resume on the videos page to flip `queue_state` back to `running`.

## Scope
**Doing**: Complete v1 per spec — schema, worker, all 15 pipeline steps, dashboard pages, API routes, settings, Freepik headed automation, ffmpeg render, WSL aeneas alignment, cleanup.

**Not doing** (per `docs/histforge-spec.md:14-20`):
- Multi-user / auth.
- Cloud deployment, S3, storage abstraction.
- Human-in-the-loop review UI.
- YouTube upload.
- Parallel video processing.
- Desktop / sound / email notifications (`docs/histforge-spec.md:751-753`).
- LLM full prompt/response logging (`docs/histforge-spec.md:780`).
- Confidence scoring on alignment (`docs/histforge-spec.md:432`).
- Segment caching on render retry (`docs/histforge-spec.md:573`).

## Tasks

### Phase 1: Skeleton — project, DB, worker loop, stub pipeline

Goal of phase: end-to-end queue → in_progress → done → failed paths work with stub steps that just sleep and write a file. No real LLM/TTS/Freepik/ffmpeg yet. Verify resume-on-restart and per-video failure isolation by hand.

- [x] **Task 1.1: Initialize Node project + tooling**
  **Files**: `package.json`, `tsconfig.json`, `tsconfig.worker.json`, `next.config.js`, `tailwind.config.js`, `postcss.config.js`, `.eslintrc.json`, `.gitignore`, `.env.example`
  **What**: Create a Next.js 14+ App Router project with TypeScript, Tailwind, the runtime+dev deps listed in `README.md:36-57`, and the npm scripts in `docs/histforge-spec.md:637-645`. `.env.example` matches `docs/histforge-spec.md:759-765`. `.gitignore` excludes `data/`, `projects/`, `node_modules/`, `.next/`, `dist/`.
  **Context**: Two `tsconfig` files because the worker is built separately (`tsc -p tsconfig.worker.json` per the build script). Worker output goes to `dist/worker/`. Tailwind set up against `src/app/**/*.{ts,tsx}`. Next.js loads `.env` automatically; the worker and the `scripts/*` entries do not — every standalone tsx/node entry point in this project must call `dotenv/config` (or `import "dotenv/config"`) at the top of the file.

- [x] **Task 1.2: SQLite client + schema migration**
  **Files**: `src/lib/db.ts`, `scripts/db-init.ts`
  **What**: `db.ts` exports a singleton `better-sqlite3` Database opened from `process.env.DATABASE_URL`, runs `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` on open, and runs idempotent `CREATE TABLE IF NOT EXISTS` for all four tables from `docs/histforge-spec.md:170-207`. `db-init.ts` is the script invoked by `npm run db:init` — imports `dotenv/config`, imports `db.ts` (which triggers migrations), and seeds default Settings rows.
  **Context**: Schema is exact from `docs/histforge-spec.md:170-207`. Settings defaults are listed in `docs/histforge-spec.md:217-233` — seed every key with its default; `model_name`, `freepik_style_name`, `voice_id` get empty strings (operator fills in via `/settings`). `queue_state` defaults to `paused` (per spec), so the system starts paused and the operator must click Start queue. The DB is the single source of truth (`docs/histforge-spec.md:212`); no `meta.json`. **WAL mode is required** because two processes (Next.js and worker) read/write the same file — without WAL, concurrent access produces `SQLITE_BUSY`. **`foreign_keys=ON`** because the schema declares `videos.topic_id REFERENCES topics(id)` and we want SQLite to actually enforce it (it's off by default), so deleting a referenced topic fails loudly instead of silently orphaning rows.

- [x] **Task 1.3: Settings + logger libs**
  **Files**: `src/lib/settings.ts`, `src/lib/logger.ts`, `src/types.ts`
  **What**: `settings.ts` exposes `getSetting(key)`, `getAllSettings()`, `setSetting(key, value)` with type coercion (ints, floats, bools, enums). Validate enums with `zod`. `logger.ts` writes to a per-video `pipeline.log` (append, prefixed `[step_name] timestamp`); on every call it `mkdir -p`s the parent `projects/<id>/` directory before appending, because for a brand-new video that directory does not yet exist when the first log line is written. `types.ts` holds shared TS types (`Topic`, `Video`, `VideoStep`, `Chunk`, `AlignmentEntry`, `IdMap`, etc.).
  **Context**: Per-video log behavior in `docs/histforge-spec.md:774-781`. Settings types are in the table at `docs/histforge-spec.md:217-233`.

- [x] **Task 1.4: Worker entry + main loop**
  **Files**: `src/worker/index.ts`, `src/worker/runner.ts`
  **What**: `index.ts` is the long-running entry, starts with `import "dotenv/config"`. **On startup, before entering the main loop, run a single SQL update that resets every `video_steps` row in `running` state to `pending`** — those are leftovers from a previous crash, the worker is definitely not running them, and this gives the orchestrator (Task 1.5) a clean view so it never has to handle a `running` row mid-iteration. `runner.ts` implements the loop in `docs/histforge-spec.md:653-663`: on start, resume any `in_progress` video; otherwise poll for queued videos FIFO, set `videos.status='in_progress'`, set `videos.started_at=now()` **only if it is currently `NULL`** (preserves the original pickup time across `FreepikSessionLost` resume cycles), call `runPipeline`. Honors `queue_state='paused'` and `freepik_relogin_needed=true`.
  **Context**: Sleep intervals 2s/5s as specified. Single Node process, single SQLite writer assumption (`docs/histforge-spec.md:649`). The startup `running → pending` reset is the only place this normalization happens — Task 1.5 then assumes every step row it sees is `pending`, `done`, or `failed`, never `running`.

- [x] **Task 1.5: Pipeline orchestrator with stub steps**
  **Files**: `src/worker/pipeline.ts`, `src/worker/steps/01-research-outline.ts` ... `src/worker/steps/15-cleanup.ts` (15 stub files)
  **What**: `pipeline.ts` exports `STEP_ORDER`, the `Step` interface (`{ name: string; run(videoId): Promise<void>; cleanup?(videoId): Promise<void> }`), the `FreepikSessionLost` error class, and `runPipeline(videoId)`. Each stub step file exports a `Step` object whose `run` sleeps ~500ms and writes a marker file under `projects/<id>/`. The stubs intentionally do NOT define `cleanup` — the orchestrator's default cleanup behavior (see below) is sufficient for them; only steps with non-trivial output layouts (notably step 4) override `cleanup`.

  **`runPipeline(videoId)` responsibilities** (expanding `docs/histforge-spec.md:666-687`):
    1. **Pre-loop:** Upsert one `video_steps` row per name in `STEP_ORDER` with `status='pending'` if it doesn't exist (idempotent — resume runs are no-ops).
    2. **Per-step iteration:**
       - **Pause check (between steps):** if `queue_state='paused'` or `freepik_relogin_needed=true`, set `videos.status='queued'` and return — the step-level pause from `docs/histforge-spec.md:689-691` ("Worker finishes the current step, then idles. Granularity = step-level"). Pause is checked before each step, not after, so the in-flight step always finishes.
       - **Skip done:** if `video_steps.status='done'`, continue. (Task 1.4 has already normalized any stale `running` rows to `pending` on worker startup, so this iteration only ever sees `pending`, `done`, or `failed`.)
       - **Mark running:** set `video_steps.status='running'`, `started_at=now()`, and `videos.current_step=<step_name>` (the denormalized field from `docs/histforge-spec.md:185`).
       - **Run:** `await step.run(videoId)`.
       - **On success:** set `video_steps.status='done'`, `finished_at=now()`.
       - **On `FreepikSessionLost`:** set `video_steps.status='pending'` (NOT `failed`), set `queue_state='paused'`, set `freepik_relogin_needed=true`, set `videos.status='queued'`, return. The same video resumes from this step after re-login. (Do NOT touch `videos.started_at` — Task 1.4's `IS NULL` guard preserves it.)
       - **On any other throw:** call `step.cleanup?.(videoId)` if the step defines one; otherwise look up `STEP_OUTPUTS[step.name]` and `rm -rf` each path under `projects/<id>/`. Set `video_steps.status='failed'`, `finished_at=now()`. Set `videos.status='failed'`, `failed_step=<step_name>`, `failed_reason=err.message`, `finished_at=now()`. Append the stack trace to `pipeline.log` under `[<step_name>]`. Return.
    3. **Post-loop (all steps done):** set `videos.status='done'`, `finished_at=now()`, `output_path='projects/<id>/final.mp4'`, `current_step=NULL`.

  **`STEP_OUTPUTS` map:** Spell out the full table inline in `pipeline.ts`. Paths are relative to `projects/<video_id>/`. Empty array means no default cleanup runs (either because there's nothing to delete or because the step has a custom `cleanup` hook). This is the contract for the spec's "delete failing step's *own* artifacts, not previous steps'" rule (`:310`):

  | Step name | `STEP_OUTPUTS` value | Notes |
  |---|---|---|
  | `research_outline` | `["script/01_outline.md"]` | |
  | `research_characters` | `["script/02_characters.md"]` | |
  | `write_hook` | `["script/03_hook.md"]` | |
  | `write_chapters` | `[]` | Task 3.4 uses atomic `.tmp`+`rename` writes, so any chapter file on disk is complete — default no-op cleanup is correct. |
  | `assemble_script` | `["script/full_script.md"]` | |
  | `voiceover` | `["audio/narration.mp3"]` | |
  | `align` | `["alignment/sentences.txt", "alignment/alignment.json"]` | |
  | `chunk` | `["chunks/chunks.json"]` | |
  | `enrich_chunks` | `[]` | Re-running re-enriches all chunks in place (`docs/histforge-spec.md:461`); leaving the partial state alone is correct. |
  | `freepik_main_images` | `["freepik/main_id_map.json"]` | Freepik project folder on the remote stays — the next run reuses it. |
  | `freepik_hook_images` | `["freepik/hook_id_map.json"]` | Same caveat. (Step 12 also writes to this file; see note below.) |
  | `freepik_hook_videos` | `[]` | Step 12 *appends* to `hook_id_map.json`'s `videos` section; deleting the whole file would also wipe step 11's `images` section. Custom cleanup is overkill — the next run can resume from a partial videos section because each lookup is by chunk_id. Leave it. |
  | `download_assets` | `["freepik/main", "freepik/hook_videos"]` | Both download dirs — the id maps stay so the next run knows what to download. |
  | `render` | `["render", "final.mp4"]` | The renderer also `rm -rf`s `render/` at the start of every run (Task 8.1), so this is belt-and-suspenders. `final.mp4` is included in case the failure was during the audio mux after the file already existed. |
  | `cleanup` | `[]` | A failed cleanup leaves the project half-tidied; manual recovery only. |

  **Context**: Step contract in `docs/histforge-spec.md:304-313`. Stubs let Phase 1 verify queue, resume, and failure paths end-to-end before any real integration. Step list in `docs/histforge-spec.md:286-302`. The denormalized `videos.current_step` field is what powers the videos-list current-step column (Phase 2, Task 2.2) without needing a join — keep it in sync or that column lies.

- [x] **Task 1.6: Minimal Next.js shell + health check**
  **Files**: `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`
  **What**: Bare layout with Tailwind imported. `page.tsx` redirects to `/videos` per `docs/histforge-spec.md:82`. Add a `/api/health` route returning `{ ok: true, queue_state }` so Phase 1 can be validated by hand.
  **Context**: Real pages come in Phase 2. This task only needs enough Next.js to confirm `npm run dev` boots both Next + worker via `concurrently`.

### Phase 2: Dashboard — topics, videos, settings, API routes

- [x] **Task 2.1: Topics page + API**
  **Files**: `src/app/topics/page.tsx`, `src/app/api/topics/route.ts`, `src/app/api/topics/[id]/route.ts`, `src/app/api/topics/[id]/queue/route.ts`
  **What**: List topics in a table; add-topic modal collects `title`, `topic_info`, optional `style_prompt_override`. Row actions: **Edit**, **Archive**, **Delete**, **Queue**. POST sets both `topics.created_at` and `topics.updated_at` to `now()`. PATCH bumps `topics.updated_at`. **Archive** sets `topics.status='archived'` and is the spec-mandated user action from `docs/histforge-spec.md:209`. **Delete** is only enabled on archived topics with no referencing `videos` rows (the `foreign_keys=ON` pragma from Task 1.2 will reject the delete otherwise — surface that as a 409 with a helpful message). **Queue** POSTs to `/api/topics/:id/queue` which, **inside a `db.transaction()`**, inserts a `videos` row (`status='queued'`, ulid id, snapshot title, `created_at=now()`) and flips the topic's `status` to `in_pipeline`; the transaction guarantees we never end up with an orphan video row or a topic stuck in `idea` after a half-applied write. Queue is disabled when topic status is already `in_pipeline` or `archived`.
  **Context**: Page spec `docs/histforge-spec.md:702-707` (note: the row actions list there omits Archive — see Open Decision #5 in Current State for the rationale). Routes in `docs/histforge-spec.md:730-734`. Topic vs video id distinction in `docs/histforge-spec.md:181`. Use `ulid` package for IDs. Validate inputs with `zod`.

- [x] **Task 2.2: Videos list page + API + queue controls**
  **Files**: `src/app/videos/page.tsx`, `src/app/api/videos/route.ts`, `src/app/api/queue/start/route.ts`, `src/app/api/queue/pause/route.ts`
  **What**: Table with title, status, current_step, started_at, finished_at, output link. Top bar Start/Pause toggle hits `/api/queue/start` and `/api/queue/pause` (just toggles `settings.queue_state`). Status badges with the colors in `docs/histforge-spec.md:712`. Banner if `freepik_relogin_needed`. Polls `/api/videos` every 5s; show a toast on done/failed transitions.
  **Context**: Page spec `docs/histforge-spec.md:709-712`. Polling cadence `docs/histforge-spec.md:751-753`. The worker (Phase 1) already reads `queue_state` and idles; this task only flips the flag. Note the spec lists a `paused` badge color (`:712`) but `videos.status` enum (`:184`) only has `queued | in_progress | done | failed` — the "paused" badge reflects `queue_state='paused'` (rendered on rows with `status='queued'` while the queue is paused), not a per-row status value.

- [x] **Task 2.3: Video detail page + retry/restart APIs**
  **Files**: `src/app/videos/[id]/page.tsx`, `src/app/api/videos/[id]/route.ts`, `src/app/api/videos/[id]/retry/route.ts`, `src/app/api/videos/[id]/restart/route.ts`
  **What**: Header with title/status/final.mp4 link. Step list with status icons + timings (read from `video_steps`). "View pipeline log" link serves the file. Artifacts panel lists files in the project folder. No controls when `status='done'` (locked). Both retry/restart routes wrap their writes in a `db.transaction()`.

  **POST `/api/videos/:id/retry`** (only valid when `videos.status='failed'`):
    - Update the failed `video_steps` row: `status='pending'`, `started_at=NULL`, `finished_at=NULL`. (The orchestrator already deleted that step's artifacts at failure time per Task 1.5's `STEP_OUTPUTS` rule — nothing to clean now.)
    - Update the `videos` row: `status='queued'`, `failed_step=NULL`, `failed_reason=NULL`, `finished_at=NULL`. **Do not** touch `started_at` (preserve the original pickup time) or `current_step` (the orchestrator will set it on the next iteration).
    - The worker's outer loop picks the row up FIFO; the orchestrator's pre-loop upsert is a no-op since the row already exists with `status='pending'`, and the iteration resumes at the previously failed step.

  **POST `/api/videos/:id/restart`** (valid when `videos.status='failed'` or `done`):
    - `rm -rf projects/<id>/` (this also deletes `pipeline.log`; that's fine, restart means fresh log).
    - `DELETE FROM video_steps WHERE video_id = ?`.
    - Update the `videos` row: `status='queued'`, `failed_step=NULL`, `failed_reason=NULL`, `started_at=NULL`, `finished_at=NULL`, `current_step=NULL`, `output_path=NULL`.
    - Worker picks it up, orchestrator's pre-loop creates 15 fresh `pending` step rows, pipeline runs from step 1.

  **Context**: Page spec `docs/histforge-spec.md:714-722`. The two routes differ only in scope: retry resumes from the failed step with all prior artifacts intact; restart wipes everything. Both flip `videos.status='queued'` so the worker picks them up.

- [x] **Task 2.4: Settings page + API**
  **Files**: `src/app/settings/page.tsx`, `src/app/api/settings/route.ts`
  **What**: Form with every key from `docs/histforge-spec.md:217-233`, grouped (model, render, voice, queue). PATCH on save. Validate types (`zod`) and enum values. Cross-field validation: `act_distribution` is a comma-separated list of ints that **must sum to `chapter_count`** (per `:224`); reject the PATCH with a 400 otherwise. Float ranges from the table (`voice_stability` 0–1, `voice_speed` 0.7–1.2, etc.) must also be enforced. Includes the "Re-login to Freepik" button (wires to `/api/freepik/relogin` — created in Phase 7).
  **Context**: All settings live in the DB, not env (`docs/histforge-spec.md:756-767`). The Re-login button can be a no-op stub until Phase 7.

### Phase 3: LLM steps 1–5 (script chain)

- [x] **Task 3.1: OpenRouter client + prompt loader**
  **Files**: `src/lib/openrouter.ts`, `src/lib/prompts.ts`, `prompts/_shared/audience_profile.md`, `prompts/_shared/banned_words.md`, `prompts/_shared/format_guidelines.md`, `prompts/_shared/numbers_as_letters.md`
  **What**: `openrouter.ts` exports `chat(messages, opts): Promise<string>` using `OPENROUTER_API_KEY` and `settings.model_name`. Includes 3-retry exponential backoff. `prompts.ts` exports `render(promptFile, vars)`: reads the file from disk fresh on every call (no caching, per `docs/histforge-spec.md:769-771`), auto-loads every file in `prompts/_shared/` into a variable named after its basename (so `_shared/audience_profile.md` becomes `{{audience_profile}}`, `_shared/format_guidelines.md` becomes `{{format_guidelines}}`, etc.), merges those with the caller-supplied `vars`, then substitutes all `{{var}}` placeholders. Step impls call `render()` to produce a string, then wrap as `[{ role: 'user', content }]` and call `chat()`. Shared fragments are stub content for now; operator will replace.
  **Context**: Interface contract `docs/histforge-spec.md:786-791`. Variable substitution requirements `docs/histforge-spec.md:319-329`. The four shared fragments are described in `docs/histforge-spec.md:352-356`. **Loader mechanism is per Open Decision #4 in Current State** — single substitution pass, no `{{include:...}}` syntax. Note that `_shared/format_guidelines.md` is mentioned in the spec as a shared fragment but never appears in any prompt's variable list (`:321, :329`); under this design, the implementer manually adds `{{format_guidelines}}` to the stub prompts that should include it.

- [x] **Task 3.2: Step 1 — research_outline + Step 2 — research_characters**
  **Files**: `src/worker/steps/01-research-outline.ts`, `src/worker/steps/02-research-characters.ts`, `prompts/01_research_outline.md`, `prompts/02_research_characters.md`
  **What**: Step 1 reads topic title/topic_info from DB + settings (chapter_count, act_distribution), substitutes into `prompts/01_research_outline.md`, calls LLM, writes `projects/<id>/script/01_outline.md`. Step 2 reads outline from disk, calls LLM with `prompts/02_research_characters.md`, writes `02_characters.md`.
  **Context**: Inputs/outputs `docs/histforge-spec.md:288-289`. Variables for outline `docs/histforge-spec.md:321`. Prompt files start as stubs with the right `{{var}}` slots — operator supplies real prompt content from their existing `research_prompt.txt`/`characters.txt`.

- [x] **Task 3.3: Step 3 — write_hook + Step 5 — assemble_script**
  **Files**: `src/worker/steps/03-write-hook.ts`, `src/worker/steps/05-assemble-script.ts`, `prompts/03_write_hook.md`
  **What**: Step 3 reads outline + characters + title, calls LLM with `prompts/03_write_hook.md`, writes `03_hook.md` (target 250–400 words). Step 5 concatenates `03_hook.md` + `04_chapter_01.md` ... `04_chapter_NN.md` with double newlines into `full_script.md`.
  **Context**: Hook spec `docs/histforge-spec.md:327-330`. Assemble spec `docs/histforge-spec.md:349-350`. Step 5 is intentionally placed in this task because it's trivial and depends only on file presence.

- [x] **Task 3.4: Step 4 — write_chapters with sub-resume**
  **Files**: `src/worker/steps/04-write-chapters.ts`, `prompts/04_extract_structure.md`, `prompts/04_write_chapter.md`, `prompts/04_story_so_far.md`
  **What**: Two phases per `docs/histforge-spec.md:336-347`:
    - **Phase A**: If `04_outline_structured.json` doesn't exist, call LLM with the extract-structure prompt and parse JSON output. Write file. (Idempotent — skip if exists.) The exact prompt content is in `docs/histforge-spec.md:337-339`.
    - **Phase B**: For `i in 1..chapter_count`: skip if `04_chapter_<i>.md` exists on disk; otherwise build context (outline + characters + structured chapter i + story_so_far), call LLM, write the chapter file **atomically** (`.tmp` + `rename`), then call LLM again with story-so-far prompt and overwrite `story_so_far.md` (also atomic).
  Step is `failed` only if a chapter call exhausts its retries (`docs/histforge-spec.md:313`).

  **Failure handling (implementation note — deviates from original plan):** no `cleanup` hook is exported; `STEP_OUTPUTS.write_chapters = []` leaves the default no-op cleanup in place. Atomic writes guarantee that any `04_chapter_<i>.md` present on disk is, by construction, a complete chapter — a crash mid-write only leaves `<file>.tmp` behind, never a torn final file. On resume, the existence check at the top of the loop skips completed chapters and regenerates the missing one. This satisfies the spec's "if chapter 7 fails, only chapter 7's file is deleted" rule (`:312`) without needing a custom cleanup hook or module-level in-flight tracking. The original plan called for a `cleanup(videoId)` override; the atomic-write approach was chosen instead because it also handles the mid-write crash window the cleanup hook wouldn't.
  **Context**: Sub-resume logic is critical (`docs/histforge-spec.md:309-313`). The orchestrator's `STEP_OUTPUTS`-based default cleanup would wipe everything listed for the step — since the list is empty for `write_chapters`, partial progress is preserved exactly as sub-resume requires.

### Phase 4: Voiceover (step 6) — GenAI Pro

- [x] **Task 4.1: GenAI Pro client + step 6**
  **Files**: `src/lib/genaipro.ts`, `src/worker/steps/06-voiceover.ts`
  **What**: `genaipro.ts` exports `synthesize(text, outPath): Promise<void>`. Submit task to `POST https://genaipro.vn/api/v1/labs/task` with the body shape in `docs/histforge-spec.md:367-383`, building the JSON body from DB Settings: `model_id` from `voiceover_model_id`, `voice_id` from `voice_id`, `stability`/`similarity`/`style`/`speed` from `voice_*` keys, `use_speaker_boost` from `voice_use_speaker_boost`, `call_back_url` always `""` (per `:390`). Poll the task-status GET endpoint every 30s capped at 2 min between polls, no overall timeout (`docs/histforge-spec.md:386`). On success, download mp3 URL and write to `outPath`. 3 retries with exponential backoff on submit; on `failed` task status, throw. Step 6 calls `synthesize(fullScript, "audio/narration.mp3")`.
  **Context**: **The poll endpoint is NOT in the spec** — Open Decision #1 in Current State. Look it up in GenAI Pro docs first; almost certainly `GET /api/v1/labs/task/{task_id}`. Auth: Bearer `GENAIPRO_API_KEY` from env. **Every voice tuning param comes from Settings, not env** (`docs/histforge-spec.md:394`) — do not hardcode the values from the spec's example body.

  **Implementation notes (post-review corrections):**
  - **Poll cadence simplification.** Spec :386 "Polling cadence: 30s, capped at 2 min" is implemented as a constant 30s interval — the 2-min cap is treated as a never-approached literal ceiling. A first cut used 30s→60s→120s step-up, but the spec doesn't specify backoff, a long TTS job has no overall timeout anyway, and any increase just wastes wall-clock time. Constant interval is the simplest implementation that satisfies the spec.
  - **Poll loop error dispatch.** Transient per-poll failures (network errors, non-2xx, malformed JSON) are swallowed with `continue` inside dedicated per-request try blocks; terminal states (`completed` with a valid URL, `failed`) throw or return *outside* those try blocks so they can never be caught-and-swallowed as if transient. A first cut used a regex-on-error-message to distinguish the two inside a single wrapping try/catch, which was fragile (rewording a string would silently change behavior). Pinned by a test that feeds transient 503 + network-error into the poll stream and asserts polling continues.
  - **Parent-dir ownership.** `synthesize` calls `mkdirSync(dirname(outPath), { recursive: true })` inside `downloadMp3` before writing the file. The client owns its output path so no caller has to pre-create directories. Step 6 is thin glue — read script, call synthesize — with no filesystem prep. Pinned by a happy-path test whose `outPath` points into a nonexistent `audio/` subdirectory.
  - **Test-time speedup.** `SynthesizeOpts` exposes `retryDelayMs` (for submit backoff) and `pollIntervalMs` (for poll cadence). Tests pass `0` for both to avoid real sleeps — same escape-hatch style as `openrouter.ts`'s `retryDelayMs`. No injected `sleep` function.

### Phase 5: Alignment (step 7) + Chunking (step 8)

- [x] **Task 5.1: WSL alignment wrapper + align.py**
  **Files**: `src/lib/align.ts`, `src/lib/sentences.ts`, `python/align.py`, `src/worker/steps/07-align.ts`
  **What**: `sentences.ts` wraps `sbd` for sentence splitting. `align.ts` exports `align(audioPath, scriptPath, outPath): Promise<void>` which: (1) loads `full_script.md`, (2) splits to sentences, (3) writes one per line to `alignment/sentences.txt`, (4) spawns `wsl -d $WSL_DISTRO <wslPath>/python/.venv/bin/python3 <wslPath>/python/align.py --audio ... --text ... --out ...`. Implement `wslPath()` as a string transform: `C:\Users\x\foo` → `/mnt/c/Users/x/foo`. `align.py` parses `--audio`/`--text`/`--out` argv and uses aeneas `ExecuteTask` API with config `task_language=eng|is_text_type=plain|os_task_file_format=json`, writing the result to the `--out` path. Step 7 calls `align(...)`.
  **Context**: Full pre-processing + invocation in `docs/histforge-spec.md:399-432`. **Use the venv Python, not bare `python3`** — Open Decision #6 in Current State. The spec example at `:407-415` shows bare `python3` but that conflicts with the README install (`README.md:122-128`) which puts aeneas in `python/.venv`. The `lib/align.ts` interface (`docs/histforge-spec.md:791`) lets us swap to WhisperX later. Output JSON shape `docs/histforge-spec.md:425-430`.

- [x] **Task 5.2: Step 8 — chunking**
  **Files**: `src/worker/steps/08-chunk.ts`
  **What**: Implement the algorithm in `docs/histforge-spec.md:436-451`: read `alignment.json`, build hook chunks (sentences from t=0 until ≥120s, cut at nearest sentence boundary not exceeding 120s, then split into 12 contiguous near-equal-duration groups, ids `hook_01..hook_12`), then main chunks (~30s each from where hook ended, cut at nearest sentence boundary, ids `main_001..main_NNN`). Write `chunks.json` with `prompt: null`. Sum of all chunk durations must equal audio length exactly.
  **Context**: Hook is exactly 12 chunks; main is N chunks of roughly 30s each. No gaps, no overlaps. **Field rename:** `alignment.json` entries use `begin`/`end` (`docs/histforge-spec.md:425-430`), but `chunks.json` entries use `start`/`end` (`docs/histforge-spec.md:265, :443-447`). When aggregating sentences into a chunk, the chunk's `start` is the first sentence's `begin` and the chunk's `end` is the last sentence's `end`. This rename is the spec's, not optional.

### Phase 6: Enrichment (step 9)

- [x] **Task 6.1: Step 9 — enrich_chunks**
  **Files**: `src/worker/steps/09-enrich-chunks.ts`, `prompts/09_enrich_chunk.md`
  **What**: For each chunk in `chunks.json`, call LLM with prev-text + current-text + next-text + style prompt. Output is a single visual prompt string. Update `chunks.json` in place after each chunk (so a crash mid-step leaves partial progress; re-run re-enriches all — that's fine, cheap). Style prompt source: `topics.style_prompt_override` if set, else `settings.style_prompt_default`.
  **Context**: `docs/histforge-spec.md:455-463`. Persist after each chunk for resumability.

### Phase 7: Freepik agent (steps 10–13)

- [x] **Task 7.1: Persistent session + login flow**
  **Files**: `src/lib/freepik/session.ts`, `src/lib/freepik/selectors.ts`, `scripts/freepik-login.ts`, `src/app/api/freepik/relogin/route.ts`, `src/app/api/freepik/relogin/done/route.ts`
  **What**: `session.ts` exposes `getContext()` returning `chromium.launchPersistentContext("./data/freepik-profile/", { headless: false })` — **always headed** (`docs/histforge-spec.md:471`). `selectors.ts` is the single source of truth for every Freepik DOM selector. `scripts/freepik-login.ts` is the standalone `npm run freepik:login` script — starts with `import "dotenv/config"`, opens a headed Chromium against the profile dir, waits for the operator to close the window. `FreepikSessionLost` is already defined in Phase 1 (Task 1.5); reuse it. Each Freepik step opens Freepik first and checks the logged-in indicator — if missing, set `queue_state='paused'`, `freepik_relogin_needed=true`, throw `FreepikSessionLost` (the orchestrator handles the rest).

  **Re-login routes** (per Open Decision #7 in Current State — the worker owns the long-lived Playwright context, the API spawns its own short-lived one against the same profile dir):
    - `POST /api/freepik/relogin`: launch a headed Chromium against `./data/freepik-profile/` from inside the Next.js process. Hold the `BrowserContext` reference in a module-level variable. Return `{ ok: true }` immediately. Safe because `freepik_relogin_needed=true` ⇒ `queue_state='paused'` ⇒ worker is not using the profile.
    - `POST /api/freepik/relogin/done`: close the held `BrowserContext`, clear `freepik_relogin_needed=false`. The operator separately clicks Resume on the videos page to flip `queue_state` back to `running` (so they get a chance to verify everything's good before the queue charges ahead).

  **Production-mode caveat:** the module-level `BrowserContext` reference relies on Next.js *not* hot-reloading the route module between the relogin call and the relogin/done call. Dev mode (`npm run dev`) hot-reloads on file changes, which would orphan the Chromium window. **The re-login flow is only supported under `npm start` (production build).** This matches the spec's general rule (`docs/histforge-spec.md:184-188`) that overnight runs use production mode, but worth calling out explicitly so the implementer doesn't smoke-test the re-login flow under dev and conclude it's broken.
  **Context**: Session lifecycle `docs/histforge-spec.md:469-474`. Selector centralization required because of brittleness (`docs/histforge-spec.md:805`). The orchestrator already handles `FreepikSessionLost` distinctly (Phase 1, Task 1.5).

- [x] **Task 7.2: Generate + download libs**
  **Files**: `src/lib/freepik/generate.ts`, `src/lib/freepik/download.ts`
  **What**: `generate.ts` exposes:
    - `setupStep(kind, videoId)`: creates project folder `histforge_<id>_<kind>`, selects style (`settings.freepik_style_name`) and aspect ratio once.
    - `submitBatch(prompts, idMap)`: 8 in flight at a time per `docs/histforge-spec.md:489-503`. For each chunk in batch: focus textarea, type prompt, click generate, wait briefly for new wrapper in `[data-cy="main-feed-gallery"]`, capture `data-item` attribute, append to `id_map.json` immediately. Then wait until all 8 wrappers in this batch are `draggable="true"`. Per-image timeout 2 min — log+skip on timeout. UI errors (modals, content policy) → log+skip+continue.
  `download.ts` exposes `downloadProjectFolder(folderName, idMap, outDir, ext)`: open folder, click select-all, click download, capture ZIP via Playwright download handler, extract, parse trailing numeric id from each `freepik_<slug>_<id>.<ext>`, look up chunk_id in idMap, move/rename to `outDir/<chunk_id>.<ext>`. Log files-without-map and map-without-files (`docs/histforge-spec.md:539-540`).
  **Context**: Pacing is exactly 8 in flight, persisted id_map per submission for crash safety. Use `lib/freepik/selectors.ts` for everything DOM-related.

- [x] **Task 7.3: Steps 10, 11, 12, 13**
  **Files**: `src/worker/steps/10-freepik-main-images.ts`, `src/worker/steps/11-freepik-hook-images.ts`, `src/worker/steps/12-freepik-hook-videos.ts`, `src/worker/steps/13-download-assets.ts`
  **What**:
    - **Step 10**: setupStep("main"), submitBatch on all `kind=main` chunks, persist `freepik/main_id_map.json`.
    - **Step 11**: setupStep("hook"), submitBatch on all `kind=hook` chunks, write to `hook_id_map.json` images section.
    - **Step 12**: For each hook image id, navigate to hook project on Freepik, open the image, click image-to-video, type **the chunk's enriched prompt** (per Open Decision #3 in Current State — reuse the same string from `chunks.json`), generate. Write video data-items to `hook_id_map.json` videos section. **Verify the library-reference assumption on first manual run** (Open Decision #2); if Freepik requires re-upload, insert a download-then-upload sub-step here (the rest of the pipeline is unaffected).
    - **Step 13**: downloadProjectFolder for main → `freepik/main/`, then for hook videos → `freepik/hook_videos/`. Delete both ZIPs.
  **Context**: Failure handling matrix in `docs/histforge-spec.md:522-526`. `hook_id_map.json` shape `docs/histforge-spec.md:518-520`.

### Phase 8: Render (step 14)

- [x] **Task 8.1: ffmpeg renderer**
  **Files**: `src/lib/render.ts`, `src/worker/steps/14-render.ts`
  **What**: `render.ts` exports `CROSSFADE_SECONDS = 1.0`, `ZOOM_TARGET = 1.275`, and `render(videoId)`. Compose ffmpeg command lines and spawn `ffmpeg.exe` directly. Stages per `docs/histforge-spec.md:572-607`:
    - **Setup**: delete `render/` first (no caching). Compute `W × H` from `aspect_ratio` + `long_edge_px`.
    - **Stage A — Hook segment**: concat hook clips with no crossfade via `concat` demuxer; append a re-encoded last-frame still for `CF` seconds (no time-stretching).
    - **Stage B — Per-segment renders**: for each main chunk, render `dur` (or `dur+CF` if not last) seconds with `zoompan` 1.0 → ZOOM_TARGET, `frames = round(dur * framerate)`, output `render/segment_NNN.mp4`. Use the exact filter chain in `docs/histforge-spec.md:587-592`.
    - **Stage C — Crossfade chain**: build xfade filter graph chaining all main segments with `transition=fade duration=CF offset=<cumulative>`. Output `main_concat.mp4`. If argv length becomes a problem, fall back to pair-wise reduction.
    - **Stage D — Hook→main crossfade**: xfade `hook_concat.mp4` → `main_concat.mp4` with `duration=CF`. Output `video_only.mp4`.
    - **Stage E — Mux audio**: `ffmpeg -i video_only.mp4 -i audio/narration.mp3 -c:v copy -c:a aac -b:a 192k -shortest final.mp4`.
  Implement placeholder fallback for missing chunk images: black W×H frame with `drawtext` `MISSING: <chunk_id>` (`docs/histforge-spec.md:609-610`).
  **Context**: Crossfade duration math is the trickiest part — `docs/histforge-spec.md:558-569`. Each non-last segment is rendered with `D_i + CF` content, last with exact `D_N`, so the xfade chain output equals `Σ chunk_duration = T_main`. **Read this section carefully before writing any ffmpeg commands.** Constants live in `lib/render.ts`, not Settings.

### Phase 9: Cleanup (step 15) + final polish

- [x] **Task 9.1: Step 15 — cleanup**
  **Files**: `src/worker/steps/15-cleanup.ts`
  **What**: Delete `render/`, `freepik/` (whole folder including `main/`, `hook_videos/`, both id maps), `audio/`, `alignment/`, `chunks/`, and **all intermediate script files** (`script/01_outline.md`, `script/02_characters.md`, `script/03_hook.md`, `script/04_outline_structured.json`, `script/04_chapter_*.md`, `script/story_so_far.md`). Keep `script/full_script.md`, `final.mp4`, `pipeline.log`.
  **Context**: Spec section 14 (`docs/histforge-spec.md:614-627`) lists explicit deletes but omits the intermediate script files; spec line 280 ("After cleanup: only `final.mp4`, `script/full_script.md`, and `pipeline.log` remain") makes the keep set authoritative. Implement against the keep set: enumerate the project dir and delete anything not in `{ final.mp4, script/full_script.md, pipeline.log }`. This is more robust to accidental file additions than maintaining a delete list.

- [x] **Task 9.2: Production build path**
  **Files**: `package.json` (scripts), `tsconfig.worker.json` (verify output paths)
  **What**: Verify `npm run build` produces `dist/worker/index.js` runnable by `node`, and `npm start` runs both `next start` and the compiled worker via `concurrently`. Both processes must be launched from the repo root so that relative paths to `prompts/`, `python/align.py`, `data/histforge.db`, and `projects/` resolve correctly — the worker reads prompts from disk on every step run (Task 3.1) and they live at `prompts/` relative to `process.cwd()`. Smoke-test by running through one full topic end-to-end in production mode (file-watch reloads during a long run would corrupt in-progress steps — `docs/histforge-spec.md:184-188`).
  **Context**: Production mode is the actual operating mode for overnight runs. Dev mode is only for editing.

- [ ] **Task 9.3: End-to-end smoke test**
  **Files**: (no new files — manual run + bug fixes across the codebase)
  **What**: Add one topic via dashboard, queue it, run the full pipeline through to `final.mp4`. Fix anything that breaks. Verify: resume on worker restart mid-pipeline, retry from failed step, restart from beginning, Freepik session-lost pause/resume cycle, queue pause/resume, settings round-trip.
  **Context**: This is the "verify queue, resume, failure paths end-to-end" item from `docs/histforge-spec.md:812` applied to the real pipeline (Phase 1 only verified it on stubs).

## References
- Spec: `docs/histforge-spec.md` (entire file is authoritative)
- Suggested build order: `docs/histforge-spec.md:810-822`
- Step contract: `docs/histforge-spec.md:304-313`
- Schema: `docs/histforge-spec.md:170-207`
- Settings keys: `docs/histforge-spec.md:217-233`
- Worker loop: `docs/histforge-spec.md:651-695`
- Render math: `docs/histforge-spec.md:558-569`
- Open issues / risks: `docs/histforge-spec.md:797-807`
- Dependencies + install: `README.md:9-128`
