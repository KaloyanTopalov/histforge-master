---
name: tdd
description: Test-driven development with red-green-refactor loop. Use when user wants to build features or fix bugs using TDD, mentions "red-green-refactor", wants integration tests, or asks for test-first development.
---

# Test-Driven Development

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Test File Location

All tests go in `__tests__/` at the project root — **never colocated** next to source files.

```
__tests__/
  api/          # API route tests (mirrors app/api/)
  components/   # Component tests (mirrors components/)
  unit/         # Unit tests (mirrors lib/)
    ai/
    config/
    chat/
    rag/
    supabase/
    utils/
  helpers/      # Shared test utilities
```

- **API route tests** → `__tests__/api/{route-path}/route.test.ts`
- **Component tests** → `__tests__/components/{category}/{component}.test.tsx`
- **Unit tests** (lib/) → `__tests__/unit/{module}/{file}.test.ts`
- Import source code using `@/` aliases (e.g., `import { foo } from "@/lib/rag/retrieve"`)

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test → one implementation → repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

```
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED→GREEN: test1→impl1
  RED→GREEN: test2→impl2
  RED→GREEN: test3→impl3
  ...
```

## Workflow

### 1. Planning

Before writing any code, think through (do not ask the user):

- [ ] What interface changes are needed
- [ ] Which behaviors are most important to test (prioritize)
- [ ] Identify opportunities for [deep modules](deep-modules.md) (small interface, deep implementation)
- [ ] Design interfaces for [testability](interface-design.md)
- [ ] List the behaviors to test (not implementation steps)

**You can't test everything.** Focus testing effort on critical paths and complex logic, not every possible edge case. Decide for yourself which behaviors matter most and proceed — do not pause to get approval on the plan. Jump straight into the tracer-bullet cycle below.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

```
RED:   Write test for first behavior → review mocks → test fails
GREEN: Write minimal code to pass → test passes
```

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

```
RED:   Write next test → review mocks → fails
GREEN: Minimal code to pass → passes
```

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

#### Mock Review

After writing each test, before running it, review every mock declaration using this test:

**The import-path test:** Does the import resolve to a file in the project repository? (Paths starting with `@/`, `./`, `../`, `~/`, `src/`, or any project-local alias.) If yes — it's internal, remove the mock. If it resolves to an npm package in `node_modules` (e.g., `@supabase/supabase-js`, `ai`, `next/navigation`) — it can be a legitimate boundary mock.

This is a bright line. Two common rationalizations to resist:

1. **"It wraps an external service"** — A project file like `lib/supabase/server` or `lib/ai/provider` may create or configure an external client, but it's still project code. Mock the npm package it uses internally, not the wrapper. The wrapper's logic (error handling, configuration, connection setup) is exactly what your tests should exercise.

2. **"The UI component needs browser APIs unavailable in jsdom"** — A project UI component like `components/ui/dialog` may depend on an npm library that uses portals or positioning. In practice, most render fine in jsdom with testing-library. Try rendering it real first. If it truly fails in the test environment, mock the npm package (e.g., `@radix-ui/react-dialog`), not your project's wrapper component.

If removing an internal mock is straightforward, fix it immediately. If the test was designed around the mock and needs a fundamentally different approach, flag it to the user with a proposed alternative.

### 4. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- [ ] Extract duplication
- [ ] Deepen modules (move complexity behind simple interfaces)
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

### 5. Mock Audit

After refactoring, scan every test file written or modified during this cycle. Apply the import-path test to every mock declaration: if the import resolves to a project file, it's internal — remove it and mock the npm package it depends on instead. Run tests to confirm after each fix.

If any violations were found, report a brief summary:
```
Mock audit: {N} internal mocks found and fixed in {files}
```

## Checklist Per Cycle

```
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] No internal modules/components mocked (only system boundaries)
[ ] Code is minimal for this test
[ ] No speculative features added
```
