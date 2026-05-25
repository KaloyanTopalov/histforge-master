---
name: claude-md
description: Create, update, and optimize CLAUDE.md files. Use when a user asks to create a CLAUDE.md, improve an existing CLAUDE.md, review a CLAUDE.md, sync project skills into CLAUDE.md, or set up Claude Code for a project. Also use when creating .claude/CLAUDE.md or any variant of project-level Claude instructions.
disable-model-invocation: true
---

# CLAUDE.md Manager

Create and maintain an effective, compact CLAUDE.md containing only universal project instructions that are needed in most sessions — including an up-to-date catalog of project skills.

## Content Triage

Use the triage checklist in [references/principles.md](references/principles.md) to decide what belongs in CLAUDE.md. The key question: **"Is this needed in most sessions?"** If yes → include. If area-specific, enforced by tooling, or discoverable from docs → exclude.

## Workflow

1. **Analyze the project** — Explore the repo in this priority order:
   - `package.json` / `pyproject.toml` / `Cargo.toml` (stack, scripts, dependencies)
   - Existing `CLAUDE.md` or `.claude/` directory (prior context setup)
   - Top-level directory structure (`ls src/`, `ls services/`, etc.)
   - Entry points and routers (e.g., `src/app/`, `main.py`, `index.ts`)
   - CI config (`.github/workflows/`, `.gitlab-ci.yml`)
   - Linter/formatter configs (`.eslintrc`, `ruff.toml`, `prettier.config`)
   - Git hooks (`.husky/`, `.pre-commit-config.yaml`)
2. **Read principles** — Load [references/principles.md](references/principles.md) for the full triage checklist, anti-patterns, and alternative mechanisms
3. **Scan project skills** — Find all skills by scanning `.claude/skills/*/SKILL.md`. All skills live at this single level (e.g., `claude-md`, `create-plan`, `domain-chat-rag`, `domain-admin-users`). Extract the `name` and `description` from each skill's YAML frontmatter. This data is used for both the Project Skills section and Troubleshooting nudge lines.
4. **Determine scope** — New file vs improving existing. See the improvement workflow below for existing files
5. **Draft CLAUDE.md** — Consult [references/example-full.md](references/example-full.md) for structure and tone (pick the example closest to the project's stack), then draft using universal instructions only, following the structure template below
6. **Apply inclusion test** — For each CLAUDE.md line: "Is this needed in most sessions?" If no, cut it.
7. **Validate** — Run the quality checks at the bottom of this file

## CLAUDE.md Placement

Place `CLAUDE.md` at the **repository root** by default — this is the standard location Claude Code looks for. Use `.claude/CLAUDE.md` only if the project already uses a `.claude/` directory for other config. Both locations work, but don't create both — pick one.

For monorepos, a root CLAUDE.md covers the whole repo. Avoid nested CLAUDE.md files per service.

## CLAUDE.md Structure

Target: <150 lines for most projects. Large monorepos or multi-service projects may need up to 250 lines if every line passes the inclusion test — but try to hit 150 first and only expand if genuinely universal content doesn't fit. Order sections by relevance frequency:

```
# CLAUDE.md

## Project Overview        <- 1-2 sentences: what, why, stack

## Development Commands    <- install, dev, build, test, lint (copy-pasteable)

## Architecture            <- directory tree, key patterns, entry points

## Key Conventions         <- non-obvious rules, schema workflows, naming

## Project Skills          <- auto-generated catalog from .claude/skills/

## Branch Strategy         <- branch model, deployment flow

## Constraints             <- a11y, browser/runtime versions, API versioning, data privacy, performance budgets (if applicable)

## Troubleshooting         <- nudge lines pointing to relevant skills
```

### Project Skills Section

Scan all skill locations (see step 3 in Workflow) and build the skills catalog. For each skill found, read its YAML frontmatter and extract `name` and `description`. List them as a table:

```markdown
## Project Skills

| Skill | Description |
|-------|-------------|
| `create-plan` | Creates implementation plans for complex tasks. Use when a task needs multiple steps, touches many files, or will span multiple sessions. |
| `implement-plan` | Implements tasks from a plan file, one at a time. Reads the plan, finds the next unchecked task, does the work, commits, and checks it off. |
| `claude-md` | Create, update, and optimize CLAUDE.md files. |
```

Rules for the skills catalog:
- **Exclude slash-command-only skills** — if a skill's frontmatter contains `disable-model-invocation: true`, skip it. These are user-invoked slash commands that the model cannot access, so listing them in CLAUDE.md adds noise with no benefit.
- Include every other skill found across all scan paths
- Use the `name` field from frontmatter as the skill name
- Use the `description` field from frontmatter, but truncate to the first 1-2 sentences if it's very long (keep it scannable)
- Sort alphabetically by skill name
- When updating an existing CLAUDE.md, replace the entire Project Skills section with a fresh scan — this ensures removed or renamed skills don't linger

### Troubleshooting Nudge Lines

If the project has skills, add a one-line pointer for each in CLAUDE.md's Troubleshooting section so Claude knows where to look:

```markdown
## Troubleshooting
- Chat/streaming issues: Use the `domain-chat-rag` skill for AI SDK streaming patterns and RAG pipeline details
- Database/auth issues: Use the `domain-supabase-auth` skill for schema, RLS, and auth flow details
- Admin panel issues: Use the `domain-admin-users` skill for user management and config patterns
```

## Improving an Existing CLAUDE.md

When the user has an existing CLAUDE.md that needs improvement:

1. **Read the existing file first** — understand what's already there before changing anything
2. **Identify bloat** — look for content that fails the inclusion test: area-specific patterns, linter-enforceable rules, inlined code snippets, tutorial content
3. **Identify gaps** — check for missing dev commands, missing architecture overview, missing branch strategy, missing or outdated Project Skills section
4. **Triage each section** — apply the inclusion test to every block of content. Cut anything that isn't needed in most sessions.
5. **Refresh the skills catalog** — always rescan all skill locations (see step 3 in Workflow) and regenerate the Project Skills section, even if the user only asked for minor edits. Skills change frequently and the catalog should stay current.
6. **Preserve project-specific pitfalls** — common gotchas and non-obvious workflows are high-value content. Keep them if they apply broadly, cut if area-specific.
7. **Show the user what changed** — summarize what was kept and what was removed (and why)

## Content Rules

For detailed include/flag/exclude guidance, see the triage checklist and anti-patterns in [references/principles.md](references/principles.md). The short version:

- **Include:** Universal project knowledge needed most sessions (commands, architecture, branch strategy, critical constraints, project skills catalog, troubleshooting nudge lines)
- **Exclude:** Area-specific patterns, linter-enforceable rules, tutorial content, stale code snippets, anything discoverable from error messages or docs

## Examples

See [references/example-full.md](references/example-full.md) for two complete CLAUDE.md examples (Node.js API and Python monorepo). Consult this during drafting to match the expected structure and tone.

## Quality Checks

Before finalizing, verify:
- [ ] CLAUDE.md < 150 lines (up to 250 for large monorepos if every line passes inclusion test)
- [ ] Every CLAUDE.md line passes: "Needed in most sessions?"
- [ ] No area-specific knowledge inlined (cut it)
- [ ] Project Skills section is present and matches all skills found across scan paths
- [ ] Troubleshooting section has nudge lines for existing skills (if any exist)
- [ ] No linter-replaceable content anywhere
- [ ] No inlined code snippets that will go stale
- [ ] Commands are copy-pasteable
- [ ] No standalone `docs/` or `agent_docs/` directories proposed

## Prohibited

- Creating standalone `docs/` or `agent_docs/` directories for Claude context
- Inlining area-specific gotchas that aren't needed in most sessions
- Duplicating linter/type-system knowledge in prose
- Manually curating the skills list — always scan all skill locations for the source of truth
