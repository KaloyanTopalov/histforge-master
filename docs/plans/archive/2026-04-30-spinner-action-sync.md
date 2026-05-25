# Spinner sync on /videos action buttons

## Overview

Action button spinners on `/videos` clear as soon as the POST request returns, but the visible state (row status, badge, position in topics/queue split) doesn't change until the next `useVideoPoller` tick — up to 5 seconds later. Result: spinner stops, button looks done, row hasn't moved, click feels ignored.

This plan keeps the spinner spinning until the polled state actually reflects the action, and triggers an immediate poll after success so the wait is short. The queue pause/resume toggle is already optimistic and works fine — explicitly left alone.

## Current State

- All five action buttons funnel through `useVideoAction` (`src/app/videos/use-video-action.ts:40-72`). It flips `busy` true, fetches, then unconditionally clears `busy` in `finally` — spinner duration tracks fetch time only.
- `router.refresh()` (`use-video-action.ts:54`) is fire-and-forget and not awaited. The `/videos` table data comes from `useVideoPoller`, not RSC, so for these four handlers the refresh adds nothing meaningful for the table itself. It may still matter for other server-rendered bits of the page (header counts, etc.), so the plan keeps it.
- `useVideoPoller` (`src/app/videos/use-video-poller.ts:53-126`) owns the data the table renders. It runs a `setInterval` at 5 s (`POLL_MS = 5000`, line 7) and exposes setters for optimistic overrides. There is no way to trigger a poll on demand from outside the hook today.
- Call sites that wait for polled state (and feel laggy today): `onStartAll`, `onStartVideo`, `onPauseVideo`, `onResumeVideo` (`src/app/videos/videos-client.tsx:79-124`).
- Call site that already feels instant: `onToggleQueue` (`videos-client.tsx:126-137`) — uses an optimistic `setQueueState` callback. **Stays as-is on purpose.** The asymmetry is intentional: optimistic update is a strictly better UX when it's available, and the queue state is the only one whose post-action value is fully knowable client-side. Do not migrate this handler to `waitFor`.
- Predicate inputs already on `VideoListItem` (`src/types.ts:11,15-43`): `status`, `paused`, `deferred_until`. No schema work.
- Row action buttons live in `src/app/videos/topics-table.tsx` and `src/app/videos/video-queue-table.tsx`. They already gate on `rowInflight` (passed from `videos-client.tsx`); no edits expected, but they must continue to honor the lock during the longer wait window.
- `running_step_started_at` is *not* a usable predicate input here — it's a worker-side artifact, not all transitions touch it, and it lags behind user-visible status changes. Predicates use `status`, `paused`, and (for resume) `deferred_until`.
- Existing test patterns: `__tests__/components/videos/use-video-action.test.tsx` and `__tests__/components/videos/use-video-poller.test.tsx` — fake timers, mocked `fetch`/`sonner`/`next/navigation`, harness components driving the hook. New tests follow that shape.

## Scope

**Doing**:
- Expose `pollNow()` from `useVideoPoller` with single-flight de-duplication.
- Extend `useVideoAction` with an optional `waitFor` predicate that gates `setBusy(false)` until the predicate matches or a fixed 8000 ms timeout elapses.
- Wire `pollNow` + per-handler `waitFor` predicates into the four laggy call sites in `videos-client.tsx`.
- Emit a non-silent timeout toast for handlers that are already non-silent today; stay silent for handlers that already opt out via `errorToast: false`.
- Update tests for both hooks.

**Not doing**:
- Queue pause/resume toggle (already optimistic; documented above).
- Full per-row optimistic UI (would require modeling each transition; orthogonal to this fix).
- Per-row concurrency (`rowInflight` remains a single-row global lock; click queueing across different rows is out of scope).
- Reuse outside `/videos` (video-detail and other pages are out of scope here).
- API or schema changes.

## Design decisions (committed up front)

These were judgement calls in the first draft of the plan; locking them in here so the implementer doesn't re-litigate mid-task.

1. **Predicate re-evaluation mechanism.** A predicate captured at click time would close over stale `topics`/`queue` and never re-evaluate. To avoid that:
   - The call site passes `waitFor` as `{ pollNow, predicate }` where `predicate` is a closure that **reads from a ref** the call site keeps in sync with the latest poller state.
   - `videos-client.tsx` keeps a single `latestRowsRef` updated via `useEffect` on every render of the polled state. Predicates read `latestRowsRef.current` so each evaluation sees fresh data.
   - Inside `useVideoAction`, after a successful POST: call `pollNow()`, then re-check `predicate()` on a small internal `setInterval` at 250 ms. (Subscribing to a "poll completed" signal was considered and rejected — the interval is simpler, has no cross-hook coupling, and at 250 ms × 8 s = 32 checks max the cost is negligible. Each check is a pure function call against a ref.)

2. **`pollNow()` and the regular interval.** `useVideoPoller` keeps a single `inFlightRef: useRef<Promise<void> | null>`; both the interval handler and `pollNow()` read/write it. If a poll is in flight, `pollNow()` returns the same promise instead of starting a new fetch. After the fetch resolves the ref is set back to null. This makes back-to-back `pollNow()` calls and interval-overlap safe.

3. **`pollNow()` failures.** A failed fetch is swallowed (matches today's behavior at `use-video-poller.ts:105-107`). The action hook does not retry pollNow internally — the regular 5 s interval will retry on its own schedule. If pollNow fails right after the POST, the predicate keeps re-checking against whatever state was last polled, and either the next interval tick satisfies it or the 8 s timeout fires. Acceptable.

4. **`start-all` predicate uses an ID snapshot, not "topics is empty."** The handler captures the IDs of all rows currently in `topics` at click time; the predicate satisfies when **none of those IDs** still have `status === "new"`. This avoids two failure modes: (a) user deletes the last topic mid-action and the predicate falsely satisfies, (b) user adds a new topic mid-action and the predicate falsely re-fails. New topics added during the action are explicitly out of scope of "started by this click."

5. **`onResumeVideo` predicate includes `deferred_until`.** A row can be `paused === 0 && deferred_until > Date.now()` (unpaused but still deferred). Predicate satisfies when `paused === 0 AND (deferred_until === null OR deferred_until <= Date.now())`. This matches the user's mental model: spinner clears when the row is *actually* eligible to resume work.

6. **Timeout policy.** Fixed `WAIT_FOR_TIMEOUT_MS = 8000` (slightly over the 5 s `POLL_MS`, so at least one full poll cycle elapses before timing out). Hard-code as a module constant in `use-video-action.ts`, not a per-call option. Re-evaluate only if a real call site needs different.

7. **Timeout toasting.** When a 2xx POST is followed by a `waitFor` timeout:
   - For handlers with `errorToast: false` (e.g. `onStartAll`, `onStartVideo`): stay silent. The next poll will surface state. Matches today's "the route returns no actionable info" policy.
   - For handlers with a configured `errorToast` (e.g. `onPauseVideo`, `onResumeVideo`): emit a generic "Action submitted but state hasn't updated yet — try again if needed." This avoids the silent-failure feeling while honoring each handler's existing verbosity choice.

8. **Cleanup.** `useVideoAction` returns a function rather than owning component lifecycle, so it has no `useEffect` cleanup hook to attach to today. Two layers of cleanup:
   - **Per-action interval cleanup**: the predicate-check `setInterval` is cleared on (a) predicate match, (b) timeout. A local `let cancelled = false` closure flag plus `clearInterval(intervalId)` at each exit branch handles both — no `useRef` needed.
   - **Unmount safety**: add a `useEffect` inside `useVideoAction` that owns a `Set<number>` of currently-active interval IDs. The action function adds its interval ID on start and removes it on either exit branch. The effect's cleanup clears any remaining IDs in the set on unmount. Call the latest `setBusy` defensively — if a `setBusy` call lands after unmount React will warn but not crash; the unmount-clear prevents the warning entirely.

9. **Concurrency.** `rowInflight` stays a single-row global lock. Users can't start an action on row B while waiting on row A. Acceptable — multi-row concurrency is out of scope. Document this in the call-site comments so a future reader doesn't widen it without thinking.

10. **`router.refresh()`.** Keep it for the four laggy handlers — even though the table data comes from the poller, other server-rendered bits on the page may rely on it. Removing it is a separate audit.

## Tasks

### Phase 1: Hook changes

- [x] **Task 1: Expose `pollNow()` from `useVideoPoller`**
  **Files**: `src/app/videos/use-video-poller.ts`, `__tests__/components/videos/use-video-poller.test.tsx`
  **What**: Hook returns a stable `pollNow: () => Promise<void>` on `UseVideoPollerResult` (lines 32-40). Calling it triggers an immediate poll cycle. A single `inFlightRef` is shared between the interval handler and `pollNow()` — if a fetch is already in flight, `pollNow()` returns that same promise; otherwise it kicks one off. State updates from a `pollNow()`-triggered fetch are identical to interval-triggered ones (same diff/toast logic at lines 85-97). Errors are swallowed.
  **Context**: The current poll body is inline inside `useEffect` (lines 71-115) and references `cancelled` from the closure. Extract it so both the interval and `pollNow` invoke the same implementation. Stability of the returned function matters because call sites will pass it through `useVideoAction`. Tests should cover: pollNow triggers a fetch outside the interval cadence; two `pollNow()` calls back-to-back produce one in-flight fetch (assert `fetch` mock call count); pollNow updates the rendered state with the fresh payload like the interval does; pollNow rejection / network error doesn't crash the hook and the interval still ticks afterward; on unmount the interval is cleared and a late-resolving in-flight pollNow does not write state to the unmounted component (existing `cancelled` flag at line 77 already guards interval polls — the same guard must protect pollNow-triggered fetches).

- [x] **Task 2: Add `waitFor` + 8 s timeout + cleanup to `useVideoAction`**
  **Files**: `src/app/videos/use-video-action.ts`, `__tests__/components/videos/use-video-action.test.tsx`
  **What**: Extend `ActionOptions` with `waitFor?: { pollNow: () => Promise<void>; predicate: () => boolean }`. When provided and the POST returns 2xx:
  1. Call `pollNow()` (await it; ignore rejection).
  2. If `predicate()` is already true, clear `busy` and return.
  3. Otherwise start a `setInterval` at 250 ms; each tick re-evaluates `predicate()`. On match, clear interval, clear `busy`, return.
  4. Track elapsed time; at 8000 ms, clear interval, clear `busy`, and (if `errorToast` is non-silent) emit a generic "Action submitted but state hasn't updated yet — try again if needed." toast. If `errorToast === false`, stay silent.
  5. On component unmount mid-wait, the interval must be cleared. See Decision #8 for the exact mechanism (per-action local closure cleanup + a hook-level `Set<number>` of active interval IDs cleared in a `useEffect` cleanup).
  When `waitFor` is omitted, behavior is unchanged (today's `finally` clears busy on fetch completion).
  **Context**: The existing `finally` (lines 69-71) is the wrong cleanup point when `waitFor` is set — it must NOT fire on POST completion in that branch. Restructure so the success path with `waitFor` returns without hitting the finally's setBusy(false). On non-OK responses, `waitFor` is ignored: clear busy synchronously like today, run the existing toast logic. Hard-code `WAIT_FOR_TIMEOUT_MS = 8000` and `WAIT_FOR_POLL_MS = 250` as module constants. Update the JSDoc above the `useVideoAction` export to document the new option (the existing docstring already describes `onSuccess` / `errorToast` / `busy` choices; add `waitFor` alongside). Tests should cover: predicate already true on first check → busy clears immediately after `pollNow()`; predicate becomes true on third interval tick → busy clears then; predicate never matches → busy clears at 8 s and timeout-toast fires for non-silent handlers but stays silent for `errorToast: false`; non-OK response with `waitFor` provided → busy clears synchronously, no waiting, no pollNow call; unmount mid-wait → interval is cleared (assert with `vi.useFakeTimers` + advancing past 8 s and checking no further state updates).

### Phase 2: Wire call sites

- [x] **Task 3: Pull `pollNow` and a "latest rows" ref through `videos-client.tsx`**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**: Destructure `pollNow` from the `useVideoPoller` result (lines 48-60). Maintain a ref (e.g. `latestRowsRef`) updated via `useEffect` on every render with `{ topics, queue }` so predicates can read fresh data after this render commits. No behavior change yet — this is plumbing.
  **Context**: Predicates created inside the four handler functions will close over `latestRowsRef.current`, not `topics` / `queue` directly, so each interval re-check sees the latest poller state. Land this before Task 4 to keep diffs reviewable. Add a brief inline comment explaining why the ref exists (predicate freshness across the wait window).

- [x] **Task 4: Add `waitFor` predicates to the four laggy handlers**
  **Files**: `src/app/videos/videos-client.tsx`
  **What**: Pass a `waitFor` to each of the four laggy handlers. Predicates read from `latestRowsRef.current`:
  - `onStartVideo(id)` (lines 98-106): the row with this `id` is no longer in topics — i.e. it doesn't appear in `latestRowsRef.current.topics`. Equivalent to "status moved off `new`." Vanish-as-satisfied applies (deleted row also satisfies).
  - `onStartAll` (lines 79-89): **snapshot the topic IDs at click time** (`const targetIds = topics.map(t => t.id)`). Predicate satisfies when none of `targetIds` appear in `latestRowsRef.current.topics`. New topics added during the wait don't affect the predicate. Vanish-as-satisfied applies per ID.
  - `onPauseVideo(v)` (lines 108-115): row with `v.id` in `latestRowsRef.current.queue` has `paused === 1`. Vanish-as-satisfied applies.
  - `onResumeVideo(v)` (lines 117-124): row with `v.id` has `paused === 0` AND (`deferred_until === null` OR `deferred_until <= Date.now()`). Vanish-as-satisfied applies.
  All four predicates apply the same **vanish-as-satisfied** rule: if the row is no longer in the polled state for any reason (deleted, filtered out, missing from payload), the predicate satisfies. This is intentional — we never want a spinner to hang on a row that no longer exists, even if the user's original intent (start / pause / resume) was not what produced the disappearance.
  Leave `onToggleQueue` (lines 126-137) untouched — it stays optimistic. Add a one-line code comment on the queue toggle stating *why* it doesn't use `waitFor` (optimistic update via `setQueueState` is a strictly better UX and is the only handler whose post-action state is fully client-knowable), so a future reader doesn't "fix" the inconsistency.
  **Context**: `running_step_started_at` is deliberately not used (worker artifact, lags status). The `paused` and `status` fields drive what the table actually renders, so gating spinners on them aligns spinner duration with visible UI change.

### Phase 3: Manual verification

- [x] **Task 5: Smoke-test all five buttons in `npm run dev`**
  **Files**: none (manual)
  **What**: With the worker running, exercise each button on `/videos` and confirm:
  - **Add all to queue**: spinner persists until every originally-listed topic has left the topics section. Adding a new topic mid-wait does NOT make the spinner re-spin.
  - **Start row (topics)**: spinner persists until the row leaves topics and lands in the queue section.
  - **Pause row**: spinner persists until the paused indicator appears in the queue row.
  - **Resume row**: spinner persists until the paused indicator clears AND (if the row was deferred) until `deferred_until` has passed or cleared.
  - **Pause/Start queue (control)**: unchanged — instant flip via optimistic `setQueueState`.
  Failure-mode checks:
  - **Stop the worker** (so DB state never changes), click Start row → spinner clears at ~8 s, no toast (since `onStartVideo` uses `errorToast: false`).
  - **Stop the worker**, click Pause row → spinner clears at ~8 s and a generic timeout toast appears (since `onPauseVideo` has a configured `errorToast`).
  - **Throttle network in devtools to "Slow 3G"**, click Start row → spinner persists through the slow `/api/videos` poll and clears once the row visibly moves; no premature timeout.
  - **Click Start on row A, then immediately Pause on row B mid-wait** → row B click is blocked by `rowInflight` (existing behavior). Acceptable.
  **Context**: Type checks and unit tests verify code correctness, not feature correctness. UI-layer behavior change must be eyeballed.

## References

- `src/app/videos/use-video-action.ts:40-72` — current action runner (busy clearing in `finally`)
- `src/app/videos/use-video-poller.ts:53-126` — current poller, 5 s interval, error swallow at 105-107
- `src/app/videos/videos-client.tsx:79-137` — five action handlers; `onToggleQueue` is the optimistic outlier
- `src/app/videos/topics-table.tsx`, `src/app/videos/video-queue-table.tsx` — consume `rowInflight`; not edited but must keep working
- `src/types.ts:11,15-43` — `VideoStatus`, `Video`, `VideoListItem` (`status`, `paused`, `deferred_until` are the predicate inputs)
- `__tests__/components/videos/use-video-action.test.tsx` — test harness pattern for the action hook
- `__tests__/components/videos/use-video-poller.test.tsx` — test harness pattern for the poller hook
