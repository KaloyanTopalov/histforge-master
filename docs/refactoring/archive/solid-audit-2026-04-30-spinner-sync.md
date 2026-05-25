# SOLID Audit — 2026-04-30 (spinner-action-sync)

**Mode**: Post-feature (from `e1876cf`)
**Scope**: Spinner-action-sync feature on `/videos`. Six commits, five files changed (3 production: `use-video-action.ts`, `videos-client.tsx`; 2 test). Net ~165 production-code lines added across two files. Builds on this morning's `videos-client.tsx` SOLID refactor (the centralized `useVideoAction` and the `useVideoPoller` extraction it depends on).
**Domains analyzed**: domain-dashboard

## Summary

The feature adds a `waitFor` option to `useVideoAction` so action spinners persist until the polled state actually reflects the action, with a fixed 8 s timeout and unmount-safe interval cleanup. Implementation is well-tested, well-commented, and the design choices were locked into the plan up front — including an explicit "intentional outlier" comment on the queue-toggle handler so a reader doesn't try to "fix" the asymmetry. No high-severity SOLID violations introduced. Three small cleanups and one cross-cutting reuse opportunity worth flagging.

## Findings Overview

| ID  | Domain           | Principle | Severity | Effort | Files                                  |
|-----|------------------|-----------|----------|--------|----------------------------------------|
| 1   | domain-dashboard | DRY/DIP   | medium   | medium | `src/app/videos/[id]/video-actions.tsx` |
| 2   | domain-dashboard | ISP/SRP   | low      | small  | `src/app/videos/use-video-action.ts`   |
| 3   | domain-dashboard | SRP       | low      | small  | `src/app/videos/use-video-action.ts`   |
| 4   | domain-dashboard | DRY       | low      | small  | `src/app/videos/videos-client.tsx`     |

## Findings Detail

### #1 — Detail-page action surface duplicates the action-runner pattern that was just centralized
**Domain:** domain-dashboard | **Principle:** DRY, DIP | **Severity:** medium | **Effort:** medium
**Files:** `src/app/videos/[id]/video-actions.tsx` (`post()` lines 58-78) — unchanged file, surfaced by this work.
**Recommendation:** Migrate `video-actions.tsx`'s `post()` handler to `useVideoAction`. The detail page uses inline `<p role="alert">` errors instead of toasts, so `useVideoAction`'s `errorToast` policy needs a fourth shape — either a `{ setError }` channel callers can target, or accept that the migration also flips the detail page to toast errors (a UX choice for the team). Once migrated, the detail page can adopt `waitFor` for Retry / Restart / Pause / Resume so its spinners track real state transitions instead of clearing at fetch resolve.
**Why:** `video-actions.tsx` runs the exact shape this morning's refactor centralized: busy flag → fetch → parse `body.message` → set error → `router.refresh()` → finally clear busy. The plan deliberately deferred reuse outside `/videos`, but the detail page now has the same "spinner clears too early" UX gap the list page just solved — the operator clicks Retry on a failed video, the spinner stops, but the row's status still shows `failed` until the next 5 s poll. Adopting `useVideoAction` + `waitFor` closes this once instead of forking the implementation, and prevents the two surfaces from drifting (e.g. a future error-policy tweak applied in one place but not the other).

---

### #2 — `errorToast` parameter does double duty: POST-failure message control AND timeout visibility gate
**Domain:** domain-dashboard | **Principle:** ISP, SRP | **Severity:** low | **Effort:** small
**Files:** `src/app/videos/use-video-action.ts` (lines 9, 75, 93, 113-115)
**Recommendation:** Split into two options. Keep `errorToast: false | string | { fallback }` as the POST-failure policy (full message control). Add a separate `timeoutToast?: false | string` (default to today's generic message) for the `waitFor` timeout path. Update the four call sites in `videos-client.tsx` accordingly — most can stay with the default; the silent ones (`onStartAll`, `onStartVideo`) explicitly pass `timeoutToast: false`.
**Why:** Today the timeout branch reads `errorToast` purely as a boolean to decide whether the generic `WAIT_FOR_TIMEOUT_MESSAGE` fires — `errorToast`'s configured `string` or `{ fallback }` is never reused on timeout. A reader of `errorToast: "Failed to pause video"` cannot tell whether the same string is reused on timeout (it isn't). The contract is implicit and survives only because all four call sites have matching POST-failure-and-timeout intent today; a future caller wanting "silent on POST-failure but loud on timeout" (or vice versa) cannot express it. Splitting makes the contract explicit and prevents that silent-failure surprise.

---

### #3 — `useVideoAction` now mixes three concerns: action lifecycle, predicate-wait loop, hook-level interval cleanup
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** low | **Effort:** small
**Files:** `src/app/videos/use-video-action.ts` (lines 60-72 cleanup effect, 73-109 runner closure, 111-136 predicate loop)
**Recommendation:** Extract the predicate-wait + cleanup into a sibling helper hook (e.g. `useWaitFor()`) that owns the `Set<intervalId>` ref and `useEffect` cleanup, and returns a function `(predicate, errorToast) => Promise<void>`. The runner inside `useVideoAction` then awaits this helper without managing intervals itself. The hook's first responsibility (call `fetch`, set busy, branch on `res.ok`, fire toast) stays cohesive; the second (run an async predicate loop with timeout and unmount-safe cleanup) becomes independently testable and reusable.
**Why:** The plan's Decision #8 already calls out the cleanup mechanism as intricate — "useEffect inside `useVideoAction` that owns a `Set<number>` of currently-active interval IDs ... the action function adds its interval ID on start and removes it on either exit branch" — and that intricacy now lives mixed into the runner closure alongside fetch/toast logic. Severity is low because today's three concerns still cohere and the test suite covers the unmount-safety path; this is a "watch out before adding a fourth concern" flag (e.g. retry-on-timeout, debounce, optimistic-with-rollback would each push it over). Extracting now is cheaper than after another concern accretes.

---

### #4 — Three of the four `waitFor` predicates repeat the same "find row by id, vanish-as-satisfied" shape
**Domain:** domain-dashboard | **Principle:** DRY | **Severity:** low | **Effort:** small
**Files:** `src/app/videos/videos-client.tsx` (`onStartVideo` predicate lines 138-140, `onPauseVideo` predicate lines 152-156, `onResumeVideo` predicate lines 169-184)
**Recommendation:** Add a small helper inside `videos-client.tsx` (or `_shared.tsx` if a second consumer appears — see #1): something like `predicateForRow(rowsRef, id, condition: (row: VideoListItem) => boolean)` that returns a predicate satisfying when the row is missing OR `condition(row)` is true. Three of the four predicates collapse to one-line condition expressions; the fourth (`onStartAll`'s "none of targetIds appear in topics" shape) stays as-is because its semantics are different.
**Why:** The vanish-as-satisfied rule is well-documented in the plan but encoded three times — a future predicate writer must remember to include the `row === undefined ||` clause or risk a hung spinner if the row disappears mid-wait (deletion, status filter, payload omission). A named helper makes the rule explicit at the type level instead of relying on convention. Pairing this with finding #1's migration would let the detail page use the same helper rather than inventing its own predicate shape, compounding the win.

## Priority Action Plan

### Most valuable
- **#1** — `video-actions.tsx` migration. Closes the same "spinner clears too early" UX gap on the detail page that the list page just fixed, prevents the two surfaces from drifting, and gives the detail page `waitFor` semantics for Retry/Restart/Pause/Resume. Pair with #4 to land the predicate helper at the same time.

### Cleanups
- **#2** — Split `errorToast` and `timeoutToast`. Two-line type change, four call sites updated, contract becomes explicit.
- **#4** — Predicate helper. Marginal today; valuable when #1 lands so the detail page adopts the same shape.

### Watch-out (no immediate action)
- **#3** — `useVideoAction` concern split. Today's three concerns cohere; flag is "extract before adding a fourth concern." Re-evaluate next time someone wants to extend the hook.

## How to Act on This

```
/create-plan Refactor items #1, #4 from docs/refactoring/solid-audit-2026-04-30-spinner-sync.md
```

## Notes

**Positive patterns worth preserving** (resist any urge to "normalize" them):

- The `onToggleQueue` "intentional outlier" comment (`videos-client.tsx:189-194`) is exemplary — explicitly states that this handler doesn't follow the `waitFor` pattern because optimistic update is strictly better when post-action state is fully client-knowable, and is the only handler meeting that bar. Keep this style of comment for any deliberate asymmetry; it pre-empts future "consistency" PRs that would regress UX.
- The `latestRowsRef` write-during-render pattern (`videos-client.tsx:74`) is unconventional but correctly justified by the inline comment — predicates fire on the timer queue, not synchronized with React's commit phase, so a `useEffect` ref-update would lose freshness on the first predicate tick after each poll commit. This is the right call here; do not "fix" it.
- The `RowInflight` discriminated union (`videos-client.tsx:24-27`) survived the `BusyHandle` abstraction intact. The `rowBusy(id, action)` factory translates between them cleanly. Single-row global lock is intentional per Decision #9; widening to multi-row concurrency is a deliberate non-goal.

**Verified non-issues** (deliberately not flagged):

- `WAIT_FOR_TIMEOUT_MS = 8000` and `WAIT_FOR_POLL_MS = 250` are module-scoped, not configurable per call. Plan Decision #6 chose this explicitly; not an OCP concern at one variant.
- The `onSuccess: "router-refresh" | (() => void)` literal-or-callback shape is the audit-#2 design from this morning. Each call site makes a deliberate, documented choice. Don't collapse to a single callback form — the literal communicates "I want the framework default" intent.
- The `deferred_until` unit-conversion in `onResumeVideo` (`videos-client.tsx:178-181`) is a fragile pattern (unix-seconds vs ms), but it's well-commented with a cross-reference to the worker-side SQL filter and was the explicit fix-up commit (`27ee3f5`). A shared TS helper would only have one consumer; deferring extraction until the detail page adopts the same predicate (finding #1) is correct.

**Test coverage**: the new tests cover all the design decisions enumerated in the plan — predicate-already-true fast path, predicate-becomes-true-mid-wait, 8 s timeout with and without toast, non-OK ignores `waitFor`, unmount cleanup, single-flight `pollNow` dedup, late-resolving fetch after unmount. The `start-all` two-stage advance test (`videos-client.test.tsx:397-480`) is particularly valuable — it locks in the `targetIds` snapshot semantics so a future "simplify to topics-empty" change fails loudly.
