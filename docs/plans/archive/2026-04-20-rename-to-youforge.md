# Rename HistForge → YouForge (Soft Rebrand)

## Overview
Repo-wide soft rebrand from HistForge to YouForge. User-visible strings,
docs, and package metadata change. Internal structural identifiers
(SQLite db filename, `projects/` directory name, log prefixes inside
the worker, environment variable names) are **out of scope** per the
"soft rename" decision — those can migrate in a later hard-rename pass
if ever needed.

This plan is a placeholder pinned alongside the YouForge Flow extension
plan (`2026-04-20-google-flow-hybrid.md`). It should execute **after**
that plan ships, since YouForge Flow already uses the new brand name
for the extension itself and a half-rebranded repo would be confusing
during that work.

## Scope

**Doing** (soft surface rename only)
- `package.json` `name` field and related metadata.
- `README.md` top-level title, description, badges.
- `CLAUDE.md` — "Project Overview" section, any prose references to
  "HistForge".
- `docs/histforge-spec.md` → rename file to `docs/youforge-spec.md`,
  update internal prose references. Update any link/redirect from
  other docs that referenced the old filename.
- Next.js app metadata (`<title>`, favicons, `metadata.title` export,
  OpenGraph tags) and dashboard header branding.
- Settings page branding / footer if present.
- Any user-facing log/error strings that include the project name.

**Not doing** (explicitly deferred)
- SQLite db filename: stays `data/histforge.db`. Renaming means a
  one-time migration on startup that detects old filename and renames
  it — possible but easy to botch. Defer.
- `projects/` directory convention: stays. Used in paths throughout
  the spec and in customer data on disk.
- Env var names (`PROJECTS_DIR`, any `HISTFORGE_*` if they exist):
  stay. Breaking user env setups silently is rude.
- Internal TypeScript identifiers that contain "histforge" in their
  name (if any). These aren't user-visible.
- Worker process log prefixes like `[histforge-worker]`, if any.
  Non-user-facing.
- Git repo directory name / remote URL — user's ops concern, not a
  code change.

## Tasks

### Phase 1: User-visible rename

- [ ] **Task 1.1: Package and README metadata**
  **Files**: `package.json`, `README.md`
  **What**: `package.json.name`, `description`, keywords, homepage if
  present. README top-heading, taglines, any installation/run prose
  that names the project.

- [ ] **Task 1.2: CLAUDE.md project description**
  **Files**: `CLAUDE.md`
  **What**: Update the "Project Overview" section's project name and
  prose. Leave directory paths untouched. Update any "HistForge" in
  troubleshooting or skill descriptions.

- [ ] **Task 1.3: Spec file rename**
  **Files**: `docs/histforge-spec.md` → `docs/youforge-spec.md`,
  plus any files that reference the old path
  **What**: `git mv` the file (preserve history), update prose inside
  to say "YouForge", find and update any cross-references (grep
  `histforge-spec.md` across the tree and update each hit).

- [ ] **Task 1.4: Dashboard branding**
  **Files**: `src/app/layout.tsx` (or wherever `metadata` is
  exported), `src/app/page.tsx` or whatever renders the dashboard
  header, favicon references, any navbar component that shows the
  project name.
  **What**: App title, meta tags, visible header text all read
  "YouForge".

- [ ] **Task 1.5: Audit remaining user-visible strings**
  **Files**: wherever Grep hits `HistForge` / `histforge` (case-
  insensitive) in source that renders to the UI or to error messages
  that reach the user.
  **What**: One pass through each match, decide user-visible vs
  internal, rename the user-visible ones. Leave internal ones alone
  per the out-of-scope rule.

### Phase 2: Sanity

- [ ] **Task 2.1: Type-check, build, run tests**
  **What**: Confirm `npm run build`, `npm run lint`, `npm run test`
  all pass post-rename.

- [ ] **Task 2.2: Update this plan's status**
  **What**: Mark all tasks checked; leave the file as a historical
  record.

## References
- `docs/plans/2026-04-20-google-flow-hybrid.md` — the extension plan
  that introduces "YouForge" as a brand and warrants this rebrand.
- CLAUDE.md "Branch Strategy" — `master` is the only branch; do the
  rename as a single PR.
