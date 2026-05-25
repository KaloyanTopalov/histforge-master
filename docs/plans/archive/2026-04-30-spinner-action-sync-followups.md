# Spinner-action-sync follow-ups (audit items #1, #2, #4)

## Overview

Three follow-ups from `docs/refactoring/solid-audit-2026-04-30-spinner-sync.md`. Item #2 splits the `errorToast` parameter into two distinct knobs so the wait-for-timeout policy stops piggy-backing on the POST-failure policy. Item #4 extracts the "vanish-as-satisfied" row predicate into a small named helper so the rule is encoded once instead of three times. Item #1 migrates `src/app/videos/[id]/video-actions.tsx` onto `useVideoAction`, gives the detail page the same `waitFor` semantics the list page just got, and is the reason #4 lands in shared scope rather than file-local.

Doing #2 and #4 first means #1 picks up the cleaned-up API and the helper rather than churning them.

Terminology: this plan uses `inflight` for the per-action busy state on the detail page (matching the existing identifier at `video-actions.tsx:49`).

## Current State

- `useVideoAction` (`src/app/videos/use-video-action.ts:59-109`) reads `errorToast` for two distinct decisions:
  - On non-OK POST (`use-video-action.ts:98-104`) — uses the full `false | string | { fallback }` shape.
  - On `waitFor` timeout (`use-video-action.ts:113-115, 128-130`) — reads `errorToast` purely as a boolean to decide whether the generic `WAIT_FOR_TIMEOUT_MESSAGE` fires. The configured `string` / `{ fallback }` is never reused on timeout.
- The four call sites in `videos-client.tsx` (`onStartAll`, `onStartVideo`, `onPauseVideo`, `onResumeVideo` — lines 93-185) all happen to want matching POST-failure-and-timeout intent today, so the implicit contract holds. A future caller wanting "silent on POST-failure but loud on timeout" can't express it.
- Three of the four `waitFor` predicates in `videos-client.tsx` repeat the same shape "find row by id, satisfy if missing OR condition(row) is true". Of those three, two (`onPauseVideo`, `onResumeVideo`) carry an actual row-level condition and benefit most from a named helper; one (`onStartVideo`) has no row-level condition (its predicate is the missing-row check itself):
  - `onStartVideo` (lines 138-140) — predicate satisfies when the row is no longer in `topics`. Pure-vanish form, no condition body.
  - `onPauseVideo` (lines 152-156) — predicate satisfies when the queue row is missing OR `paused === 1`.
  - `onResumeVideo` (lines 169-184) — predicate satisfies when the queue row is missing OR (`paused === 0` AND `deferred_until` cleared/elapsed).
  - The fourth (`onStartAll` lines 108-110) has different "none of these IDs appear in topics" semantics — collection-level, not row-level — and stays as-is.
- `latestRowsRef` (`videos-client.tsx:70-74`) exposes `{ topics, queue }` for predicate reads.
- `src/app/videos/[id]/video-actions.tsx` (lines 58-78) runs the `post()` handler shape that `useVideoAction` was built to centralize: busy flag → fetch → parse `body.message` → set error → `router.refresh()` → `finally` clear busy. Errors land in a local `useState<string | null>(null)` rendered as `<p role="alert">` (lines 217-221).
- The detail page's polling loop is an inline `useEffect` in `src/app/videos/[id]/video-detail-client.tsx:105-144`. It owns `video`, `steps`, `artifacts`, `workflowLabel`, `queueState` and overwrites them every 5 s. There is no `pollNow()` exported and no ref the action handlers can read for predicate freshness.
- Detail page actions (Start, Retry, Restart, Pause, Resume) all have the same "spinner clears too early" UX gap on `/videos/[id]` that `videos-client.tsx` just fixed for the list page.
- `_shared.tsx` (`src/app/videos/_shared.tsx`) is the shared module already imported by both `videos-client.tsx` (line 16) and `video-detail-client.tsx` (line 18) — the natural home for a cross-page predicate helper.
- Existing tests: `__tests__/components/videos/use-video-action.test.tsx` (561 lines) covers all current decisions including timeout toast on/off, predicate-already-true fast path, predicate-becomes-true mid-wait, unmount mid-wait. `__tests__/components/videos/videos-client.test.tsx` (643 lines) covers the wired call sites including the `start-all` two-stage advance test. No existing test file for `video-actions.tsx`.

## Scope

**Doing**:
- Add `timeoutToast?: false | string` option to `useVideoAction` and update the four call sites in `videos-client.tsx` to pass nothing (default) — they all want today's behavior. (#2)
- Extract a `predicateForRow` helper into `_shared.tsx` and refactor the two list-page predicates that have a row-level condition (`onPauseVideo`, `onResumeVideo`) to use it. The pure-vanish predicates (`onStartVideo`, `onStartAll`) stay inline. (#4)
- Migrate `video-actions.tsx`'s `post()` handler to `useVideoAction`. Detail page actions adopt `waitFor` for Start, Retry, Restart, Pause, Resume. (#1)
- Refactor the inline polling loop in `video-detail-client.tsx` to expose `pollNow()` and a `latestVideoRef` so detail-page predicates have the same freshness guarantee the list page got. (Required by #1; minimum change to enable `waitFor`.)
- Flip detail-page error surfacing from inline `<p role="alert">` to toasts (matches the rest of the dashboard). (Decision #1 below.)
- Update tests for `useVideoAction` (timeoutToast option), `videos-client.test.tsx` (still passes through), and add focused tests for the migrated `video-actions.tsx`.

**Not doing**:
- Audit item #3 (extracting a `useWaitFor()` sibling hook). The audit explicitly flags it as "watch-out, no immediate action" — re-evaluate when a fourth concern lands.
- Extracting a full `useVideoDetailPoller` hook. The minimum change to enable `waitFor` on detail is exposing `pollNow` + `latestVideoRef` from the existing inline `useEffect`; do not lift the whole loop into a new hook.
- Changing the detail page's flow-summary / flow-accounts polling (`video-detail-client.tsx:146-176`) — it's orthogonal to action sync.
- Changing `WAIT_FOR_TIMEOUT_MS` / `WAIT_FOR_POLL_MS` per-call (Decision #6 of the original spinner-sync plan stands).
- API or schema changes.

## Design decisions (committed up front)

1. **Detail-page error surfacing → toasts.** The audit framed this as a UX choice ("a fourth `{ setError }` channel" vs "flip detail page to toasts"). Going with toasts: matches the rest of `/videos`, avoids expanding `useVideoAction`'s API to a fourth shape, and the inline `<p role="alert">` in `video-actions.tsx` (lines 217-221) is the only error pattern in the videos surface that doesn't already use sonner. Remove the local `error` state and the rendered paragraph entirely. Each handler's `errorToast` becomes a `string` or `{ fallback }` per its semantics (see Task 8 mapping).
2. **Predicate helper signature is getter-based, not collection+id-based.** The audit suggested `predicateForRow(rowsRef, id, condition)` for the list page. To serve the detail page (single-video ref) with the same helper, generalize to `predicateForRow(getRow: () => T | null | undefined, condition: (row: T) => boolean)`. Callers pass a closure that reads from whatever ref shape they have. This is the same complexity (one function), works on both pages, and makes the vanish-as-satisfied rule live in exactly one place.
3. **Detail page uses `pollNow` + `latestVideoRef`, not a new hook.** The minimum change is two additions inside `video-detail-client.tsx`: a `useCallback` `pollNow` that runs the poll body, and a `latestVideoRef` that mirrors the freshly-polled `video`. The existing `useEffect` interval calls `pollNow()` instead of the inline body. The ref-write happens at render time (`latestVideoRef.current = video`) for the same reason the list page does it that way (predicate ticks fire on the timer queue, not synchronized with React's commit phase — see `videos-client.tsx:62-74` comment).
4. **Detail page predicates are per-action, not centralized.** The five detail-page actions have distinct end-states; encoding them as five named local predicates inside `video-actions.tsx` is clearer than a generic state-machine. Each uses the `predicateForRow` helper via `() => latestVideoRef.current` (single-video form).
5. **`onSuccess` for `Restart` stays `"router-refresh"`.** Even though the restart action wipes step state, the existing `router.refresh()` already surfaces it in tandem with the next poll. Don't reach for a custom `onSuccess` callback unless a real need appears.
6. **`inflight` stays the single source of truth for "any action running."** Today the page has a single `inflight: "start" | "retry" | "restart" | "pause" | "resume" | null` state (`video-actions.tsx:49-51`) and `busy = inflight !== null` (line 56) gates every action button AND the delete button (line 213) AND the `confirmRestart` `busy` prop (line 238). After migration, all five `BusyHandle` adapters share `inflight` as the underlying state — `{ isBusy: inflight !== null, setBusy: b => setInflight(b ? actionLabel : null) }` — mirroring `rowBusy` in `videos-client.tsx:118-123`. The derived `busy` boolean stays as-is so the delete button and confirm-restart dialog continue to gate without changes.
7. **Migration order matters.** Land #2 first (smallest, cleanest API change). Then #4 (extract helper, refactor the two list-page predicates that fit). Then #1 (consumes both). Each phase ships independently green and reviewable. Inside Phase 3, Tasks 5 and 6 must land in the same commit — Task 6 imports `pollNow` / `latestVideoRef` from `video-detail-client.tsx` (Task 5's additions); splitting them breaks the prop wiring at the boundary.

## Tasks

### Phase 1: Split `errorToast` / `timeoutToast` (audit #2)

- [x] **Task 1: Add `timeoutToast` option to `useVideoAction`**
  **Files**: `src/app/videos/use-video-action.ts`, `__tests__/components/videos/use-video-action.test.tsx`
  **What**: Add `timeoutToast?: false | string` to `ActionOptions` (after `errorToast`). Default behavior matches today: when omitted, the timeout branch fires the generic `WAIT_FOR_TIMEOUT_MESSAGE`. When `false`, stay silent on timeout. When a `string`, use that string instead of the generic message. The POST-failure branch (`use-video-action.ts:98-104`) is unaffected — it continues to read only `errorToast`. The timeout branch (`use-video-action.ts:111-136`) stops reading `errorToast` entirely; it reads `timeoutToast` exclusively.
  **Context**: The current implicit contract is documented in audit finding #2: `errorToast` does double duty as "POST-failure message control" AND "timeout visibility gate." Splitting makes both knobs explicit. The two parameters are independent — a future caller can pick any 2×3 combination. `waitForPredicate` (`use-video-action.ts:111`) currently takes `errorToast` as its second arg purely for the boolean check; change its signature to take the resolved timeout-toast policy instead. Update the JSDoc above `useVideoAction` (`use-video-action.ts:34-58`) to document `timeoutToast` alongside `errorToast`. Tests should cover: `timeoutToast` omitted → generic message fires (existing test pattern at line 389); `timeoutToast: false` → stays silent (existing pattern at line 424); `timeoutToast: "Custom message"` → that string fires; matrix: `errorToast: "fail"` + `timeoutToast: false` (loud on POST-failure, silent on timeout) — assert no toast on timeout, the configured fail toast on non-OK; inverse `errorToast: false` + `timeoutToast: "timed out"` — silent on POST-failure, loud on timeout.

- [x] **Task 2: Update list-page call sites to the split API**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**: All four laggy handlers (`onStartAll` line 99, `onStartVideo` line 126, `onPauseVideo` line 145, `onResumeVideo` line 162) keep their existing `errorToast` values. None pass `timeoutToast` — the omit-default reproduces today's behavior. No behavior change; this task verifies the API split doesn't drift the call sites.
  **Context**: Before/after comparison of the four call sites against today's behavior:
    - **Silent handlers** (`onStartAll`, `onStartVideo`): today `errorToast: false` controls both branches; after split, `errorToast: false` controls POST-failure only and the timeout branch defaults to silent because the handlers explicitly pass `timeoutToast: false` — preserving today's "the route returns no actionable info; next poll surfaces state" policy.
    - **Non-silent handlers** (`onPauseVideo`, `onResumeVideo`): today `errorToast: { fallback }` triggers the generic timeout message via the boolean read; after split, `errorToast: { fallback }` controls POST-failure only and the timeout branch defaults to the generic message because `timeoutToast` is omitted.
  Tests that exercise the timeout branch live in `__tests__/components/videos/videos-client.test.tsx` (search for `pollNow`, `waitFor`, `8000`, `WAIT_FOR_TIMEOUT`); they should continue to pass without modification because both the silent and non-silent timeout outcomes are unchanged. If any test fails, that is a sign Task 1 leaked observable behavior and must be revisited before this task lands.

  Open question for the implementer: today's silent handlers actually rely on `errorToast: false` to silence the timeout. After the split, omitting `timeoutToast` defaults to the generic message — which would *change* the silent handlers' timeout behavior unless they explicitly pass `timeoutToast: false`. The two silent call sites (`onStartAll`, `onStartVideo`) MUST add `timeoutToast: false` in this task to preserve today's silence. Verify against the existing `videos-client.test.tsx` cases that assert no toast on `onStartAll`/`onStartVideo` timeout.

### Phase 2: Extract `predicateForRow` helper (audit #4)

- [x] **Task 3: Add `predicateForRow` to `_shared.tsx`**
  **Files**: `src/app/videos/_shared.tsx`
  **What**: Add an exported generic helper `predicateForRow<T>(getRow: () => T | null | undefined, condition: (row: T) => boolean): () => boolean` that returns a predicate satisfying when the row is missing (null/undefined) OR `condition(row)` is true. The "vanish-as-satisfied" rule lives here as a one-line type-level statement instead of three repeated inline `row === undefined ||` clauses across `videos-client.tsx`. Pure function, no React imports needed; can sit alongside the existing label/badge utilities in `_shared.tsx`.
  **Context**: Decision #2 above commits the getter-based signature so the same helper serves both list-page collections (caller closures over `latestRowsRef.current.topics.find(...)`) and detail-page single videos (caller closures over `latestVideoRef.current`). Add a brief docstring referencing the audit finding #4 rationale. No behavior change yet — Task 4 is the first consumer.

- [x] **Task 4: Migrate two list-page predicates onto `predicateForRow`**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**: Replace the predicate bodies in `onPauseVideo` (lines 152-156) and `onResumeVideo` (lines 169-184) with `predicateForRow` calls:
    - `onPauseVideo` — getter looks up the row in `queue` by id; condition is `(row) => row.paused === 1`.
    - `onResumeVideo` — getter looks up the row in `queue` by id; condition is `(row) => row.paused === 0 && (row.deferred_until === null || row.deferred_until <= Math.floor(Date.now() / 1000))`. Keep the `deferred_until` unit-conversion comment (`videos-client.tsx:174-181`) — it remains the only place that fragile pattern lives.
    - `onStartVideo` (lines 138-140) is intentionally NOT migrated. Its predicate is the pure vanish-as-satisfied form (`!topics.some(t => t.id === id)`) with no row-level condition; routing it through `predicateForRow` with a `() => false` condition would obscure that it's the same shape as `onStartAll` (collection-level vanish on a snapshot of IDs). Leave both `onStartVideo` and `onStartAll` (lines 108-110) inline.
  **Context**: The vanish-as-satisfied rule is now centralized in the helper (Task 3) for the two predicates that actually have a row-level condition to encode. The pure-vanish predicates (`onStartVideo`, `onStartAll`) stay inline because their condition is the missing-row check itself, not a guard around a deeper condition. Existing `videos-client.test.tsx` tests should pass unchanged — these are pure refactors of predicate construction. The unit-conversion comment for `deferred_until` should survive on the condition closure (or move just above the `predicateForRow` call) so its non-obvious correctness stays visible at the call site.

### Phase 3: Migrate `video-actions.tsx` to `useVideoAction` (audit #1)

- [x] **Task 5: Expose `pollNow` and `latestVideoRef` from `video-detail-client.tsx`**
  **Files**: `src/app/videos/[id]/video-detail-client.tsx`
  **What**: Refactor the inline `useEffect` poll loop (lines 105-144) so that:
    - The poll body is a `useCallback`-wrapped `pollNow(): Promise<void>` that does the same fetch + state-set work as today (including the 404 → `router.push("/videos")` redirect at line 113-115).
    - A single-flight `inFlightRef` deduplicates concurrent `pollNow` calls (mirror `use-video-poller.ts:72-75, 117-118` pattern).
    - The `setInterval` (currently line 139) calls the same `pollNow` — no behavior change for the timer-driven poll.
    - A `latestVideoRef = useRef(initialVideo)` is updated at render time (`latestVideoRef.current = video`) — same write-during-render rationale as `videos-client.tsx:62-74`. This ref is what detail-page predicates will read. `initialVideo` is the correct seed because a click landing in the same render as mount reads exactly the props the server returned; do NOT add a `useEffect` ref-write — that would lose freshness on the first predicate tick after each commit, the same pitfall called out for `latestRowsRef` (`videos-client.tsx:62-74`).
    - `pollNow` and `latestVideoRef` are passed down as props to `<VideoActions>` (or, if cleaner, an explicit `pollNow` prop and the ref read from a context — but a prop is the simplest path, since `VideoActions` is the only consumer).
  **Context**: Decision #3 commits this as additions inside the existing component, not extraction to a new hook. Existing behavior of the timer loop, the 404 redirect, and the swallowed-error policy all survive untouched — this task is purely "make `pollNow` / latest-video-ref reachable from the action surface." Note on Restart races: `pollNow()` is called by `useVideoAction`'s `waitFor` after the POST resolves; it overwrites `video`, `steps`, `artifacts` from the server payload. The fire-and-forget `router.refresh()` (Decision #5) then refreshes any wrapping RSC bits independently. The two cannot fight because pollNow's payload is server-truth — refresh's role is only to re-render the RSC shell, not the poll-driven state. No tests for `video-detail-client.tsx` exist today; if Task 9 adds tests for `video-actions.tsx` they will exercise the prop wiring transitively.

- [x] **Task 6: Migrate `video-actions.tsx` `post()` to `useVideoAction`**
  **Files**: `src/app/videos/[id]/video-actions.tsx`
  **What**: Replace the local `post()` handler (lines 58-78) with `useVideoAction`. Each of the five action paths (`start`, `retry`, `restart`, `pause`, `resume`) becomes a call to `runAction` with:
    - `url: \`/api/videos/${video.id}/${path}\``
    - `onSuccess: "router-refresh"` (matches today's `router.refresh()` at line 74 — Decision #5)
    - `errorToast`: per-action mapping (Task 8 commits the strings)
    - `busy`: a `BusyHandle` adapter `{ isBusy: inflight !== null, setBusy: b => setInflight(b ? path : null) }` per action (Decision #6 — `inflight` remains the single source of truth so the delete button's `disabled={busy}` gate at line 213 and `confirmRestart`'s `busy` prop at line 238 keep working untouched)
    - `waitFor`: `{ pollNow, predicate }` per action (Task 7 commits the predicates)
  Remove unused imports after this change. Accept new props `pollNow: () => Promise<void>` and `latestVideoRef: RefObject<Video>` (or equivalent — match Task 5's chosen wiring shape). The local `error` useState and `<p role="alert">` removal is committed by Decision #1 — do not duplicate the call here; just reference Decision #1.
  **Context**: This is the core DRY win — `video-actions.tsx`'s 20-line `post()` shape collapses to the centralized hook's behavior, and the same error-policy / waitFor / unmount-cleanup guarantees the list page got this morning extend automatically to the detail page. The `confirmRestart` flow (lines 232-245) and `confirmDelete` flow (lines 224-230) are unchanged — they still wrap the action call, just with `runAction` underneath. The `Copy Path` button (lines 154-169) does not go through `useVideoAction` (no fetch, no busy contention with actions); leave it as-is. This task and Task 5 must land in the same commit (Decision #7) — Task 6 imports props that Task 5 introduces.

- [x] **Task 7: Add `waitFor` predicates for the five detail-page actions**
  **Files**: `src/app/videos/[id]/video-actions.tsx`
  **What**: For each of the five actions, pass a `waitFor: { pollNow, predicate }` built via `predicateForRow(() => latestVideoRef.current, condition)`. Mapping:
    - **Start** (status `new` → moves off `new`): condition `(v) => v.status !== "new"`. Vanish-as-satisfied covers the case where the video is deleted mid-wait.
    - **Retry** (status `failed` → typically moves to `queued`): condition `(v) => v.status !== "failed"`. The 404-redirect path in `pollNow` (Task 5) handles deletion separately; vanish here means the same "spinner shouldn't hang on a missing row."
    - **Restart** (status `failed` → `queued`, with state wipe): condition `(v) => v.status !== "failed"` (intentionally identical to Retry — both routes' end-state from `failed` is the same observable, so the predicate is the same. Don't tighten Restart to also check the step-list reset; the wipe is reflected in the `pollNow` payload's `steps` field, not in the predicate's contract).
    - **Pause** (status `in_progress`, paused 0 → 1): condition `(v) => v.paused === 1`.
    - **Resume** (paused 1 → 0, with deferred check): condition matches list-page `onResumeVideo` (Task 4) — `(v) => v.paused === 0 && (v.deferred_until === null || v.deferred_until <= Math.floor(Date.now() / 1000))`. Same `deferred_until` unit-conversion caveat applies; surface the same comment at the call site.
  **Context**: All five predicates use the helper from Task 3, so the vanish-as-satisfied semantics ride on the same code path as the list page. The 404-redirect inside `pollNow` (Task 5) is the user-visible "video deleted" UX; the predicate's vanish branch is the safety net so a `setBusy(false)` fires even if the redirect raced with a concurrent action.

- [x] **Task 8: Pick `errorToast` strings for the five actions**
  **Files**: `src/app/videos/[id]/video-actions.tsx`
  **What**: Commit the per-action `errorToast` mapping. The detail page's POST-failure UX flips from inline `<p role="alert">` to sonner toasts (Decision #1):
    - **Start**: `errorToast: { fallback: \`Failed to start "${video.title}"\` }`.
    - **Retry**: `errorToast: { fallback: \`Failed to retry "${video.title}"\` }`.
    - **Restart**: `errorToast: { fallback: \`Failed to restart "${video.title}"\` }`.
    - **Pause**: `errorToast: { fallback: \`Failed to pause "${video.title}"\` }`.
    - **Resume**: `errorToast: { fallback: \`Failed to resume "${video.title}"\` }`.
  All five are non-silent and **diverge from list-page Start handlers** (`onStartAll`, `onStartVideo`, both `errorToast: false`). The divergence is intentional: the detail-page action surface is the operator-confirmation channel — the user is on the detail page specifically because they want feedback on this video, and an inline-error-turned-toast preserves that confirmation contract. The list page's silent policy is appropriate there because the list-page Start actions are "fire-and-forget; the next poll will surface state in the row." Don't pass `timeoutToast` — the default generic message is fine. Pause/Resume strings happen to match the list-page handlers; Start/Retry/Restart are detail-page-only.
  **Context**: `body.message` from the API takes precedence via `{ fallback }`'s semantics in `useVideoAction` (`use-video-action.ts:103-104`), which preserves today's "show the route's reason if present" behavior (the detail page's existing `body.message ?? \`Action failed (${res.status})\`` at line 71 maps cleanly to `{ fallback }`). Decision #1 (toast vs inline) commits the channel; this task picks the strings.

- [x] **Task 9: Add focused tests for the migrated `video-actions.tsx`**
  **Files**: `__tests__/components/videos/video-actions.test.tsx` (new)
  **What**: New test file mirroring the patterns in `__tests__/components/videos/use-video-action.test.tsx` (mocked `next/navigation`, mocked `sonner`, fake timers, fetch stub). Cover at minimum:
    - Each of the five action buttons triggers the correct URL and `router.refresh()` on success.
    - `waitFor` predicate for Start: spinner persists until `latestVideoRef.current.status` flips off `new`, then clears.
    - `waitFor` predicate for Pause: spinner persists until `latestVideoRef.current.paused === 1`, then clears.
    - `waitFor` predicate for Resume: spinner persists until `paused === 0` AND `deferred_until` is null/elapsed.
    - On non-OK POST: configured `{ fallback }` message fires via `toast.error`, no inline `<p role="alert">` appears.
    - `inflight` lock: clicking Pause while Start is in flight is blocked (button `disabled` via the derived `busy` flag).
    - Status-gated visibility: Start only renders when `video.status === "new"`; Retry/Restart only when `failed`; Pause only when `canPauseVideo`; Resume only when `canResumeVideo`. (Existing logic at lines 107-204 — the migration shouldn't change visibility.)
  **Context**: The `<p role="alert">` element no longer exists post-migration; tests should affirmatively assert `screen.queryByRole("alert")` returns null in error cases. Use a parameterized harness similar to `Harness` in `use-video-action.test.tsx:43-94` to drive `latestVideoRef` updates from the test, simulating the poll loop. The existing `useVideoAction` tests already cover the underlying timeout/cleanup mechanics — no need to re-test them here.

### Phase 4: Manual verification

This phase is a real merge gate, not a soft suggestion — type-checking and the test suite verify code correctness, not feature correctness, and the detail-page actions cannot be exercised without a running worker. Do not mark Phase 3 complete until Task 10 has been performed.

- [ ] **Task 10: Smoke-test the detail page actions in `npm run dev`**
  **Files**: none (manual)
  **What**: With the worker running, exercise each detail-page button on `/videos/[id]` for representative video states:
    - **Start** (a video in `new`): spinner persists until status badge flips off `new`. Page rerenders with `queued`/`in_progress` actions.
    - **Retry** (a `failed` video): spinner persists until status badge flips off `failed`. The failed-step pre block disappears or updates.
    - **Restart** (a `failed` video, after confirm dialog): spinner persists until status flips off `failed`; step list resets.
    - **Pause** (an `in_progress` video): spinner persists until the `paused` badge appears.
    - **Resume** (a paused video, possibly deferred): spinner persists until the `paused` badge clears AND (if deferred) until `deferred_until` has passed.
  Failure-mode checks:
    - **Stop the worker**, click any action: spinner clears at ~8 s, generic timeout toast appears (all five actions are non-silent).
    - **Wrong-state action** (e.g., the `restart` route refusing because the video left `failed`): the route's `body.message` surfaces as a toast.
    - **Throttled network**, click Retry: spinner persists through slow `/api/videos/[id]` polls and clears once the badge flips.
    - **Delete the video mid-action** (a separate operator deletes it via the list page while the spinner is up): the 404-redirect in `pollNow` (Task 5) fires and bounces to `/videos`. Vanish-as-satisfied predicate ensures no orphan spinner state survives the redirect.
  Cross-page sanity:
    - List page actions still behave identically (no regressions from the API split or predicate-helper extraction).
    - Confirm the queue toggle on the list page is still optimistic (no `waitFor` — the audit's "intentional outlier").

## References

- `docs/refactoring/solid-audit-2026-04-30-spinner-sync.md` — the audit driving this plan (findings #1, #2, #4).
- `docs/plans/2026-04-30-spinner-action-sync.md` — original spinner-sync plan; design decisions #6 (timeout policy), #7 (timeout toasting), #8 (cleanup mechanism) carry over.
- `src/app/videos/use-video-action.ts:34-58` — JSDoc to extend in Task 1.
- `src/app/videos/use-video-action.ts:111-136` — `waitForPredicate` to update for `timeoutToast`.
- `src/app/videos/videos-client.tsx:62-74` — `latestRowsRef` write-during-render pattern, replicated in Task 5 for `latestVideoRef`.
- `src/app/videos/videos-client.tsx:118-123` — `rowBusy` adapter, mirrored in Task 6 for the detail-page single-action lock.
- `src/app/videos/_shared.tsx` — destination for `predicateForRow` (Task 3).
- `src/app/videos/[id]/video-actions.tsx:58-78` — `post()` to replace.
- `src/app/videos/[id]/video-detail-client.tsx:105-144` — inline poll loop to refactor in Task 5.
- `__tests__/components/videos/use-video-action.test.tsx:43-94` — `Harness` pattern for the new `video-actions.test.tsx`.
