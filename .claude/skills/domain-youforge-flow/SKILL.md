---
name: domain-youforge-flow
description: Guide for the YouForge Flow Chrome extension — HistForge's "dumb runner" fork of the VEO Flow API extension. Use when modifying the service-worker background (polling, executors, settings/state), content scripts, popup, or flow-api wrapper of the YouForge Flow extension. For the HistForge-side coordinator that owns the queue, accounts, reaper, and webhook routes the extension calls, see `domain-google-flow-coordinator`.
---

# YouForge Flow Extension

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Runner & bucket-aware slot accounting**: `pollForTasksFIFO`, `pollBothBuckets`, `startPolling`, `stopPolling`, `dispatchTask`, `markVideoSlotFreedForUpscale`, `ensureBridgeAlive`
- **Executor dispatch**: `executeTaskWithSessionGuard`, `executeTaskViaAPI`, `EXECUTORS`, `buildExecutorContext`, `runVideoGeneration`, `submitFreshOperation`, `upscaleWithFallback`
- **Per-task page-context calls**: `getOrCreateProjectId`, `apiCallViaPage`, `pollVideoUntilDone`, `fetchMediaFiles`
- **Auth, stop, and auto-resume**: `getSessionTokenFromPage`, `clearAuthCache`, `assertNotStopped`, `setStopFlag`, `STOP_REQUESTED`, `scheduleAuthProbe`, `clearAuthProbe`
- **Tier & model matrix**: `MODEL_MATRIX`, `resolveModelMatrixKey`, `getVideoModelKeys`, `detectAccountTier`, `clearCachedTier`
- **Soft-pause & circuit breaker**: `triggerRateLimitCooldown`, `pauseGenerationOnly`, `resumeGenerationOnly`, `bumpConsecutiveFailures`, `resetConsecutiveFailures`
- **HistForge-facing webhook funnel**: `submitResult`, `submitFailure`, `postStatusEvent`, `postProgressEvent`, `postProjectCreated`, `postOperationStarted`, `notifySessionExpired`, `clearSessionExpiredReport`
- **Settings, state, stats**: `SETTINGS_SCHEMA`, `setSetting`, `loadSettings`, `loadState`, `getStatus`
- **Error classification**: `parseFlowApiError`, `throwFromResponse`, `throwFlowApiError`, `makeFlowApiError`, `FLOW_CONTENT_POLICY_REASONS`
- **Chrome alarm names**: `pollTasks`, `credits`, `rateLimitCooldown`, `authProbe`
- **Globals**: `AISANDBOX_BASE`, `GOOGLE_LABS_API_KEY`

## Architecture

HistForge-owned fork of the upstream VEO Flow API Chrome extension (MV3). The fork's role is a **dumb runner**: HistForge owns the work queue, per-account state, retry policy, and routing decisions. The extension polls HistForge for the next task, calls the Google Flow backend, and posts the result back. It has no local queue, no business-level error categorization, and no understanding of what a task means business-wise. The HistForge-side counterpart of every webhook contract here is documented in **`domain-google-flow-coordinator`** — reach for that skill when changing the wire shapes or anything the server interprets.

A neighboring `flow2api` directory is a **separate Python project** (FastAPI, OpenAI-compatible proxy in front of Flow). It is not the upstream of this extension and HistForge does not import from it. The extension's true upstream is the VEO Flow API Chrome extension; treat any reference snapshot as read-only.

The extension operates across **three execution worlds**, each with different powers. Any change touching tokens or page-scoped fetches has to live in the right world — the wrong world produces silent failure.

1. **Background service worker** — owns settings, state, polling, executor dispatch, webhook I/O, and MAIN-world coordination. Cannot mint reCAPTCHA Enterprise tokens; cannot see Google's session cookies from its own `fetch`; cannot set the `Referer` header required by Google's anti-abuse heuristic on the high-frequency video-status endpoint.
2. **Content script in MAIN world** — runs inside the labs.google page's own execution context. The *only* place reCAPTCHA tokens can be minted (the runtime binds each token to its minting context). Also where the session token comes from and where the reCAPTCHA hook installs.
3. **Content script in ISOLATED world** (the bridge) — routes messages between the service worker and the MAIN-world script. Cannot touch `grecaptcha` directly; can talk to both sides.

## Service-Worker Module Layout

MV3 service workers don't support ES module `import`. The background is a classic `importScripts` chain that loads each module as a plain top-level script into a shared lexical scope. The background bootstrap is a thin entry that names the import order and registers the lifecycle listeners; everything else lives in per-concern modules.

**Load order rule: leaves first.** Declaration before use — logger and constants load before any module that reads config or runtime state.

**Forward references across modules resolve at call time, not parse time.** A module can reference a function declared in a later-loaded module from inside a function body — the reference resolves when the function runs, not when the script parses. This is exploited deliberately for circular-looking dependencies (webhook ↔ runner, runner ↔ handlers, session-guard ↔ executors, auth-probe ↔ runner). Each module's header docstring names its runtime deps as "resolved at call time" — respect that contract when refactoring.

**Don't re-declare globals.** Classic scripts loaded via `importScripts` share lexical scope; re-declaring the same `const` in another module is a parse-time collision. Each shared global is declared exactly once, in the earliest-loaded module that owns the concept.

## Dumb-Runner Contract with HistForge

Five webhooks configured per-instance, plus an account token minted by HistForge:

- **Poll** — body carries `accountToken`, the legacy `mode` field, and the authoritative `wantBucket` per-bucket filter (`image` | `video`). A response that's empty, unparseable, or missing `id`/`prompt` is treated as "no tasks"; no exception. HistForge may legitimately return an empty body in several queue states — don't tighten the parser.
- **Result** — success payloads retry with exponential back-off; failure payloads are one-shot fire-and-forget. A lost failure report is cheaper than a double-submitted one. Failure payloads carry a structured error envelope (code/category/httpStatus/retryable/contentPolicyTag) so HistForge's classifier can branch without re-parsing the message.
- **Status** — out-of-band `StatusEvent`s (`session_expired`, `credits`, `rate_limited`, `progress`, `bridge_reload`, `circuit_breaker_tripped`). One-shot, unretried. `session_expired` is de-duped via a sticky flag; `progress` uses a separate gate that latches closed on first failure to avoid per-task spam during long video polls.
- **Project** — fire-and-forget `ProjectCreated` post emitted after a fresh Flow project is minted for a `(video, account)` pair. HistForge stores the projectId so the next dispatch reuses it instead of re-creating. A lost post just means HistForge re-asks the extension to create one next time, yielding a Google-side orphan — acceptable per operator policy.
- **OperationStarted** — fire-and-forget post emitted as soon as a fresh video operation submit returns. HistForge persists the operation name so a re-dispatch (after extension crash or service-worker wake) skips a fresh submit and resumes the existing poll. Emitted on fresh submit only, never on resume.

All five routes go through the webhook module — **single HistForge-facing funnel.** Don't have other modules call HistForge directly; doing so would fragment the session-expired dedup and the account-token plumbing.

**HistForge owns retry semantics.** The extension does not categorize errors or decide whether to retry. It submits the structured error; HistForge classifies (content-policy → fail, 429/quota → pause+requeue, transient → retry). The one exception is the `STOP_REQUESTED` Error.message sentinel, which stays silent (user explicitly stopped; no report).

**The reaper is the safety net.** If result submission fails all retries, or the extension crashes between executing a task and submitting, HistForge's reaper requeues the dispatched row after a configurable timeout. The extension's correctness goal is "don't double-submit"; "don't miss a submission" is best-effort, mitigated by the OperationStarted post so a redispatch can pick up the in-flight operation.

## Poll Loop and Per-Bucket Slot Accounting

The runner owns the polling loop and the active-task counter. The loop is armed by a Chrome alarm.

**Why `chrome.alarms`, not `setInterval`.** MV3 service workers suspend after a brief idle window, killing any `setInterval` timer. Alarms wake the worker. The credits poller, the rate-limit cool-off, and the auth probe use their own named alarms for the same reason. **Multiple alarm listeners coexist** — each must filter by `alarm.name` before acting.

**Two concurrency buckets, `image` and `video` (ADR 0005).** Slow video tasks must not starve fast image polls. Each bucket has its own ceiling and its own slot counter. The runner captures the bucket in a closure at increment time so the completion arms decrement and re-poll **the same bucket** — no cross-bucket poke. The periodic alarm walks both buckets with a stagger so an idle bucket eventually wakes regardless. `markVideoSlotFreedForUpscale` is the executors' narrow façade for "my video upscale is starting; free my video slot now". Image upscale runs synchronously inside its slot, so no image-side equivalent exists.

**`wantBucket` is wire-level, not a local hint.** The poll body sends both the legacy `mode` and the authoritative `wantBucket`. The server should only return matching tasks; the runner additionally re-derives the returned task's bucket and **rejects on mismatch** to guard against server/extension mode-map drift. Don't drop the defensive check.

**Cold-start fills both buckets interleaved.** A slow-saturating bucket must not starve the other during ramp-up; each bucket independently bails on `noTasks` / error / stop / per-bucket ceiling, and the fill loop exits when both have bailed.

**Poll orchestration as named phases.** `pollForTasksFIFO` is a thin orchestrator over four phases (bridge ping + tab-reload escalation, HTTP POST, validation, slot claim + dispatch). The split exists so questions like "if the bridge fails, do we reload?" are answerable without reading the whole loop. Preserve the phase boundaries when adding logic.

**The polling lock is load-bearing, and the re-checks around it are too.** Stop flag and capacity gates run *both* before the HTTP poll and after it, because state can shift during the network round-trip and the dedup read. Don't fold the two gate sets into one.

**Stop paths.** `STOP_REQUESTED` errors propagate through the session guard silently; the runner's catch skips both the failure handler and the re-poll so the stop sweep owns cleanup. `assertNotStopped()` runs before every await-able sleep in media fetches and video polls, so a stop flag set mid-task is honored within seconds.

## Executor Dispatch

The executor registry is a `{taskMode → entry}` map plus a thin dispatcher. Adding a new Flow mode means adding a registry entry; the dispatcher is mode-agnostic.

**Two fallbacks, in this order:**

1. **Unknown-mode fallback** — applied *before* context is built, because context construction needs the *matched* entry's `recaptchaAction` (the text-fallback wants the video action, not the image action).
2. **No-images fallback** (non-image-gen entries only) — applied *after* context is built; re-routes a non-image task arriving without reference / start-frame images to the text executor.

Preserve both the order and the separation. Collapsing them would either force unknown-mode tasks through a video-generation context they can't use, or skip the no-images guard on matched entries.

**Per-task context** is built once per dispatch (tokens, projectId, sessionId, resolved modelKeys, settings snapshot, correlationId, timings, closure-bound page callers). Executors read from `ctx`. **Don't call `chrome.storage.local.get` from inside an executor** — that bypasses the memoized in-memory cache and re-reads storage on every task.

### Shared Video Pipeline with Operation Resume

The three video executors (text-to-video, image-to-video, frames-to-video) are thin configs over `runVideoGeneration`. Each decides endpoint, video model key, and per-request extras; the helper owns the shared scaffolding (request body, polling, upscale, "no media IDs" guard, return shape).

**Resume-or-fresh.** When a task arrives with `googleOperationId`, the helper skips fresh submit and polls the existing operation — HistForge's way of saying "you already started this; pick it up." On `not_found` from a resumed op, the helper clears the id and retries once via fresh submit; any other error propagates. The OperationStarted post fires on fresh submit only.

**Why one helper, not three parallel files.** Before consolidation, the body builders and the `toMediaIds → poll → upscale → return` tail had drifted subtly between the three executors. Any new Flow video mode plugs in as another thin config rather than another full copy. The image-gen executor uses its own batch-generate flow and doesn't route through `runVideoGeneration`.

### Upscale

`upscaleWithFallback` is a generic retry helper used by both image and video upscale paths. The fallback callback lets the caller step down resolution when Google denies the higher tier rather than failing.

**Video upscale calls `markVideoSlotFreedForUpscale` once before its first attempt.** Upscale is lower priority than a fresh task, so the runner is told its video slot is free *before* upscale runs. If you add a new upscale path, preserve this call and its timing.

## Tier-Aware Model Matrix

`detectAccountTier` reads the user's paygate tier from the credits API (MAIN-world fetch with Bearer auth) and caches it durably across MV3 wakes. The cache is flushed by `clearCachedTier` on the stop-everything paths.

`getVideoModelKeys` turns `(account tier, quality setting, aspect ratio)` into a model-keys bundle via a flat `MODEL_MATRIX` lookup. `resolveModelMatrixKey` picks the row: `lite` quality always lands on lite, `pro` account short-circuits to pro, otherwise an `ultra.{quality}` row with the fast variant as the default for unknown qualities (so detection-failure plus unknown-quality lands on the same row a prior refactor used). Per-aspect r2v variants live in the row; the accessor collapses them based on the aspect-ratio argument. Lite rows don't carry a paygate tier; the accessor synthesizes one from the detected account tier so a Pro-on-Lite user still sends the correct paygate value.

**Account-tier detection reality.** On detection failure `detectAccountTier` defaults to the ultra row and caches that, which means a Pro account whose detection fails gets ultra model keys and 403s on every subsequent request until the cache is cleared. This is a known reliability gap. If you touch detection, consider defaulting conservatively to `pro`, or forcing re-detection on repeated 403 — and remember the cached tier lives in durable storage, not just memory.

## Settings, State, and Stats

Three modules own `chrome.storage.local`, deliberately split by concern:

- **Settings** — user-configurable values. `SETTINGS_SCHEMA` is the **single source of truth** for every storage-backed knob, loaded by both the service worker and the popup (which derives its Advanced fieldset from the schema's `popup` annotations). Adding a tunable is one entry there.
- **State** — runtime state driven by events (enabled flag, last-poll timestamp, dedup ring, cached account tier, granted HistForge origin, soft-pause reason and `until` timestamp, circuit-breaker counter).
- **Stats** — write-heavy append-only counters (lifetime plus today-* with a midnight rollover). No cache; reads only happen during `getStatus`.

**Why three modules, not one.** Configuration (user-chosen) and runtime state (runtime-derived) change for different reasons. Splitting them makes "where does this new key belong?" answerable by asking "does the user configure it?". Stats sit separately because they're the only write-heavy append path.

**Memoized loads.** Both `loadSettings` and `loadState` return a cached promise so concurrent callers share one storage round-trip. They're listener-bound to `chrome.runtime.onStartup` and also called directly at cold-load (where `onStartup` doesn't fire).

**Popup writes go through the worker** so the state cache stays in sync without subscribing to `chrome.storage.onChanged`. A direct popup `chrome.storage.local.set` would leave the worker cache stale until the next full reload.

**Defensive dedup is HistForge-specific, not a retry log.** HistForge's dispatch-qualified IDs make accidental redispatch unlikely, but cheap insurance. The ring is bounded; don't repurpose it for other deduplication needs.

## Soft-Pause and Circuit Breaker

Two independent throttles sit between submit-result errors and the runner.

- **Rate-limit cool-off.** Fires from every Flow API throw site whose error parses as `rate_limit`. Pauses generation (clears the periodic poll alarm but leaves the credits poller alive), schedules a one-shot cool-off alarm, and posts a `rate_limited` `StatusEvent`. `pauseGenerationOnly` / `resumeGenerationOnly` are the soft-pause primitives — **reason-guarded** so a credits-recovered resume can't accidentally unstick a still-active rate-limit cool-off. The credits poller uses the same primitives for `credits_exhausted`.
- **Circuit breaker.** A consecutive-failures counter trips a hard stop when the threshold is crossed. Session-expired, content-policy, and rate-limit failures are excluded — they have their own halt or cool-off paths. The breaker counts only account-health failures so user content and quota issues don't wedge the runner.

## Host Permission Lifecycle

HistForge's origin isn't known at build time — it's user-supplied. The manifest declares `<all_urls>` under `optional_host_permissions`; the user grants the specific origin at runtime via the popup. The granted origin is stored so the revocation watchdog knows which origin to care about.

**Revocation watchdog.** A `chrome.permissions.onRemoved` listener. When the user revokes from `chrome://extensions`, it sets the stop flag, stops polling, clears the granted-origin record, and flips an in-memory revoked flag that `getStatus` reports. The popup surfaces it as a takes-precedence error message.

**Popup rotates the granted origin automatically** when the user edits the webhook URLs to point at a different host — the old permission is revoked and the worker cache cleared. The principle is "only hold permissions for hosts currently in use."

**Manifest host-permission surface kept narrow.** Hard-coded hosts cover only the Google hosts the extension actually has to talk to. The upstream's catastrophically broad `http://*/*` plus `https://*/*` was removed as part of the fork. Don't re-add broad hosts; route user-configurable hosts through `optional_host_permissions` so Chrome prompts for consent.

## Session Expiry Funnel and Auto-Resume Probe

The webhook module owns a single sticky `sessionExpiredReported` flag. The first session-expired trigger (from auth, the flow-api wrapper, or `apiCallViaPage`) sets the flag, drops the session-token cache, stops the runner, fires a one-shot Chrome notification (popup-toggle-gated), posts one `session_expired` `StatusEvent`, and arms the auth probe. Subsequent expiries during the same "session bad" interval short-circuit.

**The auth probe is the auto-resume path.** A periodic alarm asks the labs.google content bridge for a session token. When the user re-logs at labs.google, the next probe sees the fresh token, starts polling, and clears itself. The probe uses raw `chrome.tabs.sendMessage` — not `getSessionTokenFromPage` — because the latter re-fires `notifySessionExpired` on failure, which would re-arm the probe in a self-tail. `clearSessionExpiredReport` also runs from `getSessionTokenFromPage` on a successful token fetch, so a manual restart from the popup naturally re-arms the flag.

**Don't add a local retry path for session-expired beyond the probe.** HistForge pauses the account on the StatusEvent; the probe handles re-arming once the operator re-logs. Anything else risks silently spinning against an expired session.

## MAIN-World Calls

Any API call that needs a reCAPTCHA token *must* execute in the MAIN world. reCAPTCHA Enterprise binds each token to its minting execution context; a service-worker `fetch` can't use a page-minted token. Some endpoints additionally need the labs.google `Origin` / `Referer` fingerprint, which a service-worker fetch from a `chrome-extension://` origin can't supply (Referer is a forbidden header per the Fetch spec) — those endpoints route through MAIN-world even when reCAPTCHA isn't required, so the request inherits the tab's fingerprint and avoids Google's anti-abuse "Sorry..." HTML 403.

Two separate MAIN-world patterns:

- **Via the content bridge** (service worker → ISOLATED bridge → MAIN content script via `window.postMessage`) — used for minting reCAPTCHA tokens and fetching the session token. Short messages, long-lived listener.
- **Via `chrome.scripting.executeScript` with `world: 'MAIN'`** — used for ad-hoc page-context fetches (generic API caller, project-create, credits, video-status polling, media fetches). The function body is **stringified across worlds** — it must be self-contained, no closure capture, all inputs through `args`.

**The reCAPTCHA hook script runs at `document_start`**, in MAIN world. It installs an `Object.defineProperty` trap that wraps `grecaptcha.enterprise.execute` *before* Google's own JS can set `grecaptcha`. The wrapper captures each call's `action` so subsequent token requests can fall back to the most recent action if the caller didn't supply one. The document-start timing is design-critical — at `document_idle` Google's first call would race the trap.

## Error Classification

`parseFlowApiError` walks Google's error envelope and returns a flat object (reason, category, httpStatus, retryable, content-policy flags, retryAfterMs, session-expired flag). `makeFlowApiError` lifts it onto a real `Error` so callers can throw without losing the structured fields. Catch sites read `err.category` rather than `instanceof`.

**Anti-abuse HTML 403 override.** Google's anti-abuse / "Sorry..." page is served with HTTP 403 and an HTML body (no JSON envelope) when their heuristics flag unusual traffic. The default 403 classification is `auth`, which would let the poller spin for the full attempts budget against a non-auth problem. The parser detects the HTML body and re-classifies as `rate_limit` so the cool-off arms and HistForge's account-cooldown path takes over. Don't simplify the 403 branch — the override is doing real work.

**`throwFromResponse` is the sanctioned funnel** — every HTTP-status throw site routes through it so the rate-limit cool-off arming, the stale-project-id 404 override, and the context-label message shape stay uniform. Direct `throwFlowApiError` is for synthesized errors with no HTTP response in hand; direct `makeFlowApiError` is for non-HTTP synthesized errors that must NOT trigger a cool-off (e.g. the session-expired sentinel).

**Cool-off is armed pre-throw.** When the parsed category is `rate_limit`, the cooldown runs *before* the throw so wrapping retry loops can read the pause reason and skip the next retry — otherwise the next attempt would immediately hit the same 429 endpoint.

**Content-policy reasons live in `FLOW_CONTENT_POLICY_REASONS`** (a Set) plus a regex for the broader public-error filter family. **The extension is the canonical source** for these reason codes — it sees errors first, on the live wire. The HistForge-side mirror documented in `domain-google-flow-coordinator` must follow; a divergence test fails loudly when they drift. Add a new reason here first, then propagate.

## Common Pitfalls

- **Forward references resolve at call time — don't flip them to parse-time.** A refactor that "cleans up" a forward ref by moving the caller earlier in `importScripts` will introduce a real cycle, because the modules genuinely call each other across boundaries (webhook ↔ runner, runner ↔ handlers, session-guard ↔ executors, auth-probe ↔ runner). Trust each module header's "resolved at call time" notes.
- **Concurrency buckets are independent — never poke the other bucket from a settle path.** The completion arms close over the bucket captured at increment time and re-poll only that bucket; the periodic alarm covers idle-bucket wakeup. Cross-bucket pokes would conflate the per-bucket rate-limit budget. `markVideoSlotFreedForUpscale` is deliberately video-only for the same reason.
- **The long-lived projectId and `googleOperationId` caches live in HistForge, not the extension.** HistForge feeds them back in task payloads so reuse is automatic. The extension only dedupes *concurrent in-flight creates for the same videoId* via a per-videoId mutex. Don't add a per-worker long-lived cache — that re-introduces the staleness window the HistForge-side cache exists to solve.
- **Multiple `chrome.alarms` listeners coexist; every listener must filter by `alarm.name`.** Alarms route to different listeners (periodic poll, credits, rate-limit cool-off, auth probe). A new alarm needs both a unique name and its own filter; forgetting the filter fires every other listener's work paths and produces hard-to-debug spurious behavior.
- **The session-expiry sticky flag has exactly one legitimate clear site.** Clearing it anywhere other than the success branch of the page-side session-token fetch means the next real expiry doesn't notify HistForge, and the operator's account silently spins against an expired session instead of being paused.
- **Don't add broad manifest host permissions.** The fork's whole point is narrowing the surface upstream had. User-facing hosts go through `optional_host_permissions` so Chrome prompts for consent and the revocation watchdog can fire; a broad host bypasses both and defeats the popup's auto-rotation of the granted origin.
- **reCAPTCHA hook timing is `document_start`, not `document_idle`.** The `Object.defineProperty` trap must install before Google sets `grecaptcha`; at `document_idle` the first call races the wrap and the captured action is wrong. Each token is single-use — upscale fetches a fresh one per call.
