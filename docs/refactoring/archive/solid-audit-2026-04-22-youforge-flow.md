# SOLID Audit — 2026-04-22 — extensions/youforge-flow

**Mode**: Path-scoped (all files under `extensions/youforge-flow/`)
**Scope**: Chrome MV3 extension that runs as HistForge's dumb Google Flow executor — ~3,200 lines across 29 JS files. 1 service-worker bootstrap + 20 background modules + 3 content-script files + 1 popup + 1 flow-api wrapper.
**Domains analyzed**: None — this directory sits outside the main project's domain skills (it is a separate extension, kept deliberately decoupled from the HistForge Next.js tree per `extensions/youforge-flow/README.md`).

## Summary

The recent modularization plan (`docs/plans/2026-04-21-youforge-flow-audit-modularize.md`) did the heavy lift: the monolithic `background.js` was split from 1,955 lines into a 68-line bootstrap plus 20 focused modules, with genuinely clean boundaries (stop-flag, settings, webhook, auth, runner, handlers, etc.). The remaining SOLID debt clusters in two areas: **executor dispatch** (mode routing uses an if-chain instead of a registry, and three video executors share ~70% of their scaffolding) and **local orchestration hotspots** (`executeTaskViaAPI` and `pollForTasksFIFO` each carry too many concerns for one function). Nothing is actively broken; these are the items that will compound next time a new Flow mode is added or someone tries to unit-test the runner.

## Findings Overview

| ID  | Principle | Severity | Effort | Files                                                              |
|-----|-----------|----------|--------|--------------------------------------------------------------------|
| 1   | OCP       | high     | small  | `src/executors/index.js`                                           |
| 2   | DRY/OCP   | high     | medium | `src/executors/text-to-video.js`, `image-to-video.js`, `frames-to-video.js` |
| 3   | SRP       | high     | medium | `src/runner.js`                                                    |
| 4   | SRP       | medium   | small  | `src/executors/index.js`                                           |
| 5   | OCP       | medium   | small  | `src/account-tier.js`                                              |
| 6   | SRP       | medium   | small  | `src/messages.js`                                                  |
| 7   | DIP       | medium   | small  | `src/executors/index.js`, `src/executors/shared.js`                |
| 8   | DIP       | medium   | medium | `src/runner.js`, `handlers.js`, `status.js`, `executors/index.js`, `account-tier.js` |
| 9   | DRY       | low      | small  | `src/handlers.js`, `src/messages.js`                               |
| 10  | SRP       | low      | small  | `src/media-fetch.js`                                               |
| 11  | ISP       | low      | small  | `src/executors/index.js`                                           |

## Findings Detail

### #1 — Executor mode dispatch is an if-chain instead of a registry
**Principle:** OCP | **Severity:** high | **Effort:** small
**Files:** `src/executors/index.js` (lines 27-36, 105-131)
**Recommendation:** Replace the `taskMode` if-chain and the parallel recaptcha-action ternary with a single registry: `const EXECUTORS = { createimage: { run: runImageGen, recaptchaAction: 'IMAGE_GENERATION' }, imagegen: {...}, text: { run: runTextToVideo, recaptchaAction: 'VIDEO_GENERATION' }, image: { run: runImageToVideo, ... }, ingredients: { run: runImageToVideo, ... }, frames: { run: runFramesToVideo, ... } }`. Dispatcher becomes `const entry = EXECUTORS[taskMode] ?? EXECUTORS.text;`. Keep the "no-images fallback" guard as a separate explicit rule between lookup and dispatch.
**Why:** Two places today encode mode-to-behavior knowledge: lines 34-36 pick the recaptcha action, lines 105-131 pick the executor. Both are if-chains that must agree. Each new mode the HistForge team ships (or each new one upstream adds — `sound` for audio-aware Flow is a likely future variant) requires editing both. The project's own `lib/tts/index.ts` / `lib/image/index.ts` / workflow registry are the positive precedent: the registry pattern is already the house style for "add-a-provider" growth in HistForge. This extension is the inconsistent outlier.

---

### #2 — Three video executors duplicate ~70% of their scaffolding
**Principle:** DRY/OCP | **Severity:** high | **Effort:** medium
**Files:** `src/executors/text-to-video.js`, `src/executors/image-to-video.js`, `src/executors/frames-to-video.js`
**Recommendation:** Extract the common shape into a helper in `src/executors/shared.js`: `async function runVideoGeneration(task, ctx, { endpoint, request })`. The executors shrink to tiny configs that build their request-specific bits (reference images, start/end frames) and name their endpoint. The aspect-ratio mapping, `mediaGenerationContext`/`clientContext`/`seed`/`textInput`/`useV2ModelConfig: true` scaffolding, and the `toMediaIds → throw if empty → pollVideo → throw if empty → upscaleVideos → return { taskId, resultUrl, mode }` tail all collapse into one place.
**Why:** The videoAspect ternary appears 3 times; `mediaGenerationContext: { batchId: crypto.randomUUID() }` 5 times; `clientContext: buildClientContext({ projectId, recaptchaToken, sessionId, paygateTier: modelKeys.paygateTier })` 5 times; the five-line `toMediaIds → throw → poll → throw → upscale → return` tail appears 3 times. Adding a hypothetical sixth Flow endpoint (e.g., a trajectory-based video mode) means stamping out another ~110-line file. The three existing executors also drifted subtly from each other during the modularization — compare the wording of the "returned no media IDs" error at `text-to-video.js:42`, `image-to-video.js:88`, `frames-to-video.js:109` — identical messages repeated with slightly different surrounding whitespace. Consolidating prevents future drift.

---

### #3 — `pollForTasksFIFO` mixes bridge health-check, HTTP polling, validation, and scheduling
**Principle:** SRP | **Severity:** high | **Effort:** medium
**Files:** `src/runner.js` (lines 102-246, 144 lines)
**Recommendation:** Split into a pipeline of named phases:
- `ensureBridgeAlive(flowTabId)` — the 3-attempt ping + reload block (lines 138-162).
- `fetchNextTask(pollUrl, accountToken, mode)` — the HTTP POST + JSON-parse + "empty response = no tasks" handling (lines 164-186).
- `validateTask(task)` — the mode-aware id-and-prompt presence check (lines 188-196).
- `dispatchTask(task, flowTabId)` — the fire-and-forget chain that increments counters, invokes the session-guard, and re-polls (lines 217-236).

`pollForTasksFIFO` then becomes a thin ~25-line orchestrator: acquire lock → check capacity/stop → ensureBridgeAlive → fetchNextTask → validate → dedup-check → dispatch.
**Why:** Today the function has 12 distinct concerns, 5 early-return paths, and 3 stop-flag re-checks. Testing a single behavior — say, "if the bridge ping fails three times, do we reload the tab?" — requires standing up the whole thing. The logic for "at capacity, skip" is checked twice (lines 117 and 212) against a state that can shift during the intervening HTTP call; split phases would let you reason about each check in isolation. This is the one remaining monolith from the pre-modularization era that didn't get decomposed when the rest of `background.js` was broken up.

---

### #4 — `executeTaskViaAPI` mixes prelude construction with mode dispatch
**Principle:** SRP | **Severity:** medium | **Effort:** small
**Files:** `src/executors/index.js` (lines 27-132, 105 lines)
**Recommendation:** Extract `buildExecutorContext(task, tabId)` returning `{ ctx, taskMode }`. It owns lines 29-103 (token fetching, storage reads, account-tier detection, closure creation, ctx assembly). `executeTaskViaAPI` keeps only lines 105-131 (dispatch). The two responsibilities then change independently — adding a tracing hook doesn't touch the dispatcher; adding a new mode doesn't touch context construction.
**Why:** The function has two distinct phases joined by a `const ctx = {...}` boundary. They change for entirely different reasons: the prelude changes when auth/storage/tier concerns evolve; the dispatch changes when Flow adds modes. Today they're interleaved, which means the 100-line function has to be read whole for either kind of change. Pairs naturally with Finding #1 (dispatch becomes a registry lookup → the dispatcher half shrinks to 5 lines and the prelude's separation becomes obvious).

---

### #5 — `getVideoModelKeys` is a nested if-tree that should be a lookup table
**Principle:** OCP | **Severity:** medium | **Effort:** small
**Files:** `src/account-tier.js` (lines 70-123)
**Recommendation:** Flatten into a data table:
- `MODEL_MATRIX` keyed by `"lite" | "pro" | "ultra.fast" | "ultra.quality" | "ultra.lower"`, each entry holding `{ t2v, r2v_portrait, r2v_landscape, i2v, i2v_fl, paygateTier }`.
- A small resolver: `quality === 'lite' ? 'lite' : tier === 'pro' ? 'pro' : 'ultra.' + quality`.
- The aspect-ratio switch becomes a post-lookup step that picks `r2v_portrait` vs `r2v_landscape`.

**Why:** The current function has 5 return statements with 4 fields each, and the branching logic (lite short-circuit → pro branch → ultra.quality → ultra.lower → ultra.fast default) is harder to audit than a flat table would be. Adding a new tier or a new Veo model generation (VEO 4?) today means reading through the if-tree to find the right insertion point; a flat table makes the matrix of supported combinations immediately visible. Low blast-radius refactor — behavior is unchanged — but it pays off every time the matrix grows.

---

### #6 — `messages.js` switch embeds business logic instead of delegating cleanly
**Principle:** SRP | **Severity:** medium | **Effort:** small
**Files:** `src/messages.js`
**Recommendation:** Move inline work into the owning modules:
- `stopAllProcessing` (lines 25-47): move the tab-notification IIFE into a new `forceStopAllTabs()` export of `runner.js`. The router case becomes a 4-line delegate.
- `taskRetrying` (lines 84-97): the stats bump belongs with the other stats helpers — extract a `bumpStat('retries')` (see Finding #9).
- `videoFound` (lines 59-67): the shape translation (mapping incoming `{ task, videoUrl, isGeneratedImage }` to `handleTaskCompletedFIFO`'s expected `{ taskId, resultUrl, isGeneratedImage }`) belongs in `handlers.js` as a named adapter. Router just forwards.

**Why:** The file's docstring claims "coordination only, business logic lives in the owning modules," but 3 of 16 cases break that rule. As more actions are added (the plan mentions upcoming Flow status events, credits refresh triggers, etc.), each will be tempted to add another inline IIFE. Keeping the file religiously switch-only makes it a reliable map of "what inbound message → which module owns the handler," which is its one job.

---

### #7 — `onUpscaleStart` callback couples executors to runner internals
**Principle:** DIP | **Severity:** medium | **Effort:** small
**Files:** `src/executors/index.js` (lines 81-87), `src/executors/shared.js` (line 116)
**Recommendation:** Replace the hand-rolled callback with a one-line event on the runner: `runner.markSlotFreedForUpscale()`. The executor calls that; the runner owns what it means internally. `ctx.onUpscaleStart` stops being a passed-in function reference and the coupling inverts — the executor now depends on a narrow `runner.markSlotFreedForUpscale()` symbol, not on `decrementActiveTaskCount`, `getActiveTaskCount`, `getMaxConcurrent`, and `pollForTasksFIFO` all at once.
**Why:** Today the closure at `executors/index.js:81-87` directly references four runner internals, which means the executor transitively knows about the active-task counter, concurrency cap, and polling function. If the runner ever changes how it represents "slot free" (e.g., adds a semaphore or switches to a token-bucket), the executor breaks. A one-function façade hides those details. Low-severity because the coupling is small and documented, but it's the only place executors reach back into the runner and is worth keeping narrow before a second such callback appears.

---

### #8 — Direct `chrome.storage.local` access scattered across modules instead of funneling through `settings.js`
**Principle:** DIP | **Severity:** medium | **Effort:** medium
**Files:** `src/runner.js:62, :97, :126, :201`, `src/handlers.js:16, :42, :80`, `src/status.js:19`, `src/executors/index.js:55`, `src/account-tier.js:48`, `src/host-permission.js:18, :25, :28`, `src/messages.js:88`
**Recommendation:** Pick one model and apply it consistently. Either:
- **(a)** Extend `src/settings.js` to own every piece of extension state (config + runtime: `isEnabled`, `lastPoll`, `stats`, `processedJobIds`, `generationMode`, `outputCount`, `aspectRatio`, `imageModel`, `videoModel`, `imgUpscale`, `vidUpscale`, `accountTier`, `grantedOrigin`). All modules read/write through named getters and setters.
- **(b)** Accept that "configuration" (webhooks, concurrency, mode) and "runtime state" (isEnabled, stats, processedJobIds, cached tier) are different concerns, rename `settings.js` to reflect that, and add a sibling `state.js` module for the runtime half.

The current split is implicit: webhooks go through `settings.js`; the executor settings at `executors/index.js:55-65` read directly; stats are handled in handlers.js and messages.js; processedJobIds in runner.js and handlers.js.
**Why:** The inconsistency makes it non-obvious where a new piece of state should live. It also means the 6-field `chrome.storage.local.get([...])` at `executors/index.js:55-65` bypasses the load-once-cache-in-memory pattern that `settings.js` uses — those reads happen on every task execution. Not fast-path expensive, but unnecessary. The modularization plan correctly pulled config out of `background.js`; this finding is about finishing the job for runtime state.

---

### #9 — Stats-bump pattern duplicated 3 times
**Principle:** DRY | **Severity:** low | **Effort:** small
**Files:** `src/handlers.js:42-48` (processed), `src/handlers.js:80-86` (failed), `src/messages.js:87-95` (retries)
**Recommendation:** Add `async function bumpStat(key)` to a new `src/stats.js` module (or to `settings.js` / `handlers.js`). Body: read-modify-write the `stats` key with `(stats?.[key] || 0) + 1`. Three call sites collapse from 7 lines each to 1.
**Why:** Same pattern, three copies, all load-bearing (each counter appears in the popup). The same shape will apply to any new counter (e.g., a `sessionExpiries` or `contentPolicyRejections` counter is plausible next). Pairs naturally with Finding #8 — a `stats.js` module is a logical sibling to the state/settings split.

---

### #10 — `fetchMediaFiles` interleaves URL parsing, tab coordination, and retry logic
**Principle:** SRP | **Severity:** low | **Effort:** small
**Files:** `src/media-fetch.js` (lines 73-164)
**Recommendation:** Extract two helpers in the same file:
- `decodeDataUrl(dataUrl)` — parse header/b64/mime, return `MediaFile` (replaces lines 86-97).
- `fetchOneMediaViaPage(tabId, url)` — the MAIN-world `executeScript` call that fetches one HTTP URL with size guard and FileReader, returning one `MediaFile` or throwing (replaces lines 113-141).

`fetchMediaFiles` then becomes: split URLs, for each call `decodeDataUrl` or run a 3-retry loop over `fetchOneMediaViaPage`. The inline 30-line MAIN-world function becomes a named top-level construct you can reason about in isolation.
**Why:** The function is 92 lines with 4 concerns (split, data-URL decode, retry loop, cross-world fetch). The retry loop's interaction with the stop flag (lines 108-111) is easy to miss inside the current structure — surfacing it at the call site makes the "respect stop flag mid-retry" semantics visible. Also lets the inline function become testable (today it's a string argument to `executeScript`).

---

### #11 — `ctx` bundles fields that most executors don't use
**Principle:** ISP | **Severity:** low | **Effort:** small
**Files:** `src/executors/index.js` (lines 89-103), consumed by all executors + `shared.js`
**Recommendation:** Only act on this when tackling Finding #2's `runVideoGeneration` helper. At that point, split ctx into:
- `ExecutorBase` — `{ projectId, sessionId, recaptchaToken, settings, pageCall }` (everyone uses these).
- `VideoExecutorCtx extends ExecutorBase` — adds `{ authToken, pollVideo, uploadImage, modelKeys, onUpscaleStart, taskId }`.
- `ImageExecutorCtx extends ExecutorBase` — adds `{ uploadImage }`.

If you're not tackling Finding #2, leave this as-is: the prop-bag is pragmatic in untyped JS and the ISP cost is borne mostly by the dispatcher (which has to know every field anyway).
**Why:** Today `runImageGen` receives 7 fields it never reads (`modelKeys`, `pollVideo`, `authToken`, `onUpscaleStart`, `tabId`, `getRecaptcha`, and one subtle overlap: `ctx.taskId` is set but every executor reads `task.id` locally — only `upscaleVideos` in `shared.js` actually destructures `ctx.taskId`, making it partially redundant). The cost is small in JS — the executor just ignores fields it doesn't see — but a typed consumer would immediately complain. Low severity because you'd only pay this down alongside a larger refactor.

---

## Priority Action Plan

### Immediate (high severity, small–medium effort)
- **#1** — Replace executor mode if-chain with a registry (matches the HistForge house style for TTS/image providers).
- **#4** — Extract `buildExecutorContext()` from `executeTaskViaAPI` (pairs with #1 so the dispatcher shrinks to a registry lookup).
- **#2** — Extract `runVideoGeneration(task, ctx, {endpoint, request})` shared helper; collapse the three video executors into config-plus-delta files.

### Next Sprint (medium severity, small effort)
- **#3** — Split `pollForTasksFIFO` into `ensureBridgeAlive` / `fetchNextTask` / `validateTask` / `dispatchTask`.
- **#5** — Flatten `getVideoModelKeys` into `MODEL_MATRIX` lookup.
- **#6** — Move embedded business logic out of `messages.js` (restore switch-only discipline).
- **#7** — Replace `onUpscaleStart` callback with a `runner.markSlotFreedForUpscale()` façade.
- **#8** — Consolidate all `chrome.storage.local` access through `settings.js` (or a new `state.js` sibling).

### Backlog (low severity)
- **#9** — Extract `bumpStat(key)` helper.
- **#10** — Extract `decodeDataUrl` and `fetchOneMediaViaPage` from `fetchMediaFiles`.
- **#11** — Only if tackling #2: split `ctx` into `ExecutorBase` / `VideoExecutorCtx` / `ImageExecutorCtx`.

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #2, #4 from docs/refactoring/solid-audit-2026-04-22-youforge-flow.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

**Positive patterns worth preserving.** The modularization from `docs/plans/2026-04-21-youforge-flow-audit-modularize.md` landed well. Items specifically not flagged here because they're genuinely good:
- `buildClientContext` in `src/client-context.js` collapsed 12 inline object literals into one builder — exactly the kind of consolidation SOLID audits love.
- `upscaleWithFallback` in `src/executors/upscale.js` is a clean OCP-friendly retry helper: caller provides `attempt()` and `on403Fallback()`, helper owns the retry arithmetic. Both `upscaleImages` and `upscaleVideos` collapse into one call of it.
- `stop-flag.js` is a perfect one-responsibility leaf module; `assertNotStopped` is called from 5 modules without coupling them.
- The `importScripts` leaves-first discipline, with docstrings naming each module's call-time dependencies, is well-maintained and compensates for the service-worker platform's lack of ES-module imports.
- `webhook.js` as the single HistForge-facing funnel (all outbound submissions + session-expired dedup) is textbook DIP.

**Non-SOLID issues worth recording but out-of-scope for this audit.**
- `src/account-tier.js:59-62` silently defaults to `ultra` on detection failure. A Pro account getting ultra model keys would 403 on every request. This is a reliability concern, not a SOLID one, but worth surfacing separately.
- `cachedProjectId` in `src/auth.js:14` has no TTL. Low-probability staleness risk (project deletion + recreation within one service-worker lifetime).
- The `processedJobIds` bounded-ring in `src/handlers.js:15-25` is sound, but the justification comment and the 500-entry cap are coupled to HistForge's dispatch-ID format — worth a cross-reference comment pointing at the HistForge-side code that mints those IDs.
