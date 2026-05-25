---
name: create-plan
description: Creates implementation plans for complex tasks. Use when a task needs multiple steps, touches many files, or will span multiple sessions.
disable-model-invocation: true
argument-hint: "[what you want to build or change]"
---

# Create Plan

Create a persistent implementation plan that `/implement-plan-tdd` can execute task by task. The plan file is the contract between planning and implementation — it survives across sessions, tracks progress with checkboxes, and gives the implementer exact file references for each task.

Use this when a task is too big to do in one shot. For small changes, just do them directly.

## Initial Response

If `$ARGUMENTS` provided, read any referenced files and begin immediately.

If no arguments:
```
What would you like to plan? Describe the feature, change, or refactor.

Example: /create-plan Add WebSocket support to the notification system
```

## Process

### 1. Investigate

Understand the codebase before planning. Use codebase-locator and codebase-analyzer agents in parallel to find relevant files and understand existing patterns. Read the key files they identify.

Then present what you found and ask focused questions — only things your research couldn't answer (design preferences, priority calls, constraints you can't infer from code).

### 2. Align on approach

If there are meaningful design choices, present options with trade-offs. Get the user's input before writing the plan. For straightforward tasks, skip this — just confirm the approach and proceed.

### 3. Write the plan

Save to `docs/plans/YYYY-MM-DD-description.md` using the template below. Describe WHAT and WHY, never HOW to code it — reference existing patterns by file:line instead.

### 4. Review

```
Plan saved to `docs/plans/YYYY-MM-DD-description.md`

Run `/implement-plan-tdd docs/plans/YYYY-MM-DD-description.md` to start.
```

Iterate if the user wants changes.

## Plan Template

This structure is what `/implement-plan-tdd` reads. The **Files Affected** and **Key Considerations** fields on each task are critical — the implementer reads those files before starting work.

```markdown
# [Feature Name]

## Overview
[2-3 sentences: what and why]

## Current State
[Key files, existing patterns, constraints — with file:line references]

## Scope
**Doing**: [what's included]
**Not doing**: [what's explicitly excluded]

## Tasks

### Phase 1: [Name]

- [ ] **Task 1: [Name]**
  **Files**: `path/to/file.ext`
  **What**: [Outcome required]
  **Context**: [Pattern to follow — file:line reference, edge cases]

- [ ] **Task 2: [Name]**
  **Files**: `path/to/file.ext`
  **What**: [Outcome required]
  **Context**: [Pattern to follow — file:line reference, edge cases]

### Phase 2: [Name]
[Same structure]

## References
- [file:line or link]
```

## Guidelines

- **Investigate first** — read the code before planning. Every task should have real file:line references, not guesses.
- **WHAT and WHY, not HOW** — no code snippets. The implementer decides the approach.
- **Slice phases vertically, not horizontally** (where applicable) — each phase should deliver one end-to-end capability (DB → API → UI for a single feature), not one layer across all features. Vertical slices produce working software at every phase, so design issues surface before lower layers calcify and the user can redirect cheaply. Horizontal slicing is fine for genuinely infrastructural work — schema-only migrations, library refactors with no behavior change.
- **Don't create separate phases for unit tests** — `/implement-plan-tdd` writes unit tests inline per task via the RED→GREEN→REFACTOR cycle, so a "write all the tests" phase is both redundant and a horizontal slice in disguise. End-to-end or integration tests that exercise behavior no single task owns *do* earn their own phase (or a final task within the last feature phase) — call those out explicitly when needed.
- **Keep it lean** — include only phases/tasks that are needed. One phase is fine for simple work.
- **Adapt to the project** — discover conventions from CLAUDE.md or equivalent. Don't assume any tech stack.
- **No open questions** — research or ask before writing. The plan must be actionable.
