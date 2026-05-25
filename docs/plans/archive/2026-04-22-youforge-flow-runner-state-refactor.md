# YouForge Flow: Runner Decomposition, State Consolidation, and Coupling Cleanup

## Overview

Seven SOLID refactors to close out the remaining audit items from
`docs/refactoring/solid-audit-2026-04-22-youforge-flow.md` (findings
**#3**, **#5**, **#6**, **#7**, **#8**, **#9**, **#10**). The audit's
earlier items (#1, #2, #4) are already landed in prior commits; this
plan finishes the "Next Sprint" and "Backlog" groups in the audit's
priority table.

The refactors are ordered so each phase reduces the friction of the
next one. Phase 1 knocks out small single-file cleanups. Phase 2 splits
the runner's polling monolith so later phases have a narrow surface to
build façades against. Phase 3 introduces the missing state module
(Option B from the audit — a sibling `state.js` + `stats.js` next to
`settings.js`), which Phase 4 then leans on when restoring
`messages.js` to switch-only discipline and inverting the
runner↔executor coupling.

Finding **#11** (split `ctx` into `ExecutorBase` / `VideoExecutorCtx` /
`ImageExecutorCtx`) is intentionally out of scope: the audit recommends
it only as a co-refactor with #2 (done), and in an untyped JS service
worker the ISP cost is theoretical — executors silently ignore fields
they don't read. The redundant `ctx.taskId` (noted in the audit) is
also left alone; removing it is a one-line cleanup that has no effect
on runtime behavior.

## Current State

**Platform.** Chrome MV3 service worker loaded via classic
`importScripts` from `extensions/youforge-flow/background.js`. No ES
modules, no bundler; every file lands in one global scope. Load order
is leaves-first (see `background.js:9-35`). Adding a new top-level
module means adding a new `importScripts` line in the correct position.

**The runner.** `src/runner.js` is 247 lines. `pollForTasksFIFO`
(lines 102-246, 144 lines) still carries bridge-health, HTTP polling,
task validation, dedup, stop-flag re-checks, capacity re-checks, and
the fire-and-forget dispatch chain in one function. It was the one
monolith that didn't get decomposed during the April 21 modularization
plan (`docs/plans/2026-04-21-youforge-flow-audit-modularize.md`). The
activeTaskCount helpers (`getActiveTaskCount`,
`incrementActiveTaskCount`, `decrementActiveTaskCount`,
`resetActiveTaskCount`) live at `src/runner.js:17-34` and are the
runner's internal slot-counter primitives.

**The model-keys matrix.** `src/account-tier.js` is 124 lines.
`getVideoModelKeys` (lines 70-123) is five return statements with
near-identical shape — `{ t2v, r2v, i2v, i2v_fl, paygateTier }` —
differing only in which specific model IDs each tier/quality tuple
returns. The aspect-ratio ternary appears once per branch (5 times).

**The messages router.** `src/messages.js` is 151 lines. Its docstring
claims coordination-only but three cases still embed business logic:
`stopAllProcessing` lines 25-47 (tab notification IIFE),
`taskRetrying` lines 84-97 (stats-bump IIFE),
`videoFound` lines 59-67 (payload shape translation from
`{ task, videoUrl, isGeneratedImage }` to the `handleTaskCompletedFIFO`
shape `{ taskId, resultUrl, isGeneratedImage }`).

**The upscale callback.** `buildExecutorContext` in
`src/executors/index.js:83-89` constructs `onUpscaleStart`, which
directly references four runner internals: `decrementActiveTaskCount`,
`getActiveTaskCount`, `getMaxConcurrent`, `pollForTasksFIFO`. The
callback is stored on `ctx.onUpscaleStart` (line 104) and invoked
from `upscaleVideos` in `src/executors/shared.js:188`.

**Scattered `chrome.storage.local` access.** Nine call sites outside
`settings.js`:
- `src/runner.js:62, :97, :126, :201` (`isEnabled`, `lastPoll`,
  `processedJobIds`)
- `src/handlers.js:16-22, :42-48, :80-86` (`processedJobIds`, `stats`)
- `src/status.js:19` (reads `isEnabled`, `lastPoll`, `stats`,
  `processedJobIds`, `generationMode` in one shot)
- `src/executors/index.js:57-59` (reads 6 executor settings —
  `outputCount`, `aspectRatio`, `imageModel`, `videoModel`,
  `imgUpscale`, `vidUpscale` — **on every task execution**,
  bypassing the load-once cache pattern `settings.js` uses)
- `src/account-tier.js:48` (`accountTier` cache)
- `src/host-permission.js:19, :25, :29` (`grantedOrigin`)
- `src/messages.js:88` (`stats` — part of `taskRetrying`'s inline work)

**The duplicated stats bump.** Three copies of the read-modify-write
pattern for the `stats` object: `src/handlers.js:42-48` (bumps
`processed`), `src/handlers.js:80-86` (bumps `failed`),
`src/messages.js:87-95` (bumps `retries`). Identical shape, only the
counter name differs.

**The media-fetch monolith.** `src/media-fetch.js` is 165 lines;
`fetchMediaFiles` (lines 73-164, 92 lines) interleaves URL-splitting,
data-URL decoding, retry-loop management, and a 30-line cross-world
`executeScript` body inlined as a string argument. The stop-flag
re-check at lines 108-111 is easy to miss inside the current
structure.

**Settings cache pattern.** `src/settings.js` already caches POLL_URL,
RESULT_URL, STATUS_URL, ACCOUNT_TOKEN, MAX_CONCURRENT, and
`currentMode` in module-scoped variables, loads them once via
`loadSettings` at bootstrap (lines 22-43), and exposes getters at
lines 67-72. It is the positive precedent for the new modules. What
it does **not** cover: runtime state (isEnabled, lastPoll,
processedJobIds, cached accountTier, grantedOrigin), counters (stats),
or the six executor settings that `executors/index.js:57-59` reads
directly each call.

**Testing.** No automated tests cover this extension. Manual smoke is
the only gate — see Verification below.

## Scope

**Doing**:
- Flatten `getVideoModelKeys` into a lookup table (#5).
- Split `fetchMediaFiles` into `decodeDataUrl` + `fetchOneMediaViaPage`
  helpers (#10).
- Decompose `pollForTasksFIFO` into `ensureBridgeAlive` /
  `fetchNextTask` / `validateTask` / `dispatchTask` + a thin
  orchestrator (#3).
- Create `src/state.js` sibling to `settings.js`, owning runtime
  state (Option B from audit #8).
- Create `src/stats.js` with `bumpStat(key)` helper, absorbing the
  three duplicated call sites (#9).
- Extend `settings.js` cache to own the six executor settings that
  `executors/index.js` reads each call (part of #8).
- Route every direct `chrome.storage.local` call outside the three
  state modules through their getters/setters (#8).
- Replace `onUpscaleStart` callback with a `markSlotFreedForUpscale()`
  façade exported from `runner.js` (#7).
- Restore `messages.js` to switch-only discipline — move
  `stopAllProcessing`'s tab-notify work to `runner.forceStopAllTabs`,
  `videoFound`'s shape translation to a `handlers.js` adapter, and
  `taskRetrying`'s stats bump to `bumpStat` (#6).
- Smoke-test the extension end-to-end after each phase.

**Not doing**:
- Finding #11 (ctx-field split) — see overview rationale.
- Converting the service worker to ES modules or adding a bundler.
- Adding automated tests for the extension (manual smoke only).
- Changing upstream files under `extensions/veo-upstream/`.
- Touching the behaviors that the audit's Notes section flagged as
  non-SOLID (silent `ultra` default in `account-tier.js:59-62`,
  `cachedProjectId` TTL in `auth.js:14`, `processedJobIds` cap
  justification in `handlers.js:15-25`) — those are separate
  reliability concerns, not this plan's scope.
- Adding a `chrome.storage.onChanged` listener to auto-sync the
  cache. Updates flow through the existing popup-driven update
  path (`updateWebhooks`, `updateConcurrency`, `setMode`); the new
  modules mirror that pattern.

## Tasks

### Phase 1: Small independent refactors

- [x] **Task 1.1: Flatten `getVideoModelKeys` into `MODEL_MATRIX` lookup**
  **Files**: `src/account-tier.js`
  **What**: Replace the five-branch if-tree at
  `src/account-tier.js:70-123` with:
    - A top-level `MODEL_MATRIX` const keyed by one of
      `"lite" | "pro" | "ultra.fast" | "ultra.quality" | "ultra.lower"`.
      Each entry is `{ t2v, r2v_portrait, r2v_landscape, i2v, i2v_fl,
      paygateTier }`.
    - A tiny resolver that picks the matrix key from
      `(quality, tier)`: `quality === 'lite' ? 'lite' : tier === 'pro'
      ? 'pro' : 'ultra.' + quality`. The `quality` values in play
      today are `fast`, `quality`, `lower` (see existing branches at
      lines 97-104, 105-112, 114-121).
    - A post-lookup aspect-ratio step that collapses
      `r2v_portrait` / `r2v_landscape` into a single `r2v` field based
      on `isPortrait` before the function returns, so callers still
      see the `{ t2v, r2v, i2v, i2v_fl, paygateTier }` shape they use
      today.
  Behavior must be bit-identical — verify every existing
  (tier, quality, aspect) tuple maps to the same six field values it
  does pre-refactor.
  **Context**: Declare `MODEL_MATRIX` at top level (classic
  service-worker script; no exports). Update the function docstring
  at `src/account-tier.js:64-69` to describe the matrix lookup. The
  function's caller is `buildExecutorContext` in
  `src/executors/index.js` via `getVideoModelKeys(tier, settings,
  isPortrait)` — signature is unchanged. The silent `ultra` fallback
  on detection failure at lines 59-62 is out of scope (see "Not
  doing"); MODEL_MATRIX keeps the same fallback behavior by making
  `"ultra.fast"` the default resolver output when tier is `"ultra"`
  with an unknown quality.

- [x] **Task 1.2: Split `fetchMediaFiles` into named helpers**
  **Files**: `src/media-fetch.js`
  **What**: Extract two top-level helpers in the same file:
    - `decodeDataUrl(dataUrl)` — owns the data-URL header/b64/mime
      parse currently at lines 86-97, returns a `MediaFile` object
      (or whatever the existing shape is — match the in-place
      return).
    - `fetchOneMediaViaPage(tabId, url)` — owns the MAIN-world
      `executeScript` call with size guard and FileReader currently
      inlined at lines 113-141. Returns one `MediaFile` or throws.
  `fetchMediaFiles` then shrinks to: split URLs with
  `_splitResultUrls(resultUrl)`, for each entry call `decodeDataUrl`
  (data URL) or a 3-retry loop over `fetchOneMediaViaPage` (HTTP
  URL). Preserve the stop-flag re-check at lines 108-111 — keep it
  visible at the call site in `fetchMediaFiles`, not hidden inside
  `fetchOneMediaViaPage`, so the "abort retry mid-loop" semantics
  stay explicit.
  **Context**: Current file is `src/media-fetch.js` (165 lines).
  The inline `executeScript` function is passed as a string-form
  function argument to `chrome.scripting.executeScript({ func: ...,
  args: [url] })`; keep it a normal named function at top level of
  the MV3 worker and pass it the same way. The 3-retry arithmetic
  (backoff, attempt count) stays inside `fetchMediaFiles` — the
  helper is a single-attempt fetch. Update the module docstring
  (lines 1-8) to list the two new helpers.

### Phase 2: Runner decomposition (#3)

- [x] **Task 2.1: Decompose `pollForTasksFIFO` into named phases**
  **Files**: `src/runner.js`
  **What**: Extract four top-level async functions out of
  `pollForTasksFIFO` (`src/runner.js:102-246`):
    - `ensureBridgeAlive(flowTabId)` — the 3-attempt ping + reload
      block currently at lines 138-162. Returns `true` on success,
      `false` after exhausting retries post-reload. The caller
      handles the "not ready after reload" early-return.
    - `fetchNextTask(pollUrl, accountToken, mode)` — the HTTP POST
      + JSON-parse + "empty response = no tasks" handling at lines
      164-186. Returns the parsed task object (or `{}` on empty /
      invalid response).
    - `validateTask(task)` — the mode-aware id-and-prompt presence
      check at lines 188-196. Returns `true` if the task has an id
      and a valid prompt for its declared mode.
    - `dispatchTask(task, flowTabId)` — the fire-and-forget chain at
      lines 217-236: increment counter, invoke
      `executeTaskWithSessionGuard`, wire `.then`/`.catch` to call
      `handleTaskCompletedFIFO` / `handleTaskFailedFIFO`, re-poll if
      not stopped. Preserves the `STOP_REQUESTED` skip in the catch
      branch.
  `pollForTasksFIFO` becomes a thin orchestrator (~25 lines): stop
  check → poll-in-progress guard → capacity check → lock
  acquire → tab lookup → `ensureBridgeAlive` → `fetchNextTask` →
  `validateTask` → dedup check → second stop check → second
  capacity check → `dispatchTask` → return result → finally release
  lock.
  **Context**: Do not remove the second capacity check at line 212
  — state can shift during the HTTP call; the audit specifically
  calls this out as "reason about each check in isolation," not
  "delete the duplicate." Keep the stop-flag re-checks in the
  orchestrator (they gate whether to even reach dispatch); phases
  themselves do not need to call `getStopFlag()`. Keep every
  existing `safeLog` message verbatim so the log timeline an
  operator sees is unchanged. The `[runner]` prefix convention is
  already used at lines 53, 56, 118, 213, 218, 222, 229 — preserve
  it. Update the module docstring (lines 1-15) to list the new
  phase functions alongside `activeTaskCount` helpers. The 300 ms
  inter-slot delay in `fillInitialSlots` (line 87) is unrelated —
  leave untouched.

### Phase 3: State and stats consolidation (#8 + #9)

- [x] **Task 3.1: Create `src/state.js` runtime-state module**
  **Files**: `src/state.js` (new), `background.js`
  **What**: New module sibling to `src/settings.js`, owning the
  runtime state audit #8 identified as "not config":
  `isEnabled`, `lastPoll`, `processedJobIds`, `accountTier`
  (the cached tier), `grantedOrigin`. Mirror the `settings.js`
  pattern:
    - Module-scoped cache vars.
    - `loadState()` async function doing a single
      `chrome.storage.local.get([...])` at startup.
    - Named getters for each field (`getIsEnabled`,
      `getLastPoll`, `getProcessedJobIds`,
      `getCachedAccountTier`, `getGrantedOrigin`).
    - Named setters that update the cache **and** persist to
      `chrome.storage.local` in one call
      (`setIsEnabled`, `setLastPoll`,
      `addProcessedJobId`, `setCachedAccountTier`,
      `setGrantedOrigin`, `clearGrantedOrigin`).
    - `addProcessedJobId` preserves the existing bounded-ring
      behavior currently at `src/handlers.js:15-25` (500-entry
      cap — move the constant over with the logic).
  Wire `loadState()` into the same bootstrap path as
  `loadSettings()`. Add `importScripts('src/state.js')` in
  `background.js` right after `src/settings.js` (line 12), so
  anything that currently reads storage runtime-state can see
  `state.js` during its own init.
  **Context**: Style reference is `src/settings.js:22-72`.
  Follow the docstring conventions at `src/settings.js:1-7`.
  `state.js` is for data that mutates during the worker's
  lifetime (toggled by user, written by runner, cached from
  remote). `settings.js` stays for user-chosen configuration.
  Keep the MV3 `chrome.runtime.onStartup` and cold-bootstrap
  call paths in sync — whatever invokes `loadSettings()` should
  also invoke `loadState()`.

- [x] **Task 3.2: Create `src/stats.js` with `bumpStat(key)`**
  **Files**: `src/stats.js` (new), `background.js`
  **What**: New module owning the counters:
    - `async function bumpStat(key)` — reads the `stats` object
      from `chrome.storage.local`, increments
      `stats[key]` (treating missing as 0), writes it back.
    - `async function getStats()` — reads and returns the full
      `stats` object (used by `status.js` in Task 3.4).
    - `async function loadStats()` if a cache is useful —
      optional, only if bump/read performance matters. Default
      to direct read/write on each call; stats are a low-write
      path (one bump per completed/failed/retried task).
  Add `importScripts('src/stats.js')` after `src/state.js` in
  `background.js`.
  **Context**: The audit (#9) lists three call sites to
  collapse: `src/handlers.js:42-48` (`processed`),
  `src/handlers.js:80-86` (`failed`),
  `src/messages.js:87-95` (`retries`). Migrating them is
  Task 3.4 — this task only creates the module. Keep `stats.js`
  separate from `state.js` because counters are append-only
  / write-heavy and state is read-heavy, and because future
  counters (`sessionExpiries`, `contentPolicyRejections` — audit
  mentions both) will be added here without touching state.

- [x] **Task 3.3: Extend `settings.js` cache to own executor settings**
  **Files**: `src/settings.js`, `src/executors/index.js`
  **What**: Add the six executor-facing settings to the
  `settings.js` cache and getters: `outputCount`, `aspectRatio`,
  `imageModel`, `videoModel`, `imgUpscale`, `vidUpscale`.
    - Extend `loadSettings()` (`src/settings.js:22-43`) to pull
      these from `chrome.storage.local` alongside the existing
      webhook/mode/concurrency reads.
    - Add six module-scoped cache vars with sensible defaults
      (match today's in-`ctx` defaults at
      `src/executors/index.js:64-69`).
    - Add six getters. Name them consistently with existing
      style — `getOutputCount`, `getAspectRatio`, etc.
    - Add a single `updateExecutorSettings(message)` that the
      popup / message router can invoke to refresh the cache
      (mirror `updateWebhooks`, `updateConcurrency`, `setMode`
      at `src/settings.js:45-65`). Leave wiring the router to
      call it out of scope — if popup UI doesn't yet, the load-
      at-bootstrap path is enough; the key goal is removing
      the per-task fetch. If a message case already calls
      `loadSettings()` on settings-change, that's sufficient.
    - Replace the direct `chrome.storage.local.get([...])` at
      `src/executors/index.js:57-59` with a single call that
      assembles the same `{ outputCount, aspectRatio,
      imageModel, videoModel, imgUpscale, vidUpscale }` shape
      from the new getters. The destructuring consumers at
      lines 64-69 keep working.
  **Context**: Audit #8 calls out this specific bypass: "reads
  happen on every task execution. Not fast-path expensive, but
  unnecessary." The fix is moving the load to bootstrap and
  serving subsequent reads from cache. Popup's settings-change
  flow already hits the message router — whatever path
  currently invokes `loadSettings()` / `updateWebhooks()` when
  the user changes a webhook is the same path that should also
  invoke the equivalent for executor settings. If no such path
  exists today for these six keys (they rely on fresh reads),
  the cache-via-getters change is still correct — popup writes
  to storage and the worker reads at next startup.

- [x] **Task 3.4: Migrate every remaining `chrome.storage.local` call site**
  **Files**: `src/runner.js`, `src/handlers.js`, `src/status.js`,
  `src/messages.js`, `src/host-permission.js`,
  `src/account-tier.js`
  **What**: Replace every direct
  `chrome.storage.local.get/set` call outside the three state
  modules (settings.js, state.js, stats.js) with a getter/setter
  call from the appropriate module:
    - `src/runner.js:62, :97` — `isEnabled` set → `setIsEnabled(true/false)`.
    - `src/runner.js:126` — `lastPoll` set → `setLastPoll(new Date().toISOString())`.
    - `src/runner.js:201` — `processedJobIds` read → `getProcessedJobIds()`.
    - `src/handlers.js:15-25` — move `markJobAsCompleted`'s
      bounded-ring logic into `state.js` as
      `addProcessedJobId` (already specced in Task 3.1). The
      call site becomes a one-liner.
    - `src/handlers.js:42-48` — `stats` processed bump → `bumpStat('processed')`.
    - `src/handlers.js:80-86` — `stats` failed bump → `bumpStat('failed')`.
    - `src/status.js:19` — single multi-key read → assemble from
      `getIsEnabled()`, `getLastPoll()`, `getStats()`,
      `getProcessedJobIds()`, and `settings.js`'s existing
      `getCurrentMode()` (for `generationMode`). `status.js`
      already has a narrow job (build the popup payload); this
      makes it stay a pure aggregator of getters.
    - `src/messages.js:87-95` — `taskRetrying` retries bump →
      `bumpStat('retries')`. (Part of #6 cleanup, but the
      storage migration happens here.)
    - `src/host-permission.js:18-29` — `grantedOrigin`
      read/set/clear → `getGrantedOrigin()`, `setGrantedOrigin()`,
      `clearGrantedOrigin()`.
    - `src/account-tier.js:48` — `accountTier` cache set →
      `setCachedAccountTier(value)`. Keep the in-module
      `cachedAccountTier` memoized var if it's used as a fast
      path within account-tier.js, but have the tier-detection
      writeback call `setCachedAccountTier` so `state.js` is the
      durable home.
  After this task, `chrome.storage.local.*` calls exist **only**
  inside `src/settings.js`, `src/state.js`, and `src/stats.js`.
  **Context**: The audit's acceptance criterion is
  consolidation, not that every consumer block-reads from one
  module. A call in `status.js` that reaches into three modules
  to assemble a popup payload is fine — the important thing is
  that no consumer reaches into `chrome.storage.local` directly.
  Preserve all existing `safeLog` messages at each site so log
  output is unchanged. A grep for `chrome\.storage\.local` after
  this task should return hits only in the three state modules
  and in `background.js:onInstalled` (which legitimately wipes
  old keys at install).

### Phase 4: Coupling cleanup (#6 + #7)

- [x] **Task 4.1: Replace `onUpscaleStart` with `runner.markSlotFreedForUpscale()`**
  **Files**: `src/runner.js`, `src/executors/index.js`,
  `src/executors/shared.js`
  **What**: Invert the coupling direction at
  `src/executors/index.js:83-89`:
    - Add a top-level async function
      `markSlotFreedForUpscale()` in `src/runner.js`. Body owns
      the existing three-line sequence:
      `decrementActiveTaskCount()`, `safeLog` the slot-freed
      message, and `setTimeout(() => pollForTasksFIFO(), 300)`
      if `!getStopFlag()`. The function is the runner's single
      public verb for "a task just handed its slot back mid-
      flight (upscale is lower priority)."
    - Remove the `onUpscaleStart` closure construction in
      `buildExecutorContext` at
      `src/executors/index.js:83-89`.
    - Remove `onUpscaleStart` from the ctx shape (line 104).
    - In `src/executors/shared.js:172-175`, stop destructuring
      `onUpscaleStart` from ctx. In `upscaleVideos` at line
      188, call `markSlotFreedForUpscale()` directly (it's at
      top-level scope, visible to all modules via
      `importScripts`).
  `runner.js` now owns both the slot counter and the "freed
  slot" verb; executors depend on one narrow symbol instead of
  four runner internals.
  **Context**: Audit #7. Pairs naturally with Phase 2 (#3) —
  after the runner split, runner.js has a clearer public
  surface. The 300 ms re-poll delay and the slot-freed log
  message wording come verbatim from the existing closure at
  `src/executors/index.js:83-89`. Update the executor module's
  docstring at `src/executors/index.js:1-25` to remove the
  `onUpscaleStart` mention; update `shared.js`'s docstring at
  `src/executors/shared.js:1-8` similarly for `upscaleVideos`.

- [x] **Task 4.2: Restore `messages.js` switch-only discipline**
  **Files**: `src/messages.js`, `src/runner.js`, `src/handlers.js`
  **What**: Move the three inline-work cases out of
  `src/messages.js`:
    - **`stopAllProcessing` (lines 25-47).** Extract the
      tab-query + per-tab `stopProcessing` sendMessage IIFE
      into a new `forceStopAllTabs()` async function exported
      from `src/runner.js`. The router case in `messages.js`
      becomes a 4-line delegate that calls `stopPolling()`,
      `forceStopAllTabs()`, resets active-task count if
      applicable (check current behavior), and sends the
      response.
    - **`taskRetrying` (lines 84-97).** Replace the stats-bump
      IIFE with a `bumpStat('retries')` call. (The storage
      migration happens in Task 3.4; the router case in
      `messages.js` still contains the `(async () => { await
      bumpStat('retries'); })()` invocation until removed here,
      when it becomes a one-line direct `await bumpStat(...)`
      before the response send.)
    - **`videoFound` (lines 59-67).** Extract the
      `{ task, videoUrl, isGeneratedImage }` →
      `{ taskId, resultUrl, isGeneratedImage }` shape
      translation into a named adapter in
      `src/handlers.js`. Suggest name
      `handleVideoFoundFIFO(message)` that internally builds
      the target shape and delegates to
      `handleTaskCompletedFIFO`. The router case in
      `messages.js` becomes a single delegate call + response.
  After this task, every case in `messages.js` is a thin router
  delegate — no IIFEs, no shape translations, no storage reads,
  no stats math.
  **Context**: Audit #6. The file's docstring (check current
  content and update) already claims switch-only discipline;
  this task makes the file match its claim. Preserve the
  response-shape conventions each case returns to the caller
  (`{ status: 'ok' }` etc.) — the router contract is
  unchanged, only where the work lives shifts. After both
  `forceStopAllTabs` and `markSlotFreedForUpscale` from Task
  4.1 are in `runner.js`, update its module docstring at
  `src/runner.js:1-15` to list both as the runner's public
  surface (alongside `startPolling`, `stopPolling`,
  `pollForTasksFIFO`, `handleContentReady`).

## Verification

No automated tests cover this extension. After each phase lands,
reload the unpacked extension in Chrome (per
`extensions/youforge-flow/README.md:39-52`) and verify:

**Phase 1 smoke.**
1. **Model keys (#5).** Send one video task in each of the five
   tier/quality combinations your test Flow account can reach
   (or at minimum: lite, pro, ultra-fast). Compare
   `[YouForge Flow]` log lines showing which videoModelKey /
   paygateTier was selected against a before-refactor log. Must
   be identical.
2. **Media fetch (#10).** Submit a completed task that triggers
   `fetchMediaFiles` with both an HTTP URL and a data: URL (or
   two of each). Confirm the webhook submission succeeds end-to-
   end. Hit Stop mid-retry to confirm the `getStopFlag()` check
   at the retry loop still aborts cleanly.

**Phase 2 smoke.**
3. **Runner split (#3).** Send a happy-path task and verify
   every `safeLog` line that appeared pre-refactor still
   appears post-refactor (the log timeline is the behavioral
   contract — no missing or reordered lines). Test each early-
   return path:
   a. Tab closed → "No Flow tab" error returns.
   b. Bridge ping failures → 3 retries + reload + "Content
      bridge not ready after reload" (kill the content script
      via devtools, then trigger a poll).
   c. Empty response → "no valid task" path (let the queue
      run dry).
   d. Duplicate job ID → "already processed - skipping" path
      (resend the same task externally).
   e. Stop flag mid-poll → task never dispatches.
4. **Capacity re-check.** With concurrency set to 1, start a
   long-running task, then trigger a second poll via the alarm.
   Confirm the second poll hits the post-HTTP capacity guard
   and returns `{ atCapacity: true }` instead of double-
   dispatching.

**Phase 3 smoke.**
5. **State roundtrip (#8).** Open the popup; confirm Start/Stop
   toggles `isEnabled` in storage (devtools → Application →
   Storage → Extension), `lastPoll` updates after each alarm
   fire, `processedJobIds` accumulates completions, and the
   popup's stats/tier/lastPoll display matches.
6. **Cache correctness.** Change `aspectRatio` in the popup,
   restart the worker, submit a video task, and confirm the
   request body's aspectRatio matches the new setting (via
   network inspect on the Flow tab). The per-task storage read
   at the old `executors/index.js:57-59` is now a getter call —
   cache must be hot.
7. **Stats counters (#9).** Send one completed task (expect
   `processed` +1), one task that fails (expect `failed` +1),
   one task that retries (expect `retries` +1). Verify the
   popup counter displays match.
8. **Grep gate.** Run
   `rg "chrome\\.storage\\.local" extensions/youforge-flow/src/`
   and confirm the only hits are in `settings.js`, `state.js`,
   `stats.js`, and `background.js` (the `onInstalled` key
   cleanup).

**Phase 4 smoke.**
9. **Upscale slot handoff (#7).** Submit a video task with
   `vidUpscale: "4k"`. In the service-worker devtools, confirm
   the "Slot freed for upscale" log appears once, `active` count
   drops by 1, and a follow-up poll fires 300 ms later. Compare
   to a pre-refactor log — timing and wording unchanged.
10. **Messages router switch-only (#6).** Read through
    `messages.js` and confirm every `case:` body is ≤5 lines and
    contains no IIFE, no `chrome.storage.local`, no
    inline shape-building. Trigger each of the three refactored
    cases (`stopAllProcessing`, `taskRetrying`, `videoFound`)
    via the popup or a test task and confirm end-to-end
    behavior is unchanged.
11. **Stop flag through everything.** Submit a long-running
    video task and hit Stop. Confirm `STOP_REQUESTED`
    propagation still kills the task cleanly through the new
    helper layer, `forceStopAllTabs` fires `stopProcessing` to
    live content scripts, and the popup shows the runner
    stopped.

## References

- Audit source: `docs/refactoring/solid-audit-2026-04-22-youforge-flow.md` (findings #3, #5, #6, #7, #8, #9, #10)
- Prior plan in this series (findings #1, #2, #4 — already landed): `docs/plans/2026-04-22-youforge-flow-executor-refactor.md`
- Original modularization plan (context for the current file split): `docs/plans/2026-04-21-youforge-flow-audit-modularize.md`
- State-module style precedent: `extensions/youforge-flow/src/settings.js`
- Extension README (load/smoke-test instructions): `extensions/youforge-flow/README.md`
- Key files touched:
  - `extensions/youforge-flow/src/runner.js`
  - `extensions/youforge-flow/src/account-tier.js`
  - `extensions/youforge-flow/src/messages.js`
  - `extensions/youforge-flow/src/handlers.js`
  - `extensions/youforge-flow/src/status.js`
  - `extensions/youforge-flow/src/host-permission.js`
  - `extensions/youforge-flow/src/media-fetch.js`
  - `extensions/youforge-flow/src/settings.js`
  - `extensions/youforge-flow/src/executors/index.js`
  - `extensions/youforge-flow/src/executors/shared.js`
  - `extensions/youforge-flow/src/state.js` (new)
  - `extensions/youforge-flow/src/stats.js` (new)
  - `extensions/youforge-flow/background.js` (importScripts additions)
