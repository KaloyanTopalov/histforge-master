---
name: Google Flow SOLID — Issues 4-10
description: Phase 2 of the 2026-04-28 SOLID audit. Issues 1-3 shipped; this plan covers the medium-severity findings on both the coordinator and youforge-flow extension sides.
---

# Google Flow SOLID — Issues 4-10

## Overview

Follow-up to `2026-04-28-google-flow-solid-1-3.md`. The first plan resolved the high-severity items (cool-off helper, content-policy list sync, `runner.js` cool-off extraction). This plan covers the seven medium-severity findings: one OCP refactor on the server's error dispatch, one DRY cleanup of the extension's last unconsolidated throw paths, the settings-schema rewrite that unblocks the defensive-guard cleanup, and three SRP decompositions (`runGoogleFlowStep`, `handleTaskFailedFIFO`, `google-flow-accounts.tsx`).

## Current State

Verified against the working tree on 2026-04-28:

- **Issue #4** — `src/app/api/flow/submit-result/[token]/route.ts:77-151` still dispatches via if-chain on `errorCategory` (5 categories: `create_project_failed`, `auth`, `stale_project_id`, `rate_limit`, `transient`) with a legacy `classifyError` fallback for missing categories.
- **Issue #5** — Two of three throw paths already adopted `throwFlowApiError` (Phase 1):
  - `extensions/youforge-flow/flow-api.js:35-51` ✓ uses helper
  - `extensions/youforge-flow/src/page-call.js:109-138` ✓ uses helper
  - `extensions/youforge-flow/src/project-mgmt.js:104-153` — only the 429 rung (line 130) routes through `throwFlowApiError`; 401 (109-115), 5xx (133-141), 4xx (144-152) still call `throw makeFlowApiError(...)` directly and rebuild the classification logic that `parseFlowApiError` already owns.
- **Issue #6** — `src/app/settings/google-flow-accounts.tsx` is 483 lines; one component owns fetch (105-122), all mutations (124-175), inline editing, three dialogs, and the table render.
- **Issue #7** — `extensions/youforge-flow/src/settings.js` declares 35 module-scoped tunables as `let X = default; function getX() { return X; }`; `extensions/youforge-flow/popup.js` mirrors 15 of them in `ADVANCED_NUMERIC_FIELDS` (lines 28-46). Adding one tunable still costs 5 edits in two files with no compile-time check that the defaults agree.
- **Issue #8** — 27 `typeof getX === 'function'` defensive guards across `runner.js`, `auth.js`, `webhook.js`, `handlers.js`, `media-fetch.js`, `page-call.js`, `account-tier.js`, `credits-poller.js`, `executors/upscale.js`, `poll-video.js`, `logger.js`, plus `cooldown.js`, `status.js`, `self-test.js` (the last three not in the original audit). Note: `cooldown.js`, `status.js`, and `self-test.js` use the guard pattern against runner-state / status-funnel accessors, not settings getters — see Task 4.1 for how they're handled.
- **Issue #9** — `src/worker/steps/google-flow-common.ts` is 326 lines; `runGoogleFlowStep` (66-188) inlines enqueue + wait/moderate loop + failure aggregation; `maybeModerate` (204-325) bundles failed-row lookup, item building, LLM call, in-memory chunks update, DB transaction, and `chunks.json` write.
- **Issue #10** — `extensions/youforge-flow/src/handlers.js:99-176` (`handleTaskFailedFIFO`) inlines four concerns. The cool-off fallback at lines 144-146 is now provably redundant: every throw site arms cool-off via `throwFlowApiError` (Phase 1 / Issue #3); the comment already concedes the block is a safety net.

Audit reference: `docs/refactoring/solid-audit-2026-04-28-google-flow.md` findings #4-#10.

## Scope

**Doing**:
- #4: Replace the `submit-result` `errorCategory` if-chain with a registry; legacy `classifyError` stays as the default branch.
- #5: Extract a `throwFromResponse({ httpStatus, body, retryAfterHeader, contextLabel, urlForStaleProjectCheck })` helper next to `makeFlowApiError`; collapse `project-mgmt.js`'s full four-rung 401/429/5xx/4xx ladder through it (the 429 rung's existing `throwFlowApiError` call is uniformly replaced).
- #7: Replace per-tunable `let/getX/storage-key/popup-field` boilerplate with a single `SETTINGS_SCHEMA` table; popup reads its advanced-fields list off the schema.
- #8: Remove the 27 defensive `typeof === 'function'` guards once accessors are guaranteed to exist (gated on #7).
- #9: Split `runGoogleFlowStep` into `enqueueChunks` / `runModerationLoop` / `aggregateFailures`; split `maybeModerate` into `buildModerationItems` / `applyModerationRewrites` so the LLM call is the only thing the function owns.
- #10: Split `handleTaskFailedFIFO` into `submitFailureToHistForge` / `bumpFailureStats` / `maybeTripCircuitBreaker`. **Drop** the cool-off fallback at lines 144-146 (now redundant after Phase 1).
- #6: Decompose `google-flow-accounts.tsx` into a `useFlowAccounts` hook, a `GoogleFlowAccountsTable` presentational component, and `FlowAccountMintedDialog` / `FlowAccountDeleteConfirm` / `useEditableName` extractions.

**Not doing**:
- Issues #11, #12, #13 (low severity, deferred to a later sweep).
- The `account-tier.js` ultra-default reliability concern from the audit's "Carry-overs" section (not SOLID; tracked separately).
- The `docs/flow-wire-contract.md` documentation suggestion from the audit's cross-cutting observation.
- Generated code for the cross-runtime content-policy list sync (Phase 1 already added a divergence test; build-time generation is out of scope here).

## Tasks

### Phase 1: Server `errorCategory` registry (Issue #4)

- [x] **Task 1.1: Convert `handleError` if-chain into a category registry**
  **Files**: `src/app/api/flow/submit-result/[token]/route.ts`, `__tests__/api/flow/submit-result/[token]/route.test.ts`
  **What**: Replace the five sequential `if (category === '...')` blocks at lines 77-151 with a `Record<string, (db, args) => void>` keyed by category. Each existing branch becomes a named handler (`handleCreateProjectFailed`, `handleAuth`, `handleStaleProjectId` — `handleQuota` and `handleTransient` already exist). The legacy `classifyError` fallback stays as the default branch when `parsed?.errorCategory` is missing or unknown.
  **Context**: Pattern parallel: see the extension's executor registry at `extensions/youforge-flow/src/executors/index.js` (audit 2026-04-22 #1) — that's the shape to mirror. Preserve every comment from the current branches; the `create_project_failed` 24h pause + flag write and the `stale_project_id` `clearFlowProjectForAccount` semantics are load-bearing. Do not change behavior for unknown categories — the fallback path at lines 140-150 stays intact.

  Tests: `__tests__/api/flow/submit-result/[token]/route.test.ts` covers this route — it must keep passing without modification. The refactor is behavior-preserving; if any test breaks, the registry mapped a category differently than the old branch. Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:55-59`.

### Phase 2: Extension `throwFromResponse` helper (Issue #5)

- [x] **Task 2.1: Add `throwFromResponse` helper**
  **Files**: `extensions/youforge-flow/src/flow-error.js`, `__tests__/unit/youforge-flow/flow-error.test.ts`
  **What**: Add a helper alongside `makeFlowApiError` / `throwFlowApiError` (already shipped in Phase 1) that takes `{ httpStatus, body, retryAfterHeader, contextLabel, urlForStaleProjectCheck? }`, synthesizes a response-shape object for `parseFlowApiError`, applies the stale-project-id 404 override (the same logic `flow-api.js:42-47` and `page-call.js:121-125` use today), and ends in `await throwFlowApiError(parsed, fallbackMsg)`. Returns `Promise<never>`.
  **Context**: The 404+/projects/ stale-project override and the cool-off arming both already live in two places — `flow-api.js:_throwFlowApiError` and `page-call.js`'s error branch. Read those first to confirm the shape that needs to subsume both. The helper's purpose is to be the single funnel the third caller (`project-mgmt.js`) can use.

  Tests: `__tests__/unit/youforge-flow/flow-error.test.ts` covers `parseFlowApiError` / `makeFlowApiError` / `throwFlowApiError`. Add coverage for `throwFromResponse`: at minimum a 404-on-`/projects/` URL → stale-project-id case, a 429 rate-limit case (verifies cool-off arming flows through), and a generic 4xx case. Existing tests must stay green. Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:63-67`.

- [x] **Task 2.2: Route all four `_createFlowProject` rungs through `throwFromResponse`**
  **Files**: `extensions/youforge-flow/src/project-mgmt.js`, `__tests__/unit/youforge-flow/project-mgmt.test.ts`
  **What**: Replace all four blocks at 109-115 (401, `throw makeFlowApiError`), 118-130 (429, `await throwFlowApiError`), 133-141 (5xx, `throw makeFlowApiError`), and 144-152 (4xx, `throw makeFlowApiError`) with calls to `throwFromResponse`. The four-rung status ladder (104-153) collapses into a single helper call passing `httpStatus`, `body`, `retryAfterHeader`, `contextLabel: 'createProject'`, and a category override for the cases where `parseFlowApiError`'s default doesn't match (the 4xx rung needs `create_project_failed` instead of `transient`). The 429 rung's existing `throwFlowApiError` call is *also* migrated — the goal is one uniform funnel, not a mixed convention.
  **Context**: All four rungs migrate together — the 429 rung gets no special treatment beyond the others. The helper's signature must let callers override the parsed category (the 4xx → `create_project_failed` case is the motivating example) and the parsed reason / message. Don't lose the `safeLog('createProject HTTP ' + status + ' body:', truncated)` debug logs — fold them into the helper (gated on a `contextLabel` arg) or keep them at the call site before the throw. The 401 rung's `isSessionExpired: true` flag is load-bearing for `notifySessionExpired` downstream — verify it survives the migration.

  Tests: `__tests__/unit/youforge-flow/project-mgmt.test.ts` exercises `_createFlowProject` and the four-rung ladder; the refactor is behavior-preserving and these tests must stay green. Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:65-67`.

### Phase 3: Settings schema (Issue #7)

- [x] **Task 3.1: Build `SETTINGS_SCHEMA` and rewrite `loadSettings`**
  **Files**: `extensions/youforge-flow/src/settings.js`, `__tests__/unit/youforge-flow/settings.test.ts`
  **What**: Define a single `SETTINGS_SCHEMA` array with one entry per tunable: `{ key, default, kind: 'string'|'number'|'boolean'|'enum', enumValues?, popup?: { id, label } }`. Replace the 35 individual `let X = default` declarations and the matching `getX()` accessors with a single internal store (e.g. a `Map` keyed on schema-key) and a single `getSetting(key)` accessor. `loadSettings` becomes one loop that reads `chrome.storage.local.get(SETTINGS_SCHEMA.map(s => s.key))` and runs each value through a `coerce(kind, value, default)` helper. Existing public accessors (`getTaskPollIntervalSec`, etc.) become one-line wrappers around `getSetting('taskPollIntervalSec')` so the rest of the extension keeps compiling. The `popup` field lands now (consumed in Task 3.2) — entries that don't appear in the popup omit it.
  **Context**: Verify the current default values against the schema entries before deleting the `let X = default` lines — silent default drift is the worst failure mode here. Settings already involved in Phase 1 work (`rateLimitCooldownMinutes`, `circuitBreakerThreshold`) need to keep behaving identically.

  Tests: `__tests__/unit/youforge-flow/settings.test.ts` covers `loadSettings`, the coercion guards, and per-tunable getter behavior; the refactor must keep them green and add coverage for `getSetting(unknown_key)` returning `undefined` (or whatever the schema contract specifies). Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:86-99`.

- [x] **Task 3.2: Drive popup advanced fields off the schema**
  **Files**: `extensions/youforge-flow/popup.js`
  **What**: Replace the `ADVANCED_NUMERIC_FIELDS` array (lines 28-46) with a derivation off `SETTINGS_SCHEMA` — filter to entries that have a `popup` field. After this task, adding a tunable touches **only** the schema entry: `key`, `default`, `kind`, and (when popup-exposed) `popup: { id, label }` all live in one place. The 5-place edit problem (storage-key array + read + let/getter + update handler + popup field) is gone.
  **Context**: Today's `ADVANCED_NUMERIC_FIELDS` carries `{ key, id, def }`. The `id` ties to a hand-authored DOM element in the popup HTML — keeping it on the schema entry is fine because the schema is the only consumer that reads it. If the popup HTML still owns the markup, the schema entry's `popup.id` is what `popup.js` queries; if a future refactor renders rows dynamically, the schema is already the right shape.

  Tests: no popup-specific test exists in `__tests__/unit/youforge-flow/`; verification is by smoke-test (open the popup, confirm advanced fields render with the right defaults). Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:97-99`.

### Phase 4: Drop defensive guards (Issue #8)

**Sequencing note**: Land Phase 3 first and smoke-test the extension end-to-end (queue poll → task dispatch → submit-result) before starting Phase 4. A regression in the schema rewrite would otherwise be masked by a simultaneous guard removal.

- [x] **Task 4.1: Remove `typeof === 'function'` guards across the extension**
  **Files**: `extensions/youforge-flow/src/runner.js`, `auth.js`, `webhook.js`, `handlers.js`, `media-fetch.js`, `page-call.js`, `account-tier.js`, `credits-poller.js`, `executors/upscale.js`, `poll-video.js`, `logger.js`, `cooldown.js`, `status.js`, `self-test.js`
  **What**: Replace each `(typeof getX === 'function') ? getX() : default` site with a direct `getX()` (or `getSetting(key)`) call. 27 occurrences. The defensive guard exists because pre-schema accessors could be undefined under some sandbox loads; after Phase 3 settings accessors are guaranteed.

  Per-file scoping:
  - **Settings getters** (the bulk — `runner.js`, `auth.js`, `webhook.js`, `handlers.js`, `media-fetch.js`, `page-call.js`, `account-tier.js`, `credits-poller.js`, `executors/upscale.js`, `poll-video.js`, `logger.js`): drop the guard, call `getSetting(key)` (or the wrapper) directly.
  - **Non-settings accessors** (`cooldown.js`, `status.js`, `self-test.js`): these guard against runner-state / status-funnel imports that aren't in `SETTINGS_SCHEMA`. For each occurrence, decide: (a) the import is always present at runtime → drop the guard; (b) the import is genuinely conditional (e.g. test sandbox) → keep the guard and add a one-line comment explaining why. Don't add these to the schema; they're cross-module references, not tunables.
  **Context**: This is mechanical but invasive — best done as one pass with a clear diff. `poll-video.js:15-20` stacks the pattern five times in six lines and is a useful sanity check that the rewrite is uniform on the settings-getter side.

  Tests: every file in the touched list has a matching test under `__tests__/unit/youforge-flow/` (e.g. `runner.test.ts`, `auth.test.ts`, `webhook.test.ts`, `handlers.test.ts`, `media-fetch.test.ts`, `page-call.test.ts`, `account-tier.test.ts`, `credits-poller.test.ts`, `upscale.test.ts`, `poll-video.test.ts`, `logger.test.ts`, `status.test.ts`, `self-test.test.ts`). Run the full extension test suite after the pass; a previously-passing test failing post-removal indicates a guard that was real (case (b) in the per-file scoping). Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:103-110`.

### Phase 5: SRP decompositions

**Independence note**: Tasks 5.1, 5.2, and 5.3 are fully independent — different files, different domains. Pick any order; they can be parallel PRs.

- [x] **Task 5.1: Decompose `runGoogleFlowStep` and `maybeModerate`**
  **Files**: `src/worker/steps/google-flow-common.ts`, `__tests__/unit/worker/steps/google-flow-common.test.ts`
  **What**: Extract three named subroutines from `runGoogleFlowStep` (66-188):
  - `enqueueChunks` — the disk → open-row → enqueue cascade (87-111) plus the no-enqueueable / no-existing-outputs hard stop. Returns `{ existingOutputs, enqueueableChunks }`.
  - `runModerationLoop` — the wait → moderate → re-wait iteration (126-167) with the `MAX_MODERATION_ITERATIONS_GUARD`. Includes the `deferred: true / retryAfter` early return at 165 (this belongs to the wait loop, not aggregation).
  - `aggregateFailures` — the disk-presence-driven failure aggregation throw (169-185). The throw fires only when chunks have failed *and* their output files are still missing.

  The orchestrator keeps the final `videosRepo.clearDeferredUntil(db, videoId)` call at line 187 — it's the success-path side effect after aggregation passes, and stays in `runGoogleFlowStep` where the orchestration sequence is visible.

  Inside `maybeModerate` (204-325), pull out `buildModerationItems(chunks, failed)` and `applyModerationRewrites(chunks, writes)` so the function's body is the moderator call plus the surrounding I/O orchestration.
  **Context**: `runGoogleFlowStep` is the only Flow worker step doing this much — the other `generate-*-google-flow.ts` steps are ~30-line wrappers, so the split should keep this file's exports stable. Watch the `MAX_MODERATION_ITERATIONS_GUARD` belt-and-suspenders — it's defense against a moderator that never stabilizes; keep it inside `runModerationLoop`. Don't change the chunks.json read/write semantics: it's read once before the loop and written once after the moderator returns.

  Tests: `__tests__/unit/worker/steps/google-flow-common.test.ts` exists and covers the orchestration; the split is behavior-preserving and these tests must stay green. Run them after the refactor. Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:114-124`.

- [x] **Task 5.2: Split `handleTaskFailedFIFO`**
  **Files**: `extensions/youforge-flow/src/handlers.js`, `__tests__/unit/youforge-flow/handlers.test.ts`
  **What**: Split `handleTaskFailedFIFO` (99-176) into three named helpers: `submitFailureToHistForge(task, errorOrMessage)` (the `submitFailure` + `markJobAsCompleted` pair), `bumpFailureStats(error)` (the `bumpStat('failed')` call plus the per-category daily counters at 121-132), and `maybeTripCircuitBreaker(error)` (the `_shouldCountForCircuitBreaker` + threshold check + halt sequence at 149-175 — owns the `CIRCUIT_BREAKER_THRESHOLD_DEFAULT` constant). **Delete** the cool-off fallback block at 144-146: every throw site arms cool-off via `throwFlowApiError` (Phase 1 / Issue #3); the inline comment already concedes the block is a safety net for hand-built errors that "forgot to wire it" — but Phase 1 made the helper the only sanctioned throw path. The orchestrator becomes ~6 lines.
  **Context**: The audit (`docs/refactoring/solid-audit-2026-04-28-google-flow.md:128-138`) listed `maybeTriggerCooldownFallback` as the fourth helper expecting it to fold into Issue #3's helper; since #3 shipped, the cleanest move is to remove the block entirely rather than wrap it. If a future call site bypasses `throwFlowApiError`, that's a bug to fix at the call site, not a safety net to keep here.

  Tests: `__tests__/unit/youforge-flow/handlers.test.ts` covers `handleTaskFailedFIFO` (submission, stat counters, circuit breaker). The split is behavior-preserving and existing tests must stay green. Tests that asserted the cool-off fallback fired need to be updated or removed — that's expected, the behavior is gone by design.

- [x] **Task 5.3: Decompose `google-flow-accounts.tsx`**
  **Files**: `src/app/settings/google-flow-accounts.tsx`, plus new sibling files (see naming below); `__tests__/components/settings/google-flow-accounts.test.tsx`
  **What**: Extract:
  - `useFlowAccounts()` hook — owns `accounts` state, `loading`, `error`, `reload`, and the `patchAccount` / `onAdd` / `onDelete` mutators (current lines 92-175).
  - `GoogleFlowAccountsTable` — pure presentational component taking `accounts`, `nowSec`, and the action callbacks.
  - `FlowAccountMintedDialog` — the create-account result dialog (lines 392-449).
  - `FlowAccountDeleteConfirm` — the delete confirmation (lines 451-481).
  - `useEditableName(commit)` — encapsulates the inline-name-edit state machine.

  Top-level `GoogleFlowAccounts` becomes ~50 lines of composition.

  **File layout**: The rest of `src/app/settings/` is flat (`google-flow-accounts.tsx`, `page.tsx`, `settings-form.tsx`) — match that. New files go as siblings: `src/app/settings/google-flow-accounts-table.tsx`, `google-flow-accounts-hooks.ts` (for `useFlowAccounts` + `useEditableName`), `google-flow-account-minted-dialog.tsx`, `google-flow-account-delete-confirm.tsx`. Do **not** introduce a `google-flow-accounts/` subdirectory — nothing else under `settings/` is nested.
  **Context**: Pattern reference: `src/app/videos/videos-client.tsx` and `src/app/settings/topics-table.tsx` already follow the hook + table + dialog split — match their style. Don't move the `nowSec` ticker into the hook unless the table consumes it directly; it's a render-only concern. Watch the `pauseFor` / `pauseIndefinitely` / `resume` / `toggleEnabled` / `commitNameEdit` callbacks — all currently `useCallback`-wrapped and need stable identities for the table.

  Tests: `__tests__/components/settings/google-flow-accounts.test.tsx` exists and exercises the component's user-visible behavior — it must keep passing. If the test imports the top-level component only, no test changes are needed; if it imports internals, update imports to point at the new files. Audit detail: `docs/refactoring/solid-audit-2026-04-28-google-flow.md:71-82`.

## References

- Audit: `docs/refactoring/solid-audit-2026-04-28-google-flow.md` findings #4-#10
- Phase 1 plan: `docs/plans/2026-04-28-google-flow-solid-1-3.md`
- Prior extension audits: `docs/refactoring/solid-audit-2026-04-22-youforge-flow.md` (executor registry, runner phases) — Phase 5 of this plan extends those patterns to the coordinator side and the remaining extension monoliths.
