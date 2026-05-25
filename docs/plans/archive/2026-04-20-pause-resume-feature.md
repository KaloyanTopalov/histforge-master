# Pause / Resume (per-video + global)

## Overview
Re-introduce pause as two independent controls: a per-video pause flag and a
global queue pause setting. A video runs only when both flags are clear.
Pause takes effect at between-step boundaries — in-flight steps finish first,
mirroring how `delete_requested` already works.

## Current State

- **Atomic step model**: `src/worker/runner.ts:35-46` picks the next video
  FIFO (crash-resume first, then oldest queued). `src/worker/pipeline.ts`
  runs steps to completion; there is no mid-step interruption hook.
- **delete_requested is our template**:
  - Column: `videos.delete_requested INTEGER DEFAULT 0` at `src/lib/db.ts:92`
  - Repo: `setDeleteRequested` / `readDeleteRequested` at
    `src/lib/repos/videos.ts:112-116, 244-249`
  - Between-step check: `src/worker/pipeline.ts:236-240` (and again at :270
    after the last step)
  - API: DELETE handler at `src/app/api/videos/[id]/route.ts:103-137`
    branches on status — in-flight ⇒ flag, otherwise immediate.
  - UI: `<DeletingLabel />` replaces the Delete button when
    `delete_requested=1` (`src/app/videos/video-queue-table.tsx:67`).
- **No global pause today**: `queue_state` setting, `pause-gate.ts`,
  `/api/queue/pause`, `/api/queue/start`, and the Pause/Resume header button
  were deleted in commit `6a13bdb` on 2026-04-19. The old code is recoverable
  via `git show 6a13bdb^:<path>` and is the reference for the global half.
- **Status model**: `VideoStatus` and `VideoStepStatus` defined at
  `src/types.ts:11, 29`. We keep the existing set — no new `"paused"` status.
- **Settings**: string-valued rows in SQLite, Zod-validated in
  `src/lib/settings.ts`, defaults seeded via `DEFAULT_SETTINGS` /
  `seedDefaultSettings` in `src/lib/db.ts:11-47`.
- **Schema migrations**: there is no migration system. `createDb` uses
  `CREATE TABLE IF NOT EXISTS` only (`src/lib/db.ts:79-107`), so adding a
  column to that block would not affect existing DBs. This plan adds an
  explicit `ALTER TABLE` in the same function, wrapped in a try/catch since
  SQLite has no `ADD COLUMN IF NOT EXISTS`.
- **Crash recovery**: `src/worker/index.ts:29` calls `resetStaleRunningSteps`
  at startup. Pause does not change this — an `in_progress` video resumes,
  hits the between-step check, honors the flag.
- **One-at-a-time invariant**: `pickNextVideo` returns an in_progress row
  if one exists, otherwise a queued row. The runner never runs two videos
  concurrently. Pause must preserve this — a paused in_progress video
  keeps `status='in_progress'`, and the runner idles rather than "falling
  through" to a queued row.

## Scope
**Doing**:
- Per-video `paused` column, repo helpers, `/api/videos/[id]/pause` and
  `.../resume` routes, Pause/Resume buttons in queue-table and detail view.
- Global `queue_state` setting revived, runner-level and between-step checks,
  `/api/queue/pause` + `/api/queue/start` routes, Pause/Resume header
  control on the videos page.
- Queue-table and detail **Paused** badge + page-level banner for global
  pause, so user feedback is clear.

**Not doing**:
- No mid-step cancellation (no killing FFmpeg/TTS/LLM calls in flight).
- No new `VideoStatus = "paused"` value — flag only.
- No automatic pause on errors or upstream outages.
- No bulk per-video pause controls (global pause already covers that case).

## Tasks

### Phase 1: Schema + repo

- [x] **Task 1.1: Add `paused` column to `videos` (schema + migration)**
  **Files**: `src/lib/db.ts`, `src/types.ts`
  **What**: Add `paused INTEGER NOT NULL DEFAULT 0` to the `CREATE TABLE
  IF NOT EXISTS videos` block so fresh DBs get the column. **Also** add an
  explicit `ALTER TABLE videos ADD COLUMN paused INTEGER NOT NULL DEFAULT 0`
  in `createDb`. SQLite has no `ADD COLUMN IF NOT EXISTS`, so wrap it in a
  try/catch that **narrowly matches the expected "duplicate column" error**
  (better-sqlite3 throws `SqliteError` with message containing
  `duplicate column name`) and rethrows anything else — swallowing all
  errors would hide real bugs. `Video` row type in `src/types.ts` gains
  `paused: 0 | 1`.
  **Context**: CREATE block at `src/lib/db.ts:79-107`, `delete_requested`
  column at `:92` is the shape to mirror. Type at `src/types.ts:13-27`.
  No migration framework exists — this is the simplest correct approach.

- [x] **Task 1.2: Add `queue_state` setting**
  **Files**: `src/lib/settings.ts`, `src/lib/db.ts`
  **What**: Setting key `queue_state` with values `"running" | "paused"`,
  default `"running"`. Zod-validated. Added to `DEFAULT_SETTINGS` so
  `seedDefaultSettings` seeds it on init.
  **Context**: `DEFAULT_SETTINGS` map at `src/lib/db.ts:11-35`;
  `seedDefaultSettings` at `:37-47`. Enum-style Zod schema conventions in
  `src/lib/settings.ts`.

- [x] **Task 1.3: Per-video pause repo helpers**
  **Files**: `src/lib/repos/videos.ts`
  **What**:
  - `setPaused(db, id)`, `clearPaused(db, id)`, `readPaused(db, id)` —
    mirror `setDeleteRequested` / `readDeleteRequested`.
  - Update `findOldestQueuedId` and `findInProgressId` to add
    `AND paused = 0` to their WHERE clauses. This is where the SQL-level
    skip-paused filter lives; `pickNextVideo` does not need its own filter
    on top.
  - **Also** add `anyInProgressExists(db): boolean` — an UNFILTERED
    check (`SELECT 1 FROM videos WHERE status='in_progress' LIMIT 1`).
    Task 2.1 uses this to preserve the one-at-a-time invariant: if any
    in_progress row exists (paused or not) and the filtered
    `findInProgressId` returned none, the runner must idle rather than
    fall through to a queued row.
  **Context**: `findOldestQueuedId` at `src/lib/repos/videos.ts:222-229`,
  `findInProgressId` at `:231-236`. Flag setters/readers pattern at
  `:112-116, 244-249`.

- [x] **Task 1.4: Clear `paused` on restart**
  **Files**: `src/lib/repos/videos.ts`
  **What**: `resetToQueued` (the full-restart wipe invoked by the
  restart route on failed/done videos) must also set `paused = 0`.
  Without this, a video that was paused before it finished/failed
  would silently stay paused after the user clicks **Restart** — the
  row lands in `status='queued'` with `paused=1`, and the runner's
  `findOldestQueuedId` filter would skip it, making the restart
  button look broken. A restart is an explicit "run this from
  scratch" action; pause intent does not carry across it.
  Retry (`clearFailure`) is intentionally NOT touched here — retry
  only nulls failure metadata and is a narrower recovery action;
  if we later decide retry should also clear `paused`, that is a
  follow-up.
  **Context**: `resetToQueued` at `src/lib/repos/videos.ts:193-205`;
  restart route at `src/app/api/videos/[id]/restart/route.ts:54`;
  retry route at `src/app/api/videos/[id]/retry/route.ts:49` (left
  alone).

### Phase 2: Worker enforcement

- [x] **Task 2.1: Global + per-video gate in runner**
  **Files**: `src/worker/runner.ts`
  **What**:
  - In `pickNextVideo` (or a thin wrapper called from `tickOnce`),
    short-circuit to `null` when `queue_state === "paused"`.
  - Because Task 1.3 filters paused rows out of `findInProgressId` and
    `findOldestQueuedId`, `pickNextVideo` naturally returns `null` when
    the only in_progress video is paused — but it must NOT then fall
    through to `findOldestQueuedId` in that case. Preserve the
    one-at-a-time invariant: after `findInProgressId` returns none,
    call the new `anyInProgressExists` helper (Task 1.3); if it's
    true, return `null` (idle) instead of consulting the queued branch.
  - `tickOnce` behaviour is unchanged — when `pickNextVideo` returns
    `null`, `tickOnce` returns `"idle-empty"`, which sleeps 5s. This is
    what prevents the worker from busy-spinning on a paused in-progress
    video.
  **Context**: Pick logic at `src/worker/runner.ts:35-46`; `tickOnce` at
  `:68-90`; sleep map at `:97-100`. Deleted `pause-gate.ts` (via
  `git show 6a13bdb^:src/worker/pause-gate.ts`) is reference only — do
  not reintroduce a separate file; inline the setting read.

- [x] **Task 2.2: Between-step pause check**
  **Files**: `src/worker/pipeline.ts`
  **What**: After each step completes, if `queue_state === "paused"` OR
  the video's `paused=1`, stop the pipeline cleanly: leave status as
  `in_progress`, leave `current_step` untouched, return. Next tick will
  not pick it up (Task 2.1) until both flags clear. Check delete first
  so delete still wins when both are set.
  Note: `current_step` will continue to show the last-completed step's
  name in the UI while paused — acceptable, since the row is genuinely
  still mid-pipeline; no code change needed.
  **Context**: Insert next to the existing `delete_requested` check at
  `src/worker/pipeline.ts:236-240` (and the post-last-step check at
  `:270` — same logic applies). Do not reintroduce `clearRunStateToQueued`
  — that was removed intentionally in 6a13bdb.

### Phase 3: API routes

- [x] **Task 3.1: Per-video pause/resume routes**
  **Files**: `src/app/api/videos/[id]/pause/route.ts` (new),
  `src/app/api/videos/[id]/resume/route.ts` (new)
  **What**: POST handlers.
  - Pause: 409 unless status is `queued` or `in_progress` AND
    `delete_requested=0` AND `paused=0`; otherwise set `paused=1`.
  - Resume: 409 unless `paused=1` AND `delete_requested=0`; otherwise
    clear the flag. (Reject while delete is pending — the video is on
    its way out.)
  - Wrap each in `db.transaction`.
  **Context**: Route shape and status-guard pattern at
  `src/app/api/videos/[id]/start/route.ts` (guard, transaction, JSON
  response). DELETE deferred-flag pattern at
  `src/app/api/videos/[id]/route.ts:103-137`.

- [x] **Task 3.2: Global pause/start routes**
  **Files**: `src/app/api/queue/pause/route.ts` (new),
  `src/app/api/queue/start/route.ts` (new)
  **What**: POST handlers that flip the `queue_state` setting to
  `"paused"` / `"running"`. Idempotent.
  **Context**: Revive from `git show 6a13bdb^:src/app/api/queue/...` as
  a starting point. Use the current `lib/settings.ts` helpers rather
  than raw `setSetting` if that's the new convention.

- [x] **Task 3.3: Extend GET responses with `queue_state`**
  **Files**: `src/app/api/videos/route.ts`,
  `src/app/api/videos/[id]/route.ts`
  **What**: Both the list GET (`/api/videos`) and the per-video GET
  (`/api/videos/[id]`) are polled every 5s from different clients. Both
  must return `queueState` so global-pause toggles propagate live to
  both the list page and the detail page.
  - List route: extend `{ videos }` → `{ videos, queueState }`
    (additive; existing clients keep working).
  - Per-video route: extend its existing response shape with the same
    `queueState` field.
  Both server-rendered pages (`src/app/videos/page.tsx` and
  `src/app/videos/[id]/page.tsx`) should also read the setting and pass
  it to their client islands so the first paint is correct.
  **Context**: Needed by Tasks 4.1, 4.2, 4.3. List-page polling at
  `src/app/videos/videos-client.tsx:69-106`; detail-page polling at
  `src/app/videos/[id]/video-detail-client.tsx:114, 141`.

### Phase 4: UI

- [x] **Task 4.1: Per-video Pause/Resume buttons in queue table**
  **Files**: `src/app/videos/video-queue-table.tsx`,
  `src/app/videos/videos-client.tsx`
  **What**: New action button that shows:
  - **Pause** when (`status='queued'` or `status='in_progress'`) and
    `paused=0` and `delete_requested=0`.
  - **Resume** when `paused=1` and `delete_requested=0`. Disable the
    Resume button (with a tooltip like "Queue is globally paused") when
    `queueState='paused'` — clicking it would clear the per-video flag
    but the runner still wouldn't pick up the video, which is
    confusing.
  - A single **Paused** badge (mirroring `<DeletingLabel />`) shown in
    the status cell when `paused=1`. No "Pausing…" transitional
    variant — the video row exposes no direct signal for "worker has
    stopped touching this one," and splitting states would require an
    extra `video_steps` query per row for marginal value.
  - **Badge precedence in the status cell** (most to least specific):
    `delete_requested=1` → `<DeletingLabel />`; else `paused=1` → new
    PausedLabel; else `<StatusBadge status=…/>`. Existing precedence
    for DeletingLabel at `src/app/videos/video-queue-table.tsx:77`.
  - Hide Pause/Resume buttons entirely while `delete_requested=1` (the
    API would 409 anyway per Task 3.1).
  - **Prop threading**: `VideoQueueTable` currently takes only
    `rows / workflows / onStart / onEdit / onDelete`
    (`video-queue-table.tsx:17-23`). Add `queueState: "running" |
    "paused"` plus `onPause(v)` / `onResume(v)` to its props, and wire
    them from `VideosClient` (which holds the `queueState` in state,
    seeded from the server-rendered initial prop and updated by the
    existing 5s poll). Mutation handlers for pause/resume live in
    `videos-client.tsx` alongside `onStartVideo`.
  **Context**: Sibling buttons (Start / Edit / Delete) and their status
  branching at `src/app/videos/video-queue-table.tsx:79-115`;
  `<DeletingLabel />` at `:67` is the badge template. Follow the
  existing shadcn + sonner toast conventions already used in
  `videos-client.tsx`.

- [x] **Task 4.2: Per-video Pause/Resume on detail page**
  **Files**: `src/app/videos/[id]/page.tsx`,
  `src/app/videos/[id]/video-detail-client.tsx`,
  `src/app/videos/[id]/video-actions.tsx`
  **What**: Same button logic, conditions, and disabled-on-global-pause
  tooltip as Task 4.1, slotted into the detail action bar. Same single
  **Paused** badge when `paused=1`, with the same precedence as Task 4.1.
  - **Prop threading**: `page.tsx` reads `queue_state` from settings and
    passes it as `initialQueueState` to `VideoDetailClient`.
    `VideoDetailClient` keeps it in state, updates it from the extended
    per-video poll response (Task 3.3), and passes it to
    `VideoActions` so the Resume button can disable + tooltip.
  **Context**: Existing status-gated buttons (Start / Retry / Restart)
  at `src/app/videos/[id]/video-actions.tsx:96-142`. Server-to-client
  prop wiring pattern at `src/app/videos/[id]/page.tsx` around the
  `<VideoDetailClient ... />` call.

- [x] **Task 4.3: Global Pause/Resume control + banner**
  **Files**: `src/app/videos/videos-client.tsx`,
  `src/app/videos/page.tsx`
  **What**: Header-level Pause button that toggles to Resume when
  `queueState='paused'`. Visible banner across the videos page when
  paused so the user understands nothing is processing. Initial
  `queueState` comes from the server render (Task 3.3 change to
  `page.tsx`); polling reads it from the extended `/api/videos`
  response (Task 3.3). Do not reintroduce `freepik_relogin_needed`
  (removed for good).
  **Context**: Old implementation existed on this page before commit
  6a13bdb — `git show 6a13bdb^:src/app/videos/videos-client.tsx` for
  shape, but wire it into the current shadcn-ified layout (header
  buttons live at `src/app/videos/videos-client.tsx:135-156`).

### Phase 5: Tests

- [x] **Task 5.1: Route tests**
  **Files**: `__tests__/api/videos/[id]/pause/route.test.ts` (new),
  `__tests__/api/videos/[id]/resume/route.test.ts` (new),
  `__tests__/api/queue/pause/route.test.ts` (new),
  `__tests__/api/queue/start/route.test.ts` (new)
  **What**: Integration-style tests for the four new routes from
  Phase 3: valid transitions, 409 on invalid states, idempotency for
  the global routes.
  Note: unit tests for the new repo helpers (`setPaused`,
  `clearPaused`, `readPaused`, the `paused=0` filters on
  `findOldestQueuedId` / `findInProgressId`, `anyInProgressExists`,
  and `resetToQueued` clearing `paused`) are intentionally NOT in
  this task — they were written TDD-style alongside Phase 1 and
  already live in `__tests__/unit/lib/repos/videos.test.ts`.
  **Context**: Follow the existing route-test style (see
  `__tests__/api/videos/[id]/start/route.test.ts` for the pattern).
  Do not introduce a new framework.

- [x] **Task 5.2: Pipeline + runner gate tests**
  **Files**: existing worker test locations
  **What**: Cover:
  (a) runner skips paused queued videos;
  (b) runner short-circuits on `queue_state=paused`;
  (c) pipeline stops at the between-step boundary when either flag is
  set;
  (d) delete still wins when both `delete_requested` and `paused` are
  set;
  (e) clearing both flags lets the video resume on the next tick;
  (f) **no busy-spin**: when the only in_progress video is paused,
  `tickOnce` returns `"idle-empty"` (not `"worked"`), even if queued
  rows exist — proving the one-at-a-time invariant holds and the loop
  sleeps 5s instead of spinning.
  **Context**: Existing tests around the pipeline between-step delete
  check are the closest analog.

## References
- Deleted-but-useful prior art: `git show 6a13bdb` and
  `git show 6a13bdb^:src/worker/pause-gate.ts`
- Delete-request template: `src/worker/pipeline.ts:236-240`,
  `src/lib/repos/videos.ts:112-116, 244-249`,
  `src/app/api/videos/[id]/route.ts:103-137`
- Runner pick logic: `src/worker/runner.ts:35-46`
- Spec: `docs/histforge-spec.md`
