---
name: implement-plan-tdd
description: Implements tasks from a plan file using test-driven development. Reads the plan, finds the next unchecked task, writes tests first (red-green-refactor), commits, and checks it off.
disable-model-invocation: true
argument-hint: "[plan-path] [task-number]"
---

# Implement Plan (TDD)

Pick up a plan created by `/create-plan` and implement the next task using test-driven development. Every task goes through the RED-GREEN-REFACTOR cycle. You do the work directly — no delegating implementation to subagents.

## Getting Started

1. Parse `$ARGUMENTS` for plan path and optional task number
2. If no plan path, list available plans: `ls docs/plans/`
3. Read the plan completely
4. Detect the project's test runner and test file conventions (look at package.json, existing test files, config files like vitest.config, jest.config, pytest.ini, etc.)
5. Find the next unchecked task (`- [ ]`), respecting phase and task order
6. Present what you're about to do:
   ```
   Next: Phase {N}, Task {M} — {description}
   Test runner: {detected runner}
   Test location: {detected convention}
   Proceeding.
   ```

**Phase boundaries are hard stops.** When you finish the last task of a phase, end your turn after the phase wrap-up (see [Phase Boundaries](#phase-boundaries)). Do not start the next phase in the same response, even if the plan looks straightforward. The user uses phase boundaries to review work, catch drift, and decide whether the plan still makes sense before more code is built on top. One-shotting a multi-phase plan defeats that — it's the single most important rule in this skill.

## Per Task

### 1. Read Context

- Read files listed in the task's **Files** field
- Read any patterns referenced in **Context** (file:line)
- Check CLAUDE.md for project conventions
- Look at existing tests near the affected files to understand patterns

### 2. Identify Behaviors to Test

Before writing any code, briefly state (for your own reasoning and as a short status update to the user — not as a question) the behaviors you plan to test:

```
Task: {task description}

Behaviors to test:
1. {behavior} — {why it matters}
2. {behavior} — {why it matters}
3. {behavior} — {why it matters}

Proceeding to write tests and implement.
```

Think about what the public interface looks like and which behaviors are most important. Focus testing effort on critical paths and complex logic, not every edge case. Identify opportunities for [deep modules](deep-modules.md) — small interface, deep implementation. Design interfaces for [testability](interface-design.md).

**Do not wait for approval.** This is your own design decision — state it and move on. The user can interrupt if they disagree. Jump straight into the tracer-bullet cycle below.

### 3. TDD: When Applicable

Most tasks benefit from TDD. Use the RED-GREEN-REFACTOR cycle:

#### Incremental Loop

For each behavior from your list:

```
RED:   Write test → review mocks → run tests → fails
GREEN: Minimal code to pass → run tests → passes
```

The first cycle is your tracer bullet — it proves the path works end-to-end before you build more on top.

Rules:
- One test at a time — vertical slices, never horizontal
- Only enough code to pass the current test
- Don't anticipate future tests
- Keep tests focused on observable behavior through public interfaces
- Tests describe WHAT the system does, not HOW it does it

#### Mock Review

After writing each test, before running it, apply the **import-path test** to every mock declaration:

- Resolves to a project file (`@/`, `./`, `../`, `~/`, `src/`, or any project-local alias)? It's internal — remove the mock.
- Resolves to an npm package (lives in `node_modules`)? It can be a legitimate boundary mock.

If removing an internal mock is straightforward, fix it immediately. If the test was designed around the mock and needs a fundamentally different approach, pick the best alternative and proceed.

See [mocking.md](mocking.md) for the full rule, the common rationalizations to resist (wrapper modules around external services, UI components in jsdom), and patterns for designing mockable interfaces. See [tests.md](tests.md) for good-vs-bad test examples.

### Test File Location

All tests go in `__tests__/` at the project root — **never colocated** next to source files. Mirror the source structure inside it.

```
__tests__/
  unit/         # mirrors lib/, worker/, or any non-route source dirs
  api/          # mirrors app/api/ or any HTTP route layer (if present)
  components/   # mirrors components/ — UI tests (if present)
  helpers/      # shared test utilities
```

Use the project's path alias when importing source code (e.g., `import { foo } from "@/lib/foo"`). If the project has no alias configured, fall back to whatever convention `tsconfig.json` (or equivalent) defines.

**Anti-pattern: horizontal slices.** DO NOT write all tests first, then all implementation. This produces tests that verify imagined behavior rather than actual behavior. Each test should respond to what you learned from the previous cycle.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
```

#### Refactor

After all tests pass for this task, look for [refactor candidates](refactoring.md):

- Duplication → extract function/class
- Long methods → break into private helpers (keep tests on public interface)
- Shallow modules → combine or deepen
- Feature envy → move logic to where data lives
- Primitive obsession → introduce value objects
- What the new code reveals about existing code
- Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

### 4. When TDD Doesn't Apply

Some tasks don't produce testable code — SQL migrations, config file edits, style changes, documentation, static asset additions. For these:

- Note that you're skipping TDD and why:
  ```
  Skipping TDD for this task — {reason, e.g., "SQL migration, no testable interface"}
  ```
- Implement directly, following existing patterns
- Still run the full test suite to catch regressions

### 5. Verify

Run the project's full test suite. Check for:

- **New tests pass** — the ones you just wrote
- **Existing tests still pass** — no regressions

If existing tests broke, **stop and report** using the format in [troubleshooting.md](troubleshooting.md#broken-existing-tests). Do not auto-fix broken existing tests — wait for the user.

### 6. Commit

```bash
git add {specific files — implementation + tests}
git commit -m "$(cat <<'EOF'
feat({scope}): {task description}

Phase {N}, Task {M}
EOF
)"
```

### 7. Check Off

Edit the plan: `- [ ]` → `- [x]` for the completed task.

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] No internal modules/components mocked (only system boundaries)
[ ] Code is minimal for this test
[ ] No speculative features added
[ ] Full test suite passes
[ ] If this was the last task in the phase: stop after commit + check-off. Do not begin the next phase in this turn.
```

## Phase Boundaries

After the last task in a phase, do a cross-task scan + mock audit, then emit the pause block, then **end your turn**. Do not start the next phase in the same response — the user must explicitly tell you to proceed.

See [phase-boundaries.md](phase-boundaries.md) for the cross-task scan checklist, mock-audit procedure, the cleanup commit format, and the exact pause template.

## When the Plan Is Wrong

Plans are snapshots. If reality doesn't match, stop and report using the format in [troubleshooting.md](troubleshooting.md#plan-doesnt-match-reality). Wait for the user — don't guess.

## Resuming

If the plan has existing checkmarks, trust them. Start from the first unchecked task.

## Rules

- **One task at a time** — finish it fully before moving on
- **TDD by default** — skip only when genuinely not applicable
- **One test at a time** — vertical slices, never write all tests first
- **No scope creep** — don't fix unrelated things
- **No subagents for implementation** — research agents are fine for context
- **Follow project conventions** — check CLAUDE.md
- **State, don't ask — about test design only** — when deciding what behaviors to test within a task, announce your plan and proceed; don't fish for approval on design calls the user can interrupt. This does **not** apply to phase boundaries, plan mismatches, or broken existing tests — those are explicit pause points covered above.
- **Apply SOLID principles where natural** — single-responsibility units, dependency inversion, and interface segregation make code easier to test; the existing pointers to [deep-modules](deep-modules.md) and [interface-design](interface-design.md) cover the testability angle. Skip when the code is procedural and the principles would only add ceremony.
