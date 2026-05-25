# SOLID Audit — 2026-04-28 — Google Flow (coordinator + extension)

**Mode**: Multi-domain, scoped (HistForge-side coordinator + `extensions/youforge-flow`; explicitly excludes `extensions/flow2api`)
**Scope**: 9 webhook + operator API routes (`src/app/api/flow/`), 8 coordinator lib modules (`src/lib/flow-*.ts`), 1 repo (`src/lib/repos/google-flow.ts`), 3 worker steps (`generate-*-google-flow.ts`, `google-flow-common.ts`), 1 settings UI (`src/app/settings/google-flow-accounts.tsx`), 1 video-detail strip, 33 extension JS files (~4 175 lines under `extensions/youforge-flow/`).
**Domains analyzed**: `domain-google-flow-coordinator`, `domain-youforge-flow`.

## Summary

The two halves of the dumb-runner contract have evolved on different curves since the last audit. The extension was thoroughly modularized in April (audit 2026-04-22) and most of those findings are resolved; but the Phase 3 reliability work (rate-limit cool-off, soft-pause, circuit breaker, advanced tunables) re-grew `runner.js` back to 485 lines and scattered the same defensive patterns across many files. The coordinator side (server, never audited until now) is in much better shape — `flow-auth.ts`, the repo, and the reaper are textbook SOLID — but accumulated three small leaks past the repo boundary, an OCP smell in the v2 `errorCategory` dispatch that mirrors the one the extension recently fixed, and one settings UI that has outgrown a single component. The biggest cross-cutting risk is a **content-policy reason list that has already drifted** between the two sides of the wire — the extension's list has 5 entries the server's lacks.

## Findings Overview

| ID  | Domain                          | Principle | Severity | Effort | Files                                                     |
|-----|---------------------------------|-----------|----------|--------|-----------------------------------------------------------|
| 1   | youforge-flow                   | SRP       | high     | medium | `src/runner.js`                                           |
| 2   | coordinator + youforge-flow     | DRY/LSP   | high     | small  | `src/lib/flow-error-classify.ts`, `extensions/youforge-flow/src/flow-error.js` |
| 3   | youforge-flow                   | DRY/DIP   | high     | small  | `flow-api.js`, `src/page-call.js`, `src/project-mgmt.js`, `src/handlers.js` |
| 4   | coordinator                     | OCP       | medium   | small  | `src/app/api/flow/submit-result/[token]/route.ts`         |
| 5   | youforge-flow                   | DRY/SRP   | medium   | small  | `flow-api.js`, `src/page-call.js`, `src/project-mgmt.js`  |
| 6   | coordinator                     | SRP       | medium   | medium | `src/app/settings/google-flow-accounts.tsx`               |
| 7   | youforge-flow                   | OCP       | medium   | medium | `src/settings.js`, `popup.js`                             |
| 8   | youforge-flow                   | DRY       | medium   | small  | (~29 call sites across the extension)                     |
| 9   | coordinator                     | SRP       | medium   | medium | `src/worker/steps/google-flow-common.ts`                  |
| 10  | youforge-flow                   | SRP       | medium   | small  | `src/handlers.js`                                         |
| 11  | coordinator                     | DIP       | low      | small  | `src/app/api/flow/accounts/route.ts`, `accounts/[id]/route.ts`, `src/lib/flow-watcher.ts` |
| 12  | youforge-flow                   | DRY       | low      | small  | `src/webhook.js`                                          |
| 13  | youforge-flow                   | SRP/DRY   | low      | small  | `src/messages.js`, `src/runner.js`                        |

## Findings Detail

### #1 — `runner.js` regrew past 485 lines absorbing the Phase 3 cool-off subsystem
**Domain:** youforge-flow | **Principle:** SRP | **Severity:** high | **Effort:** medium
**Files:** `extensions/youforge-flow/src/runner.js`
**Recommendation:** Extract the rate-limit / soft-pause subsystem into its own module — call it `src/cooldown.js`. It owns `triggerRateLimitCooldown`, `pauseGenerationOnly`, `resumeGenerationOnly`, the `rateLimitCooldown` alarm listener (currently inlined in the `pollTasks` listener at `runner.js:117-135`), and the `_launchStaggerMs` / `_taskPollIntervalMinutes` accessors. Extract `ensureBridgeAlive` into a `src/bridge.js` (~40 lines, has its own `postStatusEvent('bridge_reload')` concern). After the move, `runner.js` shrinks back to its pre-Phase-3 shape: poll loop, slot accounting, `pollForTasksFIFO` and its 4 phases, and the `pollTasks` alarm listener — nothing else.
**Why:** The previous audit (#3 in 2026-04-22) split `pollForTasksFIFO` into named phases; that win remains intact. But Phase 3's rate-limit / circuit-breaker / soft-pause work all landed in `runner.js` because that's where the alarm listener lived and re-exporting from a new module was a half-step. The result: a single file now owns polling, slot accounting, two distinct alarm subsystems (`pollTasks` + `rateLimitCooldown`), the soft-pause primitive, the launch stagger, the bridge prober, and the cross-tab stop sweep. Tests for any one of these have to mock the others. The cool-off subsystem is the most extractable: its API surface is small (`triggerRateLimitCooldown`, `pauseGenerationOnly`, `resumeGenerationOnly`, `getPauseReason` already lives in `state.js`) and 5 different files call into it — each of them currently has to know the function lives in `runner.js`.

---

### #2 — Content-policy reason list has already drifted between the two sides
**Domain:** coordinator + youforge-flow | **Principle:** DRY (cross-runtime), LSP (each side claims to recognize "the same" set) | **Severity:** high | **Effort:** small
**Files:** `src/lib/flow-error-classify.ts:29-40` (server), `extensions/youforge-flow/src/flow-error.js:19-35` (extension)
**Recommendation:** Make the extension's `FLOW_CONTENT_POLICY_REASONS` set the **declared** source of truth (its list is the more complete one — the comment in `flow-error-classify.ts:27` already says so), then sync the server's `CONTENT_POLICY_REASONS` to match. Long-term, generate the server's list from the extension's at build time (an `npm run sync:flow-policy-list` script that reads the JS file and writes a derived `flow-policy-list.generated.ts`), or at minimum write a unit test that fails if the two arrays diverge. Add a comment on each side pointing at the other and explaining who is canonical.
**Why:** The extension lists 15 reason codes including 5 `PUBLIC_ERROR_*_FILTER*` named entries (`PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED`, `PUBLIC_ERROR_SAFETY_FILTER_FAILED`, `PUBLIC_ERROR_CHILD_FILTER_FAILED`, `PUBLIC_ERROR_DANGER_FILTER`, `PUBLIC_ERROR_AUDIO_FILTERED`); the server lists 10 and relies on the broader regex `/SAFETY|CHILD_DANGER|PUBLIC_ERROR_/` to catch those. **The two regex/list combinations don't classify identically.** A reason like `BLOCKED_REASON_SAFETY` matches both. But a hypothetical `CHILD_DANGER_FILTER_BYPASS` or any `PUBLIC_ERROR_FOO_FILTERED` variant would route to `content_policy` on the extension (named-list match, then pattern match) but on the server only via the `PUBLIC_ERROR_` substring inside `classifyError` — which is a coarser regex. This is exactly the kind of cross-the-wire LSP violation that produces silent classification disagreements: the moderation loop in `runGoogleFlowStep` reads the server's `isContentPolicyError`, but failures from the extension are tagged with the extension's list. A reason the extension marks as content-policy can fall through to "transient" on the server and silently exhaust retry budget instead of being moderated. The comment on `flow-error-classify.ts:27` calls the extension's list "the source of truth" — but that contract isn't enforced anywhere.

---

### #3 — Five throw sites duplicate the rate-limit cooldown trigger
**Domain:** youforge-flow | **Principle:** DRY/DIP | **Severity:** high | **Effort:** small
**Files:** `extensions/youforge-flow/flow-api.js:54-56`, `extensions/youforge-flow/src/page-call.js:133-135`, `extensions/youforge-flow/src/page-call.js:238-240`, `extensions/youforge-flow/src/project-mgmt.js:132-134`, `extensions/youforge-flow/src/handlers.js:143-145`
**Recommendation:** Move the trigger inside `makeFlowApiError` itself, or wrap it in a single `throwFlowApiError(parsed, fallbackMsg)` helper that lives next to `makeFlowApiError` in `src/flow-error.js` and does the cooldown trigger before throwing. After Finding #1's extraction, the helper imports `triggerRateLimitCooldown` from `cooldown.js`. The five call sites collapse from `parsed → makeFlowApiError → if rate_limit → trigger → throw` to `throwFlowApiError(parsed, ...)`. A single forgotten trigger today silently sends the next 2-3 retries straight into the same 429 endpoint — that's why `page-call.js:238-240`, `flow-api.js:54-55`, and `project-mgmt.js:132-134` have all sprouted a duplicate guard.
**Why:** The exact 5-line block `if (parsed.category === 'rate_limit' && typeof triggerRateLimitCooldown === 'function') { try { await triggerRateLimitCooldown(err); } catch (_e) { /* advisory */ } }` appears 5 times verbatim. Each was added defensively (Phase 3 fix #1) so the cool-off arms before downstream `retryWithBackoff` loops re-hit the rate-limited endpoint. The pattern works, but new throw sites won't get it for free — the trigger must be remembered each time. The comment on `flow-api.js:33-37` even calls this out: "Phase 3 fix #1: when the parsed error categorizes as 'rate_limit', fire triggerRateLimitCooldown at the throw site — earlier than handlers.js sees it." That's documenting a workflow constraint that should be enforced in code.

---

### #4 — `submit-result` v2 `errorCategory` dispatch is an if-chain
**Domain:** coordinator | **Principle:** OCP | **Severity:** medium | **Effort:** small
**Files:** `src/app/api/flow/submit-result/[token]/route.ts:77-151`
**Recommendation:** Replace the `handleError` if-chain (5 explicit categories: `create_project_failed`, `auth`, `stale_project_id`, `rate_limit`, `transient`) with a registry: `const HANDLERS: Record<string, (db, args) => void> = { create_project_failed: ..., auth: ..., stale_project_id: ..., rate_limit: handleQuota, transient: handleTransient }`. The legacy `classifyError` fallback stays as the default branch for the missing-category case. Each handler is already a small function — they just need to be lifted out and named. Adding a future category (`upload_failed`, `circuit_breaker_fired`, …) becomes a one-entry edit.
**Why:** This is the exact pattern the extension was migrated away from in audit 2026-04-22 #1 (the executor mode dispatch). The server side missed the same refactor. Each new category emitted by the extension (and the SW comment block at `webhook.js:218-226` explicitly enumerates four future categories the server "currently ignores": `content_policy`, `rate_limit`, `transient`, `auth`/`invalid_argument`) requires editing this if-chain in lockstep with the extension. The coupling between "extension emits new category" and "server route grows new branch" should be a registry add, not a conditional chain edit. Pairs with Finding #2 because both are about the cross-wire contract drifting silently.

---

### #5 — Three throw paths each rebuild the response → flow-error sequence
**Domain:** youforge-flow | **Principle:** DRY/SRP | **Severity:** medium | **Effort:** small
**Files:** `extensions/youforge-flow/flow-api.js:39-58` (`_throwFlowApiError`), `extensions/youforge-flow/src/page-call.js:106-139` (the `apiCallViaPage` error branch), `extensions/youforge-flow/src/project-mgmt.js:103-198` (the `_createFlowProject` status ladder)
**Recommendation:** Lift the common shape into `src/flow-error.js` as `throwFromResponse({ httpStatus, body, retryAfterHeader, contextLabel, urlForStaleProjectCheck })` returning `never`. It runs `parseFlowApiError` against a synthesized response object, applies the stale-project-id 404 override (`page-call.js:122-125` and `flow-api.js:46-49` both do this independently), arms the rate-limit cooldown (per Finding #3 once unified), and throws via `makeFlowApiError`. `project-mgmt.js`'s 401/429/5xx/4xx ladder collapses into one call. The advantage compounds with Findings #2 and #3 — three call sites that need to see the unified content-policy list and unified cooldown trigger become one site that has both.
**Why:** Today each surface that hits Google's error envelope re-implements the same `parseFlowApiError → if 404+/projects/, override → makeFlowApiError → if rate_limit, trigger → throw` ladder. `_createFlowProject` is the worst — it's a manual 401/429/5xx/4xx ladder built on raw `chrome.scripting.executeScript` results because it can't reuse `apiCallViaPage` (the fetch happens with `credentials: 'include'` cookies, not a Bearer token). The `project-mgmt.js` ladder reproduces the entire status-classification logic that `parseFlowApiError` already does. Bringing it back through a shared helper keeps the failure-shape contract in one place.

---

### #6 — `google-flow-accounts.tsx` is a 484-line component owning rendering, mutations, dialogs, and inline editing
**Domain:** coordinator (settings UI) | **Principle:** SRP | **Severity:** medium | **Effort:** medium
**Files:** `src/app/settings/google-flow-accounts.tsx` (484 lines)
**Recommendation:** Decompose into:
- `GoogleFlowAccountsTable` — pure presentational; takes `accounts`, `nowSec`, and a small set of action callbacks (`onPause`, `onPauseIndefinitely`, `onResume`, `onDelete`, `onToggleEnabled`, `onEditName`).
- `useFlowAccounts()` hook — owns `accounts` state, `loading`, `error`, `reload`, and the `patchAccount`/`onAdd`/`onDelete` mutators. Returns the action callbacks the table consumes.
- `FlowAccountMintedDialog` — the create-account result dialog (currently lines 392-449, 60 lines of one-off rendering).
- `FlowAccountDeleteConfirm` — the delete confirmation (lines 451-481).
- `useEditableName(commit: (name) => Promise<void>)` — encapsulates the inline-name-edit state machine (`editingName`, `commitNameEdit`, the keyboard handlers).

Top-level `GoogleFlowAccounts` becomes ~50 lines of composition.
**Why:** The component currently mixes data-fetching (lines 105-118), mutation orchestration (`onAdd`, `patchAccount`, `onDelete`, `pauseFor`, `pauseIndefinitely`, `resume`, `toggleEnabled`, `commitNameEdit`), UI state (`editingName`, `confirmDelete`, `minted`), HTTP error handling, clipboard interaction (`copyAll`), and inline JSX rendering of three distinct dialogs. Adding a single feature — say, an "extend pause" button or a per-account credits refresh trigger — requires reading the whole file to find the right spot. The rest of the dashboard already uses the React-table + hook pattern (`videos-client.tsx`, `topics-table.tsx`); this component is the inconsistent outlier. Lower priority than findings on the hot path, but every operator session touches this UI and the next CRUD action will compound the file's size.

---

### #7 — `settings.js` has 30+ tunables, each requiring a 5-place edit to add one
**Domain:** youforge-flow | **Principle:** OCP | **Severity:** medium | **Effort:** medium
**Files:** `extensions/youforge-flow/src/settings.js`, `extensions/youforge-flow/popup.js`
**Recommendation:** Replace the pattern with a single `SETTINGS_SCHEMA` table — one entry per tunable with `{ key, default, kind: 'string'|'number'|'boolean'|'enum', popupId? }`. `loadSettings` becomes a loop over the schema; the 30 individual `if (Number.isFinite(...))` guards collapse to one `coerce(kind, value, default)`. The 30 individual `let X = default; function getX() { return X; }` declarations become `getSetting('keyName')`. The popup's `ADVANCED_NUMERIC_FIELDS` array (popup.js:28-46) merges with the schema. Adding a new knob becomes a one-line schema entry instead of 5 separate edits across two files.

The compound win: the per-call-site pattern from Finding #8 (`(typeof getX === 'function') ? getX() : default`) goes away because the schema-default is the canonical default — no defensive-getter needed.
**Why:** Each new tunable from the Phase 3 / Phase 4 work (and there were 17 of them: `taskPollIntervalSec`, `webhookMaxRetries`, `upscaleMaxAttempts`, `uploadMaxRetries`, `imageRequestTimeoutSec`, `videoRequestTimeoutSec`, `uploadTimeoutSec`, `mediaFetchTimeoutSec`, `sessionReFetchRetries`, `progressEventEveryN`, `circuitBreakerThreshold`, `rateLimitCooldownMinutes`, `creditsMinThreshold`, `launchStaggerMs`, `videoPollBaseSec`, `videoPollMaxSec`, `videoPollMaxAttempts`) requires:
1. A `let X = default;` declaration.
2. The key name in the storage-keys array passed to `chrome.storage.local.get(...)`.
3. A 1-line `if (Number.isFinite(settings.X)) X = settings.X;` cache populator.
4. A `function getX() { return X; }` accessor.
5. An entry in `popup.js`'s `ADVANCED_NUMERIC_FIELDS` array with `{ key, id, def }`.

That's 5 places for one logical addition, in two different files, with no compile-time check that the defaults agree (the `def` in popup.js and the `let X = N` in settings.js can drift silently). The next Phase 5 will add more knobs; the cost will keep growing.

---

### #8 — Defensive `(typeof getX === 'function') ? getX() : default` pattern across 29 call sites
**Domain:** youforge-flow | **Principle:** DRY | **Severity:** medium | **Effort:** small (mechanical, but invasive)
**Files:** 29 call sites across `runner.js`, `auth.js`, `webhook.js`, `handlers.js`, `media-fetch.js`, `page-call.js`, `account-tier.js`, `credits-poller.js`, `executors/upscale.js`, `poll-video.js`, `logger.js`
**Recommendation:** Either:
- **(a) (preferred, pairs with #7):** After the schema-driven settings rewrite, accessors are guaranteed to exist; the defensive guard becomes unnecessary. Replace all 29 sites with a direct `getX()` call.
- **(b) (cheaper, no schema rewrite):** Add a single `getOrDefault(getter, fallback)` helper in `src/settings.js`. Call sites become `getOrDefault(getTaskPollIntervalSec, 10)`. The `typeof === 'function'` check lives in one place.

**Why:** The pattern was added so test sandboxes that don't load the full settings module wouldn't break — but it produces a lot of noise. `poll-video.js:15-20` has the pattern stacked five times in six lines. Each occurrence makes the call site non-trivially harder to read and tempts new code to copy the same pattern even when not strictly needed. With a schema-driven settings module, the guard becomes provably unnecessary. Defer judgment if Finding #7 isn't tackled — the dependency goes the right way (do #7 first, #8 is a follow-up cleanup).

---

### #9 — `runGoogleFlowStep` orchestrates, aggregates, AND drives the moderation loop
**Domain:** coordinator (worker step) | **Principle:** SRP | **Severity:** medium | **Effort:** medium
**Files:** `src/worker/steps/google-flow-common.ts` (326 lines)
**Recommendation:** Split into three named pieces inside the same file:
- `enqueueChunks(videoId, deps, spec)` — owns the disk → open-row → enqueue-with-null-skip cascade (lines 76-119) and the "no enqueueable, no existing outputs" hard stop. Returns `{ existingOutputs, enqueueableChunks }`.
- `runModerationLoop(videoId, chunksPath, deps, spec)` — owns the wait → moderate → re-wait iteration with the `MAX_MODERATION_ITERATIONS_GUARD` belt-and-suspenders. Inside it, `maybeModerate` (already extracted, 122 lines) reads failed rows + chunks.json, calls the moderator, writes the rewrites — already SRP-violation-on-violation, see below.
- `aggregateFailures(videoId, projectDir, spec)` — owns the disk-presence-driven failure aggregation throw (lines 174-185).
- `runGoogleFlowStep` becomes ~25 lines of orchestration.

`maybeModerate` itself is also doing too much: chunks.json read, failed-row lookup, moderation-round arithmetic, item building, LLM call, in-memory chunks update, DB transaction, chunks.json write. Extract `buildModerationItems(chunks, failed)` and `applyModerationRewrites(chunks, writes)` so the LLM call is the only thing the function actually owns.
**Why:** The current function is 326 lines with one happy path and 5 throw sites, and it crosses three subsystem boundaries (file I/O, queue, LLM). Future work the spec hints at — adding a new chunk-kind that needs Flow generation, adding a per-chunk moderation policy override, adding a parallel image+video flow — will all need to touch this monolith. The orchestrator-vs-internals separation makes each easier to reason about. Note this is the only worker step that does this much; the other Flow steps are 30-line wrappers.

---

### #10 — `handleTaskFailedFIFO` mixes 4 distinct concerns
**Domain:** youforge-flow | **Principle:** SRP | **Severity:** medium | **Effort:** small
**Files:** `extensions/youforge-flow/src/handlers.js:99-175` (76 lines)
**Recommendation:** Split into:
- `submitFailureToHistForge(task, errorOrMessage)` — the `submitFailure` call + `markJobAsCompleted` housekeeping (already small, just rename to make the boundary explicit).
- `bumpFailureStats(error)` — `bumpStat('failed')` + the conditional `todayContentPolicy` / `todayRateLimited` bumps. Returns the category for downstream consumers.
- `maybeTripCircuitBreaker(error)` — the `_shouldCountForCircuitBreaker` check + `bumpConsecutiveFailures` + threshold compare + the stop sequence + the `circuit_breaker_tripped` StatusEvent. Owns the `CIRCUIT_BREAKER_THRESHOLD_DEFAULT` constant.
- `maybeTriggerCooldownFallback(error)` — the defense-in-depth trigger at lines 143-145 (folds into Finding #3's unified helper).

`handleTaskFailedFIFO` becomes a 6-line orchestrator.
**Why:** Today, debugging "why didn't the circuit breaker trip?" requires reading 76 lines that also handle stat counters, cooldown fallback triggers, and HistForge submission. The four concerns change for different reasons: stats update when new counters are added; circuit breaker changes when account-health logic evolves; cooldown trigger changes when retry semantics change; submission changes when the v2 envelope grows. Splitting them lets each evolve independently. Compounds with Finding #3 — `maybeTriggerCooldownFallback` becomes a one-liner once the trigger lives in a single helper.

---

### #11 — Three places leak raw SQL past the `google-flow` repo boundary
**Domain:** coordinator | **Principle:** DIP | **Severity:** low | **Effort:** small
**Files:** `src/app/api/flow/accounts/route.ts:19-26` (`nextAccountId`), `src/app/api/flow/accounts/[id]/route.ts:51-53` (PATCH name update), `src/lib/flow-watcher.ts:65-84` (reaper stage 1 join query) and `:118-131` (reaper stage 3 wake)
**Recommendation:** Add four repo functions in `src/lib/repos/google-flow.ts`:
- `nextAccountId(db): string` — moves the `MAX(CAST(SUBSTR(id,5) AS INTEGER))+1` formula into the repo.
- `setAccountName(db, id, name): void` — the one-line UPDATE.
- `listStuckUnderDeadAccounts(db, staleCutoff): {...}[]` — the JOIN at `flow-watcher.ts:65-84`.
- `wakeDeferredVideosWithPendingFlow(db, nowUnix): number` — the reaper stage 3 UPDATE that returns the affected count.

Routes and the reaper then read/write through repo functions, and the schema-coupling stays in one file.
**Why:** The repo already exists and is the convention — every other write goes through it. These four leaks are inconsistent: each is a one-shot piece of SQL inlined in a route or a lib module. The reaper's stage 1 query is the most important one to consolidate because it joins `google_flow_queue` and `google_flow_accounts`, and a future schema change to either table would need to touch the reaper *and* the repo separately. Low severity because it works today, but pairs with audit 2026-04-17 #2 (the repository layer extraction across the rest of the codebase).

---

### #12 — `submitFailure` extracts 8 structured-error fields manually
**Domain:** youforge-flow | **Principle:** DRY | **Severity:** low | **Effort:** small
**Files:** `extensions/youforge-flow/src/webhook.js:231-273`
**Recommendation:** Add one helper next to `makeFlowApiError` in `src/flow-error.js`: `extractV2Envelope(errorOrMessage): { error, errorCode, errorCategory, httpStatus, retryable, contentPolicyTag, correlationId, timings }`. Encapsulates the 8 individual `isErrorObj && typeof errorOrMessage.X === 'Y' ? errorOrMessage.X : null` checks. `submitFailure`'s body shrinks to a `JSON.stringify({ ...envelope, type: 'ResultSubmission', schemaVersion: 2, ... })`.
**Why:** The 8-field extraction is 17 lines of repetitive ternaries that only `submitFailure` reads. If the v2 envelope grows a new field — and the comment block at lines 199-225 documents the contract is still evolving — the extraction has to be updated in one place. Also pairs with Finding #2's content-policy contract: the extracted envelope is what the server's submit-result Zod schema validates, so consolidating the build site narrows the cross-wire contract surface.

---

### #13 — `messages.js stopAllProcessing` and `autoStopped` cases each manually compose 4-5 cleanup calls
**Domain:** youforge-flow | **Principle:** SRP/DRY | **Severity:** low | **Effort:** small
**Files:** `extensions/youforge-flow/src/messages.js:30-38` (stopAllProcessing), `:62-70` (autoStopped), `runner.js`
**Recommendation:** Add `haltAllProcessing()` to `runner.js`: composes `setStopFlag` + `stopPolling` + `clearCachedTier` + `clearInFlight` + (when called from stopAllProcessing) `forceStopAllTabs`. The router cases collapse to 1-2 lines of delegation. Distinguish the two via a parameter (`{ sweepTabs: true }` for `stopAllProcessing`, `{ resetActiveCount: true }` for `autoStopped`).
**Why:** The two router cases call into 4-5 modules each, and adding a future cleanup (e.g., clearing the new circuit-breaker counter or resetting the cooldown alarm — both already partially handled, but inconsistently between the two cases) would have to remember to update both. The router file's docstring at messages.js:1-5 explicitly says "no IIFEs, no shape-building, no stats math, no storage reads" — these two cases are right at the edge of that rule with their multi-call composition. Folding into one runner-side helper keeps the router cleanly switch-only.

---

## Priority Action Plan

### Immediate (high severity, small–medium effort)
- **#3** — Move the rate-limit cooldown trigger inside `makeFlowApiError` / a `throwFlowApiError` helper; remove 5 duplicates.
- **#2** — Sync the content-policy reason lists between `flow-error-classify.ts` and `flow-error.js`; add a divergence test.
- **#1** — Extract `cooldown.js` (and optionally `bridge.js`) from `runner.js`; brings it back under 250 lines.

### Next sprint (medium severity)
- **#4** — Convert `submit-result`'s `errorCategory` if-chain into a registry (mirrors the extension's executor refactor).
- **#5** — Lift the response → flow-error sequence into `throwFromResponse({...})`; collapse the three throw paths.
- **#7** — `SETTINGS_SCHEMA` table replaces 5-place tunable boilerplate.
- **#8** — Replace defensive `typeof === 'function'` guards (do after #7).
- **#9** — Decompose `runGoogleFlowStep` and `maybeModerate` into named subroutines.
- **#10** — Split `handleTaskFailedFIFO` into 4 named helpers.
- **#6** — Decompose `google-flow-accounts.tsx` into hook + table + dialog components.

### Backlog (low severity)
- **#11** — Move the 4 raw-SQL leaks into `google-flow.ts` repo helpers.
- **#12** — Add `extractV2Envelope` helper for `submitFailure`.
- **#13** — Add `haltAllProcessing()` and collapse the two router cleanup composites.

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #3, #2 from docs/refactoring/solid-audit-2026-04-28-google-flow.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

**Positive patterns worth preserving.**

- **`flow-auth.ts`'s `resolveFlowAccount`** is a textbook DIP gate: every per-account route is one call away from the right token-mismatch / unknown-token / disabled-account branch, with `last_seen_at` bumped exactly once. The 401-vs-404 split, the bump-before-enabled-gate ordering, and the body-token-vs-URL-token redundancy check all live in one place. **Don't fragment this.**
- **`google-flow.ts` repo** wraps every SQL with a clear contract — `requeueTask` clears `external_task_id` for the dedup-ring reason; `bumpRetryCount` is decoupled from `requeueTask` so reaper salvage doesn't burn retry budget; `takeNextTaskForAccount` mints a fresh `external_task_id` on every claim. The repo is the model the rest of the codebase should follow (see audit 2026-04-17 #2).
- **`flow-watcher.ts`'s 3-stage tick ordering is load-bearing**, and the function is a pure `(db, now, thresholds) => void` so tests can freeze time. Don't reorder the stages or fold them into one query.
- **`flow-media.ts`'s SSRF allowlist + atomic write** are the right kind of defense-in-depth (the `submit-result` route also re-validates with `isAllowedResultHost`). Don't drop either layer.
- **Extension's `MODEL_MATRIX` flat lookup** (audit 2026-04-22 #5) and the **executor registry** (audit 2026-04-22 #1) both shipped clean and are doing exactly what the prior audit recommended. Use them as references when tackling Finding #4 (server's `errorCategory` dispatch) and Finding #7 (settings schema).
- **`webhook.js`'s single HistForge-facing funnel** is preserved — every HistForge POST goes through one of `postStatusEvent`, `notifySessionExpired`, `submitResult`, `submitFailure`, `postProjectCreated`, `postProgressEvent`. The session-expired sticky flag dedup lives in the funnel. Don't have other modules call HistForge directly.

**Carry-overs from prior audits worth re-flagging.**

- **`account-tier.js:62 detectAccountTier` defaults to `ultra` on detection failure.** Same gap audit 2026-04-22 noted as "non-SOLID, out of scope." A Pro account whose `userPaygateTier` read fails gets ultra model keys and 403s on every subsequent generation until `stopAllProcessing` clears the cache. The `clearCachedTier` from auto-stop / stop-all does evict it now, but a polling re-arm without going through stop won't. Consider defaulting conservatively to `pro` or forcing re-detection on consecutive 403s. **Reliability concern, not SOLID — call out separately if/when the Phase 5 / reliability sweep is planned.**

**Cross-cutting observation.**

- The extension and coordinator are now mostly aligned in structure (registries, repos, single-funnels, schema separation), but the **wire contract between them lives nowhere in source.** The v2 `errorCategory` enum is defined implicitly across `extensions/youforge-flow/src/flow-error.js:_categorize` (the producer) and `src/app/api/flow/submit-result/[token]/route.ts:handleError` (the consumer). The content-policy reason list is duplicated in both. The webhook payload shapes (`TaskRequest`, `ResultSubmission`, `StatusEvent`, `ProjectCreated`) are defined in extension JS and validated by Zod schemas in TS — neither side imports the other. A small `docs/flow-wire-contract.md` (or generated types) would make these contracts explicit and auditable; today they're enforced by reading both sides. Findings #2 and #4 are both symptoms of this implicit-contract design.
