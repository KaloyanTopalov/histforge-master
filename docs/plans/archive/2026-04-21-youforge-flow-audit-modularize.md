# YouForge Flow: Security Audit and Modularization

## Overview

Split `extensions/youforge-flow/background.js` (1955 lines, ~10 mixed
concerns) into focused modules, consolidate duplicated request-body /
upscale-retry / client-context patterns, and fix a handful of hygiene &
security issues discovered during the audit (wildcard `postMessage`
targets, doubly-installed reCAPTCHA hook, hardcoded Google API key
repeated in two places, dead globals carrying over from upstream).

`extensions/veo-upstream/` is the pristine upstream reference copy and
is **not touched** by this work (per `README.md:55-59`).

## Current State

### File sizes and responsibilities
- `background.js` (1955) — service worker, does everything: settings load,
  lifecycle, permission watchdog, messaging router, auth token plumbing,
  account-tier detection, API task execution per mode, video polling,
  upscale retries, FIFO runner + counters + polling lock, credits poller,
  job-queue bookkeeping, webhook submission, media-fetch → base64.
- `flow-api.js` (346) — declares 7 Flow API wrappers + `safeLog` scrubber.
  Only `checkVideoStatus` (via `pollVideoUntilDone`) and `getCredits`
  (via `pollCreditsOnce`) are actually called. The other 5 wrappers
  (`generateImage`, `startTextToVideo`, `startFramesToVideo`,
  `uploadImage`, `upsampleImage`) are **duplicated inline** inside
  `executeTaskViaAPI` because that path must use a MAIN-world fetcher
  (`apiCallViaPage`) so the reCAPTCHA token is used from the same
  context that minted it (see `background.js:737-770`).
- `content.js` (135) — MAIN world: reCAPTCHA hook + session-token fetch.
- `content-bridge.js` (78) — ISOLATED world: bridge between
  `chrome.runtime.onMessage` and `window.postMessage`.
- `recaptcha-hook.js` (87) — MAIN world at `document_start`: hooks
  `grecaptcha.enterprise.execute` before Google's code loads.
- `popup.html` / `popup.js` (203) / `styles.css` — config form UI.

### Security findings
- **Wildcard `postMessage` targets** in `content.js:52, 59, 71, 78, 134`
  and `content-bridge.js:23, 36`. The session `accessToken` path
  broadcasts its Bearer with `'*'` target. Low severity (same-window,
  same-origin listener would have to be a co-injected MAIN-world script
  from another extension), but trivially tightened to
  `window.location.origin`.
- **Duplicate reCAPTCHA hook**: `recaptcha-hook.js:61-84` (flag
  `enterprise._veoWrapped`) and `content.js:15-42` (flag `_veoHooked`).
  The two use different flag names so they both wrap. Calls go
  wrapped-twice through `execute`. Not broken, but unintended — and
  `content.js` runs at `document_idle` so it can miss early reCAPTCHA
  invocations, making its local `capturedAction` stale vs
  `window.__VEO_LAST_ACTION` from the early hook.
- **Hardcoded Google public API key** `AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY`
  duplicated at `flow-api.js:340` and `background.js:588`. Not a secret
  (labs.google ships it client-side), but DRY.
- **Dead globals**: `cachedRecaptchaToken` / `cachedRecaptchaTime`
  (`background.js:435-436` — defined, never read; `getRecaptchaTokenFromPage`
  always refetches), `isProcessing` (`:19` — only reset, never read),
  `tasksInFlight` (`:29` and 7 other refs at `:227, :287, :1916, :1918,
  :1922, :1923, :1932` — docstring says "for RetryFailed gating" but
  RetryFailed was stripped from upstream per `README.md`; the remaining
  refs are log-string embeds and no-op decrements).
- **Duplicate state: `contentScriptBusy`** — comment at `:31` already
  calls it a "legacy alias". 10 writes across the file: declaration at
  `:31`, explicit `= false` at `:225, :285, :318, :384, :1422, :1462`,
  derived `= activeTaskCount > 0` at `:1221, :1917, :1925, :1935`. Two
  reads at `:1515, :1524` (both inside `getStatus`). Fold out by
  replacing every read with `activeTaskCount > 0` and deleting the
  writes. Most sites are semantics-preserving — the `= false` writes
  at `:225, :285` are adjacent to `activeTaskCount = 0` resets, `:384`
  is removed when `handleContentReady` is trimmed, `:318` and `:1422`
  run when `activeTaskCount` is already zero. The one real semantic
  shift is at `:1462` (`stopPolling`) which does **not** reset
  `activeTaskCount` — after fold-out, `getStatus` will correctly
  report "busy" while in-flight tasks drain post-stop, instead of the
  current misleading "idle". Flag this in the end-of-Phase-1 smoke.
- **`handleContentReady` (`:380-395`) is a no-op on dead keys** — it
  clears `waitingForReload`, `currentTask`, `currentJobId`, which were
  already wiped once by `onInstalled` (`:47-56`) and are never written
  anywhere in this fork. Combined with the `contentScriptBusy` fold-out
  above, the whole function trims to `return { hasTask: false };`.
- **Stale `getStatus` fields**: `currentTask`, `currentJobId`, `jobQueue`
  read at `background.js:1510-1520` but never written anywhere in this
  fork — returning `undefined`/`0` is harmless but dead.
- **`currentMode` is live** (not dead): `:21` (default), `:80` (loaded),
  `:372` (setMode handler), **`:1865` (outbound poll body `mode` filter
  sent to HistForge)**, `:1522` (getStatus fallback). Do not strip.
  Note: no UI control in the current popup actually changes it — it's
  pinned to `'image'` via the `onInstalled` default at `:62`.
- **`onInstalled` legacy-wipe list includes `processedJobIds`** (`:47-56`)
  — but `processedJobIds` is the **live** defensive-dedup list that
  `pollForTasksFIFO:1896` reads and `markJobAsCompleted:1539` writes.
  Every extension upgrade wipes the dedup history. Possibly tolerable
  (HistForge's reaper compensates, and dedup is defensive per
  `:1891-1895`) but worth confirming intent before keeping it in the
  slimmed bootstrapper.
- **`cachedProjectId` has no TTL** (`:439, :498`) — once resolved, never
  refreshed. If the user's Flow project is deleted and recreated, the
  service worker will happily post to a dead project until it's
  restarted. Low probability, low severity; flagging.

### Repetition hotspots
- `clientContext` object literal is inlined **12 times** in two shapes.
  - Full shape (11×): `{ recaptchaContext, projectId, tool:'PINHOLE',
    sessionId, userPaygateTier? }` at
    `background.js:887, 899, 939, 1012, 1056, 1075, 1131, 1144, 1162,
    1182, 1239`.
  - Minimal shape (1×): `{ projectId, tool:'PINHOLE' }` at
    `background.js:801` inside `uploadImageViaPage`. The helper needs
    to accept both.
- Upscale retry loop (3 attempts + 4K→2K/1080p fallback on 403)
  implemented twice: image `:932-985`, video `:1233-1283`. Same shape,
  different API bodies.
- `if (globalStopFlag) throw new Error('STOP_REQUESTED');` appears at
  **7 sites** (`:449, :693, :706, :739, :777, :1302, :1306`). Broader
  `globalStopFlag` refs: 25 total — 7 state-machine mutations (`:24,
  :111, :154, :223, :283, :311, :1423`), 3 `if (!globalStopFlag)`
  continuation checks (`:1225, :1928, :1938`), and 8 other reads
  (early-returns and `break`s inside loops) at `:320, :1446, :1558,
  :1613, :1616, :1671, :1795, :1903`. Only the 7 throw sites are
  candidates for an `assertNotStopped()` helper; the rest become
  `get/set/clearStopFlag()` calls per Task 2.3.
- Mode-dispatch cascade inside `executeTaskViaAPI` (`:705-1295`) is a
  580-line if/else ladder — each branch (createImage, text-only,
  image-to-video, ingredients, frames, unknown) is 60-100 self-contained
  lines that could be pure modules. Mode → executor-file mapping:
  `createimage`/`imagegen` → image; `text` → text-to-video;
  `image`/`ingredients` → image-to-video; `frames` → frames-to-video;
  anything else → text-to-video (fallback per `:1177-1195`). **Plus a
  compound fallback at `:1006`**: if none of `task.referenceImage`,
  `task.startFrame`, `task['Start Frame']`, `task['Image URL']` is
  set, the code routes to text-to-video regardless of declared mode.
  Any dispatcher must preserve this graceful degradation.

### Constraint: MV3 service worker
- `background.js` is a classic (non-module) service worker; it uses
  `importScripts('flow-api.js')` at `:5`. Any split keeps this model
  (no bundler, no ES modules) to minimise load-order risk. Scripts are
  imported in dependency order; each script attaches its exports to the
  worker's global scope.
- Content scripts are separate files declared in `manifest.json:22-40`
  and are already appropriately sized — **not split**.

## Scope

**Doing**
- Security / hygiene cleanup: scoped `postMessage`, deduped reCAPTCHA
  hook, single-source-of-truth for the Google public API key, removal
  of dead globals (`cachedRecaptchaToken`/`Time`, `isProcessing`,
  `tasksInFlight`), folding out the `contentScriptBusy` alias,
  trimming `handleContentReady` / `getStatus` dead branches.
- Extract shared helpers: `buildClientContext`, `upscaleWithFallback`,
  and a dedicated `src/stop-flag.js` module (`assertNotStopped`,
  `getStopFlag`, `set/clearStopFlag`).
- Reconcile `flow-api.js`: delete the 5 unused wrappers (kept in
  `extensions/veo-upstream/flow-api.js` for reference), keep
  `checkVideoStatus` + `getCredits`, move `safeLog` out. File stays
  at extension root for upstream-diff friendliness.
- Split `background.js` into focused modules under
  `extensions/youforge-flow/src/` (15 top-level files plus an
  `executors/` subdirectory of 6 files, for ~21 files total — plus
  the 3 helpers created in Phase 2), loaded via `importScripts` from
  a slim `background.js` bootstrapper.
- Manual smoke test across all four task modes + one upscale path +
  the host-permission-revoked halt path.

**Not doing**
- Any edit to `extensions/veo-upstream/` (reference copy).
- Edits to `content.js`, `content-bridge.js`, `popup.*`, `styles.css`
  beyond the security fixes above — all right-sized already.
- Changing `manifest.json` `optional_host_permissions: ["<all_urls>"]`:
  runtime grant is origin-specific (`popup.js:126`), the manifest entry
  is the *allowlist for what can be requested*, and HistForge deploys
  at arbitrary user URLs (including `http://localhost:3000` for dev).
  Narrowing to `https://*/*` would break local dev.
- Switching to ES modules / bundler (`"type": "module"` in manifest).
  Works, but adds build step and risk without matching upside.
- Adding a test framework for the extension. Validation stays manual
  (load-unpacked + exercise from the HistForge dashboard).
- Changing the webhook protocol or any HistForge-side code.

## Tasks

### Phase ordering

Phases run sequentially and each builds on the prior state of
`background.js`:

- **Phase 1** operates on the monolithic `background.js`. No new files
  yet; Task 1.4's constant is declared at the top of `background.js`
  (it relocates to `src/constants.js` in Task 3.2).
- **Phase 2** creates three new helper files (`src/client-context.js`,
  `src/executors/upscale.js`, `src/stop-flag.js`). The still-monolithic
  `background.js` adds `importScripts(...)` for each one and updates
  its call sites. Task 2.4 deletes the five unused `flow-api.js`
  wrappers but leaves `safeLog` / `_rawLog` in place — the two
  surviving wrappers (`checkVideoStatus`, `getCredits`) still call
  them.
- **Phase 3** disassembles `background.js`. Task 3.1 is the point at
  which `safeLog` moves out of `flow-api.js` into `src/logger.js`.
- **Phase 4** is manual QA, run in a dev Chrome profile against a
  running local HistForge. Run a truncated Task 4.2 (one task per
  mode, no upscale) at the end of Phase 1 to catch regressions from
  the dead-code cleanup before the module split begins, and again at
  the end of Phase 3 before moving to full Phase 4.

### Phase 1: Security and dead-code cleanup

- [x] **Task 1.1: Scope `postMessage` target origins**
  **Files**: `extensions/youforge-flow/content.js`,
  `extensions/youforge-flow/content-bridge.js`
  **What**: Replace `'*'` target in every `window.postMessage(...)` call
  with `window.location.origin`. Source checks via `event.source !== window`
  already exist — this closes the send side.
  **Context**: `content.js:52, 59, 71, 78, 134`;
  `content-bridge.js:23, 36`. The pairs are request (bridge→MAIN) and
  response (MAIN→bridge); both hops are same-window, same-origin, so
  origin restriction is tight.

- [x] **Task 1.2: Single reCAPTCHA hook**
  **Files**: `extensions/youforge-flow/content.js`,
  `extensions/youforge-flow/recaptcha-hook.js`
  **What**:
  - Delete `hookRecaptcha` and its retry interval in `content.js:15-42`.
  - Delete the now-orphaned `capturedAction` variable at `content.js:9`.
  - Update `getRecaptchaToken` (`content.js:87-108`) to read
    `window.__VEO_LAST_ACTION` (already set by `recaptcha-hook.js`) as
    the captured-action fallback instead of `capturedAction`.
  - Drop the `capturedAction` reference in the debug log at `content.js:49`
    (replace with the requested action, or remove).
  **Context**: `recaptcha-hook.js` runs at `document_start` and already
  owns the hook via `enterprise._veoWrapped`. `content.js` runs at
  `document_idle` with a different flag (`_veoHooked`), causing a
  double-wrap. Removing the late hook is a no-op for correctness and
  eliminates the conflict.

- [x] **Task 1.3: Strip dead globals, duplicate state, and stale fields**
  **Files**: `extensions/youforge-flow/background.js`
  **What**:
  - Remove `cachedRecaptchaToken`, `cachedRecaptchaTime` (`:435-436`)
    — defined, never read; `getRecaptchaTokenFromPage` always refetches.
  - Remove `isProcessing` (`:19, :1561`) — only written, never read.
    Note the `isProcessing:` *property* in the `getStatus` return at
    `:1515` is a separate field (assigned from `contentScriptBusy`); it
    stays until the getStatus trim below.
  - Remove `tasksInFlight` (`:29, :227, :287, :1916, :1918, :1922,
    :1923, :1932`) — 8 refs total; delete the declaration, the two
    resets inside stop handlers, the increment, the two decrements,
    and drop the `inFlight:` segment from the two log strings at
    `:1918, :1923`. The RetryFailed gating path was stripped from
    upstream per `README.md:10-14`.
  - Fold out `contentScriptBusy` alias. All 10 writes go
    (`:31` declaration; explicit `= false` at `:225, :285, :318,
    :384, :1422, :1462`; derived `= activeTaskCount > 0` at
    `:1221, :1917, :1925, :1935`). Both reads in `getStatus`
    (`:1515, :1524`) are covered by the `getStatus` trim below —
    `isProcessing` becomes `activeTaskCount > 0`, and the separate
    `contentScriptBusy` field drops entirely. Fold-out is
    semantics-preserving at every write except `:1462` (`stopPolling`),
    which is an intentional improvement: the popup will now report
    "busy" while in-flight tasks drain after Stop, instead of the
    current misleading "idle". `:384` dies with `handleContentReady`'s
    trim below; the writes at `:225, :285, :318, :1422` are all
    adjacent to (or immediately followed by) `activeTaskCount` resets,
    so the derived form agrees.
  - Trim `handleContentReady` (`:380-395`) to just
    `return { hasTask: false };` — preserve the current behavior (no
    `activeTaskCount` reset on content-script reload; the original
    code never touched the active counter either). The
    `chrome.storage.local.set` block clears keys (`waitingForReload`,
    `currentTask`, `currentJobId`) already wiped by `onInstalled:47-56`
    and never written in this fork; the `contentScriptBusy = false`
    assignment dies with the alias fold-out above.
  - Trim `getStatus` (`:1507-1528`) to fields actually written:
    `isEnabled`, `stats`, `lastPoll`, `generationMode`,
    `processedJobIds` (len), plus runtime flags (`sessionExpired`,
    `hostPermissionRevoked`, `activeTaskCount > 0` as the new
    processing signal). Drop `currentTask`, `currentJobId`, `jobQueue`
    reads.
  - **Leave `currentMode` alone** — `:1865` uses it as the outbound
    poll body's `mode` filter to HistForge, and `:1522` uses it as a
    fallback. It's moved to `src/settings.js` in Task 3.3, not stripped.
  **Context**: Grep after each deletion — nothing should reference the
  removed symbols. The end-of-Phase-1 mini-smoke test (per the Phase
  ordering note above) covers regressions from this task before Phase
  2 begins.

- [x] **Task 1.4: DRY the Google public API key**
  **Files**: `extensions/youforge-flow/flow-api.js`,
  `extensions/youforge-flow/background.js`
  **What**: Declare `const GOOGLE_LABS_API_KEY = '…';` at the top of
  `background.js` (service-worker global scope, pre-Phase-3 home).
  Reference it from both `flow-api.js:340` (`getCredits`) and
  `background.js:588` (`detectAccountTier`). Relocates to
  `src/constants.js` in Task 3.2.
  **Context**: The key is labs.google's client-side public key — not
  a secret — but keeping it in one place means a single edit if
  Google rotates it. Both sites inline the same literal today.

### Phase 2: Extract shared helpers

- [x] **Task 2.1: `buildClientContext` helper**
  **Files**: new `extensions/youforge-flow/src/client-context.js`;
  caller edits in `background.js`
  **What**: Helper returning the `clientContext` object literal with
  optional `recaptchaContext`, `sessionId`, and `userPaygateTier`.
  Replaces all 12 inline copies (11 full-shape + 1 minimal variant in
  `uploadImageViaPage`).
  **Context**: Three shape variants to cover:
  - Image-gen (no `userPaygateTier`) at `:887-890, :899-902` —
    `{ recaptchaContext, projectId, tool, sessionId }`.
  - Full with paygate at `:939-944` (image upscale) and `:1012-1015,
    :1056-1059, :1075-1078, :1131-1134, :1144-1147, :1162-1165,
    :1182-1185, :1239-1242` (video-gen variants + video upscale) —
    the same four fields plus `userPaygateTier`.
  - Minimal at `:801-804` (uploadImage) — `{ projectId, tool }` only.
  Helper signature ~ `buildClientContext({ projectId, recaptchaToken?,
  sessionId?, paygateTier? })`; omit any field whose corresponding
  argument is falsy so the minimal shape falls out automatically.

- [x] **Task 2.2: `upscaleWithFallback` helper**
  **Files**: new `extensions/youforge-flow/src/executors/upscale.js`;
  caller edits in the image-gen and video-gen executors (Phase 3.9)
  **What**: Generic 3-attempt retry with 4K→(2K|1080p) fallback on 403.
  Takes an `apiCall` function, target/fallback resolutions, and a
  success detector; returns the final result or `null`. The two
  current loops (`:932-985`, `:1233-1283`) collapse into one call each.
  **Context**: Image fallback goes 4K→2K; video fallback goes
  4K→1080p and also swaps `upscaleModel` (`:1273`). Parameterise both.

- [x] **Task 2.3: `src/stop-flag.js` module**
  **Files**: new `extensions/youforge-flow/src/stop-flag.js`
  **What**: Own `globalStopFlag` and expose `getStopFlag`, `setStopFlag`,
  `clearStopFlag`, and `assertNotStopped()` (which throws
  `STOP_REQUESTED` when the flag is set). Replaces the 7 inline throw
  sites at `:449, :693, :706, :739, :777, :1302, :1306`. The 7 flag
  mutations (`:24, :111, :154, :223, :283, :311, :1423`) become
  `set/clearStopFlag()` calls. The remaining 11 reads — early-return
  checks at `:320, :1671, :1795, :1903`, `break` checks at
  `:1446, :1613, :1616`, the log-ternary at `:1558`, and the three
  `if (!globalStopFlag)` continuation checks at `:1225, :1928, :1938`
  — become `getStopFlag()` / `!getStopFlag()` reads.
  **Context**: Dedicated module chosen over parking in `runner.js`
  because writers span four target modules: `webhook.notifySessionExpired`
  (`:154`), `host-permission.halt_onHostRemoved` (`:111`),
  `messages.js` cases `stopAllProcessing` / `autoStopped` /
  `manualPoll` (`:223, :283, :311`), and `runner.startPolling` (`:1423`).
  Loaded early (between `constants.js` and `settings.js` in the Task
  3.17 order) so every downstream module can import it cleanly.

- [x] **Task 2.4: Delete unused `flow-api.js` wrappers**
  **Files**: `extensions/youforge-flow/flow-api.js`
  **What**: Remove `generateImage`, `startTextToVideo`,
  `startFramesToVideo`, `uploadImage`, `upsampleImage` (unused — the
  live code paths use inline MAIN-world equivalents). Keep
  `checkVideoStatus`, `getCredits`, `apiHeaders`, `sessionExpiredError`,
  `AISANDBOX_BASE`, **and `safeLog` / `_rawLog`**. After deletion only
  `checkVideoStatus:241` still calls `safeLog` — the other seven sites
  (`:88, 106, 143, 154, 200, 211, 301`) go with their deleted wrappers,
  and `getCredits` doesn't log. One surviving call is enough to keep
  `safeLog` defined in `flow-api.js` through Phase 2; it relocates to
  `src/logger.js` only in Task 3.1, after the logger is loaded first in
  the new `importScripts` order.
  **Context**: The upstream versions remain intact in
  `extensions/veo-upstream/flow-api.js` for any future revival.

### Phase 3: Split background.js

Target layout: all new files under `extensions/youforge-flow/src/`,
loaded in order via `importScripts(...)` from a ~50-line
`background.js` bootstrapper. The bootstrapper keeps only a trimmed
`onInstalled` legacy-key wipe (Task 3.17 drops `processedJobIds` from
the list) and a `loadSettings()` kickoff.

Proposed module split and dependencies:

- [x] **Task 3.1: `src/logger.js`**
  **Files**: new `src/logger.js`; remove from `flow-api.js:5-23`
  (leave the `:1-4` file-header comments in place).
  **What**: `safeLog`, `_rawLog`. No deps; imported first. The
  `sessionExpiredReported` flag and `clearSessionExpiredReport` live
  in `src/webhook.js` per Task 3.11, not here — mentioned only because
  the current co-location in flow-api.js is accidental.

- [x] **Task 3.2: `src/constants.js`**
  **Files**: new `src/constants.js`
  **What**: `AISANDBOX_BASE` (dup'd `flow-api.js:25` — consumed by
  `src/executors/*.js` and `src/page-call.js` when building URLs;
  `flow-api.js` keeps its own copy at `:25` so future upstream diffs
  against `extensions/veo-upstream/flow-api.js` stay noise-free per
  Task 3.17), `GOOGLE_LABS_API_KEY` (relocated from its Task 1.4 home
  in `background.js`), `FLOW_URL` (`background.js:16`),
  `POLL_INTERVAL_MINUTES` (`:17`), `CREDITS_POLL_MS` (`:1470`),
  `MAX_CONCURRENT_MAX = 10`. Do **not** mirror `RECAPTCHA_SITE_KEY`
  here — the service worker never references it (grep-confirmed);
  it is owned by `content.js:8` and used only at `content.js:102`.
  A mirror would add a drift risk with no consumer.

- [x] **Task 3.3: `src/settings.js`**
  **Files**: new `src/settings.js`; move `background.js:7-14, 21, 27,
  66-88` + webhook/concurrency/setMode applier cases from the message
  router. (Line 28, `activeTaskCount`, stays out — it belongs to
  `runner.js` per Task 3.14.)
  **What**: Module-scoped `POLL_URL`, `RESULT_URL`, `STATUS_URL`,
  `ACCOUNT_TOKEN`, `MAX_CONCURRENT`, `currentMode`. Exposes getters.
  `loadSettings`, `updateWebhooks`, `updateConcurrency`, `setMode`
  functions.
  **Context**: These globals are read by the webhook, auth, executor,
  and runner modules (runner also uses `currentMode` + `ACCOUNT_TOKEN`
  to build the outbound poll body in `pollForTasksFIFO`). Preserve
  the existing double-fire `loadSettings` pattern
  (`chrome.runtime.onStartup` listener for service-worker wake, plus
  a direct call from the bootstrapper for cold load) — both are
  intentional for MV3 service-worker lifecycle.

- [x] **Task 3.4: `src/host-permission.js`**
  **Files**: new `src/host-permission.js`; move `background.js:96-125`
  **What**: `halt_onHostRemoved`, `noteHostAdded`, `pathsStartsWithOrigin`,
  `hostPermissionRevoked` flag, and the two
  `chrome.permissions.on{Removed,Added}` listener wires.
  **Context**: Runtime deps: `stop-flag.setStopFlag()` (replaces the
  `globalStopFlag = true` at `:111`) and `runner.stopPolling()`
  (replaces the call at `:112`). Reads `grantedOrigin` directly from
  `chrome.storage.local` — no dependency on `settings.js` / ACCOUNT_TOKEN
  despite the grep neighbourhood.

- [x] **Task 3.5: `src/control-panel.js`**
  **Files**: new `src/control-panel.js`; move `background.js:20, 168-200`
  **What**: `openControlPanel`, `controlPanelWindowId` bookkeeping,
  `chrome.action.onClicked` listener.

- [x] **Task 3.6: `src/auth.js`**
  **Files**: new `src/auth.js`; move `background.js:435-570` **minus**
  `:440` (`cachedAccountTier`, which moves to `account-tier.js` per
  Task 3.7).
  **What**: `getFlowTabId`, `getRecaptchaTokenFromPage`,
  `getSessionTokenFromPage`, `getProjectIdCached`, `cachedSessionToken`
  + `cachedSessionTime` + `cachedProjectId`.
  **Context**: After Task 1.3 removes `cachedRecaptchaToken`/`Time`.
  Runtime deps on `webhook.js`: `getSessionTokenFromPage` calls
  `webhook.clearSessionExpiredReport()` on success (`:480`) and
  `webhook.notifySessionExpired()` on failure (`:485, :491`). Because
  `webhook.js` loads before `auth.js`, these are ordinary forward refs
  at load time.

- [x] **Task 3.7: `src/account-tier.js`**
  **Files**: new `src/account-tier.js`; move `background.js:572-680`
  plus the `cachedAccountTier` declaration at `:440` (carved out of
  Task 3.6's auth block).
  **What**: `detectAccountTier`, `cachedAccountTier`, `getVideoModelKeys`,
  and a `clearCachedTier()` export so the `messages.js` handlers for
  `stopAllProcessing` (current reset at `:228`) and `autoStopped` can
  null the cache through a named API instead of reaching into another
  module's internal state. Uses auth (for session token) + constants
  (for API key).

- [x] **Task 3.8: `src/page-call.js`**
  **Files**: new `src/page-call.js`; move `background.js:737-832`
  **What**: Pure helpers extracted from the closures inside
  `executeTaskViaAPI`:
  - `apiCallViaPage({ tabId, authToken, url, body })` — MAIN-world
    fetch, returns parsed JSON or throws with `status: text`.
  - `uploadImageViaPage({ tabId, authToken, projectId, imageUrl,
    filename })` — background-world fetch of `imageUrl`, base64
    encode, then MAIN-world POST to `flow/uploadImage`. Returns the
    `media.name` media ID.
  Replaces the inline closures that close over `tabId`/`authToken`/
  `projectId` today (`:738, :776-832`).

- [x] **Task 3.9: Executors per mode**
  **Files**: new
  `src/executors/{image,text-to-video,image-to-video,frames-to-video,upscale}.js`;
  new `src/executors/index.js` as dispatcher; new
  `src/executors/shared.js` for cross-executor helpers
  **What**: Split `executeTaskViaAPI` (`:705-1295`) on its mode
  branches. Each file exports `async run(task, ctx)` where
  `ctx = { tabId, authToken, projectId, sessionId, recaptchaToken,
  modelKeys, settings, pageCall, uploadImage, getRecaptcha }`. The
  dispatcher at `index.js` owns the shared preamble (get tokens, fetch
  project id, compute session id, read storage settings, build model
  keys) and picks the right executor in this order:
  1. **Missing-images fallback** (preserve the compound check at
     `:1006`): if `!task.referenceImage && !task.startFrame &&
     !task['Start Frame'] && !task['Image URL']` and mode is not
     `createimage` / `imagegen`, route to `text-to-video.js`
     regardless of declared mode. A task with mode `image` /
     `ingredients` / `frames` but no images today degrades to
     text-to-video instead of failing at upload; losing this would be
     a behavior change.
  2. Otherwise, dispatch by mode:
     - `createimage`, `imagegen` → `image.js`
     - `text` → `text-to-video.js`
     - `image`, `ingredients` → `image-to-video.js` (share the branch
       at `:1028`, with the lite/non-lite split preserved)
     - `frames` → `frames-to-video.js` (start-only vs start+end split
       preserved)
     - *anything else* → `text-to-video.js` (the current fallback at
       `:1177-1195`)
  **Context**: The three video branches share the `startResult`
  collection pattern — extract a `toMediaIds(result, projectId)` helper
  in `src/executors/shared.js`. Upscale (image + video) lives in its
  own file per Task 2.2; the mode-executor calls into
  `upscale.imageWithFallback` / `upscale.videoWithFallback` after its
  primary generation completes.

- [x] **Task 3.10: `src/poll-video.js`**
  **Files**: new `src/poll-video.js`; move `background.js:1297-1394`
  **What**: `pollVideoUntilDone` with its interruptible-sleep loop and
  `getMediaUrlRedirect` fallback. Takes `(authToken, mediaIds, taskId,
  tabId)`.
  **Context**: Calls `checkVideoStatus` from the trimmed `flow-api.js`.

- [x] **Task 3.11: `src/webhook.js`**
  **Files**: new `src/webhook.js`; move `background.js:135-162`
  (`postStatusEvent`, `notifySessionExpired`) + `:1678-1715`
  (submitResult retry loop body — the `for` loop only) +
  `:1755-1770` (failure submission)
  **What**: All outbound HistForge HTTP. Exports `postStatusEvent`,
  `submitResult`, `submitFailure`, `notifySessionExpired`,
  `clearSessionExpiredReport`. Owns the `sessionExpiredReported`
  de-dup flag.
  **Context**: The submit-result flow's post-loop `markJobAsCompleted`
  + stats writes (`:1717-1731`) stay in `handlers.js` (Task 3.15);
  `webhook.submitResult` returns a success boolean that the handler
  branches on.
  **Runtime forward-refs**: `notifySessionExpired` calls
  `runner.stopPolling` and `stop-flag.setStopFlag()` — both modules
  load *after* `webhook.js` in the Task 3.17 order. This works because
  the references resolve at call time, not parse time; the plan
  intentionally accepts this circular edge rather than splitting
  `notifySessionExpired` between files. Do not try to "fix" the load
  order by moving webhook later — `auth.js` loads after webhook and
  needs `clearSessionExpiredReport` at call time from
  `getSessionTokenFromPage`.

- [x] **Task 3.12: `src/media-fetch.js`**
  **Files**: new `src/media-fetch.js`; move `background.js:1564-1665`
  **What**: The MAIN-world fetch+base64 logic for result URLs, including
  data-URL handling (`:1591-1602`). Exports
  `async fetchMediaFiles(resultUrl): Promise<MediaFile[]>`.

- [x] **Task 3.13: `src/credits-poller.js`**
  **Files**: new `src/credits-poller.js`; move `background.js:1470-1505`
  **What**: `startCreditsPolling`, `stopCreditsPolling`,
  `pollCreditsOnce`, `creditsPollTimer`.

- [x] **Task 3.14: `src/runner.js`**
  **Files**: new `src/runner.js`; move `background.js:1400-1464` +
  `:1790-1954`
  **What**: `activeTaskCount`, `pollingInProgress`, `pollForTasksFIFO`,
  `startPolling` (with its inner `fillInitialSlots` helper at
  `:1444-1452`), `stopPolling`, `chrome.alarms.onAlarm` listener, and
  `handleContentReady` (trimmed per Task 1.3). Exposes counter
  accessors so executors can decrement slots on upscale
  (`:1219-1227`). `globalStopFlag` and `assertNotStopped` live in
  `src/stop-flag.js` (Task 2.3), not here. After Task 1.3,
  `contentScriptBusy` is gone and callers check `activeTaskCount > 0`
  directly.
  **Context**: The fire-and-forget `.then().catch()` bookkeeping at
  `:1921-1942` drives the self-refilling pump — keep this contained
  inside `pollForTasksFIFO`.

- [x] **Task 3.15: `src/handlers.js`**
  **Files**: new `src/handlers.js`; move `background.js:1535-1550`
  (`markJobAsCompleted`) + `:1557-1740` (`handleTaskCompletedFIFO`
  shell — **minus** the media-fetch block at `:1564-1665` that goes
  to `media-fetch.js` per Task 3.12 **and minus** the submitResult
  retry loop body at `:1678-1715` that goes to `webhook.js` per Task
  3.11; the post-loop `markJobAsCompleted` + stats writes at
  `:1717-1731` stay here) + `:1742-1784` (`handleTaskFailedFIFO`; its
  `fetch(RESULT_URL, …)` at `:1755-1770` becomes the
  `webhook.submitFailure` call-site).
  **What**: Task-completion orchestration + dedup/stats writes.
  Delegates media retrieval to `media-fetch.js` and webhook I/O to
  `webhook.js`; writes `stats` and `processedJobIds` to
  `chrome.storage.local` directly (no repo layer in the extension).

- [x] **Task 3.16: `src/messages.js`**
  **Files**: new `src/messages.js`; move `background.js:206-377`
  **What**: `chrome.runtime.onMessage` router switch. Each case
  delegates to its owning module (`settings.updateWebhooks`,
  `runner.startPolling`, `handlers.handleTaskCompletedFIFO`, etc.).
  Target: switch + `sendResponse` only, no business logic inline.

- [x] **Task 3.17: Slim `background.js` bootstrapper**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: Replace with `importScripts(...)` list in the dependency
  order below, plus a trimmed `onInstalled` legacy-key wipe and the
  `loadSettings()` kickoff. Target: ~50 lines.
  **Trim the `onInstalled` wipe list**: remove `processedJobIds` from
  the cleared keys (current list at `background.js:47-56`). The
  remaining entries (`manualModeState`, `jobQueue`, `currentJobId`,
  `currentTask`, `waitingForReload`, `dismissedVersion`,
  `pendingRetryTask`) are all upstream-era keys that stay in the wipe.
  Dropping `processedJobIds` preserves the defensive dedup across
  extension upgrades; HistForge's reaper is what guarantees safety on
  redispatch, not the wipe.
  Keep `flow-api.js` at the extension root (`extensions/youforge-flow/
  flow-api.js`) rather than moving under `src/`, so future upstream
  diffs against `extensions/veo-upstream/flow-api.js` stay
  straightforward.
  **Context**: Proposed order (leaves-first):
  `src/logger.js` → `src/constants.js` → `src/stop-flag.js` →
  `src/settings.js` → `src/webhook.js` → `src/host-permission.js` →
  `src/control-panel.js` → `src/auth.js` → `src/account-tier.js` →
  `src/page-call.js` → `flow-api.js` → `src/poll-video.js` →
  `src/client-context.js` → `src/executors/shared.js` → each
  `src/executors/{mode}.js` → `src/executors/upscale.js` →
  `src/executors/index.js` → `src/media-fetch.js` → `src/handlers.js`
  → `src/credits-poller.js` → `src/runner.js` → `src/messages.js`.
  **Runtime forward-refs accepted in this order** (all resolve at call
  time, not parse time):
  - `webhook.notifySessionExpired` → `runner.stopPolling`,
    `stop-flag.setStopFlag`
  - `host-permission.halt_onHostRemoved` → `runner.stopPolling`,
    `stop-flag.setStopFlag`
  - `messages.js` handlers → `runner.*`, `handlers.*`, `settings.*`,
    `control-panel.*`
  Do not reshuffle the order to eliminate these — webhook must load
  before auth (Task 3.6 dep), and runner must load after executors.

### Phase 4: Manual QA

- [ ] **Task 4.1: Load unpacked**
  **What**: In a dev Chrome profile, `chrome://extensions` → Load
  unpacked → `extensions/youforge-flow/`. Confirm no load errors in
  the service-worker DevTools console. Open popup; paste the three
  webhook URLs + token from a running local HistForge; click Grant;
  click Start.

- [ ] **Task 4.2: Smoke-test each mode**
  **What**: From the HistForge queue, dispatch one task per mode — a
  `createimage` (or `imagegen`), a `text`, an `image` (or
  `ingredients`), and a `frames` task — to this account. Mode strings
  match what the `pollForTasksFIFO` validator in `src/runner.js`
  accepts (lowercase, with the `imagegen`/`createimage` synonyms).
  Verify each drains, `resultUrl` + `mediaFiles[].base64` reach
  `/api/flow/submit-result`, stats tick up, service-worker log shows
  no "session expired" false positives.
  **Context**: HistForge protocol is in
  `src/app/api/flow/next-task/[token]/route.ts` and
  `src/app/api/flow/submit-result/[token]/route.ts`.

- [ ] **Task 4.3: Upscale fallback**
  **What**: In storage (there's no UI control), set `vidUpscale = '4k'`
  and run one `image` (image-to-video) task; verify the upscale retry
  either lands 4K or falls back to 1080p on 403 and still submits a
  result URL. Repeat for `imgUpscale = '4k'` on a `createimage` task.

- [ ] **Task 4.4: Host-permission revocation halt**
  **What**: While polling, revoke the HistForge origin via
  chrome://extensions → Details → Site access. Expect popup status
  line to show "Error: HistForge host permission revoked" within one
  `STATUS_REFRESH_MS` tick (see `popup.js`), and the service worker to
  stop polling (via `halt_onHostRemoved` in `src/host-permission.js`).
  Re-grant from popup; verify Start re-enables and a subsequent task
  executes.

## References
- `extensions/youforge-flow/README.md:10-38` — what was stripped from
  upstream and why.
- `extensions/youforge-flow/manifest.json` — current permissions /
  content-script wiring.
- `extensions/veo-upstream/` — pristine upstream, **do not edit**.
- `docs/plans/2026-04-20-google-flow-hybrid.md:60-75` — the fork's
  original intent; what stays live vs what was ripped out.
- `docs/setup-google-flow.md` — end-user setup walkthrough; Task 4.x
  exercises this flow end-to-end.
- HistForge side of the protocol (not in scope for edits, but referenced
  by Task 4.2): `src/app/api/flow/next-task/[token]/route.ts`,
  `src/app/api/flow/submit-result/[token]/route.ts`,
  `src/app/api/flow/status/[token]/route.ts`.
