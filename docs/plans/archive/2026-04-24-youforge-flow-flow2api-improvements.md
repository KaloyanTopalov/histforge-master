# YouForge Flow: Improvements ported from flow2api

## Overview

A sibling Python proxy project `extensions/flow2api/` wraps the same Google
Flow endpoints (`labs.google` / `aisandbox-pa.googleapis.com`) that our
Chrome extension `extensions/youforge-flow/` drives. flow2api has had more
production time against the upstream API and carries several patterns
the extension does not yet have: structured error parsing, per-attempt
timing traces, intermediate progress streaming, a consecutive-error
circuit breaker, a 429 cool-off, explicit per-call timeouts, MIME
magic-byte detection, and configurable polling intervals.

This plan ports the applicable ones back, reframes a few (flow2api uses
fixed retry delays, not exponential — we'll do proper backoff+jitter
since we're adding the helper anyway), and skips the pieces that don't
apply to a single-account logged-in browser runner (token load
balancing, project pooling, captcha provider abstraction, UA spoofing).

The four phases are ordered so each builds on the last. Phase 1 lands
the error/observability surface the other phases emit into. Phase 2
wraps network calls in resilient primitives. Phase 3 layers
quota/rate-limit guards on top of those primitives. Phase 4 exposes
settings and UX polish once everything underneath is stable.

## Current State

**Architecture.** Chrome MV3 service worker loaded via classic
`importScripts` from `extensions/youforge-flow/background.js`. No
bundler, no ES modules, single global scope. Load order leaves-first
(`background.js:9-37`). Adding a new module = add an `importScripts`
line in the correct position.

**Error handling today.**
- `flow-api.js:38` short-circuits on HTTP 401 to `sessionExpiredError`
  *before* the body is read; `flow-api.js:41` then forwards a raw
  error-body substring for every other non-ok status. `page-call.js:42`
  (MAIN-world `apiCallViaPage` error packaging), `page-call.js:55-56`
  (service-worker `apiCallViaPage` re-throw of the MAIN-world error),
  and `page-call.js:110-113` (service-worker `uploadImageViaPage`
  upload failure) do the same — no attempt to parse Google's `{"error":
  {"message": "...", "details": [{"reason": "..."}]}}` envelope.
- `webhook.js:103-123` `submitFailure()` posts `error: string` only.
  `runner.js:238` drops the Error object before the handler fires,
  and `handlers.js:68-70` comment explicitly defers classification to
  HistForge — HistForge gets no structured data to classify on.
- `poll-video.js:78-83` recognizes only `CHILD_DANGER` and `SAFETY`.
- flow2api extracts the first `error.details[].reason` string at
  `extensions/flow2api/src/services/flow_client.py:286-311` and
  concatenates it with `error.message` — it forwards Google's raw
  reason verbatim (`RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`,
  `QUOTA_EXCEEDED`, `INVALID_ARGUMENT`, `UNAUTHENTICATED`, etc.)
  rather than mapping to an internal taxonomy. The stable-code
  taxonomy in Task 1.1 is a YouForge addition, not a direct port.

**Retry / timeout today.**
- `webhook.js:91` uses linear `5000 * attempt` (5s, 10s).
- `poll-video.js:12-13` fixed `MAX_POLL_ATTEMPTS=120`, `POLL_INTERVAL=5000`.
- `shared.js:113-165` upscale: fixed 3-attempt / 3s-delay via
  `upscaleWithFallback()` in `src/executors/upscale.js`.
- `page-call.js:66-119` `uploadImageViaPage()` — one attempt, no retry.
- No `fetch` call in the codebase sets an explicit timeout or uses
  `AbortController`. A hung upstream request parks a concurrency slot
  indefinitely.
- flow2api has split per-call timeouts
  (`config.flow_image_request_timeout=40s`,
  `config.flow_timeout=120s`) at
  `extensions/flow2api/src/core/config.py:56-92`.

**Observability today.**
- `stats.js` tracks lifetime `processed / failed / retries` only.
- No per-task timing trace; no request correlation ID threaded
  through logs and webhook payloads.
- No periodic `progress` status event during the up-to-10-minute
  video-polling window in `poll-video.js`.
- flow2api yields SSE `生成进度: {progress}%` chunks every 7 poll
  attempts (~21s) at
  `extensions/flow2api/src/services/generation_handler.py:1709-1714`.

**Quota / rate limits today.**
- `credits-poller.js:30-59` fetches credits every 60s and reports them
  to HistForge, but does not pause polling when credits hit zero.
- 429 responses from `aisandbox-pa` are forwarded as generic 4xx
  errors. No local cool-off; polling continues to hammer the account.
- No consecutive-error circuit breaker. A token that starts failing
  every request keeps consuming slots until the user manually stops.
- flow2api auto-disables a token after `admin_config.error_ban_threshold`
  (default 3) consecutive errors at
  `extensions/flow2api/src/services/token_manager.py:636-649`, and
  hard-bans for 12 hours on 429 at `token_manager.py:659-671`.

**Configurability today.**
- `constants.js:POLL_INTERVAL_MINUTES=0.1667` (10s), `poll-video.js`
  5s×120, `webhook.js` 3 retries×(5s linear), `shared.js` upscale
  3×3s — all hardcoded. flow2api has all of these as TOML keys.

**Uploads today.**
- `page-call.js:76` uses `blob.type || 'image/png'` for MIME. Image
  URLs coming from some backends (data URIs that lack type hint,
  signed S3 URLs with opaque `application/octet-stream`, etc.) produce
  an empty or wrong `blob.type`. flow2api detects via magic bytes
  (PNG 89 50 4E 47, JPEG FF D8 FF, WEBP RIFF...WEBP, GIF, BMP, JP2) at
  `extensions/flow2api/src/services/flow_client.py:723-754`.

**Session token today.**
- `auth.js:12-13, 36` caches for 5 minutes — far shorter than Google's
  ~1-hour tokens, so we re-fetch ~12× more than needed. The session
  response from `content.js:99-104 getSessionToken()` already returns
  an `expires` field, but `auth.js:44` only reads `accessToken` and
  discards the rest.
- `auth.js:53, 59` and `webhook.js:37-44` halt globally on the first
  failed `chrome.tabs.sendMessage` round-trip. No retry before
  declaring the session dead.

**Account tier today.**
- `account-tier.js:131-143 getVideoModelKeys()` does a MODEL_MATRIX
  lookup. Every row carries both `r2v_portrait` and `r2v_landscape`,
  so `isPortrait = aspectRatio === 'portrait'` at `:132` silently
  coerces *any* unexpected aspect string (e.g., `'square'`, `'1:1'`)
  to landscape with no warning. Unknown tiers separately fall back to
  `ultra` at `:63`. flow2api's video-model resolver explicitly
  coerces unknown aspect strings to `"landscape"` with a log line at
  `extensions/flow2api/src/core/model_resolver.py:479-496` (lines
  449-456 are the orthogonal *image-size* fallback; 459-464 is a
  separate MODEL_CONFIG-membership fallback — neither is aspect).

**Project ID today.**
- `auth.js:65-122` re-derives the project ID on every task via URL
  regex then tRPC call. No cache layer — a fresh tRPC round-trip per
  task even though the project ID effectively never changes for a
  given labs.google session.

## Scope

**Doing.**
- Error-reason parsing, structured failure payload, taxonomy
  expansion.
- Per-attempt timing trace, request correlation IDs, intermediate
  progress events, bridge-reload telemetry, daily stats rollup,
  verbose-logging toggle.
- `fetchWithTimeout` helper, `retryWithBackoff` helper (exponential +
  jitter), applied to upload / webhook / upscale / session-fetch.
- Jittered / progressively-spaced video polling.
- Hardened media-URL resolution chain.
- Longer session-token cache (bounded by expiry), pre-halt re-fetch.
- MIME magic-byte detection fallback on image upload.
- Consecutive-error circuit breaker, 429 cool-off, credits-exhausted
  pause, soft launch-gate stagger.
- Settings surface for intervals / retries / thresholds; per-scenario
  (image vs video) timeouts.
- Project-ID TTL cache.
- Aspect-ratio graceful fallback in the model-key matrix.
- Chrome notification on session expiry.
- Popup "Test connection" button.

**Not doing.**
- Multi-token load balancing, project pooling, round-robin accounts —
  YouForge is deliberately single-account-per-extension.
- Captcha provider abstraction (YesCaptcha / CapMonster / etc.) — the
  extension runs logged-in in the browser; reCAPTCHA Enterprise
  tokens come from `grecaptcha.enterprise.execute` directly.
- UA / sec-ch-ua / x-browser-* spoofing — Chrome sets these
  correctly; we don't need the flow2api UA-rotation machinery.
- Disk / IndexedDB media cache — `media-fetch.js` streams straight
  to the webhook and HistForge is the system of record.
- ST→AT refresh via Playwright — the extension reads the live
  session; there is no token rotation to manage.
- Restructuring executors, splitting `ctx`, or any SOLID-grade
  refactor; each task here is a surgical addition.

## Tasks

### Phase 1: Structured errors & observability

This phase lands the data surface Phase 2–4 emit into. Changes here are
additive (new helpers, new webhook payload fields, new settings
fields) — no behavioral changes to existing flows.

- [x] **Task 1.1: Google error envelope parser + content-policy taxonomy**
  **Files**: `extensions/youforge-flow/flow-api.js`,
  `extensions/youforge-flow/src/page-call.js`,
  `extensions/youforge-flow/src/poll-video.js`
  **What**: Introduce a `parseFlowApiError(response, body)` helper
  that walks `body.error.details[].reason`, `body.error.status`,
  `body.error.code`, `body.error.message`, and also reads
  `response.headers.get('retry-after')` (seconds or HTTP-date per
  RFC 9110). Returns
  `{ reason, httpStatus, message, category, retryable, isContentPolicy,
  contentPolicyTag, retryAfterMs, isSessionExpired }` — `retryAfterMs`
  is null when the header is absent, and Task 3.2 consumes it.
  Also expose a `makeFlowApiError({ reason, category, message,
  httpStatus })` constructor for call sites that need to synthesize
  an error without an HTTP response (e.g., Task 2.5's `NO_URL`
  terminal state). Use the parser at every place today that does
  `throw new Error('${status}: ${body.substring(0,300)}')`:
  `flow-api.js:41` (checkVideoStatus), `page-call.js:42` (MAIN-world
  apiCallViaPage), `page-call.js:110-113` (uploadImageViaPage). The
  401 short-circuit at `flow-api.js:38` and the `:52-53` path in
  `page-call.js` must also read the body first so the helper can
  decide `isSessionExpired` (reason=`UNAUTHENTICATED` OR httpStatus=401
  → set the flag the same way `sessionExpiredError` at `flow-api.js:18-22`
  does, so `session-guard.js:27-30` still branches correctly). In
  `poll-video.js:74-85`, widen the content-policy tag set beyond
  `CHILD_DANGER` / `SAFETY` to include `PERSON_GENERATION`,
  `VIOLENCE`, `ADULT`, `PROFANITY`, generic `CONTENT_POLICY_VIOLATION`,
  and anything else observed in Google's `error.details[].reason`
  for Flow traffic. These tags are not sourced from flow2api (which
  only handles `SAFETY` / `content_filter` at
  `extensions/flow2api/src/api/routes.py:664`); they come from the
  raw Google API error-reason vocabulary. Treat the list as the
  starting taxonomy and add to it as real traffic surfaces more.
  **Context**: Category vocabulary:
  `transient | auth | rate_limit | quota | content_policy | invalid_argument | not_found | unknown`.
  Set `retryable` true for `transient | rate_limit | quota` and false
  for the rest. Do not throw different error classes; keep it on
  `error.reason / error.category / error.httpStatus / error.isSessionExpired`
  so no call sites break. Pattern loosely follows
  `extensions/flow2api/src/services/flow_client.py:286-311` (which
  extracts `details[0].reason` verbatim) — the taxonomy mapping from
  reason → category is the YouForge addition.

- [x] **Task 1.2: Structured failure payload in submitFailure**
  **Files**: `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/src/handlers.js`,
  `extensions/youforge-flow/src/runner.js`
  **What**: Extend the `submitFailure` POST body at
  `webhook.js:103-123` with `errorCode` (the `reason` from 1.1),
  `errorCategory`, `httpStatus`, `retryable`, `contentPolicyTag` (when
  applicable). Keep `error` (string) for backward compatibility.
  The current payload has no `schemaVersion` field; add
  `schemaVersion: 2` (treat the unversioned prior payload as v1) so
  HistForge can detect and consume the new fields.
  **Context**: The failure payload today loses the Error object at
  `runner.js:238`, which does
  `handleTaskFailedFIFO({ task, error: error.message })` — only a
  string survives. This task must plumb the whole Error through:
  change `runner.js:234-243`'s catch to pass the error object
  (preserving `reason / category / httpStatus / retryable /
  contentPolicyTag` from Task 1.1), then unpack those fields in
  `handlers.js:62-79 handleTaskFailedFIFO()` on the `submitFailure`
  call. HistForge-side consumer lives outside this extension —
  document the schema in a header comment in `webhook.js` and note
  in the task output that HistForge (`src/app/api/flow/*`) needs a
  matching change.

- [x] **Task 1.3: Request correlation IDs + per-attempt timing trace**
  **Files**: `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/src/executors/index.js`,
  `extensions/youforge-flow/src/executors/shared.js`,
  `extensions/youforge-flow/src/page-call.js`,
  `extensions/youforge-flow/src/poll-video.js`,
  `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/src/handlers.js`,
  `extensions/youforge-flow/src/logger.js`
  **What**: Mint a correlation ID at dispatch in
  `runner.js:222-244 dispatchTask`:
  `const correlationId = crypto.randomUUID()`. Attach it to the
  executor `ctx` — `buildExecutorContext` returns the ctx object at
  `executors/index.js:80-93`; add `correlationId` to that return
  block. Every `safeLog` call inside a task's lifetime should prefix
  `[cid=${correlationId.slice(0,8)}]`. Accumulate a `timings` object
  on `ctx`: `submitMs`, `uploadMs[]`, `pollCount`, `pollMs`,
  `upscaleMs`, `fetchMediaMs`. Stash the cid on the Error object
  rethrown by `executeTaskWithSessionGuard` so the catch at
  `runner.js:234-243` can forward it to `handleTaskFailedFIFO` (dovetails
  with Task 1.2's Error-object plumbing). Include `correlationId`
  and `timings` in `submitResult` and `submitFailure` payloads
  (`webhook.js:58-98, :103-123`).
  **Context**: Modeled on flow2api's `perf_trace` /
  `generation_attempts[]` / `http_attempts[]` at
  `flow_client.py:537-567`. `safeLog` at `logger.js:1-20` currently
  prefixes `[YouForge Flow]`; extend that to optionally accept a
  correlation-id context. The cleanest approach is a tiny logger
  factory `logger.forTask(correlationId)` returning a wrapped
  `safeLog` — avoid passing the ID through every call site.

- [x] **Task 1.4: Progress status events during long polls**
  **Files**: `extensions/youforge-flow/src/poll-video.js`,
  `extensions/youforge-flow/src/webhook.js`
  **What**: Inside the 120-attempt loop at `poll-video.js:15-98`, fire
  a `postStatusEvent({ type: 'StatusEvent', event: 'progress',
  taskId, correlationId, pollAttempt, totalAttempts, estimatedPct })`
  every N attempts (default 6 = ~30s, matching flow2api's 7-attempt
  / 21s cadence at `generation_handler.py:1709-1714`). Add
  `postProgressEvent` as a first-class helper in `webhook.js` next to
  `postStatusEvent`.
  **Context**: `estimatedPct = min(95, round((attempt / max) * 100))`.
  Skip the event if `statusUrl` is not configured or HistForge
  returned a previous non-2xx (avoid a per-task status-spam storm).
  HistForge consumer side is out of scope — this task only emits.

- [x] **Task 1.5: Bridge-reload telemetry events**
  **Files**: `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/src/webhook.js`
  **What**: `runner.js:154-176 ensureBridgeAlive()` silently reloads
  the flow tab on 3 consecutive ping failures. Emit
  `postStatusEvent({ type: 'StatusEvent', event: 'bridge_reload',
  attempts, lastError })` from inside the reload branch.
  **Context**: The reload is a tail-risk signal — an account whose
  tab thrashes is almost certainly heading toward a session-expired
  state. Surfacing this to HistForge lets the backend proactively
  alert / rotate accounts.

- [x] **Task 1.6: Verbose logging toggle**
  **Files**: `extensions/youforge-flow/popup.html`,
  `extensions/youforge-flow/popup.js`,
  `extensions/youforge-flow/src/settings.js`,
  `extensions/youforge-flow/src/logger.js`
  **What**: Add `verboseLogging: boolean` to settings storage +
  popup checkbox. When on, `safeLog` also logs request URL, body
  size (or truncated body), response status, and duration. When off
  (default), today's behavior is preserved. Redaction of Bearer /
  long token strings must stay on in both modes.
  **Context**: Pattern modeled on `flow2api`'s
  `config.debug.log_requests / log_responses` in
  `extensions/flow2api/src/core/config.py`. The toggle pairs with
  Task 1.3's correlation IDs to make one-off debugging viable
  without code edits or rebuilds.

- [x] **Task 1.7: Daily stats rollup with midnight reset**
  **Files**: `extensions/youforge-flow/src/stats.js`,
  `extensions/youforge-flow/src/status.js`,
  `extensions/youforge-flow/src/handlers.js`
  **What**: Add `todayProcessed`, `todayFailed`, `todayRateLimited`,
  `todayContentPolicy`, `todayDate` keys to the stats record. On
  every `bumpStat` call, compare today's ISO date against
  `todayDate`; if different, reset all `today*` counters and set
  `todayDate`. The existing bumps in
  `handlers.js:42-46 handleTaskCompletedFIFO` (bumps `processed`)
  and `:78 handleTaskFailedFIFO` (bumps `failed`) implicitly bump
  the `todayProcessed` / `todayFailed` mirrors through the shared
  `bumpStat` path — no handler changes needed for those. In
  `handleTaskFailedFIFO` (post Task 1.2, when `err.category` is
  available on the error), additionally call
  `bumpStat('todayContentPolicy')` when `err.category ===
  'content_policy'` and `bumpStat('todayRateLimited')` when
  `err.category === 'rate_limit'` so the per-category daily
  counters populate. Surface the `today*` counters through
  `status.js:20-37 getStatus()` so the popup and HistForge can see
  them.
  **Context**: Maps to flow2api's `TokenStats` table columns
  (`today_image_count`, `today_video_count`, `today_error_count`,
  `today_date`) at `extensions/flow2api/src/core/models.py:63-79`.
  No new storage backend — reuse `chrome.storage.local` `stats`
  record. Depends on Task 1.2's Error-object plumbing so the
  category is available to `handleTaskFailedFIFO`.

### Phase 2: Network resilience

Wraps every outbound HTTP call in primitives that don't get stuck, fail
loudly, or retry blindly. Depends on the error categorization in
Task 1.1 (the retry helper needs to know what is retryable).

- [x] **Task 2.1: fetchWithTimeout wrapper + apply to all call sites**
  **Files**: `extensions/youforge-flow/src/http.js` (new),
  `extensions/youforge-flow/background.js`,
  `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/src/media-fetch.js`,
  `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/flow-api.js`,
  `extensions/youforge-flow/src/page-call.js`
  **What**: Create `src/http.js` exporting `fetchWithTimeout(url,
  options, timeoutMs)` that wires `AbortController` with a
  `setTimeout(controller.abort, timeoutMs)` and guarantees the
  timeout fires on a hang (catch `e.name === 'AbortError'` and throw
  `new Error('TIMEOUT: ' + url)`). Add `importScripts('src/http.js')`
  in `background.js` right after `src/logger.js` (before any module
  that reads from the network). Replace every service-worker-world
  `fetch(` call:
    - `flow-api.js:32` (checkVideoStatus, aisandbox) → 30s
    - `flow-api.js:94` (getCredits) → 30s
    - `page-call.js:71` (background image download inside
      uploadImageViaPage) → 45s
    - `page-call.js:99` (uploadImage to aisandbox) → 60s
    - `webhook.js:21` (postStatusEvent) → 15s
    - `webhook.js:63` (submitResult) → 15s
    - `webhook.js:107` (submitFailure) → 15s
    - `runner.js:182` (fetchNextTask / HistForge poll) → 15s
    - `media-fetch.js:50` (fetchImageAsBase64) → 45s
    Leave the MAIN-world fetches alone — they run inside
    `executeScript` injected `func`s in the Flow tab's page world,
    which is bounded by Chrome's own `executeScript` timeout and
    can't be given an `AbortController` from the service worker.
    Sites to skip: `page-call.js:32` (apiCallViaPage MAIN fetch),
    `account-tier.js:34` (credits via page — needs the Referer
    the service worker can't set), `auth.js:93` (trpc
    `project.searchUserProjects`), `poll-video.js:51`
    (`media.getMediaUrlRedirect`), and `media-fetch.js:92`
    (_mainWorldFetchAsBase64). content-script files (`content.js`,
    `content-bridge.js`, `recaptcha-hook.js`) are also untouched
    — they're short-lived and bounded by the page.
  **Context**: `page-call.js:24-59 apiCallViaPage()` wraps a
  MAIN-world `fetch` in `executeScript`; if a future task needs a
  true timeout there, it has to happen *inside* the injected
  function, not in the service worker. `media-fetch.js` has its own
  3-retry loop at `:166-191` — Task 2.2 will replace that loop with
  `retryWithBackoff`; this task only swaps the inner fetch.

- [x] **Task 2.2: retryWithBackoff helper (exponential + jitter + cap)**
  **Files**: `extensions/youforge-flow/src/http.js`,
  `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/src/executors/upscale.js`,
  `extensions/youforge-flow/src/media-fetch.js`
  **What**: In `src/http.js`, export `retryWithBackoff(fn, { retries,
  baseMs, capMs, jitter, shouldRetry })`. Delay formula:
  `min(capMs, baseMs * 2 ** attempt) * (0.5 + Math.random())`.
  `shouldRetry(err)` defaults to reading `err.retryable` (from
  Task 1.1's parser). Respect `STOP_REQUESTED` and
  `isSessionExpired` — those are never retried. For call sites whose
  errors are not produced by Task 1.1's parser (HistForge webhook,
  media-fetch), pass an explicit `shouldRetry` that falls back to
  HTTP-status / `TIMEOUT:` detection. Replace three hand-rolled retry
  loops:
    - `webhook.js:54-98 submitResult` — `retries: 3`, custom
      `shouldRetry: (e) => e.message?.startsWith('TIMEOUT:') ||
      /HTTP (5\d\d|429)/.test(e.message)`.
    - `executors/upscale.js:17-39 upscaleWithFallback()` — *do not*
      replace the inner loop; the 403-fallback semantics (`i--` at
      `:32` lets a fallback retry without consuming an attempt)
      don't map cleanly onto `retryWithBackoff`'s shouldRetry
      contract. Instead, convert the fixed `sleep(delayMs)` at
      `:36` to `sleep(computeBackoff(i, { baseMs: 2000, capMs: 15000,
      jitter: true }))` — export `computeBackoff` from `src/http.js`
      alongside `retryWithBackoff` so both share the same delay
      math. The outer shape (3 attempts, 403 fallback) stays.
    - `media-fetch.js:166-191` (3-attempt media-fetch loop with
      hardcoded 3s wait) — `retries: 3`, custom `shouldRetry` that
      accepts `.mainWorldError` throws and returns false on clear
      4xx (not 429). HTTP status is parsed from the `mainWorldError`
      message (the MAIN-world func puts it there at `:94`).
  **Context**: Note `flow2api` uses fixed `retry_delay` at
  `extensions/flow2api/src/services/flow_client.py:499, 583-584` —
  not actual exponential. We're adopting exponential+jitter as an
  improvement, since we're writing the helper anyway. Default
  params: `retries: 3, baseMs: 1000, capMs: 15000, jitter: true`.

- [x] **Task 2.3: Retry uploadImage with backoff**
  **Files**: `extensions/youforge-flow/src/page-call.js`
  **What**: Wrap the network-call portion of `uploadImageViaPage()`
  at `page-call.js:66-119` with `retryWithBackoff` from Task 2.2.
  Retry-worthy parts: the `fetch(imageUrl)` at `:71` and the
  upload `fetch` at `:99`; the base64 conversion in between is
  CPU-only and doesn't need retry. Retries: 2, base 500ms, cap 5s.
  `shouldRetry`: retry on `TIMEOUT:` and HTTP 5xx / 429; do not
  retry on 4xx (except 429) or on `isSessionExpired`.
  **Context**: A single failed upload kills the whole task today.
  Image uploads go through a Google Cloud CDN edge — intermittent
  failures are common. Do not retry when stop flag is set
  (`assertNotStopped` at `:67` already fires; `retryWithBackoff`
  respects `STOP_REQUESTED` per Task 2.2). Interaction with Task 2.7:
  the MIME detection Task 2.7 adds runs *once* on the downloaded
  blob before the upload fetch; the retry should wrap the upload
  fetch only, not the whole download-decode-upload sequence, to
  avoid redundantly re-downloading + re-detecting on every retry.
  Alternatively wrap the whole sequence and accept the extra work
  — document the choice.

- [x] **Task 2.4: Jittered / progressively-spaced video polling**
  **Files**: `extensions/youforge-flow/src/poll-video.js`,
  `extensions/youforge-flow/src/settings.js`
  **What**: Replace the fixed 5s × 120 loop at `poll-video.js:11-22`
  with: `interval = min(maxIntervalMs, baseIntervalMs * (1 +
  attempt * stepFactor)) + Math.random() * jitterMs`. Defaults:
  `baseIntervalMs: 3000, maxIntervalMs: 10000, stepFactor: 0.05,
  jitterMs: 500`. Keep the 500ms assertNotStopped cadence in the
  interruptible sleep. Drive from settings (Task 4.1 will surface
  them; here just add fields with defaults).
  **Context**: With `maxConcurrent: 5`, today's synchronized 5s
  polls can collide and thundering-herd the video-status endpoint.
  Progressive spacing also halves API calls on fast image-gen jobs
  (which finish in 1-2 polls) while preserving coverage on the long
  tail.

- [x] **Task 2.5: Hardened media-URL resolution**
  **Files**: `extensions/youforge-flow/src/poll-video.js`,
  `extensions/youforge-flow/flow-api.js`
  **What**: Today `poll-video.js:44-70` falls back to using the tRPC
  redirect URL itself if no final URL materializes, and ultimately
  `media:<name>` — neither of which HistForge can download. Chain:
  (a) direct `status.url`, (b) tRPC `media.getMediaUrlRedirect`
  follow-redirect (existing), (c) re-run `checkVideoStatus` once in
  case the URL field was eventually populated upstream, (d) if all
  fail, build an error via Task 1.1's `makeFlowApiError({ reason:
  'NO_URL', category: 'not_found', httpStatus: null, message: ... })`
  and throw with `isGenerationFailure = true` so `poll-video.js`'s
  existing failure branch routes through the runner's catch and
  Tasks 1.2/1.3 plumb the structured payload to HistForge.
  `contentPolicyTag` stays null for this case.
  **Context**: Stop at step (c). Do not add speculative endpoints
  beyond the tRPC redirect — any additional media-resolution hop
  needs a real endpoint observed in live labs.google traffic.

- [x] **Task 2.6: Session token cache TTL + re-fetch before halt**
  **Files**: `extensions/youforge-flow/src/auth.js`
  **What**: `auth.js:12-13, 36` hardcodes a 5-minute cache. The
  session response from the MAIN-world `getSessionToken` at
  `content.js:99-104` already returns `{ accessToken, user, expires }`
  and the bridge forwards the full `session` object, but
  `auth.js:44` only destructures `accessToken`. Read
  `response.session.expires` too and cache the token until
  `expires - 60s` (safety margin), capped at 60 minutes. When the
  `chrome.tabs.sendMessage` call at `auth.js:43` fails (catch at
  `:55-62`), retry it via `retryWithBackoff` (Task 2.2) with
  `retries: 2, baseMs: 1000` before calling
  `notifySessionExpired()` at `webhook.js:37-44`. Real session
  expiry surfaces as a consistent failure across the retries;
  transient bridge-unreachable blips recover. The `sendMessage`
  path is not a `fetch`, so `retryWithBackoff` wraps the
  `sendMessage` call directly — `shouldRetry` returns false when
  the error message matches `/session fetch failed|401|access_token/i`
  (the existing session-expired detection at `auth.js:58`).
  **Context**: Google's labs.google session tokens are issued with
  ~1-hour expiry. The 5-min cache burns 12× more session-fetch calls
  than needed, and some of those fetches are the thing triggering
  the "session expired" false positive today. Make sure the cache
  invalidates immediately on `isSessionExpired` error (not on a
  bridge-unreachable error — a transient message failure should
  trigger retry, not invalidation).

- [x] **Task 2.7: MIME magic-byte detection fallback**
  **Files**: `extensions/youforge-flow/src/page-call.js`
  **What**: In `uploadImageViaPage()` at `page-call.js:66-119`, when
  `blob.type` is empty, `application/octet-stream`, or clearly
  wrong (e.g., `text/html` for an image URL), read the first 12 bytes
  via `blob.slice(0, 12).arrayBuffer()` and detect: PNG
  (`89 50 4E 47 0D 0A 1A 0A`), JPEG (`FF D8 FF`), WEBP (`RIFF....WEBP`),
  GIF (`GIF87a` / `GIF89a`), BMP (`42 4D`). Default to `image/jpeg`
  after detection fails.
  **Context**: Pattern from
  `extensions/flow2api/src/services/flow_client.py:723-754`. Image
  URLs from some HistForge content pipelines (signed S3, Cloudflare
  R2) return `application/octet-stream` even for well-formed
  images; Google upload rejects the request body on wrong MIME.

### Phase 3: Quota & rate-limit guards

Builds on Phase 1's error categorization and Phase 2's network
primitives. Each guard pauses polling rather than letting the extension
hammer an exhausted / rate-limited account.

- [x] **Task 3.1: Consecutive-error circuit breaker**
  **Files**: `extensions/youforge-flow/src/state.js`,
  `extensions/youforge-flow/src/handlers.js`,
  `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/src/webhook.js`
  **What**: Track `consecutiveFailures` in state (reset to 0 on every
  successful `handleTaskCompletedFIFO`, incremented in
  `handleTaskFailedFIFO` *only* when the error is counted as an
  account-health signal). When the counter hits a threshold
  (default 5, configurable via Task 4.1), call `setStopFlag()` +
  `stopPolling()` and emit a status event
  `{ event: 'circuit_breaker_tripped', consecutiveFailures, lastError }`.
  Counting rules (reading Task 1.1's fields):
  - `err.isSessionExpired === true` — do NOT count. Session-expiry
    has its own halt branch (`notifySessionExpired`); counting it
    here would trip the breaker on every legitimate re-auth need.
  - `err.category === 'content_policy'` — do NOT count. These are
    user-content failures, not account health.
  - `err.category === 'rate_limit'` — do NOT count. Task 3.2's
    cool-off handles this, and a 429 burst shouldn't permanently
    halt the extension.
  - everything else (`transient | quota | invalid_argument | auth
    (non-session-expiry) | not_found | unknown`) — COUNT.
  **Context**: flow2api's `record_error` / `record_success` at
  `extensions/flow2api/src/services/token_manager.py:636-657`. The
  HistForge-side UX choice of whether to alert / auto-resume is out
  of scope here — we just stop locally and surface the event. Note
  this is a *hard* stop (sets `stopFlag`); Task 3.2's rate-limit
  cool-off is a *soft* pause (timed auto-resume). If both fire, the
  hard stop wins: Task 3.2's resume alarm should check `getStopFlag()`
  before re-arming polling.

Tasks 3.2 and 3.3 both need a soft pause distinct from the
user-initiated hard stop. They share one primitive — introduced in
Task 3.2 as `pauseGenerationOnly()` / `resumeGenerationOnly()`
below, and reused by Task 3.3 — so both auto-pause paths keep the
credits alarm running for visibility / resume signaling.

- [x] **Task 3.2: Local 429 cool-off with auto-resume**
  **Files**: `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/src/state.js`,
  `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/flow-api.js`,
  `extensions/youforge-flow/src/page-call.js`
  **What**: Introduce `pauseGenerationOnly(reason)` /
  `resumeGenerationOnly(expectedReason)` in `runner.js`, backed by a
  single `pauseReason` field in state.js (null = not paused,
  `'rate_limited' | 'credits_exhausted'` otherwise). The pause form
  clears the `pollTasks` alarm and sets
  `pauseReason = reason` — no-op if already paused for any reason
  (the first pauser wins; do not silently overwrite the reason).
  The resume form re-creates the `pollTasks` alarm and clears
  `pauseReason`, but only if `getStopFlag()` is false (Task 3.1's
  hard stop wins) AND `pauseReason === expectedReason` (so Task
  3.3's credits-recovered path doesn't accidentally resume a
  still-active rate-limit cool-off). Neither form touches
  `stopCreditsPolling` — credits visibility stays on through the
  pause so the popup and HistForge still see account state.
  `stopPolling()` itself stays unchanged for user-initiated halts.
  Then: when Task 1.1's helper classifies an error as `category:
  'rate_limit'` (HTTP 429 / `RESOURCE_EXHAUSTED`), read
  `err.retryAfterMs` (Task 1.1 now populates it from the
  `Retry-After` header), default it to 10 minutes if null / below
  minimum, set `cooldownUntil = Date.now() + cooldownMs` in state,
  call `pauseGenerationOnly()`, emit
  `{ event: 'rate_limited', retryAfterMs, cooldownUntil }`, and
  schedule a one-shot `rateLimitCooldown` alarm that calls
  `resumeGenerationOnly()` when it fires. If the user hits
  `stopPolling` (message-router or popup) during the cool-off,
  cancel the `rateLimitCooldown` alarm cleanly in that path.
  **Context**: Unlike flow2api's 12-hour hard ban at
  `token_manager.py:659-671` (which assumes multi-account
  rotation), we're single-account and need to resume, not ban.
  Inspecting `Retry-After` is a YouForge addition: flow2api
  doesn't read the header (grep confirms zero occurrences in
  `src/services`). Register the `rateLimitCooldown` alarm handler
  alongside the existing `pollTasks` / `credits` handlers at
  `runner.js:94` — pattern is identical.

- [x] **Task 3.3: Credits-threshold auto-pause**
  **Files**: `extensions/youforge-flow/src/credits-poller.js`,
  `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/src/state.js`,
  `extensions/youforge-flow/src/settings.js`
  **What**: In `credits-poller.js:30-59 pollCreditsOnce()`, after
  fetching credits, compare to `creditsMinThreshold` setting
  (default 0, surfaced in Task 4.1). If `credits <= threshold` and
  `pauseReason === null`, call
  `pauseGenerationOnly('credits_exhausted')` (from Task 3.2) and
  emit an existing credits status event with an extra
  `{ paused: true, reason: 'credits_exhausted' }` field. On a
  later tick, if `credits > threshold` AND `pauseReason ===
  'credits_exhausted'`, call
  `resumeGenerationOnly('credits_exhausted')` and emit
  `{ resumed: true, reason: 'credits_recovered' }`. The guarded
  resume — passing the expected reason — keeps the credits poll
  from accidentally unsticking a rate-limit cool-off that's still
  running. `stopPolling()` today at `runner.js:144-149` clears the
  `pollTasks` alarm and calls `stopCreditsPolling()` (which clears
  `credits`); Task 3.2 extends it to also clear the new
  `rateLimitCooldown` alarm during cool-off. User-initiated
  `stopPolling` (popup / `stopAllProcessing` router case) tears
  down all three alarms after Task 3.2 lands.
  **Context**: Not a direct port — flow2api reports credits but
  doesn't pause. Complements Task 3.2 by separating "out of money"
  from "rate limited", sharing Task 3.2's `pauseGenerationOnly` /
  `resumeGenerationOnly` primitives. The `credits` alarm already
  runs on its own `chrome.alarms` channel
  (`credits-poller.js:61-63`) independent of `pollTasks`, so the
  plumbing for a split pause/resume already exists — this task
  just uses it.

- [x] **Task 3.4: Soft launch-gate stagger**
  **Files**: `extensions/youforge-flow/src/runner.js`,
  `extensions/youforge-flow/src/settings.js`
  **What**: `runner.js:131-139 fillInitialSlots` already sleeps
  300ms between startup fills (`:136`), but the value is hardcoded
  and post-completion refills at `:232` (inside `dispatchTask`'s
  `.then`) have no stagger — two tasks finishing in the same tick
  produce two `pollForTasksFIFO()` calls back-to-back, which
  `pollingInProgress` serializes but does not space out. Replace
  the hardcoded 300ms with a configurable `launchStaggerMs` (default
  500ms, 0 disables) read from settings (Task 4.1). Apply the same
  stagger to the post-completion refill path: add a
  `setTimeout(() => pollForTasksFIFO(), launchStaggerMs)` at
  `runner.js:232` and the mirror at `:240`.
  **Context**: Mirrors flow2api's `flow_image_launch_stagger_ms`
  config key (dormant at default 0 but structurally present at
  `extensions/flow2api/src/core/config.py:142-166`). At
  `maxConcurrent: 5` and simultaneous completion, you can trip
  Google's per-second rate limit even well below the per-minute
  quota. Note `markSlotFreedForUpscale` at `runner.js:60-66` already
  uses a `setTimeout(..., 300)` — align its constant with
  `launchStaggerMs` too.

### Phase 4: Configurability & UX polish

Surfaces the knobs Phase 1–3 added, and rounds out a few cosmetic
improvements that become practical once the underlying primitives
exist.

- [x] **Task 4.1: Promote hardcoded tunables to settings**
  **Files**: `extensions/youforge-flow/popup.html`,
  `extensions/youforge-flow/popup.js`,
  `extensions/youforge-flow/src/settings.js`,
  `extensions/youforge-flow/src/constants.js`,
  `extensions/youforge-flow/src/poll-video.js`,
  `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/src/executors/upscale.js`
  **What**: Surface in settings (with sensible defaults):
  `taskPollIntervalSec` (currently `POLL_INTERVAL_MINUTES` * 60),
  `videoPollBaseSec` / `videoPollMaxSec` / `videoPollMaxAttempts` /
  `videoPollStepFactor` / `videoPollJitterMs` (all introduced in
  Task 2.4; currently `POLL_INTERVAL` / 120),
  `webhookMaxRetries` (3), `upscaleMaxAttempts` (3),
  `uploadMaxRetries` (2), `imageRequestTimeoutSec` (30),
  `videoRequestTimeoutSec` (60), `uploadTimeoutSec` (60),
  `mediaFetchTimeoutSec` (45), `sessionReFetchRetries` (2),
  `circuitBreakerThreshold` (5), `rateLimitCooldownMinutes` (10),
  `creditsMinThreshold` (0), `launchStaggerMs` (500),
  `progressEventEveryN` (6), `notificationsEnabled` (true, from
  Task 4.4), `verboseLogging` (false, from Task 1.6).
  Group the numeric / threshold knobs as a collapsible "Advanced"
  fieldset in the popup; keep the two booleans
  (`notificationsEnabled`, `verboseLogging`) in the main form —
  they're day-to-day UX toggles, not operational tuning.
  **Context**: Do not remove the hardcoded defaults in constants —
  keep them as the fallback when the setting is absent. flow2api's
  split image vs video timeouts
  (`flow_image_request_timeout=40s`, `flow_timeout=120s` at
  `extensions/flow2api/src/core/config.py:56-92`) are the model.
  Persist via `chrome.storage.local`; `settings.js` already has the
  cache pattern to follow.

- [x] **Task 4.2: Project-ID TTL cache**
  **Files**: `extensions/youforge-flow/src/auth.js`,
  `extensions/youforge-flow/src/state.js`
  **What**: Cache the result of `getProjectIdCached()`
  (`auth.js:65-122`) for 30 minutes in-memory (no storage —
  regenerates trivially on SW wake). Key by tab URL so a user
  switching projects on labs.google doesn't serve stale.
  **Context**: Today every task calls tRPC
  `project.searchUserProjects` as a fallback even when the URL
  regex at `auth.js:73` succeeds. The regex hit is fast, but the
  fallback path runs on first cold-load. TTL cache caps the cost.

- [x] **Task 4.3: Aspect-ratio fallback warning in model-key matrix**
  **Files**: `extensions/youforge-flow/src/account-tier.js`
  **What**: `getVideoModelKeys()` at `account-tier.js:131-143`
  already silently coerces *any* non-`'portrait'` aspect string to
  landscape via `const isPortrait = aspectRatio === 'portrait'`
  at `:132`, because every MODEL_MATRIX row includes both
  `r2v_portrait` and `r2v_landscape` variants. The degradation
  itself is fine; what's missing is visibility. Add an explicit
  guard: if `aspectRatio` is not exactly `'landscape'` or
  `'portrait'`, log a one-line `safeLog` warning naming the unknown
  value before falling through to landscape. Do the same in
  `resolveModelMatrixKey` at `:119-125` if `qualitySetting` is not
  one of `lite | quality | lower | fast`.
  **Context**: Mirrors flow2api's
  `model_resolver.py:479-496` pattern (coerces unknown aspect to
  `"landscape"` with a log line). The default-to-`ultra` tier
  fallback at `account-tier.js:63` already exists; this task
  covers the orthogonal "unknown aspect / quality string" axis.
  Note lines 449-456 of `model_resolver.py` are the *image-size*
  fallback (a different code path); the aspect-ratio degradation
  is at 479-496.

- [x] **Task 4.4: Session-expired Chrome notification**
  **Files**: `extensions/youforge-flow/src/webhook.js`,
  `extensions/youforge-flow/manifest.json`
  **What**: In `notifySessionExpired()` at `webhook.js:37-44`,
  after (or instead of) `stopPolling()`, call
  `chrome.notifications.create(...)` with a message pointing the
  user to `labs.google` to re-log-in. Add the `notifications`
  permission to `manifest.json`. Respect a `notificationsEnabled`
  setting toggle (default true).
  **Context**: Today the extension silently halts and the only
  signal is the popup status line — users don't notice until the
  HistForge queue backs up. A passive Chrome notification is
  low-friction and matches the "dumb runner" ethos (the
  notification just says "re-login needed", no action buttons).

- [x] **Task 4.5: Test-connection button in popup**
  **Files**: `extensions/youforge-flow/popup.html`,
  `extensions/youforge-flow/popup.js`,
  `extensions/youforge-flow/src/messages.js`,
  `extensions/youforge-flow/src/status.js` (or a new `src/self-test.js`)
  **What**: Add a "Test connection" button in the popup that runs:
  (a) find labs.google tab → (b) fetch session token → (c) call
  `getCredits()` → (d) ping HistForge `pollUrl` with an OPTIONS-like
  probe or a dedicated `{ type: 'Ping' }` payload HistForge can
  no-op on → (e) ping `resultUrl` and `statusUrl` the same way →
  (f) check bridge alive. Display each check's pass/fail inline in
  the popup with green/red dots.
  **Context**: flow2api's `/test` page at
  `extensions/flow2api/static/test.html` is the inspiration but
  doesn't port directly (we don't have a server). The HistForge
  side needs to accept the `{ type: 'Ping' }` payload; document
  the schema in `webhook.js` comments and note in the task output.

## References

- `extensions/youforge-flow/` — the extension being improved
- `extensions/flow2api/` — the Python sibling we're borrowing from
- `extensions/flow2api/src/services/flow_client.py:286-311` — error-reason extraction (source material for Task 1.1's parser)
- `extensions/flow2api/src/services/token_manager.py:636-649` — consecutive-error auto-disable (Task 3.1)
- `extensions/flow2api/src/services/token_manager.py:659-671` — 12-hour 429 ban (Task 3.2 reframes to cool-off)
- `extensions/flow2api/src/services/generation_handler.py:1709-1714` — SSE progress emission every 7 polls (Task 1.4)
- `extensions/flow2api/src/services/flow_client.py:537-567` — per-attempt timing trace (Task 1.3)
- `extensions/flow2api/src/services/flow_client.py:723-754` — MIME magic-byte detection (Task 2.7)
- `extensions/flow2api/src/core/config.py:56-166` — timeout / retry / stagger config surface (Task 4.1 / Task 3.4)
- `extensions/flow2api/src/core/model_resolver.py:479-496` — aspect-ratio coerce-to-landscape + warning (Task 4.3)
- `extensions/flow2api/src/core/models.py:63-79` — TokenStats today-counters schema (Task 1.7)
