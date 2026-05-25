# Remove `quota_used_today` Column and "Quota" UI

**Status**: plan, ready to implement
**Rationale**: `quota_used_today` is a HistForge-internal dispatch counter, **not Google's actual quota**. It's incremented on every successful claim in `/api/flow/next-task`, reset to 0 on account pause/resume, but read **nowhere except the dashboard cell**. It gates no logic. Google-side rate limiting is already handled reactively by the error classifier (429 → pause + requeue). Removing the field is pure declutter.
**Effort**: small (≈15–30 lines across ≈6 files + optional DB migration).

## Intent

- Drop the "Quota" column from the Google Flow accounts table.
- Stop writing `quota_used_today` (remove the bump + the zeroing).
- Optionally drop the column from the SQLite schema.
- Update types and tests so nothing references the field.

## Changes by file

### Remove writes

- **`src/lib/repos/google-flow.ts`**
  - Delete `bumpAccountQuota` (lines 88-92).
  - In `resumeAccount` (lines 82-86), drop `quota_used_today = 0` from the SET list; simplify to `UPDATE google_flow_accounts SET paused_until = NULL WHERE id = ?`. Update the docstring — the "fresh cooldown window with no accrued quota" line becomes obsolete.

- **`src/app/api/flow/next-task/[token]/route.ts`**
  - Remove the `gfRepo.bumpAccountQuota(db, account.id)` call (around line 86 / the transaction body). Remove the import if it was the only consumer.

### Remove UI

- **`src/app/settings/google-flow-accounts.tsx`**
  - Delete the `<TableHead>Quota</TableHead>` header (line 252).
  - Delete the `<TableCell>{row.quota_used_today}</TableCell>` body (lines 327-329).
  - Drop `quota_used_today` from the `AccountListItem` interface.

### Remove from API shape

- **`src/app/api/flow/accounts/route.ts`**
  - Remove `quota_used_today` from the `redact` / projection helper's output shape.

### Remove from types

- **`src/types.ts`** — drop `quota_used_today: number;` from `GoogleFlowAccount`.

### DB schema — pick one

**Option A — leave the column in place.** It's `NOT NULL DEFAULT 0` and nothing writes it after this change. Cheapest; no migration risk. Leaves a dead column in `PRAGMA table_info` forever.

**Option B — drop the column via `ALTER TABLE ... DROP COLUMN`.** SQLite 3.35+ supports this. In `src/lib/db.ts:createDb`:
  - Remove `quota_used_today` from the `CREATE TABLE google_flow_accounts` DDL (lines 114-125).
  - Add a guarded `ALTER TABLE google_flow_accounts DROP COLUMN quota_used_today` migration in the same way the `deferred_until` column was added (check for column presence first via `PRAGMA table_info`).
  - Update the db-schema test in `__tests__/unit/lib/repos/google-flow.test.ts:41-71` to expect the reduced column set.

Default to **A** unless the operator explicitly wants a clean schema. A is one-line-per-reader; B adds migration footprint.

### Tests

- **`__tests__/unit/lib/repos/google-flow.test.ts`**
  - Drop the test "pauseAccount sets paused_until without touching quota_used_today" (lines 165-174) — nothing to preserve.
  - Drop the test "resumeAccount clears paused_until AND zeroes quota_used_today (atomic)" (lines 176-191) — the second half of its contract goes away. Replace with a simpler "resumeAccount clears paused_until" test.
  - Remove `bumpAccountQuota` calls anywhere else (grep the file).
  - If picking Option B: update the schema-shape test (lines 41-71) and the fully-specified-row round-trip test (lines 73-100).

- **`__tests__/api/flow/next-task/[token]/route.test.ts`**
  - In "clears paused_until AND zeroes quota_used_today when pause has elapsed" (around lines 187-226), drop the quota assertion at line 225. The pause-clearing half of the test stays.
  - In "dispatches a createImage task..." (around line 228), drop the `quota_used_today` assertion around lines 267-268.
  - Remove any `quota_used_today` fixture rows from seed helpers that are now dead.

- **`__tests__/unit/lib/db.test.ts`** — if it enumerates the default settings or introspects the accounts schema, update expected lists.

## Order of operations

1. Remove the writes (repo `bumpAccountQuota` + the route call). Tests that assert bump behavior will fail.
2. Delete / update those tests.
3. Remove UI + types + API shape. Component / type-level tests will fail.
4. Update those tests.
5. Decide A vs B for the schema (and run the corresponding migration + test update if B).
6. Run `npm test` (on Windows — see WSL/sqlite note below) and `npx tsc --noEmit`; confirm clean.

## Acceptance

- `grep -rn quota_used_today src __tests__` returns no hits (or only the schema-drop migration if Option B).
- `grep -rn bumpAccountQuota src __tests__` returns no hits.
- Accounts table renders without the Quota column.
- Existing pause/resume flows still work end-to-end; only the counter bookkeeping disappears.
- Typecheck + lint clean.

## Notes for the implementer

- Test runs require Windows — `/workspace` is a 9p mount of `C:\`, so `better-sqlite3` native module is built for Windows and vitest fails under WSL with "invalid ELF header". Ask the user to run `npm test` on Windows.
- There is no user-facing migration communication needed — quota was never a commitment, just a debug cell.
