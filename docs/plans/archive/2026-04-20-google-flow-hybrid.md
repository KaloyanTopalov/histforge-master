# Google Flow via Forked Extension (Hybrid Executor Pattern)

## Overview

Implement Google Flow image and video generation by forking the third-party
`VEO API Extension` into HistForge as **YouForge Flow**, stripping its
Baserow / n8n / remote-control baggage, and pointing it at HistForge
webhook endpoints. HistForge owns the task queue, per-account quota state,
and result storage; each Chrome profile runs one instance of the forked
extension, parked on a different Google account. Target workload:
~900 video clips per project, spread across up to 4 accounts, each
capped at ~300/day by Google.

The Playwright path (spec §12b) is abandoned: real Chrome sessions dodge
anti-bot risk, and routing logic lives entirely in HistForge instead of
being split across n8n/Baserow/extension storage. When every account is
simultaneously in cooldown, the Flow step **yields** back to the
orchestrator so other videos can progress — paused videos are resumed by
a watcher when any account becomes available.

## Current State

### Existing scaffolding to replace
- **Stub steps** throw "not yet implemented":
  - `src/worker/steps/generate-main-images-google-flow.ts:8`
  - `src/worker/steps/generate-hook-video-google-flow.ts:9`
- **Workflow already registered**: `src/worker/workflows/index.ts:44-56`
  wires `google-flow` into the registry. Slug validation at
  `src/worker/steps/index.ts:50`.
- **Existing Google Flow settings**:
  - `google_flow_profile_path` (`src/lib/settings.ts:19`) — Playwright-era,
    **remove**.
  - `google_flow_relogin_needed` (`src/lib/settings.ts:22`) — repurpose.
- **Spec §12b** (`docs/histforge-spec.md:588-594`) defers Flow and assumes
  Playwright. Needs a rewrite.

### Patterns to mirror
- **Image provider interface**: `src/lib/image/types.ts:3` — single method
  `generateBatch(items, targetDir, opts)`. Google Flow won't register a
  provider (the step is "enqueue and wait", not "call and return").
- **Hook video shape**: `src/worker/steps/generate-hook-video-comfyui.ts:29-53`
  — `(id, prompt)[] → mp4 files at videos/hook/<chunk_id>.mp4`.
  YouForge Flow matches this interface so nothing downstream changes.
- **SQLite schema**: `CREATE TABLE IF NOT EXISTS` blocks in
  `src/lib/db.ts:80-109`. `ALTER TABLE ADD COLUMN` wrapped in try/catch
  for additive migrations — see
  `docs/plans/2026-04-20-pause-resume-feature.md` for the precedent.
- **Settings**: per-key Zod in `SETTING_SCHEMAS` (`src/lib/settings.ts:12-56`),
  defaults in `DEFAULT_SETTINGS` (`src/lib/db.ts:11-36`), tab binding in
  `TAB_FIELDS` (`src/app/settings/settings-form.tsx:42-68`).
- **API routes**: public (no auth middleware). Zod body validation,
  `getDb()`, `db.transaction()`. See `src/app/api/videos/route.ts` for
  POST pattern. Flow webhooks gate on token in URL path + token in body.
- **Repos**: thin SQL wrappers — see `src/lib/repos/steps.ts`. Orchestration
  done in caller.
- **Step contract** (`src/worker/pipeline.ts:50`): `run(videoId, ctx):
  Promise<void>`. We extend this to `Promise<void | DeferSignal>` where
  `DeferSignal = { deferred: true, retryAfter: number }`. The call site
  we wrap is at `src/worker/pipeline.ts:258`.

### Extension source (upstream)
- `extensions/veo-upstream/` — v12.7.0, `background.js` 3251 lines
  + `flow-api.js` 311 lines. **Stays in repo** as upstream reference for
  future diffs.
- **Keep**: `flow-api.js` (6 Flow endpoints), `recaptcha-hook.js`,
  `content.js`, `content-bridge.js`, the FIFO runner, content-policy
  detection, upsample code paths, ingredients/frames modes (dormant in
  v1).
- **Strip**: `UPDATE_SERVER` + `checkRemoteControl()` + its alarm
  (background.js:7-15, 1533-1591) — third-party remote-control channel.
  All Baserow code — manual-mode state, handlers, `BASEROW_API`.
  Hardcoded n8n webhook defaults. `downloader.html` / `downloader.js`.
  `Polling Workflow V3.json`. `GUIDE_*.html` and `VEO GEMINI ACC
  GUIDE.html` stay where they are as upstream reference.

## Scope

**Doing**
- Fork extension to `extensions/youforge-flow/` — stripped of Baserow,
  n8n, remote-control, dead permissions. Popup gets a per-instance
  **account token**, configurable concurrency (1-10, default 5), and an
  **optional host permission** flow for the HistForge host.
- Extension reports three event types to HistForge: task polls, result
  submissions, and status events (session expired / credits updates).
- New SQLite tables `google_flow_accounts` + `google_flow_queue` with
  `ON DELETE CASCADE` from videos. New `videos.deferred_until` column.
  New repo `src/lib/repos/google-flow.ts`.
- Three HistForge webhook endpoints consumed by the extension:
  `next-task/[token]`, `submit-result/[token]`, `status/[token]`.
- Account CRUD API + UI in Settings with per-account manual pause.
- Orchestrator change: steps can return a defer sentinel; pipeline sets
  `videos.deferred_until` and moves on. A reaper in the worker process
  resets stuck dispatches and clears defers when accounts come back.
- Replace the two stub worker steps with "enqueue chunks → poll → yield
  if stalled → resume on re-entry".
- Revised Google Flow settings: remove `google_flow_profile_path`, add
  model/quality/aspect/cooldown/retries.
- Unit tests for the new repo; integration tests for the three webhook
  routes.
- Updated spec §12b and a new `docs/setup-google-flow.md`.

**Not doing**
- Playwright browser automation.
- Upscale pipeline in v1 (extension code stays; HistForge doesn't wire
  it through).
- Image-to-video hook mode (text-to-video only; mirrors ComfyUI shape).
- Frames-mode (start + end image) videos.
- Automatic Google login — users sign in manually per Chrome profile.
- Migration of existing `google_flow_profile_path` values — setting is
  removed; users haven't been able to use it anyway.
- Chrome Web Store distribution — unpacked dev-mode only.
- Daily-cap quota model — **event-driven only**: pause on 429 or quota
  error, auto-resume when `paused_until < now`.
- Toolbar-icon badge, queue auto-prune, queue monitoring page (v1.5).
- Repo rename from HistForge → YouForge — tracked in a separate plan
  (see `docs/plans/2026-04-20-rename-to-youforge.md`).

## Tasks

### Phase 1: Fork the extension

- [x] **Task 1.1: Copy extension and rename**
  **Files**: `extensions/youforge-flow/` (new), copied verbatim from
  `extensions/veo-upstream/`
  **What**: Directory exists in-repo. `manifest.json` name becomes
  `"YouForge Flow"`, `version` `"0.1.0"`, `description` updated. Replace
  `logo.png` with `src/icons/youforge_logo.png` (copy into extension
  dir with the filename `logo.png` so existing references still resolve).
  For toolbar/store display, generate 16×16, 48×48, 128×128 variants
  (any image tool works — `sharp`, `imagemagick`, or an online
  converter) and wire them into manifest `icons` + `action.default_icon`
  as a size map; a single logo renders fuzzy at 48/128. Add a
  `README.md` in the extension directory explaining that this is a
  HistForge-owned fork, what was stripped, and how to load it unpacked.
  Upstream at `extensions/veo-upstream/` is untouched.
  **Context**: Upstream manifest at `extensions/veo-upstream/manifest.json`.

- [x] **Task 1.2: Strip remote-control and auto-update channels**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: Delete `UPDATE_SERVER` const, `lastRemoteCommandId`,
  `checkRemoteControl()`, the `chrome.alarms.create('remoteControl', ...)`
  registration and its branch in the alarm listener. No third party
  should be able to steer YouForge Flow.
  **Context**: Upstream call sites at
  `extensions/veo-upstream/background.js:7-15` (const),
  `:1530-1562` (function), `:1565` (alarm creation), `:1567-1571`
  (handler branch).

- [x] **Task 1.3: Strip Baserow manual mode**
  **Files**: `extensions/youforge-flow/background.js`, `popup.html`,
  `popup.js`, `manifest.json`
  **What**: Delete every manual-mode code path: state vars
  (`manualModeActive`, `manualModeTasks`, etc.), persistence functions
  (`saveManualModeState`, `restoreManualModeState`, `clearManualModeState`),
  handlers (`handleManualTaskComplete`, `handleManualTaskFailed`),
  the `BASEROW_API` constant, any `taskId.split('_')[0]` Baserow rowId
  parsing, and the corresponding popup tab/buttons. Remove
  `api.baserow.io` from `host_permissions`. Keep **only** the FIFO
  automated path (`pollForTasksFIFO` / `executeTaskViaAPIWithRetry` +
  `handleTaskCompletedFIFO`).
  **Context**: Upstream touchpoints —
  `extensions/veo-upstream/background.js:40-102` (state +
  persistence), `:2940-3250` (manual handlers), `:17` (BASEROW_API),
  `manifest.json:18`.

- [x] **Task 1.4: Strip unused files and manifest permissions**
  **Files**: `extensions/youforge-flow/` (deletions),
  `manifest.json`
  **What**: Delete `downloader.html` and `downloader.js` (Baserow
  artifact). Remove the `web_accessible_resources` entry that exposed
  `downloader.html`. Remove `downloads` permission. Remove
  `http://*/*` and `https://*/*` from `host_permissions` (both are
  catastrophically broad). Remove `https://n8n.n8nsamerjonas.de/*`.
  Keep `labs.google/*`, `aisandbox-pa.googleapis.com/*`,
  `storage.googleapis.com/*`. Remaining `permissions` after the cut:
  `storage`, `alarms`, `tabs`, `scripting`. Do **not** add
  `externally_connectable`.
  **Context**: Upstream manifest at
  `extensions/veo-upstream/manifest.json:6-52`. The downloader
  permission set (`downloads`) is only used by the deleted
  `downloader.js`.

- [x] **Task 1.5: Popup — 3 config fields + concurrency + status line**
  **Files**: `extensions/youforge-flow/popup.html`, `popup.js`,
  `background.js`
  **What**: Popup shows exactly: `pollUrl`, `resultUrl`, `statusUrl`
  (add — extension's new third endpoint), `accountToken` (password-style
  input, maskable), `concurrency` (number input, min 1, max 10,
  default 5), `Grant HistForge access` button (conditional — see 1.6),
  `Start` / `Stop` button, and a single status line:
  "Idle" / "Last poll: Ns ago · running task #N" / "Error: <short
  reason>". Persist all fields to `chrome.storage.local`. Disable
  `Start` until pollUrl + resultUrl + statusUrl + accountToken are all
  set **and** the HistForge host permission is granted. Write a tight
  inline `<meta http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self'; style-src 'self'">`
  in `popup.html`.
  **Context**: Upstream popup at
  `extensions/veo-upstream/popup.html` + `popup.js` for field
  patterns. Upstream `MAX_CONCURRENT` at background.js:27 becomes a
  per-instance setting sourced from storage.

- [x] **Task 1.6: Optional host permission for HistForge**
  **Files**: `extensions/youforge-flow/popup.js`, `background.js`,
  `manifest.json`
  **What**: Add `optional_host_permissions: ["<all_urls>"]` to manifest
  (Chrome restricts what can go here; `<all_urls>` is the standard
  escape hatch for "user will type in a host"). When a user saves a
  pollUrl/resultUrl/statusUrl pointing at a new host, popup extracts
  the origin and shows "Grant access to <origin>" button. Click →
  `chrome.permissions.request({ origins: ["<origin>/*"] })`. On grant,
  store origin alongside config and enable `Start`. On URL change to
  a new origin, re-show the Grant button. On explicit config reset,
  call `chrome.permissions.remove` for the stored origin.
  **Context**: Chrome's `optional_host_permissions` + `permissions.request`
  API. No upstream reference — this is a new capability.

- [x] **Task 1.7: Account token in every request; concurrency is local**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: Every outbound request to HistForge — poll body, result
  submission body, status events — includes `{accountToken}` in the
  body. The token is **also** in the URL path that the user
  configured (belt-and-suspenders). The concurrency setting is
  **extension-local only** (governs upstream `MAX_CONCURRENT` at
  background.js:27, referenced in polling lock logic) — do not send
  it to HistForge; HistForge tracks dispatch per-account independently.
  Load config via the existing `loadSettings()` path at
  background.js:129-145.
  **Context**: Upstream poll body at `:1822-1830` (`{type:
  "TaskRequest", mode}`) — now `{type: "TaskRequest", accountToken,
  mode}`. Submission body at `:2252-2260`.

- [x] **Task 1.8: Session-expiry signaling**
  **Files**: `extensions/youforge-flow/background.js`, `flow-api.js`
  **What**: Wrap Flow API calls in a check for 401 / missing
  `accessToken` / `/fx/api/auth/session` failure. When detected, POST
  once to `statusUrl` (the configured endpoint) with `{type:
  "StatusEvent", accountToken, event: "session_expired", at:
  <isotime>}`. Update popup status line to
  "Error: session expired — re-login needed". Halt polling until the
  next successful session fetch (then auto-recover silently).
  **Context**: Upstream session fetch at
  `extensions/veo-upstream/content.js:110-131`. Any API call
  receiving a 401 means the session is dead.

- [x] **Task 1.9: Credits polling**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: When polling is running, call `getCredits(authToken)`
  (upstream `flow-api.js:305`) on a 60-second interval. `authToken`
  comes from the existing session-fetch plumbing (`content.js:110-131`
  `getSessionToken`, bridged into background via `content-bridge.js`);
  this is already how Flow API calls get their bearer, so reuse the
  same path — `getCredits` in upstream isn't wired anywhere, so
  there's no existing call site to copy. POST to `statusUrl` with
  `{type: "StatusEvent", accountToken, event: "credits", credits: N,
  tier, serviceTier, sku, at: <isotime>}`. Failures (including
  session errors) are silent — don't spam the status endpoint; the
  next `session_expired` event will surface auth issues on its own.
  Stop the interval on `Stop` click.
  **Context**: `getCredits` already exists in the upstream flow-api.js,
  un-used by the upstream background.js.

- [x] **Task 1.10: Log redactor (`safeLog()`)**
  **Files**: `extensions/youforge-flow/background.js`,
  `flow-api.js`
  **What**: Add a `safeLog(...args)` helper that string-replaces
  `Bearer <hex>`, reCAPTCHA tokens (long Base64-ish strings
  following "token"), and the configured `accountToken` value with
  `<redacted>` in any string arg before forwarding to `console.log`.
  Replace every `console.log`/`console.error`/`console.warn` call in
  background.js and flow-api.js with `safeLog`. Keep upstream's
  verbosity — logs are valuable for first-pass debugging, they just
  can't leak secrets. Prefix every log with `[YouForge Flow]` (rename
  from upstream's `[VEO API]` / `[VEO FIFO]`).
  **Context**: Upstream logs bearer tokens on multiple paths — e.g.
  `extensions/veo-upstream/background.js:942-951` logs the
  upload headers in some error paths. The redactor is belt-and-braces.

- [x] **Task 1.11: One-time storage cleanup on install/upgrade**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: In `chrome.runtime.onInstalled`, remove upstream-era keys
  that would be stale (`manualModeState`, `jobQueue`, `processedJobIds`,
  `currentJobId`, `currentTask`, `waitingForReload`, `dismissedVersion`,
  `pendingRetryTask`). Users who load the fork into a profile that
  previously had upstream installed get a clean slate. Do **not**
  remove our own new keys (`pollUrl`, `resultUrl`, `statusUrl`,
  `accountToken`, `concurrency`, grantedOrigin).
  **Context**: Upstream's `chrome.runtime.onInstalled` listener at
  `extensions/veo-upstream/background.js:108-123` sets defaults.
  We reset those same keys but also clear the stale ones.

- [x] **Task 1.12: Stop flag on config/permission loss**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: If the HistForge host permission is revoked mid-run (user
  clicks away in chrome://extensions), detect via a failing fetch and
  halt polling. Set status line to "Error: HistForge host permission
  revoked". Require re-grant before resuming.
  **Context**: Chrome emits `chrome.permissions.onRemoved`. Hook it and
  set the globalStopFlag if the removed origin matches the configured
  host.

### Phase 2: HistForge schema + repo

- [x] **Task 2.1: `google_flow_accounts` table + type**
  **Files**: `src/lib/db.ts`, `src/types.ts`
  **What**: New table, columns: `id TEXT PRIMARY KEY` (short slug like
  `acc_01`), `name TEXT NOT NULL`, `token TEXT NOT NULL UNIQUE`,
  `quota_used_today INTEGER NOT NULL DEFAULT 0` (cumulative in current
  cooldown window, resets on un-pause), `paused_until INTEGER`
  (unix seconds, nullable), `last_seen_at INTEGER` (nullable),
  `credits INTEGER` (nullable — last reported), `credits_updated_at
  INTEGER` (nullable), `enabled INTEGER NOT NULL DEFAULT 1`,
  `created_at INTEGER NOT NULL`. No `quota_daily_limit` / `quota_reset_at`
  — event-driven only. Add `GoogleFlowAccount` type mirroring the
  columns.
  **Context**: Pattern per `src/lib/db.ts:80-109` (`CREATE TABLE IF NOT
  EXISTS`). Unix-seconds convention per `videos.created_at`.

- [x] **Task 2.2: `google_flow_queue` table + type**
  **Files**: `src/lib/db.ts`, `src/types.ts`
  **What**: Columns: `id INTEGER PK AUTOINCREMENT`, `video_id TEXT
  NOT NULL REFERENCES videos(id) ON DELETE CASCADE`, `chunk_id TEXT`,
  `kind TEXT NOT NULL` (`main_image` | `hook_video`), `mode TEXT NOT
  NULL` (`createImage` | `text` | `image` | `frames`), `prompt TEXT
  NOT NULL`, `reference_image TEXT`, `start_frame TEXT`, `end_frame
  TEXT`, `output_path TEXT NOT NULL` (relative to projects dir, e.g.
  `images/main/<chunk_id>.png`), `status TEXT NOT NULL` (`pending` |
  `dispatched` | `done` | `failed`), `assigned_account_id TEXT
  REFERENCES google_flow_accounts(id) ON DELETE SET NULL`,
  `external_task_id TEXT`, `result_url TEXT`, `error_reason TEXT`,
  `retry_count INTEGER NOT NULL DEFAULT 0`, `priority INTEGER NOT
  NULL DEFAULT 0`, `created_at INTEGER NOT NULL`, `dispatched_at
  INTEGER`, `completed_at INTEGER`. Add index on `(status, priority,
  id)`. Add `GoogleFlowQueueItem` type.
  **Context**: `createDb` at `src/lib/db.ts:69-127`. `PRAGMA
  foreign_keys = ON` is already active at `src/lib/db.ts:79` — the
  cascade/set-null clauses will take effect. `ON DELETE CASCADE` and
  `ON DELETE SET NULL` are new patterns in this schema (no prior
  use); the cascade + set-null combo means deleting a video drops
  its queue rows, and deleting an account nulls its references
  without orphaning rows. See Task 3.5 for the delete flow that
  pairs with these FK semantics.

- [x] **Task 2.3: `videos.deferred_until` column**
  **Files**: `src/lib/db.ts`, `src/types.ts`,
  `src/lib/repos/videos.ts`
  **What**: `ALTER TABLE videos ADD COLUMN deferred_until INTEGER`
  wrapped in try/catch (SQLite has no `ADD COLUMN IF NOT EXISTS`;
  precedent in pause-resume plan). Add `deferred_until: number | null`
  to the `Video` type. Add `setDeferredUntil(videoId, at | null)` and
  `clearDeferredUntil(videoId)` repo helpers.
  **Context**: Pause-resume plan at
  `docs/plans/2026-04-20-pause-resume-feature.md` is the precedent for
  the try/catch ALTER pattern and the repo-helper style.

- [x] **Task 2.4: `src/lib/repos/google-flow.ts` — accounts**
  **Files**: `src/lib/repos/google-flow.ts` (new)
  **What**: Accounts side: `listAccounts()`, `findAccountByToken(token)`,
  `findAccountById(id)`, `insertAccount({id, name, token})`,
  `deleteAccount(id)`, `setAccountEnabled(id, enabled)`,
  `pauseAccount(id, untilUnix)`, `resumeAccount(id)` (sets
  `paused_until=NULL` AND `quota_used_today=0`), `bumpAccountQuota(id)`,
  `updateAccountLastSeen(id, atUnix)`, `updateAccountCredits(id,
  credits, atUnix)`, `firstAccountPausedUntil()` (returns the earliest
  `paused_until` among enabled+paused accounts — used by the step to
  set `retryAfter`), `anyAccountAvailable()` (boolean — used by the
  watcher to decide whether to clear defers).
  **Context**: Pattern per `src/lib/repos/steps.ts`. Thin SQL only;
  no orchestration.

- [x] **Task 2.5: `src/lib/repos/google-flow.ts` — queue**
  **Files**: `src/lib/repos/google-flow.ts`
  **What**: Queue side: `enqueueTask({video_id, chunk_id, kind, mode,
  prompt, output_path, priority})`, `findTaskById(id)` (primary-key
  lookup, internal use), `findTaskByExternalId(external_task_id)`
  (used by `submit-result` — see Task 3.2),
  `findOpenTaskForChunk(video_id, kind, chunk_id)` (returns a non-done,
  non-failed row if one exists — used for idempotent re-entry),
  `takeNextTaskForAccount(account_id)` **atomic**: inside a single
  `db.transaction()`, `SELECT id FROM google_flow_queue WHERE
  status='pending' ORDER BY priority DESC, id ASC LIMIT 1` → if row
  found, compute `external_task_id = `${id}_${now}`` and
  `UPDATE ... SET status='dispatched', assigned_account_id=?,
  dispatched_at=?, external_task_id=? WHERE id=? AND status='pending'
  RETURNING *`. Returns the updated row or null.
  `completeTask(id, resultUrl)`, `failTask(id, reason)`,
  `requeueTask(id)` (sets status back to `pending`, clears
  `assigned_account_id`, `dispatched_at`, and **also clears
  `external_task_id`** — the next claim will mint a fresh one,
  which is what sidesteps the extension's dedup),
  `countByStatusForVideo(video_id, kind)` (returns `{pending,
  dispatched, done, failed}`), `listFailedForVideo(video_id)`,
  `resetAllDispatchedOnStartup()` (used by reaper's startup hook;
  clears `external_task_id` on each row it resets, same
  rationale), `listStaleDispatched(maxAgeSec)` (returns rows where
  `status='dispatched' AND dispatched_at < unixepoch() - maxAgeSec`
  — used by the per-dispatch-age timeout in Task 5.2).
  **Context**: `external_task_id` is **dispatch-qualified**:
  `` `${queueRow.id}_${dispatched_at}` `` (e.g., `"7_1745168400"`).
  This is what the extension sees as `task.id` and keeps in its
  `processedJobIds` dedup set. Uniquifying per dispatch prevents a
  stuck-duplicate scenario: if the reaper requeues row 7 and that
  same row reaches the same extension instance again, the extension
  would otherwise skip it as already-processed (upstream
  `isJobAlreadyProcessed` at `background.js:1863`). HistForge
  **never** parses `external_task_id` — all HistForge-side lookups
  go against the column by equality (no `_` splitting, unlike
  Baserow-era code). The atomic claim uses SQLite's `RETURNING`
  clause — it works on better-sqlite3 (SQLite 3.35+), but note
  this is a **new idiom for this repo** (grep confirms no existing
  use under `src/`). If simpler is preferred, the same effect is
  achievable with a `SELECT id ... LIMIT 1` followed by
  `UPDATE ... WHERE id=? AND status='pending'` inside the same
  transaction, then a `changes()` check — slightly more code, no
  new idiom.

### Phase 3: Webhook API for the extension

- [x] **Task 3.1: `POST /api/flow/next-task/[token]`**
  **Files**: `src/app/api/flow/next-task/[token]/route.ts` (new)
  **What**: Body Zod: `{type: "TaskRequest", accountToken, mode}`.
  Verify URL token == body `accountToken`. Resolve account by token
  — 401 on mismatch, 404 on unknown, 403 if `enabled=0`. Always
  call `updateAccountLastSeen` before returning (this is the
  account's liveness signal). This route is the **canonical place
  pauses expire**: if `paused_until <= now()` (from 429 cooldown
  or manual pause), clear `paused_until` AND zero
  `quota_used_today` in the same statement. If `paused_until >
  now`, return `{}` with a `Retry-After` header of `paused_until
  - now` (extension ignores it today but it documents the wait
  for future tooling). Then call `takeNextTaskForAccount`. If a
  row is claimed, call `bumpAccountQuota`, and **clear the global
  `google_flow_relogin_needed` setting** (a successful dispatch
  to any account means that account's session is healthy; any
  remaining expired accounts still show "offline" via stale
  `last_seen_at` in the accounts table). Shape the response for
  the extension's parser. The outer gate at upstream
  `background.js:1836` short-circuits on `task && task.id &&
  task.prompt`, so **`prompt` must be present for every mode**
  including `createImage`. The per-mode validator
  (`background.js:1853-1856`) additionally requires `imagePrompt`
  for `createImage`. Response shape:
    - All modes: `{id, prompt, mode}` — `prompt` is always set
      from the queue row's `prompt` column.
    - `mode === "image"`: also include `referenceImage`.
    - `mode === "frames"`: also include `startFrame` and
      `endFrame`.
    - `mode === "createImage"`: also include `imagePrompt`,
      set to the same value as `prompt`. HistForge stores one
      prompt per task; duplicating it into both fields is what
      lets the upstream gate and per-mode validator both pass
      without a schema change.
  Unused fields are simply omitted.
  **Context**: Route param pattern per
  `src/app/api/videos/[id]/route.ts`. Extension's task validation
  keys at upstream `background.js:1836-1876`. Session-expired
  accounts are **not** paused (see Task 3.4); they self-halt in
  the extension, so no pause-clearing path is needed for them.

- [x] **Task 3.2: `POST /api/flow/submit-result/[token]` + SSRF validation**
  **Files**: `src/app/api/flow/submit-result/[token]/route.ts` (new),
  `src/lib/flow-media.ts` (new)
  **What**: Body Zod: `{type: "ResultSubmission", accountToken,
  taskId, resultUrl?, mode, error?, mediaFiles?, timestamp}`. Verify
  URL token == body `accountToken`. Look up the task by
  `external_task_id = taskId` (the dispatch-qualified string set in
  Task 2.5); **do not** parse the value or split on `_`. If no row
  matches, return `{success: true, duplicate: true}` with HTTP 200
  — a stale submission from a prior dispatch whose row has since
  been claimed again must not trigger the extension's retry storm.
  Be **state-tolerant**: accept submissions whether the task is
  `dispatched` or `pending` (reaper may have re-queued it). If task
  is already `done`, return `{success: true, duplicate: true}` with
  HTTP 200 (prevents the extension's 3-attempt retry storm at
  `background.js:2247-2282`). If the task is already `failed`
  (e.g., the reaper gave up, but the extension completed anyway),
  and the submission contains a valid `resultUrl`, accept it and
  flip the task to `done` — the work was done, don't waste it.
  Log this transition for observability.
  If `error` present, classify and act:
    - **Content policy** (error contains `SAFETY`, `CHILD_DANGER`,
      or any string starting with `PUBLIC_ERROR_` except the quota
      markers below): permanent fail — `failTask`, no retry.
      Upstream emits variants like `PUBLIC_ERROR_IP_INPUT_IMAGE`,
      `PUBLIC_ERROR_INAPPROPRIATE_CONTENT` (see upstream
      `background.js:1496-1506`).
    - **Quota / 429** (contains `429`, `RESOURCE_EXHAUSTED`,
      `QUOTA`): `pauseAccount(account_id, now + cooldown_hours*3600)`
      (cooldown from `google_flow_account_cooldown_hours` setting),
      `requeueTask(taskId)` so another account can try.
    - **Transient** (everything else, including session errors that
      somehow leak here): increment `retry_count`; if under
      `google_flow_max_retries`, `requeueTask`; otherwise `failTask`.
  If `resultUrl` present, split on `,`, take index 0 (we enqueue
  `outputCount=1` always in v1), validate the URL host against the
  allowlist — `storage.googleapis.com`, `*.googleusercontent.com`,
  `fife.*.googleapis.com`, `lh3.googleusercontent.com`, or `data:`
  scheme. Reject others with `failTask(reason="invalid result host: <url>")`.
  Call the media-download helper with task's `output_path`. Mark
  `completeTask(id, resultUrl)` only after the download+rename
  succeeds. Respond `{success: true}`.
  **Context**: Extension's result-submission body at upstream
  `background.js:2249-2274`. Extension interprets `success: false`
  in JSON body as retry trigger (`:2269-2272`) — we must return
  `success: true` for "don't retry" cases.

- [x] **Task 3.3: Media download helper**
  **Files**: `src/lib/flow-media.ts`
  **What**: `downloadToProjectPath(videoId, relativePath, sourceUrl,
  projectsDir)`. Creates parent dirs, streams URL to
  `<projectsDir>/<videoId>/<relativePath>.tmp`, then atomic rename
  to final path. Supports `storage.googleapis.com` URLs, `fifeUrl`
  (googleusercontent), `data:` URLs (upsample can return base64 —
  extension code path at upstream `background.js:1079-1095`). Pre-
  validates host against the allowlist (same list as 3.2) as a
  second line of defense. 10-minute timeout.
  **Context**: URL shapes documented in upstream `flow-api.js:69-75`.
  No existing media-download helper in the repo.

- [x] **Task 3.4: `POST /api/flow/status/[token]`**
  **Files**: `src/app/api/flow/status/[token]/route.ts` (new)
  **What**: Body Zod: `{type: "StatusEvent", accountToken, event,
  ...payload}`. Two event kinds:
    - `"session_expired"` — set
      `google_flow_relogin_needed = "true"`. **Do not pause the
      account.** The extension self-halts (Task 1.8), so it stops
      polling on its own; no per-account pause is needed to stop
      it from sending tasks. Pausing on this event caused a bug in
      an earlier draft: if cooldown_hours=4h but the user re-logs
      in 10 min, the account would stay HistForge-paused for 3h 50m
      of wasted idle time. With no pause, the extension's
      `last_seen_at` goes stale (no polls), the account surfaces
      as "offline" in the dashboard, user investigates and re-logs,
      extension resumes polling, first successful poll clears the
      global flag (Task 3.1).
    - `"credits"` — `{credits: number, tier?, serviceTier?, sku?}`
      (tier/serviceTier/sku may be `undefined` if upstream
      `getCredits` didn't include them; the Zod schema marks them
      optional for that reason). Call `updateAccountCredits`.
  Always `updateAccountLastSeen` (keeps the liveness signal fresh).
  Respond `{success: true}`.
  **Context**: New endpoint, no direct upstream equivalent. The
  extension's status-posting is implemented in Tasks 1.8 + 1.9.

- [x] **Task 3.5: Account CRUD API**
  **Files**: `src/app/api/flow/accounts/route.ts` (new),
  `src/app/api/flow/accounts/[id]/route.ts` (new)
  **What**: `POST /api/flow/accounts` — body `{name: string}` (max 64
  chars, non-empty). Server generates `id` (slug like `acc_01`
  picking the next available) and `token` (`randomBytes(24).toString
  ('base64url')` — 32 chars). Inserts row, returns `{id, name, token,
  pollUrl, resultUrl, statusUrl}` where URLs are absolute based on
  the request host header.
  `GET /api/flow/accounts` — returns all accounts (minus token — show
  `…<last4>` for re-identification).
  `DELETE /api/flow/accounts/[id]` — deletes account. Order inside
  a single `db.transaction()`:
    1. `requeueTask` for every queue row where `assigned_account_id
       = ? AND status = 'dispatched'` (clears assignee and resets to
       pending so other accounts can retry the work).
    2. `DELETE FROM google_flow_accounts WHERE id = ?`. The
       `ON DELETE SET NULL` FK in Task 2.2 is the safety net — it
       only fires if step 1 missed any `pending` rows that still
       reference this account (shouldn't happen, but harmless if
       it does).
  `PATCH /api/flow/accounts/[id]` — body `{name?, enabled?,
  paused_until_iso?}` — allows the dashboard to rename, toggle
  enabled, or manually pause. Setting `paused_until_iso` to null
  resumes (via `resumeAccount`).
  **Context**: Route patterns per existing videos API. Token format:
  URL-safe, no `+//=` so it's clean in URL paths.

### Phase 4: Worker step + orchestrator yield

- [x] **Task 4.1: Extend Step contract with defer sentinel**
  **Files**: `src/worker/pipeline.ts`
  **What**: Widen `Step.run`'s return type to `Promise<void |
  DeferSignal>`. `DeferSignal = {deferred: true, retryAfter: number}`
  (unix seconds). Wrap the `await step.run(...)` call site to
  inspect the resolved value: when it's a `DeferSignal`:
    - Leave the step row in `running` (do **not** mark done).
    - Call `setDeferredUntil(videoId, retryAfter)`.
    - Return from the per-video loop without advancing to the next
      step.
  When the return is `undefined` (normal), behave as today. Errors
  still mark the step failed.
  **Context**: Step contract (`run` signature) at
  `src/worker/pipeline.ts:50`; call site to wrap at
  `src/worker/pipeline.ts:258` (`await step.run(videoId, ctx)`).
  Video status remains `in_progress` in the deferred state —
  orchestrator's pickNextVideo treats `in_progress` as resumable
  (crash-recovery), which is what we want. Compatibility note:
  `resetStaleRunningSteps` at boot
  (`src/lib/repos/steps.ts:115-119`) flips any `running`
  `video_steps` row back to `pending`. That's fine here — the
  `deferred_until` lives on the **video**, not the step, so it
  survives the reset. At the next orchestrator tick, the video is
  skipped while `deferred_until > now()`, then re-enters the step
  which is idempotent (checks for existing queue rows + existing
  output files).

- [x] **Task 4.2: Orchestrator skips deferred videos**
  **Files**: `src/lib/repos/videos.ts`
  **What**: Push the defer filter into the two repo functions
  `pickNextVideo` delegates to — `findOldestQueuedId`
  (`src/lib/repos/videos.ts:222-229`) and `findInProgressId`
  (`:231-238`). Both already carry a `paused = 0` guard; extend their
  WHERE clauses with
  `AND (deferred_until IS NULL OR deferred_until <= unixepoch())`.
  `pickNextVideo` itself (`src/worker/runner.ts:35-47`) stays
  unchanged — this preserves its two-line resolution order and means
  callers (including `anyInProgressExists` at
  `src/lib/repos/videos.ts:245-250`, which deliberately does **not**
  filter `paused`) aren't accidentally pulled along. Pause and defer
  stay orthogonal: both must be clear for the video to be eligible.
  **Context**: The two helpers mirror each other's shape; edit them
  together so a future grep for "deferred_until" finds them side by
  side. Do **not** add the defer filter to `anyInProgressExists` —
  it enforces the one-at-a-time invariant and must see deferred rows
  so the runner doesn't fall through to a queued row while an
  in-progress video is mid-defer.

- [x] **Task 4.3: Shared queue-wait helper**
  **Files**: `src/lib/flow-wait.ts` (new)
  **What**: `waitForFlowQueue(videoId, kind, opts)` — polls
  `countByStatusForVideo` every `pollIntervalMs` (default 5000).
  Terminates with:
    - `{ok: true}` when all enqueued rows are `done` or `failed`
      (failed ones are surfaced via the caller's error path).
    - `{ok: false, reason: "stalled", retryAfter: number}` when
      `anyAccountAvailable()` returns false AND no rows are still
      `dispatched` (we're not just waiting for in-flight work — all
      rows are `pending` and nothing can move them). Computes
      `retryAfter = firstAccountPausedUntil() ?? now + 1800`.
    - `{ok: false, reason: "timeout"}` after 24h wall-clock.
  Emits progress via `opts.log`. Note: 24h is **per re-entry**,
  not cumulative across defers. If the step defers at t=3h,
  resumes at t=7h, the clock restarts. In practice this means a
  video can stay in the Flow step indefinitely while accounts
  cycle through cooldowns — that's acceptable; nothing else is
  waiting on it (orchestrator moves to other videos). A separate
  "video stuck N days" watchdog is out of scope.
  **Context**: No existing polling helper. Counts-by-status is
  cheap with the status/priority/id index.

- [x] **Task 4.4: Implement `generate-main-images-google-flow.ts`**
  **Files**: `src/worker/steps/generate-main-images-google-flow.ts`
  **What**: Replace the stub. Read `chunks/chunks.json`, filter
  `kind === "main"`. For each chunk:
    - Skip if `projects/<videoId>/images/main/<chunk_id>.png` exists
      on disk (resume behavior, matches ComfyUI step).
    - Skip if `findOpenTaskForChunk(videoId, 'main_image',
      chunk_id)` returns a non-done, non-failed row (avoid duplicates
      on re-entry).
    - Else `enqueueTask` with kind=`main_image`, mode=`createImage`,
      prompt=`chunk.prompt` (skip chunks where prompt is `null` with
      a warning), output_path=`images/main/<chunk_id>.png`.
  Track, across all main chunks, how many had a usable prompt.
  If **zero main chunks yielded enqueueable work AND no existing
  `images/main/*.png` files were detected** (i.e., the step has
  genuinely nothing to do because every prompt is null), throw
  with a clear message — silently succeeding would hand the render
  step an empty directory, and it's better to fail loudly at the
  source. If some existing outputs were present (resume case)
  and the rest are skipped due to null prompts, that's fine —
  proceed without enqueueing.
  Then call `waitForFlowQueue(videoId, 'main_image')`. On `ok:
  false, reason: "stalled"`, return the defer sentinel (the pipeline
  handles the rest per Task 4.1). On `"timeout"`, throw. On any
  `failed` row, throw an aggregated error listing the failed
  chunks and reasons. **Before returning cleanly** (step done, all
  rows `done`), call `clearDeferredUntil(videoId)` so any stale
  defer from a prior pass is wiped — prevents dirty state from
  persisting after a successful run.
  **Context**: Mirror `src/worker/steps/generate-main-images-comfyui.ts:23-47`
  for resume pattern + log style. Upstream extension's `createImage`
  mode at `background.js:980-1124`.

- [x] **Task 4.5: Implement `generate-hook-video-google-flow.ts`**
  **Files**: `src/worker/steps/generate-hook-video-google-flow.ts`
  **What**: Same pattern for hook chunks. Mode=`text` (text-to-video),
  output_path=`videos/hook/<chunk_id>.mp4`. Uses the same wait
  helper + defer behavior, including the
  `clearDeferredUntil(videoId)` call before a successful return
  (same rationale as 4.4) and the "throw if zero enqueueable
  chunks and no existing outputs" safety check.
  **Context**: Hook filter + output path per
  `src/worker/steps/generate-hook-video-comfyui.ts:40-52`.
  Text-to-video in the extension: upstream `background.js:1136-1156`.

### Phase 5: Reaper + deferred-video watcher

- [x] **Task 5.1: Startup reset of stuck dispatched rows**
  **Files**: `src/worker/index.ts`
  **What**: At worker boot, after `resetStaleRunningSteps`, call
  `resetAllDispatchedOnStartup()`. Any queue rows stuck in
  `dispatched` (because HistForge crashed while tasks were in flight)
  go back to `pending`. Incidentally: this means the extension, if
  it was still running, may later submit results for rows that are
  now `pending` — the submit-result handler is state-tolerant (Task
  3.2) so those still resolve cleanly. Note that `resetStaleRunningSteps`
  (`src/lib/repos/steps.ts:115-119`) simultaneously flips any
  `running` step back to `pending` — that's compatible with defer
  because `deferred_until` lives on the video (see Task 4.1
  compatibility note).
  **Context**: `resetStaleRunningSteps` reference at
  `src/worker/index.ts:29`.

- [x] **Task 5.2: Periodic reaper (30 s) — stale accounts, disabled
  accounts, stale dispatches, expired defers**
  **Files**: `src/worker/index.ts`, `src/lib/flow-watcher.ts` (new)
  **What**: Set an interval (30 000 ms) that:
    1. Requeues `dispatched` rows whose `assigned_account_id`'s
       `last_seen_at` is older than 10 minutes, OR whose account
       is `enabled=0`. Logs each requeue. Uses `requeueTask`.
    2. **Per-dispatch age timeout.** Requeues any `dispatched` row
       whose `dispatched_at` is older than
       `google_flow_dispatch_timeout_minutes` (see Task 6.1 —
       default 30) regardless of account liveness. This catches
       the case where the account keeps polling healthily but the
       specific dispatch never resolves (for example, the Flow
       backend silently drops the job, or upstream retry logic
       inside the extension loops on an unrecoverable error
       without ever POSTing `submit-result`). Implementation:
       `listStaleDispatched(timeoutMinutes * 60)` from Task 2.5,
       then `requeueTask` per row. Log each requeue with
       `taskId`, `account_id`, and age in seconds. `requeueTask`
       clears `external_task_id`, so the next dispatch mints a
       new one and the extension's `processedJobIds` dedup
       doesn't block it (Fix connects to Task 2.5).
    3. Clears `deferred_until` on any `videos` row where
       `deferred_until > now()` AND `anyAccountAvailable()` returns
       true AND the video still has rows with `status='pending'`
       in `google_flow_queue`. This is a "wake up now" hook so
       deferred videos don't have to wait for the `retryAfter`
       timestamp if accounts came back early. (Videos with no
       pending rows are either done or fell through — leave their
       defer state alone.)
  Runs in the worker process (not the Next.js web process).
  **Context**: No prior periodic tasks in the worker — the existing
  loop is event-driven. Adding one 30 s interval is minor. Guard
  against overlapping runs with a simple "isReaping" boolean.
  Ordering inside the tick: run step 1 first (account-level),
  then step 2 (per-dispatch) — step 1 already covers the
  "account went silent" case, so step 2 only rescues genuinely
  stuck rows under still-live accounts.

- [x] **Task 5.3: Confirm session-expiry auto-recovery is wired**
  **Files**: (verification only — no new code)
  **What**: Session-expired accounts are not paused in the DB
  (Task 3.4) — the extension self-halts in Chrome. Auto-recovery
  sequence: user re-logs → extension's session fetch starts
  succeeding → extension resumes polling → first `next-task` with
  a dispatched row clears the global `google_flow_relogin_needed`
  flag (Task 3.1). Meanwhile, the account's dashboard row shows
  "offline" while halted (stale `last_seen_at`) and flips back to
  "seen Ns ago" once polling resumes. This task is a **verification
  step**: spot-check this chain end-to-end, don't write code.
  **Context**: Pause-driven auto-recovery (in Task 3.1's "clear
  `paused_until` when <= now" path) still applies to 429 cooldowns
  and manual pauses — those do use the DB pause. Only session-
  expired skips that path.

### Phase 6: Settings + dashboard UI

- [x] **Task 6.1: Revise Google Flow settings**
  **Files**: `src/lib/settings.ts`, `src/lib/db.ts`,
  `src/app/settings/settings-form.tsx`
  **What**: Remove `google_flow_profile_path` from `SETTING_SCHEMAS`,
  `DEFAULT_SETTINGS`, and `TAB_FIELDS.google-flow`. Keep
  `google_flow_relogin_needed` (now auto-set by the session_expired
  event, auto-cleared per Task 3.1). Add:
    - `google_flow_image_model` (`z.string()`, default `"NARWHAL"`)
    - `google_flow_video_quality` (`z.enum(["fast","quality"])`, default
      `"fast"`)
    - `google_flow_aspect_ratio` (`z.enum(["landscape","portrait"])`,
      default `"landscape"`)
    - `google_flow_account_cooldown_hours` (`z.coerce.number().int().min(1).max(24)`,
      default `4`)
    - `google_flow_max_retries` (`z.coerce.number().int().min(0).max(10)`,
      default `3`)
    - `google_flow_dispatch_timeout_minutes`
      (`z.coerce.number().int().min(5).max(240)`, default `30`) —
      per-dispatch age cap consumed by the reaper (Task 5.2). Any
      `dispatched` row older than this gets requeued regardless of
      account liveness. Lower bound of 5 min keeps a transient-slow
      job from thrashing; 240 min upper bound lets operators widen
      it for very long jobs without unbounded stuck-row risk.
  **The form is not schema-driven** — fields are rendered by
  hand-written JSX in each `<TabsContent>` block. In addition to the
  `TAB_FIELDS` + `SETTING_SCHEMAS` + `DEFAULT_SETTINGS` edits, you
  must edit the `<TabsContent value="google-flow">` JSX to: remove
  the `google_flow_profile_path` input, and add input components
  for the six new fields (text input for `image_model`, selects for
  `video_quality` and `aspect_ratio`, number inputs for
  `cooldown_hours`, `max_retries`, and `dispatch_timeout_minutes`).
  Mirror the field-component style used by neighbouring tabs
  (`comfyui`, `ai33`, etc.) in the same file.
  **Context**: Schema pattern at `src/lib/settings.ts:12-56`. Defaults
  seeded at `src/lib/db.ts:11-36`. Tab binding at
  `src/app/settings/settings-form.tsx:42-68`.

- [x] **Task 6.2: Accounts section on Settings → Google Flow tab**
  **Files**: `src/app/settings/google-flow-accounts.tsx` (new),
  `src/app/settings/settings-form.tsx`
  **What**: Create `google-flow-accounts.tsx` as a client component
  that fetches / mutates via the routes from Task 3.5. Injection
  point: inside `<TabsContent value="google-flow">` in
  `settings-form.tsx`, render `<GoogleFlowAccounts />` **above**
  the scalar-field block (same JSX file; drop the component in as
  the first child of the `TabsContent`). Columns: name (inline-
  edit), enabled toggle, credits + "as of <relative time>",
  `paused_until` ("paused, 3h 20m left" / blank), `last_seen_at`
  ("seen 8s ago" / "offline"), `quota_used_today`. Per-row actions:
  "Pause 4h", "Pause indefinitely", "Resume", "Delete" (confirm
  dialog). No per-row "Copy webhook URLs" — tokens are only visible
  in the post-creation modal, and an existing account that lost its
  URLs is handled by delete + re-add (cheap under the persistent-
  profile operational model). See
  `docs/research/2026-04-21-flow-copy-webhook-urls.md` for
  alternatives that were considered.
  Above the list: "Add account" form — just a name input. On
  submit, server mints token, UI shows a modal revealing token +
  three URLs, with a single "Copy all" button. Token is only
  visible in this one moment.
  **Server-side ID generation**: take `MAX(CAST(SUBSTR(id, 5) AS
  INTEGER)) + 1` from `google_flow_accounts`, pad to two digits
  (`acc_05`). Stable IDs, gaps-after-delete are fine. Token:
  `randomBytes(24).toString('base64url')` as already specified in
  Task 3.5.
  **Context**: Mirror the form/section/validation pattern used by
  other tabs in `src/app/settings/settings-form.tsx`. URL
  construction server-side from the request host to survive dev vs
  prod hosts.

- [x] **Task 6.3: Video detail page — Flow progress panel**
  **Files**: `src/app/videos/[id]/video-detail-client.tsx`
  (existing client component), `src/app/api/flow/requeue-failed/[videoId]/route.ts`
  (new)
  **What**: When a video's workflow is `google-flow` and its
  current/past steps include `generate_main_images_google_flow` or
  `generate_hook_video_google_flow`, show a panel with counts:
  `42/120 main images, 3 failed`. Expand "failed" to show per-chunk
  error reasons (from `google_flow_queue.error_reason`). Add a
  "Requeue failed" button — calls the new
  `POST /api/flow/requeue-failed/[videoId]` route, which runs
  `requeueTask` for rows with `status='failed'` whose `retry_count`
  < `google_flow_max_retries` (user override button bypasses the
  limit — flag this in the route with a `?force=1` query param).
  Data source: a new API route (e.g.
  `GET /api/flow/queue-summary/[videoId]`) returning
  `countByStatusForVideo` + `listFailedForVideo` results, or fold
  the data into the existing video-detail server component's
  initial payload if simpler.
  **Context**: Server page at `src/app/videos/[id]/page.tsx` hands
  props to `video-detail-client.tsx`. Locate in the client
  component where ComfyUI-generated image previews are already
  rendered; add the Flow progress panel alongside. Reuse the
  existing gallery component for Flow-generated images — the path
  convention is identical (`images/main/<chunk_id>.png`).

### Phase 7: Tests

- [x] **Task 7.1: Repo unit tests (also establishes test conventions)**
  **Files**: `src/lib/repos/google-flow.test.ts` (new), test helper
  at `src/lib/repos/__test-util__/db.ts` (new) or similar
  **What**: **This is the repo's first test file** — grep confirms
  no `.test.ts` or `.spec.ts` exists under `src/`. `npm run test`
  (vitest, per CLAUDE.md) is wired but unused. Scope of this task:
    1. Establish the testing harness: an in-memory better-sqlite3
       instance per test, seeded via `createDb` + `seedDefaultSettings`,
       returned by a shared helper. Confirm vitest config picks up
       `*.test.ts` under `src/`.
    2. Write the repo tests:
       - Atomic task claim under contention: spawn N parallel
         `takeNextTaskForAccount` calls against a single pending
         row; exactly one succeeds, rest return null.
       - `pauseAccount` / `resumeAccount` lifecycle: pausing sets
         `paused_until`, resuming clears it and zeroes
         `quota_used_today`.
       - `requeueTask` clears `assigned_account_id` and
         `dispatched_at`, leaves `retry_count` intact.
       - `resetAllDispatchedOnStartup` flips all `dispatched` rows
         to `pending` in one call.
       - `findOpenTaskForChunk` returns non-done, non-failed rows
         (not failed ones).
  **Context**: Once this task lands, Task 7.2 can reuse the same
  harness.

- [x] **Task 7.2: Route integration tests**
  **Files**: `src/app/api/flow/*/route.test.ts` (new)
  **What**: For each of the three webhook routes + the accounts
  CRUD:
    - `next-task`: token mismatch → 401; unknown token → 404;
      disabled account → 403; paused account → `{}`;
      concurrent calls from different accounts each get distinct
      rows.
    - `submit-result`: SSRF attempt (`http://127.0.0.1:*`) →
      rejected with `failTask`; content-policy error → permanent
      fail, no requeue; quota error → account paused, task
      requeued; duplicate submission for done task → 200
      `{duplicate: true}` with no retry-triggering body.
    - `status`: `session_expired` pauses the account and sets the
      global relogin flag; `credits` updates the number.
    - `accounts`: CRUD happy path, token is opaque, deleting an
      account requeues its dispatched rows.
  **Context**: Check whether the project has API-route test harness;
  if not, construct one using Next's Request/Response.

### Phase 8: Docs

- [x] **Task 8.1: Rewrite spec §12b**
  **Files**: `docs/histforge-spec.md`
  **What**: Replace the Playwright-deferred paragraph with the
  hybrid-executor design: forked extension as dumb runner, HistForge
  queue + reaper + deferred-video watcher, per-account tokens,
  event-driven quota model. Update any §10 workflow references
  that mention Playwright. Document the new settings
  (`google_flow_image_model`, etc.), the three webhook endpoints
  (`next-task/[token]`, `submit-result/[token]`, `status/[token]`),
  and the queue/accounts schemas.
  **Context**: Current §12b at `docs/histforge-spec.md:588-594`.
  Don't break neighboring §12a (ComfyUI) or the ToC.

- [x] **Task 8.2: Setup guide**
  **Files**: `docs/setup-google-flow.md` (new)
  **What**: Numbered walkthrough:
    1. In HistForge Settings → Google Flow → Add account. Copy the
       token + three URLs from the post-creation modal.
    2. Open a new Chrome profile (one per account) →
       `chrome://extensions` → enable Developer mode → "Load
       unpacked" → select `extensions/youforge-flow/`.
    3. Sign the profile into its Google account → navigate to
       `https://labs.google/fx/tools/flow` → open a Flow project.
    4. Click the extension's toolbar icon → paste the three URLs,
       the token, set concurrency (leave at 5 for now) → click
       "Grant HistForge access" → accept the Chrome prompt →
       click "Start".
    5. Smoke test: create a video with 2 main chunks + 1 hook,
       select the `google-flow` workflow, observe generation end-
       to-end.
    6. Troubleshooting section: expired session, 429, content
       policy (historical content caveats), "offline" account
       indicator.
  **Context**: Model the doc's structure after
  `docs/comfyui/setup-comfyui.md` (referenced in CLAUDE.md's
  troubleshooting section).

## Open Risks & Notes
- **Google Flow API drift**: if Google changes the reCAPTCHA site
  key, action names, or endpoint paths, both upstream and our fork
  break. Keeping `flow-api.js` as close to upstream's layout as
  possible lets us cherry-pick upstream fixes cleanly.
- **Chrome profile ergonomics**: up to 4 profiles open permanently on
  the host machine is the real operational cost. No workaround.
- **SSRF allowlist may need tuning**: if Google changes the CDN host
  for result URLs, we'll reject valid results. Allowlist is in
  `flow-media.ts`; easy to extend.
- **Credits-reported value is advisory**: we don't gate dispatch on
  it (only on actual 429s) because the extension's reported credits
  can be stale. It's for dashboard visibility.
- **Concurrency × accounts math**: 4 accounts × 5 concurrency = 20
  simultaneous Flow calls max. 900-clip target at ~1 min each
  means ~45 min wall clock per account to exhaust ~300, then 4 h
  cooldown. Full 900 clips across 4 accounts finishes in ~5 h
  (assuming no content-policy hits).
- **Token in URL path**: webhook URLs reveal tokens in router logs /
  Referer headers. If HistForge is exposed beyond localhost, put the
  endpoints behind VPN or IP allowlist — out of scope here.

## References
- `extensions/veo-upstream/flow-api.js` — endpoint payloads
  (our ported copy)
- `extensions/veo-upstream/background.js:1836-2305` — FIFO
  task loop + result submission (the code paths we keep after
  stripping)
- `extensions/veo-upstream/content.js:110-131` — session
  token fetch (source-of-truth for auth)
- `extensions/veo-upstream/recaptcha-hook.js` — reCAPTCHA
  Enterprise hook (keep untouched)
- `src/worker/workflows/index.ts:44-56` — `google-flow` workflow
  already registered
- `src/worker/steps/generate-main-images-comfyui.ts` — step pattern
  to mirror (resume via file existence check)
- `src/lib/settings.ts:12-56` + `src/lib/db.ts:11-109` — settings
  and schema patterns
- `docs/plans/2026-04-20-pause-resume-feature.md` — precedent for
  additive `ALTER TABLE` migrations and between-step yield semantics
- `docs/plans/2026-04-20-rename-to-youforge.md` — follow-up plan
  for repo-wide rebrand (intentionally out of scope here)
