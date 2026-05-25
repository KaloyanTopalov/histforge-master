# Centralize step → artifact path mapping

## Overview
Replace the hand-maintained `ownerStep()` switch in `src/lib/artifact-grouping.ts` with a single named rule table — `STEP_ARTIFACT_RULES` — that maps step slugs to path predicates, and add module-load cross-validation against `REAL_STEPS` so misspelled rule slugs fail at boot rather than silently sinking artifacts into "Other". Closes audit finding #2 from `docs/refactoring/solid-audit-2026-04-30.md` along recommendation (b) — "a clean staging point" — without coupling the dashboard's Next.js bundle to worker step modules.

## Current State

**Where the duplication lives**
- `src/lib/artifact-grouping.ts:37-76` — the inner `ownerStep(path)` function inside `groupArtifactsByStep` is an order-sensitive switch chain that hard-codes every step's output paths (`script/01_outline.md` → `research_outline`, `script/04_*` → `write_chapters`, `audio/narration.*` → `voiceover`, etc.). It also contains conditional provider-priority logic for `images/main/*` and `videos/hook/*` that picks comfyui-over-google_flow when both are theoretically registered (lines 55-62, 64-71).
- `src/worker/steps/*.ts` — each step's `Step.outputs` declaration already names its produced paths, but `outputs` is the *cleanup* contract (paths to delete on failure), not a complete enumeration of dashboard-visible artifacts. Several steps have `outputs: []` intentionally: `write_chapters` and `enrich_chunks` (atomic / in-place writers), `generate_main_images_google_flow` and `generate_hook_video_google_flow` (outputs land via webhook handlers), `cleanup` (delete-only). `outputs` cannot be repurposed as the source of truth; the rule-table needs its own.

**Pattern to mirror**
- `src/lib/image/index.ts:6-16` — `Record<name, Provider>` registry + `get<X>(name)` lookup that throws on miss. The provider trio (`image/`, `tts/`, `llm/`) all follow this shape.
- `src/worker/workflows/index.ts:30-65` — flat `readonly Workflow[]` registry + `getWorkflowById` lookup (returns null on miss). Each workflow declares its own ordered step slugs.
- `src/worker/steps/index.ts:50-66` — `validateWorkflowSteps(workflows, steps)` runs at module load and throws if a workflow references an unknown slug. This plan adds a sibling validator for the new rule table.

**Tests in scope**
- `__tests__/unit/lib/artifact-grouping.test.ts` — 13 cases covering omnibus mappings (lines 219-256), provider-variant priority (128-152), final.mp4-vs-render/ asymmetry (203-217), chunk creator-vs-mutator attribution (193-201), chapter pattern accumulation (44-59), logs pinned at top (114-126), unknown paths into Other (97-112), step-index-based ordering (168-191). All must continue to pass — the refactor is behavior-preserving.
- `__tests__/unit/worker/steps/` — convention is one test file per step; module-load validators are exercised implicitly today by importing `src/worker/steps/index.ts` from existing tests.

**Out-of-bundle constraint**
`src/lib/artifact-grouping.ts` is imported by the client component `src/app/videos/[id]/video-detail-client.tsx`, so it must remain free of worker-side imports (fs, db, paths). The rule table therefore lives in `lib/`, not in worker step files; the validator that cross-checks rule slugs against `REAL_STEPS` lives in `src/worker/steps/index.ts` (worker tier can import from lib, not vice-versa).

## Scope

**Doing**
- Centralize the step → path mapping into a `STEP_ARTIFACT_RULES` table in `src/lib/artifact-grouping.ts`.
- Refactor `groupArtifactsByStep` to walk the table instead of the inline switch chain.
- Add a module-load validator in `src/worker/steps/index.ts` that throws when any rule's `step` is not the name of a step in `REAL_STEPS`.
- Update / extend tests to cover the new validator. Existing artifact-grouping tests must pass unchanged.

**Not doing**
- Audit recommendation (a) — adding `produces: RegExp[]` (or `ownsArtifactPath`) to the `Step` interface and importing per-step matchers into the dashboard. That requires either bloating the Next.js client bundle with worker step modules or adding a parallel pure-data manifest under `src/worker/steps/` whose end-state is structurally identical to the lib-side table this plan lands. The audit explicitly calls (b) "a clean staging point"; if (a) becomes worthwhile later, the rule table is already the single source to migrate.
- Audit finding #3 — the broader modular split of `video-detail-client.tsx`. Separate plan.
- Audit finding #4 — the `humanizeStepName` regex hardcoding `_(comfyui|google_flow)`. Already mitigated by the inline comment at `src/lib/artifact-grouping.ts:3-8`; full registry-coupling is "low / small" and out of scope here.
- Touching `Step.outputs` semantics — that field's job is cleanup, and it stays.

## Tasks

### Phase 1: Rule table

- [x] **Task 1: Define `StepArtifactRule` and `STEP_ARTIFACT_RULES`**
  **Files**: `src/lib/artifact-grouping.ts`
  **What**: Add a `StepArtifactRule { step: string; match: (path: string) => boolean }` interface and a top-level `STEP_ARTIFACT_RULES: readonly StepArtifactRule[]` table with one entry per step that produces dashboard-visible artifacts. Coverage from the worker-step inventory: `research_outline`, `research_characters`, `write_hook`, `write_chapters` (matches `script/04_*` and `script/story_so_far.md`), `assemble_script`, `voiceover` (matches `audio/narration.*`), `align` (matches `alignment/*`), `chunk` (matches `chunks/*` — attributes the file to its creator even after `enrich_chunks` mutates it), `generate_main_images_comfyui`, `generate_main_images_google_flow`, `generate_hook_video_comfyui`, `generate_hook_video_google_flow`, `render` (matches `render/*` and the project-root `final.mp4`). Intentionally absent: `enrich_chunks` (mutates `chunks/chunks.json` in place — chunk creator owns the file) and `cleanup` (delete-only, produces no artifacts). The Phase 2 validator only checks rule → step direction, so this exclusion is silent — if a future producer step is added without a corresponding rule, its outputs sink into Other. Order rules so comfyui variants precede their google_flow siblings — preserves the existing comfyui-first priority when both are theoretically registered.
  **Context**: Replicate the cases at `src/lib/artifact-grouping.ts:37-75`. The provider-conflict on `images/main/*` and `videos/hook/*` (lines 55-62, 64-71) is naturally subsumed by the walk: only the rule whose step is in the workflow's step list will match. Keep a comment on the chapter rule explaining the brittle dependency on the `script/04_` prefix (the existing comment at line 42-44 captures this), and on the render rule explaining that `final.mp4` lives at the project root rather than under `render/` (existing comment at line 73-74).

- [x] **Task 2: Refactor `groupArtifactsByStep` to walk the rule table**
  **Files**: `src/lib/artifact-grouping.ts`
  **What**: Remove the inner `ownerStep(path)` function (lines 37-76) and replace with a walk against `STEP_ARTIFACT_RULES`. Lookup logic: (a) `path.endsWith(".log")` → `LOGS_GROUP_KEY`; (b) the first rule where `stepIndex.has(rule.step) && rule.match(path)` returns the rule's `step`; (c) no match → `OTHER_GROUP_KEY`. The rest of `groupArtifactsByStep` — the group accumulator at lines 78-91 and the sort at 93-103 — is unchanged.
  **Context**: Behavior must match the existing function for every input the test suite covers (`__tests__/unit/lib/artifact-grouping.test.ts`). Run that test file first; if any case fails, the rule table is wrong (likely an ordering issue or a missing pattern), not the lookup.

### Phase 2: Validation

- [x] **Task 3: Cross-validate rules against `REAL_STEPS` at module load**
  **Files**: `src/worker/steps/index.ts`
  **What**: Add `validateStepArtifactRules(rules, steps)` that throws if any `rule.step` is not the `name` of a step in `REAL_STEPS`. Call it unconditionally at module load alongside the existing `validateWorkflowSteps(listWorkflows(), REAL_STEPS)` call at line 66. Import `STEP_ARTIFACT_RULES` from `@/lib/artifact-grouping`.
  **Context**: Mirror the shape of `validateWorkflowSteps` at lines 50-66. The rationale parallels the workflow validator: a typo in the rule table doesn't fail loudly today — the path silently sinks into `OTHER_GROUP_KEY` — and surfacing the mistake at boot is consistent with how the project catches dangling slugs elsewhere. Validation runs in the worker tier only; the dashboard-side `lib/artifact-grouping.ts` stays pure.

### Phase 3: Tests

- [x] **Task 4: Confirm existing artifact-grouping tests pass unchanged**
  **Files**: `__tests__/unit/lib/artifact-grouping.test.ts`
  **What**: No edits expected — the refactor is behavior-preserving. Run the file. If any test fails, the rule table or walk has changed observable behavior; investigate before moving on.
  **Context**: Coverage is comprehensive (see "Tests in scope" above). The most likely break-points if the rule order or predicates are wrong: the omnibus mapping test (lines 219-256), the provider-variant tests (128-142, 154-166), the OTHER fallback for unowned `images/main/*` (144-152), and the chunk-creator-not-mutator attribution (193-201).

- [x] **Task 5: Add a validator test**
  **Files**: `__tests__/unit/worker/steps/validate-step-artifact-rules.test.ts` (new)
  **What**: Two cases — (a) `validateStepArtifactRules` is a no-op when every rule's `step` is the name of a step in the provided steps array; (b) it throws with a useful message identifying the bad slug when given a rule whose `step` is unknown.
  **Context**: Treat the validator as a pure function (no fs / db setup). Import directly from `@/worker/steps`. Keep the test file small and focused; the existing `__tests__/unit/worker/steps/research.test.ts` shows the harness conventions but most of that file's setup (in-memory db, temp dirs, settings seeding) is unnecessary here.

## References
- `docs/refactoring/solid-audit-2026-04-30.md:30-34` — finding #2 (the issue this plan addresses) and the (a)/(b) tradeoff text
- `src/lib/artifact-grouping.ts:37-76` — the `ownerStep` switch chain to be replaced
- `src/lib/artifact-grouping.ts:93-103` — the sort logic that stays
- `__tests__/unit/lib/artifact-grouping.test.ts` — behavior pin for the refactor
- `src/worker/steps/index.ts:50-66` — `validateWorkflowSteps` as the template for the new validator
- `src/worker/workflows/index.ts:30-65` — workflow registry pattern (registry + lookup + module-load validation)
- `src/lib/image/index.ts:6-16` — provider registry pattern (cross-referenced by the audit)
