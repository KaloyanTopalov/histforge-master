# Flow Accounts Compact Strip — Plan

**Status**: plan, ready to implement
**Rationale**: on the video-detail page, the Flow progress panel only shows per-chunk task counts. To answer "is any account actually working on this queue, or are they all paused/offline?", the operator has to switch to Settings > Google Flow. A compact account-status strip embedded in the Flow progress panel resolves that without duplicating the full accounts CRUD surface.
**Effort**: small-to-medium (≈2–4 hours; no schema changes, no new DB queries, no new API endpoints).

## Intent

Add a read-only compact strip of Flow account status directly under the existing "Flow progress" header on the video detail page. One dot per account with inline label, showing enough to answer "who's online and who's paused?" at a glance. Full CRUD stays in Settings.

## UX sketch

Above the existing per-chunk rows on the Flow progress panel, add a single horizontal line:

```
Accounts  ●alice seen 3s ago (120 credits)   ●bob paused 2h left (118 credits)   ○carol polling stopped · last seen 2h ago   ●dave seen 14s ago (400 credits)
```

- Filled dot = healthy (enabled + not paused + recent `last_seen_at`).
- Paused label = `paused Xh Ym left` derived from `paused_until`.
- Stopped = no recent `last_seen_at` (older than `DEFAULT_STALE_ACCOUNT_MINUTES`) OR `enabled = 0`. Wording matches the Settings credits cell's `polling stopped · last seen …` so the two surfaces read as one.
- Credits inline per account when known (`(N credits)`), using the same fallback rules as the Settings cell: hide entirely on `credits === null`, show last-known value for paused/stopped accounts.
- No mutation buttons. The account name can be a link to Settings > Google Flow > Accounts for users who want to act.
- When there are zero accounts configured, show a single hint: `No Flow accounts configured — add one in Settings > Google Flow`.

## Data source

- Existing `GET /api/flow/accounts` returns everything needed: `{id, name, paused_until, last_seen_at, enabled}`.
- No new endpoint.
- No new DB query.

## Component layout

### New file: `src/lib/flow-account-status.ts`

Pure helper: `getAccountStatus(account: AccountListItem, nowSec: number): {kind: "online" | "paused" | "stopped", label: string}`. Encapsulates:

- `enabled === 0` → `stopped`, label `"disabled"`.
- `paused_until !== null && paused_until > nowSec` → `paused`, label `"paused Xh Ym left"` (reuse/port the existing time formatter from `google-flow-accounts.tsx`).
- `last_seen_at === null || nowSec - last_seen_at > DEFAULT_STALE_ACCOUNT_MINUTES * 60` → `stopped`, label `"polling stopped · last seen Xs ago"` (or `"never"` when `last_seen_at === null`).
- Otherwise → `online`, label `"seen Xs ago"`.

The stale threshold **must** come from `DEFAULT_STALE_ACCOUNT_MINUTES` in `@/lib/flow-constants` (10 min). That same constant is used by the reaper (`flow-watcher.ts`) and the Settings credits cell (`google-flow-accounts.tsx`); diverging here would produce user-visible contradictions — e.g. strip says "stopped" while the credits cell says "— (awaiting first poll)" for the same account. Also: the `stopped` label wording must match the Settings credits cell's wording exactly so the two adjacent surfaces read as one system.

### New file: `src/app/videos/[id]/flow-accounts-strip.tsx`

Client component. Props: `{ accounts: AccountListItem[], nowSec: number }`. Renders the strip described above using the helper. Keep it presentational — no fetching inside; the parent owns polling.

### Edit: `src/app/settings/google-flow-accounts.tsx`

The file already has (as of commit `c8f49f4`):
- `relative()` — pure relative-time string formatter.
- `futureDelta()` — future-time remaining-until formatter (for `paused_until`).
- `renderCreditsCell(row, nowMs)` — JSX helper that owns the three-state credits rendering. Its stale check already imports `DEFAULT_STALE_ACCOUNT_MINUTES` from `@/lib/flow-constants`.

Refactor: pull the stale/paused/online *logic* out of `renderCreditsCell` into the new shared `getAccountStatus` helper in `src/lib/flow-account-status.ts`. `renderCreditsCell` then becomes a JSX-shaped wrapper that (a) calls `getAccountStatus` to pick the state, (b) renders the credit count when `credits !== null`. The two time formatters (`relative`, `futureDelta`) either stay file-local or move alongside `getAccountStatus` if the strip also needs them — decide based on reuse.

Goal: one function (`getAccountStatus`) determines state for both surfaces; each surface owns its own JSX. If this refactor is done right, `__tests__/components/settings/google-flow-accounts.test.tsx` should need zero changes — all 4 credits-cell tests added in commit `c8f49f4` still pass on the refactored code.

### Edit: `src/app/videos/[id]/video-detail-client.tsx`

The Flow progress panel currently renders at lines 339-404 and polls `/api/flow/queue-summary/[videoId]` every 5s (`POLL_MS = 5000`, line 224).

Changes:
- Add `accounts` state: `useState<AccountListItem[]>([])`.
- In the same 5s tick, fire a second fetch to `/api/flow/accounts` and update `accounts`. One tick → two parallel fetches (`Promise.all` is fine; they're independent).
- Render `<FlowAccountsStrip accounts={accounts} nowSec={Math.floor(Date.now() / 1000)} />` just below the panel header, above the `Main images` / `Hook videos` rows.
- Gate by `isFlow` (line 140 check for `workflow_id === "google-flow"`). **Do not** gate on `flowStepStarted` — knowing which accounts exist is useful even before the first Flow step dispatches, unlike the per-chunk counts.

## Tests

### New: `__tests__/unit/lib/flow-account-status.test.ts`

Table-driven helper tests:

- enabled + recent `last_seen_at` → `online`.
- enabled + no `last_seen_at` → `stopped`, label includes `"never"`.
- enabled + stale `last_seen_at` (> `DEFAULT_STALE_ACCOUNT_MINUTES * 60`) → `stopped`, label starts `"polling stopped · last seen"`.
- `enabled === 0` → `stopped` with `"disabled"` label, overriding everything else.
- `paused_until > now` → `paused` with remaining-time label.
- `paused_until <= now` → treated as unpaused (defer to the online/stopped logic).
- Label formatting corner cases (<1 min, minutes+hours).

### Edit: `__tests__/components/videos/video-detail-client.test.tsx`

Add one render case that seeds the mocked `/api/flow/accounts` fetch with ~3 accounts in different states and asserts the strip renders the expected labels. Mirror the existing fetch-mock pattern used by the queue-summary tests.

### Edit: `__tests__/components/settings/google-flow-accounts.test.tsx`

Should keep passing with no change if the helper refactor preserves rendered output. If any rendered label drifts (e.g. `"seen 3 seconds ago"` → `"seen 3s ago"`), update the test assertions to match the new shared formatter — just keep the two surfaces in agreement.

## Open decisions (ask the user before implementing)

1. **Gate on `flowStepStarted` or render unconditionally for `isFlow` videos?** I recommend unconditional — "zero accounts configured" is also useful pre-step info. But if the panel currently hides on fresh videos by design, match that behavior.
2. **Name as link to Settings**, or plain text? A link costs nothing but couples the component to the Settings route path.

Previously-open decisions now settled by the 2026-04-23 credits-bug session:

- **Staleness threshold** → use `DEFAULT_STALE_ACCOUNT_MINUTES` (10 min) from `@/lib/flow-constants`. Any divergence contradicts the reaper and the Settings credits cell.
- **Show credits inline?** → yes. Credits polling is verified reliable as of commit `18246c5`. Follow the Settings cell's fallback rules for null/stopped states.

## What this plan deliberately does not do

- No account mutation buttons on the strip. Enable / pause / rename / delete stay in Settings. The strip is a health indicator, not a control panel.
- No per-chunk account assignment display (e.g. "chunk_012 dispatched to alice"). That's a bigger information surface and would crowd the Flow progress panel. Viable as a separate follow-up.
- No new DB columns, no new API endpoints.

## File list

| Action | File | Purpose |
|---|---|---|
| NEW | `src/lib/flow-account-status.ts` | Shared status-derivation helper + label formatting |
| NEW | `src/app/videos/[id]/flow-accounts-strip.tsx` | Strip presentational component |
| EDIT | `src/app/videos/[id]/video-detail-client.tsx` | Fetch accounts, render strip |
| EDIT | `src/app/settings/google-flow-accounts.tsx` | Refactor to use shared helper |
| NEW | `__tests__/unit/lib/flow-account-status.test.ts` | Helper unit tests |
| EDIT | `__tests__/components/videos/video-detail-client.test.tsx` | Extend with strip render case |

## Acceptance

- Strip visible on video detail for any `google-flow` workflow video.
- Accounts with recent `last_seen_at` show filled dots; paused accounts show remaining time; offline/disabled show hollow dot.
- Strip updates within one 5s polling tick after an account changes state (pause/resume/new last_seen_at).
- No regressions in Settings > Google Flow > Accounts table (same labels, same behavior).
- `npm test` + `npx tsc --noEmit` clean.

## Notes for the implementer

- Tests require Windows — `/workspace` is a 9p mount of `C:\`, so `better-sqlite3` fails under WSL. Ask the user to run `npm test` on Windows.
- The existing Flow progress panel uses `useEffect` + `setInterval` for polling (see around line 224). Reuse that mechanism rather than introducing a new data-fetching library.
- `src/lib/flow-constants.ts` already exports `DEFAULT_STALE_ACCOUNT_MINUTES` (commit `0fd302f`). Import it — do NOT re-declare a separate threshold constant in `flow-account-status.ts`.
- The `stopped` label wording must match the Settings credits cell verbatim. That cell uses `"polling stopped · last seen {relative(last_seen_at)}"` (commit `c8f49f4`). Changing either surface's wording requires updating the other simultaneously.
