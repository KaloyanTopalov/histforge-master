---
name: domain-create
description: Create and update domain skills that capture area-specific codebase knowledge. Use when the user wants to create new domain skills, update existing ones after architectural changes, or reorganize how project knowledge is structured into skills. Triggers on requests like "create skills for this project", "update project knowledge", "add a skill for the payments area", or "reorganize project skills".
disable-model-invocation: true
---

# Domain Create

Create and maintain domain skills — area-specific guides that capture architectural patterns, design decisions, workflows, and pitfalls for different parts of the codebase. Domain skills live in `.claude/skills/` with a `domain-` prefix (e.g., `domain-chat-rag`, `domain-admin-users`). Each skill pairs stable prose with a contract-scoped `## Anchors` section — names a developer working in that area would Grep for to start work.

## Precondition

This skill requires an existing CLAUDE.md at the project root (or `.claude/CLAUDE.md`). CLAUDE.md provides the project map — architecture tree, conventions, stack — that this skill uses to decide domain boundaries without a full codebase sweep.

If no CLAUDE.md exists, stop and tell the user to run `/claude-md` first. Don't try to compensate by exploring the entire codebase — that approach won't converge and will time out.

## Core Principles

### Stable Knowledge Only

Domain skills contain **stable knowledge** — information that doesn't change unless the architecture or design decisions change:
- Architectural patterns and their rationale
- Design decisions and the "why" behind them
- Workflows and processes
- Common pitfalls and how to avoid them
- Conventions specific to an area

Locator detail (paths, line numbers, signatures, column lists, version numbers, defaults) does not belong in a domain skill — see Guardrails below.

### Group by Developer Activity

Group skills around **what a developer is doing**, not around technologies or file types:

Good: `domain-chat-rag` (working on chat and RAG), `domain-admin-users` (admin panel work), `domain-supabase-auth` (database and auth)
Bad: `typescript-rules`, `sql-conventions`, `react-patterns`

Each skill should map to a natural area of work where a developer would spend a focused session.

## Guardrails

- **Anchors are an index, not a catalogue.** The block is a list of grep targets a downstream model uses to find the right place to start work. If a name in `## Anchors` wouldn't be a useful starting point for a Grep, it's prose. Aim for **~15–25 anchors** per skill; past 30 is the split signal (see *When a skill grows past the cap*).
- **Anchors are contract-only.** Each name must be something a developer working in this area talks about by name (a public function, type, table, settings key, env var, route, registry slug). Internal helpers and private implementation details belong in prose, not anchors.
- **No locator detail anywhere in the markdown.** No file paths, line numbers, function signatures, column lists, version numbers, or config default values — neither in prose nor inside the anchors block. Anchors are resolved against the current codebase on demand; baking locator detail into the skill is what the old catalogue-based approach did, and the staleness it produced is the reason this design exists.
- **Reference cross-skill machinery by sibling skill name.** When mentioning structures owned by another domain skill (e.g., "the workflow registry — see `domain-workflows`"), name the sibling so future readers know where the canonical guidance lives. Don't substitute a directory path.
- **Common Pitfalls is a short list, not an index.** Aim for **~5–7 items**; hard cap at 10. Each item must be (a) counter-intuitive — the obvious approach is wrong, (b) cross-cutting — it constrains code in multiple files or layers, (c) not restating prose from a section above, and (d) stable across refactors — the *why* outlasts the specific symbol or column. Items that fail any of these are either prose (move them into the relevant section) or code comments (write them at the call site, not in the skill).
- **Never modify `CLAUDE.md`** — that's outside this skill's scope.

## Workflow

### Step 1: Read the project map (bounded — don't explore beyond this list)

Read these sources in this order. This is everything you need to propose domain boundaries — don't read additional files yet.

1. **CLAUDE.md** — Architecture tree, key conventions, stack, existing skills catalog, troubleshooting section. This is the primary source for understanding the project shape.
2. **`package.json`** (or `pyproject.toml` / `Cargo.toml`) — Dependencies reveal frameworks and libraries, which hint at natural domain boundaries (e.g., a Supabase dependency suggests a database/auth domain, an AI SDK dependency suggests a chat/RAG domain).
3. **Top-level directory listing** — List the main source directories mentioned in CLAUDE.md's architecture section (e.g., `ls app/`, `ls components/`, `ls lib/`). One level deep only, not recursive. This confirms what CLAUDE.md describes and reveals any new directories it doesn't mention.

### Step 2: Check existing domain skills (frontmatter only)

Scan `.claude/skills/domain-*/SKILL.md` (excluding `domain-create`). For each skill, read only the **YAML frontmatter** (name + description) and the **section headings** (`## ...` lines). This is enough to understand each skill's scope.

Don't read full skill bodies or assess content accuracy — that's wasted work at this stage.

Note:
- What areas existing skills cover
- Obvious gaps (new features or subsystems not covered by any skill)
- Skills that might need merging or splitting based on how the project has evolved

### Step 3: Propose domain boundaries (checkpoint — wait for user)

Based on steps 1-2, propose which domains to create or update. Present the list with a one-line rationale for each:

- **New domain:** "`domain-X` — covers [area]. Needed because [reason]."
- **Update existing:** "`domain-X` — scope is still valid but needs [what changed]."
- **Merge/split:** "`domain-X` — suggest splitting into [A] and [B] because [reason]."
- **Remove:** "`domain-X` — area no longer exists in the project."

**Wait for user confirmation before proceeding.** The user might want different boundaries, different names, or want to prioritize certain domains. Don't start writing until they approve.

### Step 4: Map each domain, then write (one domain at a time)

Process each confirmed domain sequentially. For each one, map the area, then write the skill before moving to the next.

**For each domain:**

**a. Map the domain.** Discover the area's contract surface and how its pieces connect. Grep candidate anchor names project-wide to confirm they're referenced from outside their own module — names with no external callers usually fail the contract test and belong in prose, not anchors.

**b. Look for what code alone doesn't tell you** — While reading, surface:
- Architectural patterns whose rationale isn't apparent from a single file
- Design decisions where the "why" matters because real alternatives exist
- Multi-step workflows (e.g., "edit X, then run Y, then update Z")
- Pitfalls — things that look straightforward but have non-obvious consequences
- Conventions specific to this area that a newcomer would miss

**c. Write the SKILL.md** — Follow the Skill Structure section below. Lead with the `## Anchors` block (the area's contract surface), then the prose that explains the "why" behind patterns. The code already describes "what" — the skill should explain why things are the way they are, what goes wrong if you do it differently, and what the non-obvious workflows are.

**d. Move on** — Don't go back and revise previous skills during this pass. The user can iterate later.

### Step 5: Wrap up

After all domains are written, remind the user to run `/claude-md` if new skills were created or existing ones renamed/removed, so the Project Skills catalog and Troubleshooting nudge lines stay in sync.

## Skill Structure

```
.claude/skills/domain-<skill-name>/
  SKILL.md                        # Stable knowledge + Anchors block
  <supporting>.md                 # Optional supporting docs live alongside SKILL.md, not in a subfolder
```

### SKILL.md Template

```markdown
---
name: domain-<skill-name>
description: <action-oriented description of when to use this skill>
---

# <Skill Title>

## Anchors

<!-- Worked example:
       - **Worker boundary**: `runPipeline`, `runLoop`, `REAL_STEPS`, `validateWorkflowSteps`
       - **Step contract**: `Step`, `StepContext`, `RunPipelineDeps`
       - **DB tables**: `videos`, `video_steps`
       - **Behavior-driving columns**: `videos.status`, `videos.paused`, `videos.delete_requested`
       - **Settings keys**: `queue_state`, `llm_provider`, `tts_provider`, `image_provider`
       - **Env vars**: `PROJECTS_DIR`
-->

- **<Group name>**: `name1`, `name2`, `name3`
- **<Group name>**: `name1`, `name2`

## Architecture
<High-level description of how this area is structured.>

## <Area-Specific Patterns>
<Design decisions, workflows, conventions specific to this area.
Explain the "why" — this is the most valuable part.>

## Common Pitfalls
<Non-obvious gotchas. Things that have caused bugs or confusion.
Explain why each pitfall exists and how to avoid it.>
```

### Writing Good Descriptions

Descriptions determine when Claude loads the skill. Write them as action-oriented sentences that specify both what the skill covers and when to use it:

**Good:** "Guide for building chat UI, streaming responses, and the RAG pipeline. Use when modifying chat components, AI SDK integration, embedding/retrieval logic, or the chat API route."

**Bad:** "Redis, caching, TTL, pub/sub, rate limiting" (keyword list — no activation signal)

### What belongs in Anchors

**The grep test:** for each candidate name, ask *"would a downstream model open this skill, then Grep for this name to start work?"* If yes, it's an anchor. If the name is only ever encountered while reading prose around it (and nobody would search for it cold), it's prose.

The grep test is sharper than the older "does a developer talk about it by name?" test, because it forces you to imagine the *consumer's* first action, not just the area's vocabulary. A name a developer mentions in standup but never types into Grep doesn't earn an anchor.

Names that usually pass:
- **Public functions and types** other modules import — orchestrators, registries, factory functions, the shape of a context object that crosses module boundaries.
- **Tables and behavior-driving columns** — column names that flip behavior (status enums, soft-delete flags, denormalized progress columns), not every column on the table.
- **Routes** — HTTP method + path of endpoints other code or operators call.
- **Settings keys and env vars** — string keys that change behavior at runtime.
- **Cross-module identifiers** — registry slugs, workflow ids, provider names other modules look up by string.

Names that almost always fail:
- **Private helpers** that only one file calls — locally scoped, not part of the area's contract.
- **Internal state details** — React hook return shapes, context internal fields, intermediate variable names, the per-step ordering of helper calls.
- **Implementation-detail tables or columns** — bookkeeping rows nobody outside the storage layer touches, columns no consumer reads conditionally.
- **Test fixtures and helpers** — relevant inside the test suite, not part of the production surface.
- **Sibling-skill names** (e.g., `domain-workflows`) — they belong in prose where you point readers to the canonical guidance, not in the anchors block. Anchors are code identifiers, not documentation cross-references.

When in doubt, grep the name project-wide. A name with callers only inside its own file is internal; a name called from across the area (or from outside it) is a contract anchor.

### When a skill grows past the cap

If your anchor block has more than ~30 names — or has more than ~6 semantic groups, or its `## Architecture` section needs subsections that explain unrelated concerns — the area is two skills wearing one hat. See `splitting.md` for how to cluster anchors by developer activity, name the resulting sub-skills, redistribute prose, and re-apply the grep test.

## Quality Checks

Before finalizing, verify:
- [ ] Each skill is grouped by developer activity, not technology
- [ ] Each skill has a `## Anchors` section that names every contract-relevant entity a developer in the area would Grep for to start work
- [ ] **Anchor count is ~15–25**, grouped semantically into ~3–6 groups (Routes, Settings keys, DB tables, Public exports, etc.). Past 30 names or 6 groups is a split signal — see *When a skill grows past the cap*
- [ ] Every anchor passes the grep test — names a downstream model wouldn't search for don't appear
- [ ] No file paths, line numbers, function signatures, column lists, version numbers, or config default values appear anywhere in the body or in the anchors block
- [ ] Descriptions are action-oriented sentences, not keyword lists
- [ ] Common pitfalls explain the "why", not just the "what"
- [ ] Common Pitfalls has ~5–7 items (hard cap 10), each counter-intuitive, cross-cutting, non-redundant, and stable across refactors. Tactical/code-level items are pushed into prose or into source-code comments
- [ ] Cross-skill references name the sibling skill (e.g., "see `domain-workflows`") rather than pointing at a directory
- [ ] No duplicate coverage between skills
