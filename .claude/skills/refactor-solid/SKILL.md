---
name: refactor-solid
description: Analyze codebase against SOLID principles using domain skills as the lens. Produces a prioritized list of refactoring recommendations. Use after implementing a feature to catch design drift, or run a full audit periodically. Triggers on "refactor", "SOLID", "code quality audit", "design principles check".
disable-model-invocation: true
argument-hint: "[commit-hash | domain-name | full-audit] (no args = current diff)"
---

# Refactor SOLID

Analyze the codebase against SOLID principles and produce a prioritized refactoring report. The analysis uses domain skills as its lens — each domain skill defines an area of the codebase via its `## Anchors` block (contract names: functions, types, tables, settings keys, env vars, etc.). Resolve those anchors against the current codebase (Glob/Grep) to discover the concrete files and architecture to inspect.

This skill is designed to run at the end of a feature-implementation workflow — once domain skills are refreshed, run this to catch SOLID violations introduced (or exposed) by the new work.

## Modes

**Current-diff mode** (default — no arguments): Analyzes staged and unstaged changes in the working tree. Quick check while actively working.

```
/refactor-solid
```

**Post-feature mode**: Provide a starting commit hash. Diffs from that commit to HEAD, identifies changed files, maps them to domains, and analyzes only those files.

```
/refactor-solid abc1234
```

**Single-domain mode**: Provide a domain skill name. Analyzes all files in that one domain. Useful for focused reviews or larger projects.

```
/refactor-solid domain-<name>
```

**Full-audit mode**: Analyzes all files referenced across all domain skills. Use periodically or before a major release.

```
/refactor-solid full-audit
```

## Initial Response

Parse `$ARGUMENTS` to determine mode:
- No arguments → current-diff mode
- 7+ hex characters (e.g., `abc1234`) → post-feature mode
- Matches a `domain-*` skill name (glob `.claude/skills/domain-*/SKILL.md` to validate) → single-domain mode
- `full-audit` → full-audit mode
- Anything else → show usage:

```
Unrecognized argument. Usage:

  /refactor-solid                  — analyze current diff (staged + unstaged)
  /refactor-solid abc1234          — analyze changes from commit to HEAD
  /refactor-solid domain-<name>    — analyze one domain
  /refactor-solid full-audit       — analyze all domains
```

## Process

### 1. Gather Context

**Current-diff mode:**
1. Run `git diff --name-only` and `git diff --name-only --cached` to get changed files (unstaged + staged)
2. If no changes found, report "No uncommitted changes to analyze" and stop
3. Filter out non-source files (tests, configs, migrations, lock files) — note but don't analyze

**Post-feature mode:**
1. Run `git diff --name-only <commit>..HEAD` to get the list of changed files
2. Run `git log --oneline <commit>..HEAD` to understand what was done
3. Filter out non-source files — note but don't analyze

**Single-domain mode:**
1. Skip the git step — resolve the specified domain's anchors to a file set (see "Resolving anchors" below) and analyze those files
2. Only read and analyze the one domain skill (not all of them)

**Full-audit mode:**
1. Skip the git step — resolve every domain's anchors to a file set, union the results, and analyze them all

**All modes:**
1. Find domain skills: glob `.claude/skills/domain-*/SKILL.md` (single-domain mode uses only the specified one)
2. Read each relevant domain skill's `SKILL.md` for the `## Anchors` block, architectural context, and design intent
3. Resolve anchors to concrete files in the current codebase (see below)
4. Map files to domains based on which domain's anchors they implement or back

**Resolving anchors:**

A domain skill's `## Anchors` block lists contract names — typically a mix of function/type/class names, database tables or columns, settings keys, env vars, repo/module names, route paths, or other stable identifiers. It deliberately avoids file paths because they drift. To turn anchors into files:

- For function/type/class/repo names: `Grep` for the symbol's definition (e.g., `export (function|const|class) <name>`, `<name>:` in a type/interface, `function <name>`, `class <name>`). The defining file belongs to the domain; files that import or call it are call sites worth scanning too.
- For DB tables / columns: `Grep` for the literal string (`'<table>'`, `<table>.<col>`) — schema files, migrations, ORM models, and repository modules will surface.
- For settings keys / env vars / route paths: `Grep` for the literal string — gives you both the consumer and the definition site.
- Cross-reference with the domain's "Use when…" hints in its description (and any project CLAUDE.md skill index) — those usually name a directory or module group that scopes the search.

Build a `domain → files` map from these searches before analyzing. If a changed file (diff-based modes) doesn't match any domain's anchors, group it under "Uncategorized" — this itself may be a finding (missing domain coverage).

### 2. Analyze Against SOLID

For each domain with relevant files, read the source files and evaluate against each SOLID principle. The principles below are framed for typical application codebases — adapt the wording to whatever language/framework the project actually uses (backend services, frontend apps, CLIs, libraries, etc.).

**SRP — Single Responsibility Principle**
Every module, component, or function should have one reason to change. Look for:
- Modules/components that mix unrelated concerns (e.g., UI rendering + data fetching + business logic; or HTTP handling + validation + persistence + response formatting in one function)
- Files that have grown well beyond the project's typical size and juggle multiple concerns
- Hooks, services, or controllers that manage unrelated pieces of state
- Utility modules that are grab-bags of unrelated functions

**OCP — Open-Closed Principle**
Modules should be open for extension, closed for modification. Look for:
- Switch statements or if-else chains that grow every time a new variant is added (e.g., new provider, new source type, new event kind)
- Hardcoded lists that require editing the source to add entries
- Functions where adding a new case requires modifying existing logic rather than registering a new handler
- When you spot a positive OCP example in this codebase (e.g., a registry or plugin system that genuinely follows the pattern), call it out as a reference instead of flagging adjacent code that doesn't yet conform

**LSP — Liskov Substitution Principle**
Subtypes (or implementations of the same interface) should be interchangeable. Look for:
- Implementations of a shared interface that behave inconsistently or violate documented contracts
- Type narrowing with unsafe casts or runtime type checks that indicate a broken abstraction
- Functions that check `instanceof` or discriminant fields to handle cases differently when callers shouldn't have to care

**ISP — Interface Segregation Principle**
No consumer should depend on methods/properties it doesn't use. Look for:
- Large context/config objects where most consumers read 1-2 fields
- Wide interfaces (props, parameters, service contracts) with many optional fields used in disjoint subsets by different callers
- Monolithic type/schema definitions imported across many files when each file only needs a slice
- API response payloads that bundle unrelated data forcing every consumer to depend on all of it

**DIP — Dependency Inversion Principle**
High-level modules should depend on abstractions, not concrete implementations. Look for:
- Direct imports of concrete implementations where an abstraction layer would allow swapping
- High-level code reaching directly into low-level details (e.g., a UI component calling the database client directly, or business logic instantiating a specific HTTP/SDK client instead of going through a service interface)
- Hard coupling between layers that should be separated (presentation ↔ persistence, app code ↔ infra)
- When the project already has clean abstractions (a provider registry, a repository layer, a port/adapter boundary), use them as positive references and flag code that bypasses them

### 3. Rate Each Finding

For each violation found:

**Severity:**
- **high** — Actively causing problems: makes bugs likely, blocks testability, or forces shotgun surgery across files when making changes
- **medium** — Design smell that will compound: not broken today, but will make the next feature in this area harder
- **low** — Minor improvement: cleaner but not urgent, "nice to have" level

**Effort:**
- **small** — Localized change, 1-2 files, under an hour
- **medium** — Touches 3-5 files or requires rethinking a pattern, a few hours
- **large** — Architectural change spanning many files, may need its own plan

### 4. Write the Report

Save to `docs/refactoring/solid-audit-YYYY-MM-DD.md` using this format:

```markdown
# SOLID Audit — YYYY-MM-DD

**Mode**: Current-diff | Post-feature (from `<commit>`) | Single-domain (`<domain>`) | Full audit
**Scope**: [brief — e.g., "<short feature name>, N files changed across M domains"]
**Domains analyzed**: [list]

## Summary

[2-3 sentences: overall health, key themes, most pressing items]

## Findings Overview

A scannable summary table with short columns only — full details follow below.

| ID  | Domain             | Principle | Severity | Effort | Files                       |
|-----|--------------------|-----------|----------|--------|-----------------------------|
| 1   | domain-<name>      | SRP       | high     | medium | `<path/to/file>`            |
| 2   | ...                | ...       | ...      | ...    | ...                         |

## Findings Detail

Each finding as a readable card:

### #1 — [Short descriptive title]
**Domain:** domain-<name> | **Principle:** SRP | **Severity:** high | **Effort:** medium
**Files:** `<path/to/file>`
**Recommendation:** [What to do]
**Why:** [Why this matters — concrete consequences]

---

### #2 — [Short descriptive title]
...

## Priority Action Plan

Items sorted by impact (high severity + small effort first):

### Immediate (high severity, small-medium effort)
- **#1** — [one-line summary]
- **#3** — [one-line summary]

### Next Sprint (medium severity, or high + large effort)
- **#5** — [one-line summary]

### Backlog (low severity)
- **#7** — [one-line summary]

## How to Act on This

Pick the items you want to tackle and pass their IDs to `/create-plan`:

```
/create-plan Refactor items #1, #3 from docs/refactoring/solid-audit-YYYY-MM-DD.md
```

The plan will use this audit as input — each item has the files, the what, and the why already specified.

## Notes

[Optional: observations that don't fit the table — e.g., positive patterns worth preserving, cross-domain concerns, or areas that need domain skill coverage]
```

### 5. Present to the User

```
SOLID audit saved to `docs/refactoring/solid-audit-YYYY-MM-DD.md`

Found X items: Y high, Z medium, W low severity.

Top priorities:
1. #[id] — [one-line summary] (high, small effort)
2. #[id] — [one-line summary] (high, medium effort)
3. ...

Pick items to refactor and run:
/create-plan Refactor items #1, #3 from docs/refactoring/solid-audit-YYYY-MM-DD.md
```

## Guidelines

- **Read before judging** — always read the actual source files, not just file names. A file named `utils.ts` may be perfectly focused; a file with an authoritative-sounding name may be doing five things.
- **Respect existing abstractions** — every codebase has deliberate patterns (registries, repository layers, port/adapter boundaries, context separation). Don't flag these as violations; use them as positive examples of SOLID done right and as references for adjacent code that should converge on them.
- **Don't over-flag** — not every file needs to be pristine. If something works, is readable, and only has one reason to change, it's fine. Focus on violations with real consequences: harder testing, shotgun surgery, or bugs from mixed concerns.
- **Be concrete** — "this file does too much" is not helpful. Name the specific concerns (with line ranges if useful) and the specific extraction or boundary you'd introduce.
- **Context matters** — a 300-line file with one clear responsibility is better than three 100-line files with tangled dependencies. SRP is about cohesion, not line count.
- **Post-feature mode should be fast** — for a typical feature touching 5-15 files, aim for a focused report. Don't pad it with marginal findings.
- **Full-audit should be thorough** — cover all domains systematically. It's OK to produce a longer report here.
- **No code snippets** — describe WHAT to change and WHY, not HOW. The refactoring implementation is for `/create-plan` and `/implement-plan-tdd`.
