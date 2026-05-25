# Flow Credits Display Bug — Fix plan

**Status**: investigation complete, fix planned (Option A)
**Symptom**: Settings > Google Flow > Accounts shows `"—"` in the Credits column even though the extension is running.
**Date raised**: 2026-04-23

## Investigation summary

1. DB check: `credits` and `credits_updated_at` are `NULL` for `acc_01` — no credits StatusEvent has ever landed. Rules out a UI render bug.
2. `last_seen_at` is refreshed whenever any webhook (`next-task`, `submit-result`, `status`) hits `flow-auth.ts:101`, including task polling every ~10 s when Start is on. With polling active, `last_seen_at` is current — so **the extension is reaching the worker for tasks**. Credits path specifically is failing.
3. Service-worker console shows zero `[credits]` log lines because `credits-poller.js:pollCreditsOnce()` has **four silent branches**, not one:
   - `tabs.length === 0` → silent return (line 33)
   - `!authToken` → silent return (line 35)
   - `!result` from `getCredits` (Google non-2xx) → silent return (line 37)
   - bare `catch (_e)` → silent swallow (line 46)
   - Plus: no log on the success path either.
4. Root cause therefore cannot be pinpointed without adding observability first.

Original design (`docs/plans/2026-04-20-google-flow-hybrid.md` Task 1.9, committed `b1937f8`): credits poll every 60 s **while polling is active**, stopped when the user clicks Stop. The silent-catch was explicit in that task ("Failures (including session errors) are silent — don't spam the status endpoint"). The operator-visibility gap that design created is what we're fixing now.

## Decision (Option A)

- Keep credits polling tied to Start/Stop (no decoupling, no one-shot-on-connect).
- Surface per-branch failures to the **service-worker console only** via `safeLog` — no new DB column, no `credits_error` StatusEvent, no dashboard badge.
- Make the settings cell distinguish "polling stopped" from "polling on but credits unknown" using the existing `last_seen_at` column and the existing `DEFAULT_STALE_ACCOUNT_MINUTES = 10` threshold from `src/lib/flow-watcher.ts:43`.

## Phase 1 — Extension observability (diagnostic prerequisite)

Adds log lines on every silent branch of `pollCreditsOnce`. No behaviour change. After this phase lands, restarting the extension yields a log line per poll cycle that identifies which branch was taken — that finding goes in the PR description (acceptance criterion #1).

- [x] **Task 1.1: Log every outcome in `pollCreditsOnce`**
  **Files**: `extensions/youforge-flow/src/credits-poller.js`
  **What**: Replace each of the four silent returns / catches with a `safeLog('[credits] <outcome>', ...)`. Include:
  - `no Flow tab — skipping`
  - `no session token — skipping`
  - `Google non-2xx (getCredits returned null)`
  - `poll failed: <err.message>`
  - `ok — <n> credits` on the success path (after `postStatusEvent`).
  Keep all existing early-return semantics; only add logs. `safeLog` is already imported via the classic-script `importScripts` order (see file header comment).
  **Context**: Current silent paths in `credits-poller.js:30-49`. `safeLog` lives at `extensions/youforge-flow/src/logger.js`. Message prefix `[credits]` keeps these grep-able in the service-worker console alongside the existing `[YouForge Flow]` prefix (`safeLog` adds the outer prefix automatically).
  **Tests**: Skipping TDD — this is a Chrome extension classic-script file with no existing test harness. Verify by restarting the extension, opening the service-worker console, and watching for at least one `[credits]` line within one poll cycle (1 min).

### Phase 1 exit — root cause identified

Service-worker console printed `[credits] Google non-2xx (getCredits returned null)`. Network tab confirmed Google returns **403 `API_KEY_HTTP_REFERRER_BLOCKED`** with `httpReferrer: <empty>`:

- `flow-api.js:7-14` sets `'referer': 'https://labs.google/'` in `apiHeaders()` — but Chrome silently strips this. `Referer` is on the Fetch spec's forbidden-header-name list; service-worker `fetch()` cannot set it.
- The API key `AIzaSyBt...` is configured in Google Cloud Console with an HTTP-referrer restriction to `labs.google/*`. Requests without a matching Referer get 403.
- Only `getCredits` sends the API key (`flow-api.js:91`: `?key=${GOOGLE_LABS_API_KEY}`). The other aisandbox-pa calls (`checkVideoStatus`, `uploadImage`) use bearer-only auth — no key → no referrer check → they work. That's why task polling works but credits doesn't.
- Credits polling has never worked in production since commit `b1937f8` (April 21). The silent catch hid it.

## Phase 3 — Fix the 403 (B2-first, B1 fallback)

Two options, ordered by cost.

- [x] **Task 3.1 (B2): Drop the API key from the credits URL**
  **Files**: `extensions/youforge-flow/flow-api.js`
  **What**: Change `const url = \`${AISANDBOX_BASE}/credits?key=${GOOGLE_LABS_API_KEY}\`;` → `const url = \`${AISANDBOX_BASE}/credits\`;`. No other changes.
  **Why it might work**: the other aisandbox-pa endpoints accept bearer-only — the credits endpoint may do the same. If Google's gateway doesn't require a project-scoped key here, dropping it removes the referrer-restricted check entirely.
  **Why it might not**: we don't know if the endpoint is bearer-only-capable. If the gateway requires the project key, we'll get a different 401/403/400.
  **Tests**: Skipping TDD — speculative URL edit with no existing `flow-api.js` test file. If B2 works we may add a minimal regression test; if B2 fails we discard and pivot to B1.
  **Verification**: user reloads the extension, waits 60–90 s for the next alarm, reports the new `[credits]` log line:
  - `[credits] ok — N credits` → B2 worked. Proceed to Phase 2.
  - `[credits] Google non-2xx (...)` again → B2 failed. Check Network tab for the new status code + response body, then pivot to B1 (Task 3.2).

- [~] **Task 3.2 (B1 fallback — only if 3.1 fails): Route credits through the labs.google tab**

  **Not needed** — Task 3.1 succeeded. Bearer-only auth works against `/v1/credits`; the API-key+Referer path was never required. Kept here for future reference if Google changes their gateway policy.
  **Files**: `extensions/youforge-flow/flow-api.js`, `extensions/youforge-flow/src/credits-poller.js`, `__tests__/unit/youforge-flow/credits-poller.test.ts`
  **What**: Refactor `getCredits` to take a `tabId` argument and execute the fetch via `chrome.scripting.executeScript({ world: 'MAIN' })` against the labs.google tab — same pattern as `page-call.js:apiCallViaPage` but GET-shaped. Poller already has `tabId` in scope.
  **Why**: running the fetch from the labs.google tab's MAIN world means the browser auto-sends `Referer: https://labs.google/` because that *is* the tab's origin. Established pattern in this codebase (`page-call.js:24` for reCAPTCHA-tied calls).
  **Tests** (TDD): mock `chrome.scripting.executeScript` in the sandbox; assert `getCredits` invokes it with the correct URL and that the poller passes the right `tabId`. One vertical-slice test per behaviour.
  **Deferred** until Task 3.1's verification fails.

## Phase 2 — Settings cell UX (Option A core)

Replaces the binary `—` with three states so the operator can tell at a glance whether polling is even running.

- [x] **Task 2.1: Extract `STALE_ACCOUNT_MINUTES` to an isomorphic module**
  **Files**: `src/lib/flow-watcher.ts`, new `src/lib/flow-constants.ts`
  **What**: Move `DEFAULT_STALE_ACCOUNT_MINUTES = 10` from `flow-watcher.ts:43` to a new `src/lib/flow-constants.ts` and export it. Update `flow-watcher.ts` to import from the new location. No behaviour change.
  **Context**: `flow-watcher.ts` imports `better-sqlite3` (server-only) so a client component can't import from it. A dedicated constants module avoids duplicating the `10` value in the client bundle.
  **Tests**: No new tests — trivial refactor. Existing `__tests__/unit/flow-watcher.test.ts` covers the behaviour; running the suite confirms nothing broke.

- [x] **Task 2.2: Three-state credits cell**
  **Files**: `src/app/settings/google-flow-accounts.tsx`, `__tests__/components/settings/google-flow-accounts.test.tsx`
  **What**: Replace the current render at `google-flow-accounts.tsx:309-316` with:
  - `credits !== null` → `{credits} ({relative(credits_updated_at)})` — unchanged from today.
  - `credits === null && (last_seen_at === null || last_seen_at older than STALE_ACCOUNT_MINUTES)` → `polling stopped · last seen {relative(last_seen_at)}`.
  - `credits === null && last_seen_at within STALE_ACCOUNT_MINUTES` → `— (awaiting first poll)`.
  Import `STALE_ACCOUNT_MINUTES` from `@/lib/flow-constants`.
  **Context**: `relative()` helper at `google-flow-accounts.tsx:59`. `acc()` factory + `renderComponent()` harness in the existing test file.
  **Tests** (TDD, vertical slices — one test at a time, each followed by implementation):
  1. **RED→GREEN**: renders the number + relative time when `credits` is set (regression guard for today's behaviour).
  2. **RED→GREEN**: renders `polling stopped · last seen …` when `credits === null` and `last_seen_at` is older than 10 min.
  3. **RED→GREEN**: renders `— (awaiting first poll)` when `credits === null` and `last_seen_at` is within 10 min.
  4. **RED→GREEN**: renders `polling stopped · last seen never` when `credits === null` and `last_seen_at === null`.
  Use `vi.useFakeTimers()` / `vi.setSystemTime()` — matches patterns already in the test file if present; else introduce via `beforeEach` / `afterEach`.

## Acceptance

- [ ] Root cause identified and recorded in the PR description, sourced from the `[credits]` log lines printed after Phase 1.
- [ ] Settings cell no longer shows a bare `—` for a stopped poller — "polling stopped · last seen Nh ago" is visible instead.
- [ ] Silent `catch (_e) {}` in `credits-poller.js` is gone, plus all three upstream silent returns in that function.
- [ ] Existing test suite still green.

## Reference files

| File | Purpose |
|---|---|
| `extensions/youforge-flow/src/credits-poller.js` | Extension-side credits alarm + poll logic (silent paths here) |
| `extensions/youforge-flow/flow-api.js:88` | `getCredits(authToken)` |
| `extensions/youforge-flow/src/webhook.js:16` | `postStatusEvent` (already logs its own failures) |
| `src/app/api/flow/status/[token]/route.ts:30-60` | Worker receiver for `credits` StatusEvent |
| `src/lib/repos/google-flow.ts:104-113` | `updateAccountCredits` |
| `src/lib/flow-watcher.ts:43` | Current home of `DEFAULT_STALE_ACCOUNT_MINUTES` (moves in Task 2.1) |
| `src/app/settings/google-flow-accounts.tsx:309-316` | Credits cell render |
| `__tests__/components/settings/google-flow-accounts.test.tsx` | Existing UI test harness + `acc()` factory |
