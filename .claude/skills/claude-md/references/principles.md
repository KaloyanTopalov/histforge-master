# CLAUDE.md Principles Reference

## Core Constraint

CLAUDE.md content loads into every session. Target under 150 lines of universal instructions (up to 250 for large monorepos if every line passes the inclusion test). Everything else is excluded.

**Inclusion test:** "Does this prevent errors or enable decisions across most sessions?" If no, it does not belong in CLAUDE.md.

## Triage Checklist

For each piece of project knowledge:

| Question | Destination |
|----------|-------------|
| Needed every session? (commands, architecture, branch model) | Include in CLAUDE.md |
| Needed only in a specific area? (component patterns, API conventions) | Exclude — too narrow |
| Enforced by linter, type system, or git hooks? | Exclude — deterministic tools handle it |
| Basic programming knowledge? | Exclude — assume competence |
| Discoverable from error messages or docs? | Exclude — on-demand discovery is sufficient |

## Content Rules

**Include in CLAUDE.md:**
- Project purpose and tech stack
- All dev/build/test/lint commands
- Directory structure overview
- Non-obvious workflows ("edit X, never edit Y directly")
- Branch strategy and deployment flow
- Critical constraints (a11y, supported runtime versions, API versioning policy, data privacy, performance budgets)
- Troubleshooting nudge lines pointing to existing skills (if any)

**Exclude:**
- Area-specific patterns, gotchas, and debugging guides (too narrow for universal context)
- Style/formatting rules (use linter configs + hooks)
- Tutorial content or basic programming practices
- Code snippets that will go stale (use `file:line` pointers)
- Anything discoverable from error messages or official docs
- Information enforced by type systems or linter configs

## Anti-Patterns

1. **Flat doc directories** – `docs/architecture.md`, `docs/testing.md` etc. have no activation signal — Claude won't know when to load them.
2. **Standalone gotcha files** – A `GOTCHAS.md` at the root has no activation signal. If it applies broadly, put it in CLAUDE.md; otherwise exclude.
3. **CLAUDE.md as linter** – Style rules in prose are expensive and unreliable. Use deterministic tools with auto-fix.
4. **Stale code snippets** – Inlined code goes stale. Use `file:line` pointers to the source of truth.
5. **Duplicating linter knowledge** – If ESLint, Prettier, or TypeScript enforce it, don't repeat it in prose.
6. **Bloated CLAUDE.md** – Area-specific details (component patterns, API conventions, debugging guides) don't belong in the universal context. Cut them.

## Alternative Mechanisms

Before adding content to CLAUDE.md, consider whether a deterministic tool handles it better:

- **Git hooks** – Run formatters/linters pre-commit; surface errors for Claude to fix
- **Linter configs** – Codify style as deterministic rules (ESLint, Stylelint, Prettier)
- **Type systems** – TypeScript, Zod schemas, Drizzle types enforce structure at compile time
- **CI checks** – Automated validation catches issues without consuming context budget
- **Claude Code hooks** – Post-generation commands that run formatters or validators
