---
name: domain-dashboard
description: Guide for the Next.js dashboard UI, API routes, SQLite schema, and settings system. Use when modifying pages (videos list, video detail, settings), API routes, queue/per-video pause controls, adding new endpoints, changing the SQLite schema, or editing the settings Zod schemas.
---

# Dashboard & API

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Page + API routes**: `/`, `/videos`, `/videos/[id]`, `/settings`, `/api/videos`, `/api/videos/[id]` (lifecycle: `start`, `retry`, `restart`, `pause`, `resume`, `open-folder`), `/api/videos/start-all`, `/api/videos/[id]/files/[...path]`, `/api/queue/pause`, `/api/queue/start`, `/api/settings`, `/api/health`
- **DB tables**: `videos`, `video_steps`, `settings`
- **Behavior-driving columns**: `videos.status`, `videos.paused`, `videos.delete_requested`, `videos.deferred_until`, `videos.workflow_snapshot`, `videos.provided_script`, `videos.current_step`
- **Repos + DB module (public boundary)**: `getDb`, `createDb`, `seedDefaultSettings`, `videosRepo`, `stepsRepo`, `runtimeSnapshots`, `existsById`
- **Lifecycle modules**: `videoLifecycle`, `flowLifecycle`, `videoPredicates`, `applyReadyScriptArtifacts`
- **Settings module**: `getSetting`, `setSetting`, `getAllSettings`, `SettingKey`, `AllSettings`, `TAB_FIELDS`, `ENUM_VALUES`, `enumOptions`, `getDerivedChapterCount`, `getDerivedHookChunkCount`, `getHookClipSeconds`
- **Shared video UI contract**: `canPauseVideo`, `canResumeVideo`, `canRetryVideo`, `canRestartVideo`, `predicateForRow`, `StatusBadge`, `PausedLabel`, `PausingLabel`, `DeletingLabel`, `ReadyScriptBadge`, `SectionHeading`, `QueueStatusPill`, `dirtyDiff`
- **Videos page state contract**: `getVideosPageState`, `VideosPageState`, `BannerFlags`, `useVideoPoller`, `useVideoAction`, `useNowTick`
- **Behavior-driving keys**: `queue_state`, `script_length_minutes`, `hook_length_seconds`, `DATABASE_URL`, `PROJECTS_DIR`

## Architecture

Next.js App Router application that runs alongside the worker and talks to the same SQLite database. Four layers:

1. **Pages** — server components fetch initial data synchronously via `better-sqlite3`, then hand a plain-data prop bundle to a client island for interactivity.
2. **API routes** — REST endpoints consumed by client islands. Cover videos (CRUD + per-video lifecycle), queue (global pause/resume), settings, and health. Workflows API is owned by `domain-workflows`; flow webhook routes are owned by `domain-google-flow-coordinator`; drafts routes are owned by `domain-workflow-drafts`.
3. **Lifecycle modules** — `videoLifecycle` and `flowLifecycle` carry named composed multi-write transitions over their respective aggregates. Pure predicates live in sibling modules so lifecycle guards, route guards, and UI guards all share the same eligibility rules.
4. **Shared libraries** — SQLite singleton, per-key Zod-coerced settings accessors, and the repository layer — all shared with the worker.

Root redirects to the videos dashboard. The workflows page is owned by `domain-workflows` (the dashboard only provides the page shell and nav).

## Repository + Lifecycle Layering

Routes, server components, and the worker never write to SQLite via inline prepared statements. The data layer is split into two complementary boundaries:

- **Repos** — thin atomic SQL wrappers. Each function is a single prepared statement or a single conceptual write that intrinsically spans rows. No business logic, no eligibility checks.
- **Lifecycle modules** — named composed multi-write transitions over the aggregate. Each method opens its own transaction, calls into pure predicates for the eligibility decision, and composes the repo wrappers. Cross-module cascades between `videoLifecycle` and `flowLifecycle` rely on better-sqlite3's reentrant transactions (inner txns nest as SAVEPOINTs under outer ones) so a throw anywhere rolls the whole composition back.

Why:
- **One definition per SQL operation** — a column rename touches one repo file, not every route and worker path.
- **Named eligibility, named transition.** Routes read the lifecycle return code (ok-flag + reason) and map to an HTTP status; they don't compose repo calls themselves.
- **Pure predicates are the eligibility contract.** The lifecycle module, the route handler, and the UI surface all consume the same predicate functions. Three places never disagree about whether an action is allowed.
- **Shared with the worker.** The orchestrator uses the same repo + lifecycle functions the dashboard calls. No drift between read and write paths.

Exceptions:
- **`settings`** is owned by the settings module, not the repo layer. The Zod-per-key design is the authoritative validation; don't add a settings repo.
- **`workflows` / `workflow_steps`** have a repo, but external callers go through the workflows lib boundary instead. See `domain-workflows`.
- **Single-statement transitions** stay in callers — there is nothing to compose, and forcing them through a lifecycle method would add a layer without value.

## Server Component + Client Island Pattern

Every page follows the same shape:

1. **Server component** queries the DB synchronously via `better-sqlite3` and passes results as `initial*` props. Workflow metadata is resolved server-side via the workflows lib so the client never imports worker-only code into the browser bundle. A `serverNow` value is also passed so SSR and the first client render agree on timer text — `useNowTick` snaps to the real client clock after mount.
2. **Client island** owns all interactivity — local state, event handlers, fetch calls, polling.
3. **After mutations**, client islands call `router.refresh()` (or rely on the existing poll loop). The dashboard does not maintain a client-side copy of truth; the DB is always the source.

Consequences:
- No loading spinners for initial page loads — data is pre-fetched server-side.
- No stale data after mutations — `router.refresh()` triggers a full server re-render.
- Client components handle their own in-flight / error states for API calls they make.

The videos list and detail pages are intentionally split into a client orchestrator (owns polling + dialog state) plus per-table / per-action child components plus a shared module for status badges, eligibility predicates, and section chrome. The shared predicates compose the pure predicates from the lifecycle layer with any UI-only narrowing — both the queue row and the detail page consume the same helpers.

## API Routes

The patterns below are what must be preserved across routes.

### Lifecycle & CRUD shape

- **Video create / patch** validate `workflow_id` against the workflows lib before calling the repo. Unknown / disabled workflow returns a domain-coded 400, not a foreign-key failure.
- **Video PATCH** is locked once the video has left `new` / `queued`; the route returns a `not_editable` conflict, and the workflow lib re-pins `workflow_snapshot` if `workflow_id` is part of the patch — see `domain-workflows`. Patching `provided_script` on a `queued` ready-script video resyncs the on-disk script via `applyReadyScriptArtifacts`.
- **Per-video lifecycle actions** — start promotes `new → queued` (and re-pins the snapshot); the start-all batch reports per-id ready-script prep failures alongside the count, so one bad row doesn't abort the batch. Retry resets only the failed step row and clears failure meta (preserves `started_at`). Restart wipes the project directory and deletes all step rows before re-queueing; ready-script videos need `applyReadyScriptArtifacts` re-prep after the lifecycle method runs (the route owns that, since ready-script is its own concept).
- **Per-video pause/resume** — flip `videos.paused` via the lifecycle module. The lifecycle method runs read-check-write in one transaction, so a concurrent delete or status change cannot slip between the guard and the write. An in-progress paused video keeps its current running step row but won't advance to the next step until resumed.
- **Queue-level pause/resume** — flip the `queue_state` setting. The runner reads it on every poll tick; a paused queue makes the loop sleep without claiming work. This is global and orthogonal to per-video `paused`.
- **Open folder** (Windows-only) — spawns Explorer with the final video pre-selected. Fire-and-forget detached spawn because Explorer exits with code 1 even on success.
- **Files route** serves from the per-video project directory with defense-in-depth validation (see below).
- **Settings GET/PATCH** is all-or-nothing inside one transaction.
- **Health** is a liveness ping only.

### Two Pause Axes — Orthogonal

The system has two independent pause concepts and they must stay independent:

- **Queue-level (`settings.queue_state`)** — affects every video. Set by the queue toolbar button, drives the amber "Queue is paused" banner on `/videos`.
- **Per-video (`videos.paused`)** — affects one video. Set by the per-row Pause button or the detail page. Renders as `paused` (or `pausing…`) in the status column.

Don't conflate them. A paused queue with five running-but-not-paused videos resumes all five when the queue resumes. A running queue with one per-video-paused video leaves the other videos to flow normally; only that video sits idle.

### Validation

- Video create/patch use Zod schemas inline in the route. `workflow_id` is cross-validated against the workflows lib.
- Settings writes coerce through per-key Zod schemas. The entire PATCH body flows through the per-key setter inside one transaction.
- Error responses include a domain error code alongside the HTTP status so clients can branch on intent without parsing the status alone.

### Atomic Transactions

Multi-row writes always run inside a DB transaction. The lifecycle methods are the canonical homes:
- **Retry** — resets the failed step row, clears failure metadata, and sets the video back to `queued`, all atomic.
- **Restart** — wipes the project directory *before* the DB transaction because filesystem ops cannot participate in SQLite transactions; the DB-side delete+reset runs inside one txn. A partial cleanup (files gone, DB unchanged) is recoverable because the orchestrator's pre-loop upsert regenerates step rows on the next tick.
- **Settings PATCH** — every per-field write runs in one transaction. Any per-key Zod failure rolls back every field.
- **Pause / resume** — the lifecycle methods run the eligibility read and the status write in one transaction so a concurrent state change cannot race past a stale row.

### Delete Flow (status-aware)

The DELETE route branches on `video.status`:
- **Terminal or pre-run states** (`new` / `queued` / `failed` / `done`) — wipe project directory then delete the video + step rows, atomic on the DB side. The FS wipe is safe on missing dirs.
- **`in_progress`** — set `delete_requested=1` and return 202 Accepted. The orchestrator picks up the flag between steps; the DB row survives until the orchestrator tears it down (see `domain-pipeline`).

Client UX for in-progress deletes: the detail page stays put, shows a deleting spinner label, and the poller eventually 404s once the orchestrator finishes the wipe — then the page redirects.

### ID Generation

`ulid()` for new video IDs — lexicographically sortable, time-ordered, no collisions.

## Settings System

### Storage and Coercion

All settings are stored as TEXT in SQLite. The settings module defines Zod schemas per key that handle bidirectional coercion: `getSetting` parses the stored string and returns the native value; `setSetting` validates and stores the string form.

Storing TEXT + per-key coercion is deliberate: adding a new setting is a one-line schema entry plus a one-line default, and SQLite never needs a migration for type changes.

### Seeding

`seedDefaultSettings` uses `INSERT OR IGNORE` so fresh DBs get defaults and existing DBs don't clobber operator-tuned values. Defaults live in the DB module; per-key Zod schemas live in the settings module. Both must stay in sync on adds/renames; `getAllSettings` throws if a schema key has no row, which catches drift immediately.

The DB module also runs in-place additive migrations on every open (re-seeding new defaults, coercing legacy enum values back into range, renaming legacy step / kind slugs in pinned rows), so an upgraded install doesn't need to re-run `db:init` to pick up new settings or scrubs.

### Tabs and Enums (Client-Safe Modules)

Two sibling modules carry the form's structural metadata without importing the DB module (so client bundles can include them):
- **Tabs (`TAB_FIELDS`)** — declares the per-tab roster. Each setting key is owned by exactly one tab; this drives where a field renders and where the unsaved-change dot appears.
- **Enums (`ENUM_VALUES` / `enumOptions`)** — single source of truth for every enum-typed setting's accepted values. The settings module references these from its `z.enum(...)` schemas; the per-tab panels render via `enumOptions`. Adding a new enum-typed setting only needs an entry here plus the schema reference. A compile-time guard asserts every enum key is a valid `SettingKey`.

The Settings form is organized into tabs with a single form-level Save that PATCHes only the keys whose value differs from the baseline snapshot (via `dirtyDiff`). The snapshot updates on successful save, so subsequent edits are measured from the new ground truth. A dot renders next to any tab label whose fields have unsaved changes. Active tab is reflected in the URL so deep-links and reloads preserve context.

Why dirty-diff: the PATCH is all-or-nothing inside a transaction, so sending unchanged fields would cost a full re-validate of the whole form on every save. It also keeps the PATCH body minimal and makes the "no-op save" case a clean early-return.

### Derived Settings (Helpers, Not Schemas)

Operator-facing settings (script length, hook length) drive derived values that the worker consumes (chapter count via `getDerivedChapterCount`, hook chunk count via `getDerivedHookChunkCount` — the latter branches on `video_provider` via `getHookClipSeconds`).

These live as helper functions, not as separately stored derived fields, because the operator inputs the human-readable value and the worker reads the derived one. Keeping them as helpers means a knob change is instantly observable without a migration.

### `queue_state` is a Setting, Not a Repo Field

`queue_state` lives in the `settings` table because it is operator-tunable runtime state, not per-row video state. Reads happen on every runner poll tick; writes happen only via the queue toolbar. Don't move it to a dedicated table or duck-type it onto the videos table — it has no relationship to any single video.

### Surface-Only Settings

Some Google Flow keys are bound in the form but consumed only by the Flow coordinator (see `domain-google-flow-coordinator`). The relogin-needed flag renders read-only — it's auto-flipped by the webhook routes and auto-cleared on a successful task claim, so letting the operator edit it would be misleading.

## Videos List

The videos page shows three sections on one page, split client-side from a single videos GET payload: Topics (`new` videos), Video Queue (`queued` / `in_progress` / `failed`), and Finished Videos (`done`). Each section has its own per-row action set.

The page server-fetch and the videos GET both go through `getVideosPageState`, which builds the `VideosPageState` projection consumed by both entry points. Single source means the initial render and the poll response cannot drift — the client island restarts cleanly from the polled payload with no reconciliation glue. Adding a new operator-facing flag surfaced through this poller is a one-line edit to `BannerFlags` and one setting read inside the helper; the page server-fetch, the wire payload, and the `useVideoPoller` signature stay stable.

The client island runs `useVideoPoller`, which polls the videos endpoint, diffs statuses against a prior-status map to emit toast notifications on done / failed transitions, then re-overwrites the topics/queue/finished split, queue state, and banner flags. The hook also exposes synchronous setters for local overrides — the queue-toggle button uses one to flip optimistically; banner Dismiss callbacks use one to clear immediately. The next poll re-overwrites either way, so the override is a UX shortcut, not state ownership. Network hiccups are silently swallowed — the next poll recovers.

Action handlers all go through `useVideoAction`, which owns the busy state, optional toast policy, and a wait-for-poll predicate. The predicates close over a latest-rows ref updated during render (not in an effect) so each predicate tick reads the latest polled state without depending on commit timing. `predicateForRow` is the vanish-as-satisfied builder — a row that disappears between click and poll auto-satisfies, so a spinner can never hang on a row that no longer exists.

Per-row timer text is driven by `useNowTick`, which ticks at the table level when at least one queue row has an open step. Finished rows freeze. The `runtimeSnapshots` aggregate read on the steps repo gives each polled row a runtime accumulator plus the start time of any open step; the renderer extrapolates between polls.

Two banner shapes live above the tables, both populated from `BannerFlags` and owned by the Flow coordinator (see `domain-google-flow-coordinator`); the dashboard's job is purely to render and dismiss:

- **Operator-cleared banner** (e.g. create-project failure). Never auto-clears; Dismiss is the only path off-screen. Use this shape when the underlying signal cannot be re-derived without operator action.
- **Auto-cleared banner** (e.g. session-expired relogin, service overload, captcha recovery). Coordinator flips it on event and clears it on the next successful recovery; Dismiss is a snooze that returns when the event repeats. Use this shape when the system itself can detect the recovered state.

The queue's status column renders three different things in priority order: a deleting spinner if `delete_requested`, a paused (or pausing) badge if `paused`, otherwise the normal status badge. Per-row Pause/Resume buttons appear only when their shared predicate allows. Resume is force-disabled when the queue is globally paused, with a tooltip explaining why — pressing it would send a request that succeeds but doesn't actually resume processing.

The header hosts the queue toggle (the only action that optimistically updates without waiting for poll, because the post-action value is fully knowable client-side), Add Topic / Add Ready Script (the ready-script flow skips LLM generation and persists `provided_script` directly), and the bulk `new → queued` action.

When the queue is globally paused, a banner above the tables tells the operator nothing is processing.

## Video Detail

The video detail page surfaces:
- Header with title, status, workflow label, and a link to the final video when done.
- Step list in workflow order. Step rows are pulled via `stepsRepo.findByVideo`, which orders by the live workflow's materialized step list and drops orphan rows that don't belong to the current workflow.
- A pipeline-log link pointing at the files route.
- Artifacts panel listing every file under the project directory.
- Per-status action surface mirroring the queue-row actions, plus richer failed / done options the detail view exclusively hosts (Retry, Restart, Copy Path). Pause/Resume reuse the same shared predicates as the queue row.
- For workflows whose image or video provider is `google_flow`: Flow progress and moderation panels (owned by `domain-google-flow-coordinator`). The detection gates on the snapshot's provider columns, not the workflow id, so a user-authored workflow that uses Google Flow surfaces the panels too.
- The fleet-level service-overload banner appears on every video-detail page (not just Flow-provider ones) — the signal is global and operators benefit from seeing it regardless of which video they're viewing.

## File Serving — Defense-in-Depth

The files route has four validation layers, each deliberate:
1. Reject empty path (no directory-listing semantics).
2. Reject any traversal segment before touching the filesystem.
3. Reject unknown video IDs via `existsById` — no serving from arbitrary paths under the projects directory, and orphaned directories from deleted videos are inaccessible.
4. After path resolution, assert the result still lives under the project root — even if URL decoding produced unexpected traversal tokens, the absolute-path check is the final backstop.

Content-type comes from a small whitelist of extensions the pipeline produces; anything else falls back to octet-stream. If you add a new file type the pipeline produces, update the whitelist — falling back works but renders as a download instead of inline.

## In-Place SQLite Migrations

New columns on existing tables go in `createDb` as an `ALTER TABLE … ADD COLUMN` wrapped in a try/catch that *only* swallows the duplicate-column error — anything else rethrows. SQLite has no `ADD COLUMN IF NOT EXISTS`, and a blanket catch would mask real schema bugs. Keep the migration narrow: one column per try/catch block, no DDL beyond what's necessary.

For new defaults that must reach upgraded DBs without re-running `db:init`, add an `INSERT OR IGNORE` next to the existing migration block, and keep the value in sync with the defaults table. Same for legacy enum coercion: a one-shot `UPDATE` that maps out-of-range stored values back to a valid default keeps `getSetting` from throwing a ZodError on the read path.

Step / kind slug renames need a wider sweep: every table that pins the slug at runtime, plus the JSON inside `videos.workflow_snapshot`, must be updated in the same migration block. Module-tier slugs inserted at materialization time don't appear in `workflow_steps` or in the snapshot's step list, so those scopes can be skipped for module renames — script-authored renames need them.

## Common Pitfalls

- **`paused` and `queue_state` are independent axes.** Don't gate per-video pause/resume on `queue_state` server-side, and don't gate queue-level pause on any video's `paused`. The UI disables per-video Resume while the queue is globally paused as a *user cue*, but server-side eligibility for both is independent. **Why:** the two axes mean different things — operator-wide kill switch vs. per-video hold — and conflating them silently changes recoverable state into "everything stopped" or vice versa.

- **Status-column priority order matters.** The badge column renders in priority order: `delete_requested` → `paused` → status. **Why:** during the brief window where two flags overlap (e.g., delete-requested-on-a-paused-video), reordering shows the wrong state and the operator misreads what the system is doing.

- **`videos.current_step` is denormalized for the dashboard.** Authoritative per-step state lives in `video_steps`. **Why:** the orchestrator updates `current_step` on best-effort for the list view, but workflow re-ordering and orphan filtering happen in `stepsRepo.findByVideo` — trusting `current_step` in the detail view would render a step that may no longer be in the active workflow.

- **`delete_requested=1` is a soft-delete flag.** A flagged video still exists in the DB until the orchestrator tears it down at the next step boundary; do not filter it out of list responses. **Why:** the UI needs the row to show the "Deleting…" indicator, and dropping it client-side would make the row appear to vanish before the worker has actually stopped.

- **Predicates are the eligibility contract — don't inline `status === ...` comparisons.** Lifecycle methods, routes, and UI helpers all consume the same `videoPredicates` (and the shared `canX` helpers that compose them with UI-only narrowing). **Why:** the three layers exist precisely so the rules round-trip; inlining a status check in one surface without updating the predicate splits the contract and produces an action that the server accepts but the UI hides (or vice versa).

- **`getVideosPageState` is the single source of polled state — don't fan out reads across the page and the API route.** `BannerFlags` is the grouping convention for operator-facing flags surfaced through the videos poller. **Why:** the page server-fetch (initial SSR) and the videos GET (poll response) must produce identical projections; routing both through the helper guarantees that. Adding a banner field with a parallel setting read on the server component (or a sibling banners route) splits the contract and produces a flicker on mount when the polled payload finally arrives with a different shape.

- **Server components block on `better-sqlite3`.** Repo calls in server components run synchronously and block the render. **Why:** fine for a single-operator dashboard, but if multi-user concurrency ever lands, page-level fetches need to move to async/concurrent reads; treat any new page as "blocks the worker briefly per request".
