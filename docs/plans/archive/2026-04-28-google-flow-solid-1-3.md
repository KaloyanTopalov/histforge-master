# Google Flow SOLID Audit — Items #1, #2, #3

## Overview
Address the three "Immediate / high severity" findings from `docs/refactoring/solid-audit-2026-04-28-google-flow.md`: sync the content-policy reason list across the wire (#2), extract the rate-limit cool-off subsystem out of `runner.js` (#1), and collapse five duplicate cooldown-trigger sites into a single throw helper (#3). All three are in the YouForge Flow extension and the HistForge coordinator's flow-error classifier.

## Current State

**Cross-wire content-policy lists drift (#2):**
- Server: `src/lib/flow-error-classify.ts:29-40` — 10 entries in `CONTENT_POLICY_REASONS`, plus the broader regex `/SAFETY|CHILD_DANGER|PUBLIC_ERROR_/` in `classifyError` (line 62) and a `PUBLIC_ERROR_FILTER_RE` for tag extraction (line 49).
- Extension: `extensions/youforge-flow/src/flow-error.js:19-35` — 15 entries in `FLOW_CONTENT_POLICY_REASONS` (5 named `PUBLIC_ERROR_*_FILTER*` codes the server lacks).
- Comment at `flow-error-classify.ts:25-27` already declares the extension's list canonical, but nothing enforces that.
- Existing test: `__tests__/unit/lib/flow-error-classify.test.ts` (vitest, imports from `@/lib/flow-error-classify`).

**`runner.js` regrew to 485 lines (#1):**
- Owns: poll loop + slot accounting (lines 37-115, 395-485), TWO alarm subsystems (`pollTasks` + `rateLimitCooldown` at lines 117-135), the soft-pause primitive (`pauseGenerationOnly` / `resumeGenerationOnly` at 142-172), the rate-limit cool-off trigger (`triggerRateLimitCooldown` at 180-206), the launch-stagger and task-poll-interval accessors (`_launchStaggerMs` / `_taskPollIntervalMinutes` at 78-89), the bridge prober (`ensureBridgeAlive` at 271-306), and the cross-tab stop sweep (`forceStopAllTabs`).
- Loaded via `importScripts` from `extensions/youforge-flow/background.js:37` (last in load order — every other module sees its globals at runtime via `typeof === 'function'` guards).
- `startPolling` (208-253) and `stopPolling` (255-266) reference both `chrome.alarms.clear('rateLimitCooldown')` and the soft-pause / cooldown-until state — those calls must remain wired after extraction.

**Five duplicate cooldown-trigger sites (#3):**
The same 3-line `if (parsed.category === 'rate_limit' && typeof triggerRateLimitCooldown === 'function') { try { await triggerRateLimitCooldown(err); } catch (_e) { /* advisory */ } }` block appears at:
- `extensions/youforge-flow/flow-api.js:54-56` (inside `_throwFlowApiError`)
- `extensions/youforge-flow/src/page-call.js:133-135` (inside `apiCallViaPage`'s error branch)
- `extensions/youforge-flow/src/page-call.js:238-240` (inside `uploadImageViaPage`'s upload-resp error branch)
- `extensions/youforge-flow/src/project-mgmt.js:132-134` (inside `_createFlowProject`'s 429 branch)
- `extensions/youforge-flow/src/handlers.js:143-145` (defense-in-depth in `handleTaskFailedFIFO`)

The helper goes in `src/flow-error.js` next to `makeFlowApiError`. `flow-error.js` loads at `background.js:11` — early in the chain — so the helper must look up `triggerRateLimitCooldown` lazily (consistent with how `runner.js` is also loaded later than every call site today).

## Scope

**Doing**: Items #1, #2, #3 from the audit.
**Not doing**:
- Extracting `bridge.js` for `ensureBridgeAlive` (audit lists this as optional within #1).
- Items #4–#13 from the audit.
- Adding a build-time generator that derives the server list from the extension list (audit calls this "long-term" — a divergence test covers the immediate need).
- Changing the v2 `errorCategory` taxonomy emitted by the extension or accepted by the server.

## Tasks

### Phase 1: Sync the content-policy reason list across the wire (#2)

- [x] **Task 1.1: Make the extension's reason set the declared source of truth on the server**
  **Files**: `src/lib/flow-error-classify.ts`
  **What**: `CONTENT_POLICY_REASONS` (lines 29-40) must contain every entry from the extension's `FLOW_CONTENT_POLICY_REASONS` set — currently missing the 5 named `PUBLIC_ERROR_*_FILTER*` codes (`PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED`, `PUBLIC_ERROR_SAFETY_FILTER_FAILED`, `PUBLIC_ERROR_CHILD_FILTER_FAILED`, `PUBLIC_ERROR_DANGER_FILTER`, `PUBLIC_ERROR_AUDIO_FILTERED`). Update the comment at lines 23-28 to point back at `extensions/youforge-flow/src/flow-error.js:19-35` as canonical and warn that the two must stay in sync (cross-reference the divergence test from Task 1.3).
  **Context**: `classifyError` (line 58) and `extractContentPolicyTag` (line 79) both already use this constant — no logic change needed beyond extending the list. The classifier's `PUBLIC_ERROR_` substring branch will still match novel `PUBLIC_ERROR_*` codes, but adding the named entries lets `extractContentPolicyTag` return the precise code instead of falling through.

- [x] **Task 1.2: Add the same canonical-pointer comment on the extension side**
  **Files**: `extensions/youforge-flow/src/flow-error.js`
  **What**: Update the comment block above `FLOW_CONTENT_POLICY_REASONS` (lines 17-18) to declare this list canonical and point at `src/lib/flow-error-classify.ts:CONTENT_POLICY_REASONS` as the mirror that must be kept in sync. Do not change the runtime list.
  **Context**: This closes the documentation half of the LSP fix — both sides now name the canonical owner. The classifier behavior already lives in `isContentPolicyReason` (line 48).

- [x] **Task 1.3: Add a divergence unit test**
  **Files**: `__tests__/unit/lib/flow-error-classify.test.ts`
  **What**: Add a test that reads `extensions/youforge-flow/src/flow-error.js` from disk, parses out the `FLOW_CONTENT_POLICY_REASONS` Set entries, and asserts that every entry is also present in `CONTENT_POLICY_REASONS` from `@/lib/flow-error-classify`. The test fails with a clear message naming the missing codes when the two drift. Also assert the `PUBLIC_ERROR_FILTER_PATTERN` regex on the server matches the source pattern from `flow-error.js:44-46`.
  **Context**: Existing test file uses vitest, imports from `@/lib/flow-error-classify` (`__tests__/unit/lib/flow-error-classify.test.ts:1-5` for pattern). Reading the JS file as text + regex-extracting the Set is the simplest cross-runtime check that doesn't require executing the SW-only JS module. Place the new `describe` block at the bottom of the file so the existing tests remain the primary regression net.

### Phase 2: Extract the cool-off subsystem from `runner.js` (#1)

- [x] **Task 2.1: Create `src/cooldown.js` with the cool-off / soft-pause module**
  **Files**: `extensions/youforge-flow/src/cooldown.js` (new)
  **What**: Move the following from `runner.js` to the new module: `pauseGenerationOnly` (142-150), `resumeGenerationOnly` (152-172), `triggerRateLimitCooldown` (180-206), `_launchStaggerMs` (78-80), `_taskPollIntervalMinutes` (85-89), and the `rateLimitCooldown` branch of the alarm listener (117-122). The `pollTasks` branch of the alarm listener stays in `runner.js`. Re-create the alarm listener split: `cooldown.js` registers its own `chrome.alarms.onAlarm.addListener` that handles only the `rateLimitCooldown` alarm name; `runner.js` keeps a separate listener for `pollTasks`. (Chrome supports multiple listeners on the same event.) Add a brief module docstring naming the public verbs and runtime deps the new module reads (e.g. `getStopFlag`, `getPauseReason`, `setCooldownUntil`, `getRateLimitCooldownMinutes`, `postStatusEvent`, `safeLog`) — same `typeof === 'function'` guard pattern the rest of the extension uses.
  **Context**: `runner.js`'s alarm listener at lines 117-135 is the only place the cooldown alarm is handled today. `_launchStaggerMs` and `_taskPollIntervalMinutes` are private helpers used by both `runner.js` and (transitively, via `triggerRateLimitCooldown`'s effect on the `pollTasks` re-arm) the cooldown subsystem — they go with cooldown.js because the cooldown logic is the more frequent caller. After extraction, `runner.js` calls them through the new module the same way callers in other files do today (i.e. they were already global-scoped service-worker functions; nothing about the call shape changes).

- [x] **Task 2.2: Wire `cooldown.js` into the script load order**
  **Files**: `extensions/youforge-flow/background.js`
  **What**: Add `importScripts('src/cooldown.js')` at the right place in the load order. It must load *before* any caller that today depends on `runner.js`-defined `triggerRateLimitCooldown` / `pauseGenerationOnly` / `_launchStaggerMs` / `_taskPollIntervalMinutes` — practically, anywhere before `src/runner.js` (line 37) is fine since the existing call sites all use `typeof === 'function'` runtime guards. Follow the comment style of the surrounding `importScripts` lines (no extra comment needed).
  **Context**: Current load order: `flow-error.js` (line 11) → `settings.js` (14) → `state.js` (15) → `webhook.js` (17) → … → `runner.js` (37). Place `cooldown.js` after `state.js` (it reads `getPauseReason`/`setCooldownUntil` from state) and after `webhook.js` (uses `postStatusEvent`), e.g. just before `runner.js`.

- [x] **Task 2.3: Update `runner.js` to delegate to `cooldown.js`**
  **Files**: `extensions/youforge-flow/src/runner.js`
  **What**: Remove the moved functions and the `rateLimitCooldown` alarm branch. `markSlotFreedForUpscale` (lines 60-70) and `dispatchTask` (lines 352-393) reference `_launchStaggerMs` directly — let those continue to call it as a global (it's defined in cooldown.js now, same SW global scope). `startPolling` (lines 220-238) and `stopPolling` (lines 258-265) keep their existing cool-off-state cleanup calls (`chrome.alarms.clear('rateLimitCooldown')`, `clearPauseReason`, `setCooldownUntil(null)`) — those are lifecycle-boundary cleanup that runner.js still owns; only the *implementation* of cool-off moves out, not its teardown at start/stop. Update the runner.js header comment at lines 1-35 to reflect the narrower responsibility: runner.js no longer *defines* the cool-off subsystem (drop the trigger / pause-resume bullets if added) but still *clears* its state on start/stop — keep the poll-loop, slot-accounting, and `pollTasks` alarm bullets.
  **Context**: After this task, `runner.js` should be roughly the pre-Phase-3 shape: poll loop + slot accounting + `pollForTasksFIFO` + the `pollTasks` alarm listener + bridge prober + stop sweep, plus the start/stop lifecycle calls into cool-off state. Don't extract `ensureBridgeAlive` to its own file in this plan — out of scope.

- [x] **Task 2.4: Patch `runner.test.ts` loader + verify the extension still loads**
  **Files**: `__tests__/unit/youforge-flow/runner.test.ts`, n/a (extension verification)
  **What**: The plan originally claimed "no unit tests for runner.js," but `__tests__/unit/youforge-flow/runner.test.ts` exists (33 tests; 22 of them exercise the moved cool-off / pause / resume / stagger surface via `vm.runInContext`). After the Phase 2.1–2.3 move, those tests fail with `ReferenceError: _launchStaggerMs is not defined` because the test sandbox loaded only `runner.js`. Patch the loader to also `readFileSync`+`vm.runInContext` `extensions/youforge-flow/src/cooldown.js` into the same sandbox *before* `runner.js` (production load order). All 33 runner tests should pass without behavioral edits — they test the same SW-global symbols, just now sourced from two files. After tests pass: reload the unpacked extension in Chrome, confirm the service worker starts without `ReferenceError`, force a rate-limit cool-off (`chrome.alarms.create('rateLimitCooldown', { delayInMinutes: 0.05 })` from the SW devtools console) and confirm polling resumes; the existing `[runner] rateLimitCooldown alarm fired` log line should still appear (kept verbatim in cooldown.js so observability is byte-identical). User runs dev on Windows per `MEMORY.md` — flag any need to rebuild.
  **Context**: The audit's #1 win is purely an organizational refactor — behavior must be byte-identical. The `vm.runInContext` test pattern works with the move because both files share the same SW global scope at runtime; loading them sequentially into the sandbox mirrors that exactly. A future task (out of scope here) could split the cool-off tests out into `__tests__/unit/youforge-flow/cooldown.test.ts` to reflect the new module boundary, but the loader-patch keeps Phase 2 tight to "organizational refactor with zero test edits beyond setup."

### Phase 3: Consolidate the five cooldown-trigger sites behind a single helper (#3)

- [x] **Task 3.1: Add `throwFlowApiError(parsed)` helper in `flow-error.js`**
  **Files**: `extensions/youforge-flow/src/flow-error.js`
  **What**: Add a new exported helper next to `makeFlowApiError` (which lives at lines 173-195). The helper takes a single argument — the `parsed` shape returned by `parseFlowApiError`, with `parsed.message` already set to whatever the caller wants surfaced (callers pre-bake their fallback message because each call site has a different shape). The helper builds the Error via `makeFlowApiError(parsed)`, fires `triggerRateLimitCooldown(err)` when `parsed.category === 'rate_limit'` (same `typeof === 'function'` guard the existing call sites use, since `flow-error.js` loads before `cooldown.js`), and `throw`s. Returns `Promise<never>`. Document at the top of the helper that this is the single sanctioned throw site for Flow API errors and that the rate-limit cool-off is armed before the throw so downstream `retryWithBackoff` loops see the soft-pause state.
  **Context**: Don't put the trigger inside `makeFlowApiError` itself — the audit considered that and recommended the wrapper instead so `makeFlowApiError` stays a pure error-shape constructor (used today by `sessionExpiredError` at flow-api.js:20-28 to build a synthetic 401 error without an HTTP response — that path must NOT trigger a cooldown). The wrapper is the right boundary. Single-arg signature keeps each migrated call site's existing `parsed.message ||= fallback` step explicit at the call site rather than re-encoding three different fallback policies inside the helper.

- [x] **Task 3.2: Migrate `_throwFlowApiError` in `flow-api.js` to use the new helper**
  **Files**: `extensions/youforge-flow/flow-api.js`
  **What**: Replace lines 39-58 (`_throwFlowApiError`) so the body fetch (41), `parseFlowApiError` (42), and stale-project-id 404 override (47-49) stay (response-shape concerns specific to the real-HTTP path), but the make-error + trigger + throw block (50-57) collapses into: set `parsed.message = parsed.message || fallbackMsg` (where `fallbackMsg` is the existing `isSessionExpired ? SESSION_EXPIRED... : '...failed (status): body...'` construction), then `await throwFlowApiError(parsed)`. The trigger duplicate at 54-56 is gone.
  **Context**: Other parts of `flow-api.js` (line 96, 177) call `_throwFlowApiError` — those callers don't change. Only the inside of `_throwFlowApiError` shrinks.

- [x] **Task 3.3: Migrate `apiCallViaPage`'s error branch in `page-call.js`**
  **Files**: `extensions/youforge-flow/src/page-call.js`
  **What**: Replace lines 106-139 (the error branch inside `apiCallViaPage`) to use `throwFlowApiError`. The fakeResponse construction (108-117), `parseFlowApiError` call (118), and stale-project-id override (123-125) stay because they synthesize a response shape from `chrome.scripting.executeScript`'s result envelope. The fallback-message assignment + make-error + cooldown-trigger + throw (126-136) collapses to: set `parsed.message = parsed.message || (isSessionExpired ? '...' : result.error)`, then `await throwFlowApiError(parsed)`.
  **Context**: This call site uses the URL (`url` parameter) for the stale-project-id check, not `response.url`. Keep that distinction — pass the synthesized `parsed` to the helper.

- [x] **Task 3.4: Migrate `uploadImageViaPage`'s upload-resp error branch in `page-call.js`**
  **Files**: `extensions/youforge-flow/src/page-call.js`
  **What**: Replace lines 227-242 (the `if (!uploadResp.ok)` block inside `uploadImageViaPage`) to use `throwFlowApiError`. No stale-project-id override applies here — the upload endpoint isn't `/projects/<id>/`. The body read + `parseFlowApiError` stay (227-230); set `parsed.message = parsed.message || fallbackMsg`, then `await throwFlowApiError(parsed)`. The trigger at 238-240 is folded in.
  **Context**: This site is wrapped in `retryWithBackoff` (line 160) — the audit emphasizes the cooldown trigger must arm *before* the throw so `shouldRetry` skips on rate-limit. The helper preserves that ordering.

- [x] **Task 3.5: Migrate `_createFlowProject`'s 429 branch in `project-mgmt.js`**
  **Files**: `extensions/youforge-flow/src/project-mgmt.js`
  **What**: Replace lines 125-135 (the post-parse build/throw block in the 429 branch) to use `throwFlowApiError`. The fakeResponse + `parseFlowApiError` (118-124) stay. Mutate `parsed` in place to set `category: 'rate_limit'`, `httpStatus: 429`, `reason: parsed.reason || 'RESOURCE_EXHAUSTED'`, and `message: parsed.message || 'createProject 429'`, then `await throwFlowApiError(parsed)`. The trigger at 132-134 collapses.
  **Context**: This is the manual 401/429/5xx/4xx ladder noted in the audit's #5; only the 429 rung is in scope here. Leave the 401, 5xx, and 4xx rungs untouched in this plan — they don't currently trigger cooldown.

- [x] **Task 3.6: Reframe the defense-in-depth trigger in `handlers.js`**
  **Files**: `extensions/youforge-flow/src/handlers.js`
  **What**: The trigger at `handleTaskFailedFIFO` lines 143-145 is the *fallback* path for rate-limit errors that bypassed the throw-site trigger (per the existing comment at 133-142). With every throw site now going through `throwFlowApiError`, the fallback is still useful as defense-in-depth — keep the call but update the surrounding comment to reflect that all sanctioned throw sites now arm cooldown via the helper, and this branch is the safety net for unexpected pre-categorized errors.
  **Context**: Don't delete this trigger. The audit's #10 is the planned cleanup for this function; folding the trigger into a `maybeTriggerCooldownFallback` helper is part of that future work, not this plan.

- [x] **Task 3.7: Verify duplicates are gone and behavior is preserved**
  **Files**: n/a (verification)
  **What**: `grep -rn "triggerRateLimitCooldown" extensions/youforge-flow/` should now show: the definition (cooldown.js), the helper call inside `throwFlowApiError` (flow-error.js), and the defensive call in `handlers.js`. No other occurrences. Reload the extension and re-run the same manual rate-limit cool-off check from Task 2.4 — confirm a 429 from the Flow API still arms cool-off and that `submitFailure` still sees `category: 'rate_limit'`.
  **Context**: After this phase, adding a sixth throw site requires only routing through `throwFlowApiError` — the audit's "new throw sites won't get [the trigger] for free" risk is closed.

## References

- `docs/refactoring/solid-audit-2026-04-28-google-flow.md` — findings #1, #2, #3 (pp. lines 31-51 in the audit).
- `docs/histforge-spec.md` — wire contract reference (per CLAUDE.md, the spec is the source of truth for the schema and submit-result envelope).
- Existing test file: `__tests__/unit/lib/flow-error-classify.test.ts:1-40`.
- Script load order: `extensions/youforge-flow/background.js:9-41`.
