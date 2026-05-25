# SOLID Audit — 2026-04-30 (videos-client.tsx)

**Mode**: Single-file (focused review per user request)
**Scope**: `src/app/videos/videos-client.tsx` — the `/videos` list-page client island. 456 lines.
**Domains analyzed**: domain-dashboard

## Summary

Yes, `videos-client.tsx` would benefit from refactoring — though no part of it is actively broken. The file (456 lines) has accreted into a five-concern orchestrator (polling, six fetch handlers, banner subsystem, three section UIs, modal/dialog state) and the sister file `video-detail-client.tsx` already shows where this trajectory leads (730 lines, flagged separately in `solid-audit-2026-04-30.md`). The cleanest wins are extracting the failure-banner subsystem into its own component and collapsing the six near-identical action handlers behind one helper — both small, mechanical changes that pay for themselves immediately. After all three findings land, the orchestrator drops from 456 lines to ~165 (banner ≈ 95 lines extracted, action handlers + duplicated busy-state ≈ 105 lines net after one shared helper, polling effect + `splitRows` + `prevStatuses` ≈ 90 lines extracted).

## Findings Overview

| ID  | Domain           | Principle | Severity | Effort | Files                                |
|-----|------------------|-----------|----------|--------|--------------------------------------|
| 1   | domain-dashboard | SRP       | medium   | small  | `src/app/videos/videos-client.tsx`   |
| 2   | domain-dashboard | DIP, SRP  | medium   | small  | `src/app/videos/videos-client.tsx`   |
| 3   | domain-dashboard | SRP       | medium   | medium | `src/app/videos/videos-client.tsx`   |

## Findings Detail

### #1 — Failure-banner subsystem is glued into the page orchestrator
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** medium | **Effort:** small
**Files:** `src/app/videos/videos-client.tsx` (lines 38-66 type+parser, 111-112 state, 235-250 dismiss handler, 271 derived value, 286-331 banner JSX)
**Recommendation:** Extract `FlowCreateProjectFailedPayload`, `parseFlowCreateProjectFailed`, the `flowCreateProjectFailed` / `dismissingBanner` state, `onDismissBanner`, and the 45-line `<div role="alert">` block into a new `src/app/videos/flow-failure-banner.tsx`. The orchestrator hands the banner the latest raw setting string (still owned at the page level so it can be swapped on each poll) plus a callback or internal endpoint to clear it. The banner owns parsing, rendering, and dismissal.
**Why:** The banner is a self-contained subsystem — its own JSON shape, its own fallback parsing rule (malformed JSON still surfaces with placeholders, deliberate), its own API endpoint, its own JSX with timestamp formatting. None of it is shared with anything else in the file. Extracting it lets the parser be unit-tested in isolation (the file's only piece of pure logic that actually has a non-trivial branch — empty vs malformed vs valid), and shrinks the orchestrator by ~95 lines (29 type+parser + 2 state + 16 dismiss handler + 1 derived value + 46 JSX) without requiring any interface redesign.

---

### #2 — Six near-identical fetch handlers, with inconsistent post-success behavior
**Domain:** domain-dashboard | **Principle:** DIP, SRP | **Severity:** medium | **Effort:** small
**Files:** `src/app/videos/videos-client.tsx` (`onStartAll` 173-184, `onStartVideo` 186-197, `onPauseVideo` 199-215, `onResumeVideo` 217-233, `onDismissBanner` 235-250, `onToggleQueue` 252-269)
**Recommendation:** Centralize the action handlers behind one helper — `useVideoActions(setRowInflight, setQueueState, ...)` or a small `usePostAction({ url, method, onSuccess, errorToast })` hook. The bigger structural win is forcing each call site to make a deliberate, documented choice between the two post-success patterns currently in use: `router.refresh()` (Start, StartAll, Pause, Resume) versus optimistic local state update (ToggleQueue, DismissBanner). Today the choice is implicit — touching a `Video` row uses refresh; touching a scalar uses optimistic — but it's not stated anywhere, and a reader can't tell whether the pattern is intentional or accidental.
**Why:** Six handlers totalling ~92 lines, all running the same shape: set busy flag → `fetch` → branch on `res.ok` → maybe `toast.error` with `(await res.json().catch(() => ({}))) as { message?: string }` → unset busy flag in `finally`. The defensive JSON-parse cast appears twice verbatim. Two of the six handlers (`onStartAll`, `onStartVideo`) silently swallow non-OK responses with no toast — that's an inconsistency that shouldn't be hidden behind copy-paste. Centralizing also makes adding a seventh action (Retry-All? Cancel-Queue?) a one-line change rather than another 17-line block to maintain. (Note: #1 already extracts `onDismissBanner`, so the helper covers the remaining five — net delete is still ~75 lines once the duplicated busy-state booleans collapse into the helper's internal state.)

---

### #3 — File mixes five concerns; weight will keep growing with each /videos feature
**Domain:** domain-dashboard | **Principle:** SRP | **Severity:** medium | **Effort:** medium
**Files:** `src/app/videos/videos-client.tsx`
**Recommendation:** After #1 and #2 land, extract one more piece — the polling effect plus the row-split policy — into a `useVideoPoller(initialVideos, initialQueueState, initialFlowCreateProjectFailed)` hook in this same directory. The hook owns `splitRows` + `QUEUE_STATUSES` (lines 70-91), the `setInterval`, the `prevStatuses` ref, the status-diff toast emission (lines 121-169), and returns `{ topics, queue, finished, queueState, flowCreateProjectFailed }`. The orchestrator becomes a slim composer (~165 lines) that wires the hook output to the three section layouts and the modal/dialog state. The three section layouts (`<section>` blocks for Topics, Queue, Finished) stay inline — each is ~30 lines and reads as a layout, not as logic.
**Why:** The skill describes the videos list/detail surface as "a client orchestrator (owns polling + dialog state) plus per-table / per-action child components." That contract holds today only by a thread — the orchestrator already owns the banner subsystem (#1), the action layer (#2), the polling effect with status-diff toast logic, the row-split policy, and the modal/dialog state. Each new /videos feature will land here by gravity. The detail-page sister file is already at 730 lines and was flagged for the same reason in this morning's audit (`solid-audit-2026-04-30.md` finding #3) — same trajectory, one step earlier. Bundling `splitRows` into the hook also surfaces the implicit bucket policy ("`new` is its own bucket, `failed` belongs to the queue, `done` is finished") in one place; the API list route currently re-encodes a similar split, but de-duping that is out of scope here. Acting now while the seams are still clean is materially cheaper than after another two features.

## Priority Action Plan

Sequenced — #1 and #2 land first because they are the cleanest seams; #3 is most valuable *after* the file has already shed the banner and action layers, since the remaining concerns become more obvious.

### First (small effort, do together)
- **#1** — Extract `flow-failure-banner.tsx`. Pure mechanical move; ~95 lines deleted from the orchestrator and the parser becomes testable in isolation.
- **#2** — Centralize the remaining five action handlers and document the `router.refresh()` vs optimistic-update split as a deliberate per-action choice.

### Next
- **#3** — Extract `useVideoPoller` (and fold `splitRows` + `QUEUE_STATUSES` into it). Most valuable as the *last* of the three so the orchestrator's only remaining job is layout composition + modal/dialog state.

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #2 from docs/refactoring/solid-audit-2026-04-30-videos-client.md
```

## Notes

**Positive patterns worth keeping**: the `RowInflight` discriminated-union state is the right shape — one piece of state for "which row is doing what," not five booleans. The `prevStatuses` ref pattern for diffing toast emissions across polls is also clean and stable (no stale-closure trap thanks to using a ref + setters from React, which are stable identity). Both should survive the extractions intact.

**Cross-cutting with this morning's audit**: this file and `video-detail-client.tsx` are the two `/videos` orchestrators, and both are drifting in the same direction (polling + actions + multiple subsystems in one component). The corrective patterns are the same — extract subsystem components, centralize action handlers, lift polling into a hook. Doing both list-page and detail-page extractions in one pass would let them share a `useVideoPoller` shape if convergence makes sense; doing them separately is also fine since the polling payloads differ.

**Verified non-issues** (intentionally not flagged):
- The empty-deps `useEffect` on the polling loop is safe — its closures only touch refs and React-stable setters, so no stale-closure bug.
- `parseFlowCreateProjectFailed` running on every render is a non-issue at this scale (and #1 makes it the banner's internal concern anyway).
- The `VideosClientProps` shape (5 fields, one forwarded) is acceptable for a page-level island — `projectsDir` forwarding to `FinishedVideosTable` is not an ISP violation, just data flow.
