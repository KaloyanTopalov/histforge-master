# Per-Video, Per-Account Google Flow Project Folders

## Overview

The YouForge Flow extension currently couples task dispatch to whichever
Flow project the operator happens to have open in the labs.google tab —
`extensions/youforge-flow/src/auth.js:116` (`getProjectIdCached`) reads
the id off the URL or a `searchUserProjects` trpc call. Two consequences
fall out of that coupling:

1. **No-project crash loop.** With no Flow project open, every dispatch
   throws "Failed to get project ID" at
   `extensions/youforge-flow/src/executors/index.js:53`. HistForge's
   submit-result classifier treats it as a `transient` error
   (`src/app/api/flow/submit-result/[token]/route.ts:52-58`), so each
   stranded task burns its `retry_count` — a setup mistake masquerades as
   compute failure.
2. **One-folder pile-up.** All generated images and hook videos for
   every video land in whichever project the operator happened to leave
   open. Operators can't visually confirm "this video's outputs look
   right" without cross-referencing chunk_id naming conventions.

## Operator-confirmed constraints (driving the design)

These shaped the data model — read before reading the file-by-file:

- **Multi-account, parallel.** Multiple HistForge `google_flow_accounts`
  rows are enabled simultaneously and the queue is intentionally
  account-agnostic at claim time (`takeNextTaskForAccount` in
  `src/lib/repos/google-flow.ts:241` filters only on `q.status='pending'`
  + `v.paused=0`). Tasks for one video can be claimed by different
  accounts over the video's lifetime.
- **Per-account project folders.** Account A's Flow workspace cannot see
  project IDs minted under account B's Google identity. So each (video,
  account) pair needs its own Flow project. Mental model: every account
  that touches video V has its own folder for V.
- **One Google account per Chrome profile, never switched.** Each
  HistForge `google_flow_accounts` row corresponds to exactly one Chrome
  profile, and that profile stays logged into exactly one Google
  identity. We don't defend against profile cookie-switching.
- **No Google-side cleanup.** Local-side cleanup (the
  `google_flow_video_projects` table) cascades on hard-delete; Flow
  projects on Google's side stay forever. The captured `deleteProject`
  payload is documented but not implemented (see appendix).
- **`getProjectIdCached` is dead.** The new flow makes it irrelevant;
  remove it (and `cachedProjectId`) outright.

## Architectural shape

A new table `google_flow_video_projects` with composite PK `(video_id,
account_id)` stores the per-pair project ID. The next-task route reads
the row scoped to *the account claiming the task right now*. The
extension creates a project (named after the video title, newlines
stripped) on first dispatch when the field comes back null, then reports
the new id back via a new HistForge webhook.

Phase 1 lands the create flow end-to-end. Phase 2 is the local cleanup
story — implemented entirely by the FK CASCADE in Phase 1's CREATE
TABLE statement; there is no separate code or PR for Phase 2. Phase 3
surfaces creation failures on the dashboard.

---

## Phase 1 — Per-(video, account) project creation, end-to-end

### Phase 1, file-by-file

#### `src/lib/db.ts`

- Add a new `CREATE TABLE IF NOT EXISTS google_flow_video_projects`
  block alongside the other `CREATE TABLE` blocks:

  ```sql
  CREATE TABLE IF NOT EXISTS google_flow_video_projects (
    video_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    flow_project_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (video_id, account_id),
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );
  ```

  Notes:
  - `ON DELETE CASCADE` only on the video FK. Account-row deletes leave
    the rows in place (orphans, per operator decision). FK enforcement
    is already enabled (`db.pragma("foreign_keys = ON")` at line 84) so
    the cascade fires.
  - **No FK to `google_flow_accounts`.** A FK with no cascade would
    block account deletion when projects exist; a FK with cascade would
    delete the rows the operator wants kept as orphan-pointers. Skip the
    FK; treat `account_id` as a soft reference. (The existing
    `google_flow_queue.assigned_account_id` column has no FK either —
    same reasoning, same precedent.)
  - No additive `ALTER TABLE` migration needed because this is a brand
    new table — `CREATE TABLE IF NOT EXISTS` is idempotent.

- **Do NOT** add a column to `videos`. The earlier draft of this plan
  proposed `videos.flow_project_id`; that's wrong for the multi-account
  model.

#### `src/types.ts`

- Add a new exported interface mirroring the table:

  ```ts
  export interface GoogleFlowVideoProject {
    video_id: string;
    account_id: string;
    flow_project_id: string;
    created_at: number;
  }
  ```

  Place near the existing `GoogleFlowAccount` and `GoogleFlowQueueItem`
  interfaces. No change to `Video`.

#### `src/lib/repos/google-flow.ts`

Add four helpers near the queue helpers (the file's existing structure
has accounts at the top, queue below — append a "video projects" section
after queue):

- `findFlowProjectForAccount(db, videoId, accountId): GoogleFlowVideoProject | undefined`
  — single `SELECT * FROM google_flow_video_projects WHERE video_id=? AND account_id=?`.

- `upsertFlowProjectForAccount(db, videoId, accountId, flowProjectId, nowUnix): { inserted: boolean; existingProjectId: string | null }`
  — uses `INSERT INTO ... VALUES (?, ?, ?, ?) ON CONFLICT(video_id, account_id) DO NOTHING`,
  then reads back. Returns `{inserted: true, existingProjectId: null}`
  on first write; `{inserted: false, existingProjectId: <existing>}` on
  PK conflict. The route uses `inserted` to decide whether to log the
  conflict.

- `clearFlowProjectForAccount(db, videoId, accountId): void`
  — single `DELETE FROM google_flow_video_projects WHERE video_id=? AND account_id=?`.
  Called by the `stale_project_id` classifier branch in submit-result
  when the operator deletes a Flow project manually. Next dispatch
  re-creates.

- `listFlowProjectsForVideo(db, videoId): GoogleFlowVideoProject[]`
  — observability/Phase 3 dashboard. Single `SELECT * WHERE video_id=?`.

Reasoning for putting these in `google-flow.ts` rather than a new repo
module: the table is part of the Google Flow domain, and the file's
docstring already scopes it to "accounts + queue tables" — extending it
to the video-projects table is a small, in-domain expansion.

#### `src/app/api/flow/next-task/[token]/route.ts`

- After `takeNextTaskForAccount` returns the claimed row, do **two** repo reads:
  1. `videosRepo.findById(db, claimed.video_id)` — for the title.
  2. `gfRepo.findFlowProjectForAccount(db, claimed.video_id, account.id)`
     — for the existing per-account project id (or undefined).

  Both reads happen inside the existing transaction (lines 90-102).

- Extend the dispatched payload (`shapeTaskForExtension`) with three
  new fields:

  - `flowProjectId: existingProject?.flow_project_id ?? null`
  - `videoId: row.video_id`
  - `projectTitle: video.title`

  Existing fields stay untouched. Extension's poll-response parser is
  permissive (skill rule), so adding fields is safe.

#### NEW: `src/app/api/flow/project/[token]/route.ts`

- Mirror `src/app/api/flow/status/[token]/route.ts` structure: same
  `resolveFlowAccount` gate, same Zod-then-handle flow.

- Zod schema:

  ```ts
  const ProjectCreatedSchema = z.object({
    type: z.literal("ProjectCreated"),
    accountToken: z.string().min(1),
    videoId: z.string().min(1),
    projectId: z.string().min(1),
    projectTitle: z.string().min(1),
  });
  ```

- Handler:

  ```ts
  const video = videosRepo.findById(db, parsed.videoId);
  if (!video) return NextResponse.json({error: "video_not_found"}, {status: 404});
  const result = gfRepo.upsertFlowProjectForAccount(
    db, parsed.videoId, account.id, parsed.projectId, now
  );
  if (!result.inserted && result.existingProjectId !== parsed.projectId) {
    console.warn(
      `[flow] project_id conflict for (${parsed.videoId}, ${account.id}): ` +
      `existing=${result.existingProjectId}, reported=${parsed.projectId} — keeping existing`
    );
  }
  return NextResponse.json({success: true});
  ```

- Does NOT gate on `account.enabled` — same precedent as `status` route
  (a disabled account can still report something it created).

- "First writer wins per (video, account)" is enforced by the table's
  composite PK + the `ON CONFLICT DO NOTHING` upsert. The webhook is
  idempotent: re-posting the same `(videoId, accountId, projectId)` is
  a no-op; posting a different projectId for an already-recorded pair
  logs a conflict but returns 200 (don't error — the SW one-shot has
  no retry, so the second-best behavior is "log it visibly and move on").

#### `src/app/api/flow/submit-result/[token]/route.ts`

- Extend `ResultSubmissionSchema` (lines 25-34) with the optional v2
  fields the extension sends (`webhook.js:226-243` — `errorCode`,
  `errorCategory`, `httpStatus`, `retryable`, `contentPolicyTag`,
  `correlationId`, `timings`, `schemaVersion`).

- **Change `handleError` signature** from
  `handleError(db, {task, account, errorText})` to
  `handleError(db, {task, account, parsed})` so the function can read
  the v2 fields directly. Update its single caller in the `POST`
  handler. Inside `handleError`, branch on `parsed.errorCategory`
  *before* falling through to the legacy string-based `classifyError`:

  | `errorCategory` | `errorCode` examples | Action |
  |---|---|---|
  | `create_project_failed` | `HTTP_4xx`, `CREATE_PROJECT_BODY_NOT_JSON`, `CREATE_PROJECT_SHAPE_UNEXPECTED`, `CREATE_PROJECT_NO_ID` | Pause account 24h. `setSetting("flow_create_project_failed", JSON.stringify({errorCode, httpStatus, taskId, when, accountId}))`. `requeueTask` **without** `bumpRetryCount`. |
  | `auth` (when from create-project) | `HTTP_401` | **No-op here** — the SW's `notifySessionExpired` already set `google_flow_relogin_needed` via the `session_expired` StatusEvent. Just `requeueTask` without bumping retry. Don't re-set the flag from this branch (avoid the dual-path redundancy). |
  | `stale_project_id` | `HTTP_404` from `/projects/<id>/...` URL | `clearFlowProjectForAccount(db, task.video_id, task.assigned_account_id)`. `requeueTask` **without** `bumpRetryCount`. Next dispatch creates a fresh project. |
  | `rate_limit` | `HTTP_429` | Existing quota branch (pause + requeue). |
  | `transient` | `HTTP_5xx`, `CREATE_PROJECT_NETWORK` | Existing transient branch (bumpRetryCount + requeue or fail). |
  | other / missing v2 fields | n/a | Fall through to legacy `classifyError`. |

- This makes "Google API drift broke our create flow" a *setup* error
  (no retry budget consumed; account paused; banner shows on
  dashboard). The operator fixes the parser, redeploys the extension,
  resumes the account, and the queue replays.

- **Stale-project-id recovery**: when a generation call (not the create
  call) returns 404 against a `/projects/<projectId>/...` URL, treat it
  as a sign that the operator manually deleted the Flow project in
  labs.google's UI. Detection lives at the **SW call site**, not in
  `parseFlowApiError` — the parser doesn't have the URL in scope, so
  it can't tell a "project not found" 404 apart from a "credits
  endpoint not found" 404. The override goes in:
  - `extensions/youforge-flow/src/page-call.js` `apiCallViaPage` —
    after `parseFlowApiError(fakeResponse, result.body)` returns, if
    `parsed.httpStatus === 404` and the request URL matches
    `/\/projects\/[^/]+\//`, set `parsed.category = 'stale_project_id'`
    before passing to `makeFlowApiError`.
  - `extensions/youforge-flow/flow-api.js` `_throwFlowApiError` — same
    override after `parseFlowApiError`.

  HistForge's classifier branch (in the table above) reads
  `parsed.errorCategory === 'stale_project_id'`, looks up the task by
  `parsed.taskId` → discovers `task.video_id` and
  `task.assigned_account_id` → calls
  `gfRepo.clearFlowProjectForAccount(db, videoId, accountId)` →
  `requeueTask` without bumping retry. Next dispatch's `flowProjectId`
  comes back null, the extension creates a fresh project. Recovery is
  silent and automatic.

#### `extensions/youforge-flow/src/auth.js`

- **Remove `getProjectIdCached` entirely.** Also remove `cachedProjectId`,
  `cachedProjectIdUrl`, `cachedProjectIdExpiry`, and `PROJECT_ID_TTL_MS`
  (lines 19-22). Nothing else in the codebase uses them after the
  executor switches to `getOrCreateProjectId`.

- The existing `getRecaptchaTokenFromPage`, `getSessionTokenFromPage`,
  `clearAuthCache`, `_isSessionExpiredErrorMessage` stay as-is.

- **Test impact**: `__tests__/unit/youforge-flow/auth.test.ts` has a
  `describe("getProjectIdCached", ...)` block (line 304) with ~8
  assertions covering URL extraction, trpc fallback, cache hit/miss,
  TTL expiry, and tab-switch invalidation. Delete the entire describe
  block. The mock module at `auth.test.ts:9` (`mod.getProjectIdCached`)
  also gets removed. Run `npm run test` after the change to confirm no
  other tests transitively depend on the helper.

#### NEW: `extensions/youforge-flow/src/project-mgmt.js`

This is the SW module that owns Flow project creation and the
per-videoId mutex.

- **Load order.** Add `importScripts('src/project-mgmt.js')` to
  `extensions/youforge-flow/background.js` *between* `auth.js` and
  `account-tier.js`. Forward refs (resolved at call time) include
  `safeLog`, `assertNotStopped`, `parseFlowApiError`, `makeFlowApiError`,
  `getAccountToken`, `getProjectUrl` (new — see settings.js below), and
  `postProjectCreated` (new — see webhook.js below).

- Module surface:

  ```js
  // Per-videoId in-flight create map. Keyed by videoId because each SW
  // serves exactly one HistForge account (one Chrome profile = one
  // account, by operator constraint). First dispatch for (this account,
  // this video) creates; concurrent dispatches await.
  const _inFlight = new Map(); // Map<videoId, Promise<string>>

  async function getOrCreateProjectId(task, ctx) { ... }
  async function _createFlowProject(tabId, projectTitle) { ... }
  function _sanitizeProjectTitle(raw) { ... }
  ```

- `getOrCreateProjectId(task, ctx)`:

  1. `assertNotStopped()` at entry (convention from `auth.js`,
     `page-call.js`).
  2. If `task.flowProjectId` is non-empty → return it.
  3. If `_inFlight.has(task.videoId)` → return that promise.
  4. Otherwise:
     ```js
     const p = (async () => {
       try {
         const title = _sanitizeProjectTitle(task.projectTitle || task.videoId);
         const newId = await _createFlowProject(ctx.tabId, title);
         await postProjectCreated({
           videoId: task.videoId,
           projectId: newId,
           projectTitle: title,
         });
         return newId;
       } finally {
         _inFlight.delete(task.videoId);
       }
     })();
     _inFlight.set(task.videoId, p);
     return p;
     ```

  The `finally` runs on success and failure. A rejection bubbles to all
  awaiters; the next dispatch (after rejection) re-enters with a fresh
  attempt. We don't poison the videoId on a single transient blip.

- `_createFlowProject(tabId, projectTitle)`:

  - `assertNotStopped()` at entry.
  - Run via `chrome.scripting.executeScript({world: 'MAIN', func: ...})`
    — the trpc endpoint is cookie-authenticated and only the labs.google
    page world has the right cookies.
  - **No timeout wrapping.** The existing `apiCallViaPage` pattern in
    `page-call.js` does not wrap MAIN-world fetches in any timeout
    (`AbortController` cannot cross world boundaries; `executeScript`
    has no built-in timeout). Match the existing convention; the
    upstream caller's overall task timeout absorbs hangs.
  - Request:
    - URL: `https://labs.google/fx/api/trpc/project.createProject`
    - Method: `POST`
    - `credentials: 'include'`
    - `Content-Type: application/json` (operator-confirmed)
    - Body: `JSON.stringify({json: {projectTitle, toolName: "PINHOLE"}})`
  - MAIN-world function returns
    `{ok, status, body, retryAfter}` envelope (mirror `apiCallViaPage`
    at `page-call.js:82-93`).
  - SW-side defensive parsing — order matters:

    | Condition | Throw |
    |---|---|
    | HTTP 401 | `makeFlowApiError({reason:'UNAUTHENTICATED', category:'auth', httpStatus:401, isSessionExpired:true, message:'SESSION_EXPIRED: createProject'})` — session-guard picks it up via the existing funnel. |
    | HTTP 429 | `makeFlowApiError({reason:'RESOURCE_EXHAUSTED', category:'rate_limit', httpStatus:429, retryAfterMs, message:'createProject 429'})`. **Call `triggerRateLimitCooldown(err)` at the throw site** (mirror `flow-api.js:_throwFlowApiError` and `page-call.js:apiCallViaPage`) so the runner backs off immediately rather than after the catch arm. |
    | HTTP 5xx | `makeFlowApiError({reason:'TRANSIENT', category:'transient', httpStatus, retryable:true, errorCode:'HTTP_'+status})` |
    | HTTP 4xx other | `makeFlowApiError({reason:'CREATE_PROJECT_FAILED', category:'create_project_failed', httpStatus, errorCode:'HTTP_'+status, retryable:false, message:'createProject HTTP '+status+': '+truncatedBody})`. **Log the truncated body** via `safeLog` so operators can diff against future schema changes. |
    | Body unparseable JSON | category `create_project_failed`, errorCode `CREATE_PROJECT_BODY_NOT_JSON`. Log first 500 bytes. |
    | Envelope shape unexpected (no `result.data.json.result.projectId`) | category `create_project_failed`, errorCode `CREATE_PROJECT_SHAPE_UNEXPECTED`. Log truncated body. |
    | `projectId` empty / non-string | category `create_project_failed`, errorCode `CREATE_PROJECT_NO_ID`. Log truncated body. |
    | `fetch` itself threw (network error) | category `transient`, errorCode `CREATE_PROJECT_NETWORK`, retryable true. |

    Defense in depth: this is the operator's stated risk — the trpc API
    is undocumented and can change. Every parsing branch logs enough to
    reconstruct what happened.

- `_sanitizeProjectTitle(raw)`:
  ```js
  // Operator confirmed: 250-char titles work, special chars OK, newlines
  // rejected by Google. Strip newlines (CR + LF) to space; otherwise
  // pass through. Also collapse runs of whitespace and trim, defensively.
  return String(raw || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 250) || 'Untitled video';
  ```
  The `|| 'Untitled video'` fallback covers the pathological case of a
  video with an all-whitespace title.

- **`clearInFlight()`** — top-level function (the SW uses `importScripts`
  with shared lexical scope, so no ES exports; just a globally-callable
  function). Body: `_inFlight.clear()`. Called from `messages.js`'s
  `stopAllProcessing` and `autoStopped` cases (next to the existing
  `clearCachedTier()` call) so a fresh start releases any outstanding
  create promises. Not a correctness issue (promises resolve naturally)
  but matches the cleanup symmetry of the rest of the SW.

#### `extensions/youforge-flow/src/webhook.js`

- Add `postProjectCreated({videoId, projectId, projectTitle})` next to
  `postStatusEvent` (lines 22-46):

  - URL from `getProjectUrl()` (new setting).
  - Body: `{type: 'ProjectCreated', accountToken, videoId, projectId, projectTitle, at: ISO}`.
  - Single `fetchWithTimeout(..., 15_000)` attempt. No retry — if the
    post fails, the SW logs and moves on. The next dispatch for the
    same video will re-enter `getOrCreateProjectId` with `task.flowProjectId`
    still null (because HistForge didn't record the create), create a
    fresh project, and try again. The orphan project on Google's side
    is acceptable per operator policy.
  - If `getProjectUrl()` is empty, skip the post entirely with a single
    `safeLog` warning. This is the migration window — operator hasn't
    yet configured the new URL in the popup.

- The existing `submitFailure` (line 201) already forwards the v2 fields
  including `errorCategory: 'create_project_failed'`. No changes needed
  to that function — `project-mgmt.js`'s thrown errors flow through it
  cleanly.

#### `extensions/youforge-flow/src/settings.js`

- Add `projectUrl` to the memoized cache, getter `getProjectUrl()`, and
  extend `updateWebhooks(message)` to read `message.projectUrl`. Mirror
  pattern from existing `pollUrl` / `resultUrl` / `statusUrl`.
- `messages.js:117` (`updateWebhooks` case) is already a one-line
  delegate — no change there.

#### `extensions/youforge-flow/popup.html` + `popup.js`

- Add a fourth webhook input row labeled "Project URL". The popup.js
  `saveConfig` already builds the webhook map for `updateWebhooks` —
  extend it to include `projectUrl`.
- **Extend `histforgeOrigin()` (popup.js:141)** to include
  `els.projectUrl.value` in the URL list it walks. Otherwise an
  operator who fills only the Project URL during reconfiguration would
  get the host-permission gate confused.
- **Extend `refreshEnabled()` (popup.js:197-205)** to add
  `els.projectUrl.value.trim()` to the `fieldsFilled` check. The Start
  button stays disabled until all four URLs are configured. This
  closes the migration window described in the Sequencing section —
  the operator literally cannot Start without a Project URL.

#### `extensions/youforge-flow/src/executors/index.js`

- `buildExecutorContext` lines 50-54: replace the
  `getProjectIdCached(tabId)` block with:

  ```js
  // Per-(video, account) Flow project. HistForge's next-task payload
  // tells us either:
  //  - flowProjectId set: already created for this (video, this account);
  //    reuse it.
  //  - flowProjectId null: first dispatch for this (video, account);
  //    create a fresh project, named after the video, and report the
  //    new id back to HistForge so subsequent dispatches reuse it.
  // The mutex inside getOrCreateProjectId stops N concurrent dispatches
  // for the same video from each creating duplicate projects in one SW.
  const projectId = await getOrCreateProjectId(task, { tabId });
  ```

- The new call needs only `tabId` (creation runs in MAIN world via
  cookies, no authToken needed for trpc). Place it after
  `getSessionTokenFromPage` for ordering parity with the prior code.

#### `extensions/youforge-flow/src/runner.js`

No code changes. Specifically: do NOT add `flowProjectId` or `videoId`
checks to `validateTask` — a missing `flowProjectId` is the normal
first-dispatch case; a missing `videoId` is unusual but the existing
parser permissiveness rule applies.

#### `extensions/youforge-flow/src/handlers.js`

No changes. `submitFailure(task, errorOrMessage)` already forwards
structured Errors with `.category` etc. through schema-v2.

#### `extensions/youforge-flow/src/messages.js`

- Extend the `stopAllProcessing` case (currently calls
  `clearCachedTier()`) with one more line: `clearInFlight();`.
- Same addition in the `autoStopped` case.
- The router's "switch-only by design" rule is preserved — this is a
  one-line delegate to a named function in the owning module, same
  pattern as the existing `clearCachedTier()` call.

#### `extensions/youforge-flow/background.js`

- Add `importScripts('src/project-mgmt.js')` between `auth.js` and
  `account-tier.js`. project-mgmt depends on `safeLog`,
  `assertNotStopped`, `parseFlowApiError`, `makeFlowApiError`,
  `getAccountToken`, `getProjectUrl`, `postProjectCreated`, and
  `triggerRateLimitCooldown` — all of which load earlier or are
  resolved at call time per the leaves-first convention.

#### `extensions/youforge-flow/src/self-test.js`

- Add an eighth check: `projectUrl`. `pingHistForge('projectUrl', getProjectUrl, checks)`. Mirror the pattern at lines 88-90.

  This catches the "operator forgot to configure the new URL" failure
  mode at its earliest possible moment (before pressing Start).

### Phase 1, race-condition analysis

Under the new (video, account) PK, the surfaces are:

1. **Two concurrent dispatches for the same video, same SW (= same
   account, by the one-account-per-profile constraint).** The SW's
   `_inFlight` mutex catches it: one dispatch runs the create + post,
   the other awaits the same promise. Both end up with the same
   projectId. Only one trpc call, only one HistForge post.

2. **Two concurrent dispatches for the same video, different SWs (=
   different accounts).** Each SW runs its own create + post. Each
   account ends up with its own Flow project. HistForge stores both
   rows in `google_flow_video_projects` because the PK is `(video_id,
   account_id)` — they don't conflict. **This is the intended
   behavior.**

3. **SW dies after trpc create but before postProjectCreated.** The Flow
   project exists in Google but HistForge doesn't know. Next dispatch
   for the same (video, this account) enters `getOrCreateProjectId`
   with `task.flowProjectId === null` → creates a *second* project,
   posts that one. Orphan in Flow. Acceptable per operator policy
   (no Google-side cleanup).

4. **SW dies after postProjectCreated but before executor returns.**
   The reaper (`flow-watcher.ts`) requeues the dispatched task after
   `google_flow_dispatch_timeout_minutes`. Next dispatch carries the
   stored `flowProjectId`. **No duplicate.** Common case.

5. **HistForge `upsertFlowProjectForAccount` runs but PK already exists
   with a different projectId** (e.g., from a previous dropped report).
   `ON CONFLICT DO NOTHING` keeps the existing row. The route logs the
   conflict and returns 200. The extension's *current* dispatch keeps
   using its newly-created projectId for *this* task, but next dispatch
   for the same (video, account) will receive the (old, stored) id from
   `findFlowProjectForAccount` — so generation will switch projects.
   That's mildly weird but not broken: the current task's outputs land
   in the new (orphan) project, future tasks land in the old one.

   **If you want strict consistency**, change the conflict handling to
   `ON CONFLICT DO UPDATE SET flow_project_id = excluded.flow_project_id`
   — last writer wins. But that has a worse failure mode: if SW B is
   misconfigured and races SW A, it clobbers A's project mapping.
   Current plan stays with first-writer-wins. Operator can revisit.

### Phase 1, error taxonomy

Summary of the classifier table above (full table at line ~227 in
the submit-result section). Key points:

- **`create_project_failed`** is a HistForge-side classifier branch
  that **does not consume retry_count** and **pauses the account 24h**.
  This protects you from burning retry budgets when the trpc envelope
  shape changes — the queue stops dispatching to the broken account
  until you redeploy the extension parser.
- **`auth`** (401 from create): the SW's `notifySessionExpired` path
  sets `google_flow_relogin_needed` via the `session_expired`
  StatusEvent — the submit-result `auth` branch is intentionally a
  no-op on the flag (just `requeueTask` without bumping retry). The
  flag *does* end up set, just from the StatusEvent side, not the
  result-submission side. Operator re-logins at labs.google to recover.
- **`stale_project_id`** (404 from `/projects/<id>/...` URL): operator
  manually deleted the Flow project. Submit-result branch wipes the
  (video, account) row in `google_flow_video_projects`, requeues
  without bumping retry. Next dispatch creates a fresh project.
- **`rate_limit`** (429 from create) hits the existing quota branch:
  pause account, requeue task. Retry-After header honored.
- **`transient`** (5xx, network) goes to the legacy transient branch:
  bump retry, requeue or fail.

### Phase 1, test plan

Vitest patterns: `__tests__/api/flow/next-task/[token]/route.test.ts`,
`__tests__/unit/lib/repos/google-flow.test.ts` (if exists; otherwise
mirror the videos repo tests).

#### Repo tests — extend `__tests__/unit/lib/repos/google-flow.test.ts`

- `findFlowProjectForAccount returns undefined when no row exists`.
- `upsertFlowProjectForAccount on first call inserts and returns {inserted:true}`.
- `upsertFlowProjectForAccount on second call with same args is idempotent (no error, returns {inserted:false, existingProjectId: <same>})`.
- `upsertFlowProjectForAccount with different projectId for same (video, account) keeps existing (returns {inserted:false, existingProjectId: <old>})`.
- `clearFlowProjectForAccount removes the row for (video, account)`.
- `clearFlowProjectForAccount on a non-existent (video, account) is a no-op (no throw)`.
- `listFlowProjectsForVideo returns all per-account rows for the video`.
- `hard-deleting a video cascades the rows` (covers Phase 2's only mechanism).
  Seed video + 2 rows. Delete video. Assert rows gone.
- `hard-deleting an account leaves rows in place` (orphan-by-design).

#### Schema test — extend `__tests__/unit/lib/db.test.ts`

- `google_flow_video_projects table exists on a fresh DB`.
- `composite PK (video_id, account_id) rejects duplicate inserts`.
  Insert once, expect an UNIQUE constraint failure on second insert
  with same key.
- `ON DELETE CASCADE from videos fires`.

#### Next-task route — extend
`__tests__/api/flow/next-task/[token]/route.test.ts`

- `dispatched payload includes flowProjectId from the (video, account)
  row when present`. Seed account A + video V + project mapping (V, A,
  "proj-A"). Enqueue task. POST as account A. Assert `flowProjectId:
  "proj-A"`.
- `dispatched payload includes flowProjectId: null when no mapping
  exists for (video, claiming account)`. Seed account A + video V (no
  mapping for A). Enqueue task. POST as A. Assert `flowProjectId: null`.
- `dispatched payload includes flowProjectId: null even if a mapping
  exists for a DIFFERENT account`. Seed account A + B + video V +
  mapping (V, B, "proj-B"). Enqueue task. Account A claims it. Assert
  `flowProjectId: null` — A doesn't get B's project.
- `dispatched payload includes videoId and projectTitle`.

#### Project webhook — NEW
`__tests__/api/flow/project/[token]/route.test.ts`

- 401 token-mismatch / 404 unknown-token / 404 video-not-found cases
  (mirror status route's existing test patterns).
- `200 + persists row on first call`. Seed account A + video V. POST
  `ProjectCreated` for (V, A, "proj-1"). Assert
  `findFlowProjectForAccount(db, V, A) === "proj-1"`.
- `200 + idempotent on repost with same id`. Seed mapping (V, A,
  "proj-1"). POST same. Assert 200, mapping unchanged.
- `200 + first-writer-wins on different id` (the warning-log path).
  Seed mapping (V, A, "proj-1"). POST (V, A, "proj-2"). Assert 200,
  mapping is still "proj-1". (Use a console-spy or skip the log assertion
  if the test infra doesn't support it.)
- `200 + creates separate rows for different accounts on same video`.
  POST (V, A, "proj-A"). POST (V, B, "proj-B"). Assert two rows,
  unrelated.

#### Submit-result classifier — extend
`__tests__/api/flow/submit-result/[token]/route.test.ts`

- `errorCategory: create_project_failed pauses the account 24h,
  requeues the task without bumping retry_count, sets the
  flow_create_project_failed setting`. (Note: does NOT set
  google_flow_relogin_needed — that's the StatusEvent path's job for
  401-auth, not this branch's.)
- `errorCategory: auth requeues without bumping retry and does NOT
  re-set google_flow_relogin_needed` (the SW's notifySessionExpired
  StatusEvent already set it; the submit-result branch is intentionally
  a no-op on the flag).
- `errorCategory: stale_project_id clears the (video, account) row in
  google_flow_video_projects and requeues without bumping retry`.
  Seed account + video + a (video, account) row in
  google_flow_video_projects + a dispatched task. POST a v2 failure
  with errorCategory='stale_project_id'. Assert the row is gone, task
  status is pending, retry_count unchanged.
- `errorCategory missing falls back to legacy classifyError` (back-compat).

#### Self-test — extend
`__tests__/unit/extensions/youforge-flow/self-test.test.ts` (if
present; otherwise note as a manual check).

- `projectUrl pass when configured and reachable`.
- `projectUrl skip when not configured` (operator hasn't yet set it).

#### SW-side stale-project detection (page-call.js / flow-api.js)

If `__tests__/unit/youforge-flow/page-call.test.ts` exists, extend it
(otherwise add):

- `404 from /projects/<uuid>/... URL is categorized as stale_project_id`
  — mock the MAIN-world fetch to return 404, assert the thrown error
  has `category === 'stale_project_id'` and `httpStatus === 404`.
- `404 from a non-/projects/... URL stays as not_found / legacy
  category` — sanity check that the URL-based override is scoped.

#### Manual end-to-end checks (out of vitest)

- One-account, one-video happy path: dispatch a task, confirm a Flow
  project is created and named after the video.
- Two-account, one-video happy path: pause account B briefly, dispatch
  one task (claimed by A), creates project P_A. Resume B, pause A,
  dispatch another task (claimed by B), creates project P_B. Confirm
  two distinct Flow projects exist (one per account), each named after
  the video.
- API-drift simulation: change the parser to mismatch (e.g., look for
  `result.data.json.result.fakeId`). Dispatch a task. Confirm
  `create_project_failed` shows up on the dashboard banner (Phase 3),
  account is paused, task is requeued without retry_count bump.

### Phase 1, migration strategy

- Brand-new table `google_flow_video_projects`. No backfill.
- Existing in-flight videos: their next dispatch reads
  `flowProjectId: null`, the extension creates a fresh project under
  the claiming account. The Flow project the operator was using up to
  this point is orphaned in Google Flow. Per operator policy, that's
  fine.
- Existing finished videos: no further dispatches; the table stays
  empty for them. Fine.

---

## Phase 2 — Local cleanup on hard-delete

**No Google-side delete calls.** Per operator decision, Flow projects
on Google's side stay forever; cleanup is local only.

The FK `ON DELETE CASCADE` on `google_flow_video_projects.video_id`
gives us this for free. When `videosRepo.deleteVideoFullyRemoved`
(verified at `src/lib/repos/videos.ts:341`, `DELETE FROM videos WHERE
id = ?`) runs, the cascade fires and any rows in
`google_flow_video_projects` for that video are dropped.

### Phase 2, code changes

**None — the cascade is the entire mechanism.** The cascade test
listed in Phase 1's repo test plan (`hard-deleting a video cascades
the rows`) is the only verification needed and lands with Phase 1.

This phase exists as a separate header purely to mark "Google-side
cleanup intentionally not implemented" as a deliberate operator
decision, not an oversight. There is no separate PR for Phase 2.

---

## Phase 3 — Dashboard surface for create-project failures

Surfaces the `flow_create_project_failed` setting (single source) so
an API-drift incident is visible without grepping SW logs.
`google_flow_relogin_needed` is intentionally **not** included in this
banner — that flag has its own existing dashboard handling and
conflating the two would muddle the operator's mental model
("re-login at labs.google" is a different remediation than "fix the
parser and redeploy the extension").

### Phase 3, file-by-file (sketch)

- `src/app/page.tsx` (or whichever is the home dashboard — verify):
  add a banner that reads only the `flow_create_project_failed`
  setting. When truthy, render a red bar:

  > "Flow project creation is failing. Check the YouForge Flow
  > extension service-worker logs at chrome://extensions and verify
  > the trpc envelope hasn't drifted. Last failure: `<errorCode>` at
  > `<timestamp>` for account `<accountId>`."

  Banner has a Dismiss button that clears
  `flow_create_project_failed` only.

- New route: `POST /api/flow/clear-create-project-failed`. Sets the
  setting to "". **Dashboard-internal route — no token gate**, same
  origin protection as `/api/flow/accounts` and other dashboard-only
  endpoints. (Token-gated routes are reserved for the extension; this
  is operator-clicks-Dismiss, called from the dashboard's own browser
  session.)

- Read of the setting: piggyback on the existing settings exposure
  (`/api/settings/route.ts` already returns the bag).

### Phase 3, test plan

- One route test for the dismiss endpoint (no token; just POST and
  assert the setting cleared).
- Component test for the banner rendering when the setting is
  populated, hiding when empty.

---

## Sequencing

Phase 1 lands as one PR. Deploy in this order:

1. Merge HistForge changes (db migration, repo helpers, two new routes
   — project webhook + submit-result classifier extension — and
   next-task payload extension). Update `docs/setup-google-flow.md`
   in the same PR to mention the new "Project URL" setting.
2. The schema migration runs implicitly on `getDb()`, no manual step.
3. Operator reloads the extension via `chrome://extensions`.
4. Operator sets the new "Project URL" in the popup. **Start button is
   disabled until this is filled** (`refreshEnabled()` change above)
   so there's no window where the extension dispatches without
   reporting.
5. Operator clicks Test Connection — confirms the new `projectUrl`
   self-test check is green.
6. Operator presses Start.

Phase 2 has no work — it ships with Phase 1 because the FK is part of
the schema. (Listed separately for clarity.)

Phase 3 ships any time after Phase 1 (independent).

### Documentation

`docs/setup-google-flow.md` exists in this repo and currently
documents the three-webhook configuration. Update it as part of the
Phase 1 PR with:

- Mention of the new fourth URL (Project URL → `/api/flow/project/<token>`).
- A note that the Start button is gated on all four being configured.
- A note that operators no longer need to manually open a Flow project
  in the labs.google tab before pressing Start (the old constraint).

---

## Risks

1. **All-accounts-paused queue stall on API drift.** This is the
   single most plausible operator-facing failure mode after this lands.
   When Google changes the trpc createProject envelope, every account
   hits `create_project_failed` on its first dispatch attempt; each
   gets paused 24h by the classifier. Within minutes, every enabled
   account is paused and the queue silently stalls. The dashboard
   banner (Phase 3) is the operator's only visible signal. Mitigations:
   ship Phase 3 alongside Phase 1 if at all possible; the banner makes
   the difference between "queue mysteriously stops" and "queue stops
   for a clear, named reason." The captured-body logs in the SW console
   give the operator the exact data they need to fix the parser.

2. **Google API drift on createProject (parsing only).** Even if not
   all accounts pause simultaneously (e.g. a partial drift that affects
   some response shapes but not others), parsing failures still log
   truncated bodies and surface `create_project_failed`. Same fix path
   as Risk 1.

3. **Stale projectId from manual deletion.** Operator deletes a Flow
   project in labs.google's UI; HistForge still has the id. Generation
   calls return Google's "project not found" error. The
   `stale_project_id` classifier branch (added in Phase 1's submit-
   result section) wipes the (video, account) row and requeues — next
   dispatch creates a fresh project. Recovery is automatic; the
   operator only needs to know the recovery happens silently to avoid
   confusion.

4. **Operator forgets to set Project URL.** Mitigated by the Start-
   button gate (`refreshEnabled()` change in popup.js): operator
   literally cannot Start without filling all four URLs.

5. **Cookie-switching in a Chrome profile.** If the operator logs into
   a different Google account in the same Chrome profile, the trpc
   create call goes to whichever Google identity is currently active
   in cookies, but HistForge records it against the HistForge
   `account_id` of the extension instance. Silent misconfiguration.
   Out of scope for v1 — operator constraint says "one Google account
   per Chrome profile, never switched."

6. **Increased trpc traffic.** Today ~zero; new flow is ~one create
   per (new video, each account that touches it). Negligible.

---

## Appendix: captured deleteProject payload (NOT IMPLEMENTED)

Captured live from DevTools 2026-04-25, kept here as future reference.
Phase 2 deliberately does not call this endpoint — operator policy is
to leave Google-side projects in place forever.

If the policy ever changes, the implementation would parallel
`_createFlowProject`:

- URL: `https://labs.google/fx/api/trpc/project.deleteProject`
- Method: `POST`
- `credentials: 'include'`
- `Content-Type: application/json`
- Body:
  ```json
  {"json":{"projectToDeleteId":"a0848bb5-304c-4889-9071-3b531c7ad861"}}
  ```
- Response (success):
  ```json
  {"result":{"data":{"json":{"result":{},"status":200,"statusText":"OK"}}}}
  ```

The trigger point would be hard-delete of a video: before the FK cascade
drops the `google_flow_video_projects` rows, iterate them and enqueue
one `mode:'deleteProject'` queue row per (video, account) so each
account's extension fires the corresponding trpc delete. Failures are
logged and dropped — orphans are acceptable.

---

## Appendix: open questions resolved by operator

- **Multi-account scope**: queue is account-agnostic at claim time;
  expected behavior; new table supports it natively. (Q1, Q2)
- **No video-to-account pinning**: parallelism preserved at the cost
  of one Flow project per (video, account) pair. (Q3)
- **Local cleanup only on hard-delete**: FK CASCADE handles it. (NewQ1)
- **Account removal leaves orphans**: no FK to `google_flow_accounts`.
  (NewQ2)
- **`getProjectIdCached` removed entirely**: dead code. (Q4 in revision round)
- **deleteProject payload documented but unused**: appendix above.
  (Q5 in revision round)
- **One Google account per Chrome profile**: assumed, not defended in
  code.
- **Title sanitization**: strip newlines, collapse whitespace, 250-char
  cap, fallback "Untitled video". (Q7)
- **Content-Type for createProject**: `application/json`. (Q5)
- **toolName for non-image modes**: deferred — assume `PINHOLE` for
  v1; revisit if hook-video generation hits problems. (Q6)
