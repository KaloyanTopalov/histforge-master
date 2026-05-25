# Decision: per-row "Copy webhook URLs" for Google Flow accounts

**Status:** Decided — Option A (drop the action). 2026-04-21.

## What the plan asked for

`docs/plans/2026-04-20-google-flow-hybrid.md` Task 6.2 listed a
per-row **"Copy webhook URLs"** action in the Settings → Google
Flow accounts table: emit `pollUrl`, `resultUrl`, `statusUrl` to
the clipboard, ready to paste into the extension popup.

The same plan specifies (Task 3.5) that the account token is only
visible once — at creation — and `GET /api/flow/accounts` redacts
it to `…<last4>`.

## The tension

All three webhook URLs embed the account token in their path
(Tasks 3.1, 3.2, 3.4). Emitting ready-to-paste URLs from a
per-row action requires the token, but HistForge doesn't keep
the token in any recoverable form after the creation modal
closes.

## Options considered

### Option A — drop the action *(chosen)*

Operators save token + URLs from the once-per-account creation
modal. If lost, delete the account and create a fresh one; the
old Chrome profile gets re-pasted once.

### Option B — template copy with `<TOKEN>` placeholder

Emit URLs with a literal `<TOKEN>` placeholder. Operator pastes
both the template and the token into the extension popup.

### Option C — guarded token re-export endpoint

New admin-only route that returns the raw token. Breaks the
once-visible invariant; needs an auth model HistForge doesn't
have today.

### Option D — token rotation as a first-class action

New `POST /rotate-token` route mints a fresh token, invalidates
the old, and re-surfaces the creation modal.

## Why Option A

The operational model (Task 8.2 setup guide) assumes one
**persistent** Chrome profile per account, not incognito.
Persistent profiles keep cookies + extension storage
(`chrome.storage.local` holds the three URLs + token) across
browser restarts, so re-setup is genuinely rare:

- Extension configuration is one-time per profile, not per
  workflow or per video.
- Setup cost for a fresh profile is ~2 minutes: load unpacked,
  paste four strings, grant host permission, click Start.
- A lost-URL scenario already implies the operator is setting up
  a new/reset profile — rotating the account is free work at
  that point.

Incognito would break this whole model (ephemeral
`chrome.storage.local`, Google session dies on close, "Allow in
incognito" toggle required per-extension), so it's out.

Under these conditions, A is cheaper than B (no two-step paste
dance), cleaner than C (no new auth surface), and simpler than D
(no separate rotation workflow — delete+add already does the
same thing).

## What shipped

- Creation modal: Copy-all button that writes
  `token\npollUrl\nresultUrl\nstatusUrl` to clipboard in one
  click. That remains the only moment tokens are visible.
- Per-row actions: Pause 4h, Pause indefinitely, Resume, Delete.
  No per-row copy.
- Plan updated to match
  (`docs/plans/2026-04-20-google-flow-hybrid.md` Task 6.2).

## When to revisit

If any of these changes:

- HistForge grows a real auth model → Option C becomes
  inexpensive.
- Google Flow mandates forced token rotation → Option D becomes
  useful independently.
- Operators start running 10+ accounts and profile re-setup
  becomes frequent → B or D may pay for themselves.
