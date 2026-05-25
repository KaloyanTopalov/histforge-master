# Domain Skills → CodeRLM Migration

## Overview

Replace the `domain-update`-driven volatile-references system with a permanent codebase index (CodeRLM) plus contract-scoped anchor names in domain skills. Eliminates the recurring token cost of regenerating `references/current-state.md`, removes the staleness window between refreshes, and lets Claude resolve named entities to current locations on demand instead of reading pre-built path catalogues.

## Current State

Eight domain skills currently follow a two-tier pattern: stable prose in `SKILL.md` plus auto-generated path/symbol catalogues in `references/current-state.md` produced by the `domain-update` skill. The catalogues drift between refreshes; the user has been spending tokens on `/domain-update` to keep them current.

**Skills in scope** (all under `.claude/skills/`):
- `domain-content-gen`
- `domain-dashboard`
- `domain-google-flow-coordinator`
- `domain-media`
- `domain-pipeline`
- `domain-workflow-drafts`
- `domain-workflows`
- `domain-youforge-flow`

**Management skills** (also affected):
- `domain-create` — currently teaches the Volatile References pattern; needs full rewrite.
- `domain-update` — entire skill becomes obsolete; delete.

**Existing `current-state.md` files** (six of eight — `domain-workflow-drafts` and `domain-google-flow-coordinator` were never refreshed):
- `.claude/skills/domain-content-gen/references/current-state.md`
- `.claude/skills/domain-dashboard/references/current-state.md`
- `.claude/skills/domain-media/references/current-state.md`
- `.claude/skills/domain-pipeline/references/current-state.md`
- `.claude/skills/domain-workflows/references/current-state.md`
- `.claude/skills/domain-youforge-flow/references/current-state.md`

**`## Volatile References` blocks present in eight `SKILL.md` files** (`domain-create/SKILL.md:135`, `domain-content-gen/SKILL.md:101`, `domain-dashboard/SKILL.md:199`, `domain-google-flow-coordinator/SKILL.md:138`, `domain-media/SKILL.md:151`, `domain-pipeline/SKILL.md:157`, `domain-workflow-drafts/SKILL.md:131`, `domain-workflows/SKILL.md:94`, `domain-youforge-flow/SKILL.md:172`).

**"Read references/current-state.md" pointer lines** present in nine `SKILL.md` files (every skill above plus `domain-create/SKILL.md:125`).

**External references to the old system**: none — `grep -r "domain-update\|current-state.md\|Volatile References"` outside `.claude/skills/` returns only historical mentions in `docs/plans/archive/` and `docs/refactoring/` (frozen artifacts, no need to touch).

**`CLAUDE.md` Project Skills table**: already excludes `domain-update` and `domain-create` (verified via the system-loaded copy in this session), so no edit needed there for skill-table accuracy. Add a one-liner about CodeRLM as the live codebase index for future reference.

## Scope

**Doing**:
- Install and verify CodeRLM (manual prerequisite).
- Rewrite `domain-create/SKILL.md` to teach the new "anchors only for the area's contract" contract and CodeRLM-driven authoring.
- Add a contract-scoped `## Anchors` section to each of the eight domain skills.
- Strip file-path locators, the `## Volatile References` block, and the "Before making changes, read references/current-state.md" pointer line from each domain skill body.
- Delete `.claude/skills/domain-update/` and all `references/current-state.md` files (plus the now-empty `references/` directories).
- Add a short note to `CLAUDE.md` explaining that CodeRLM is the project's live codebase index and that domain skills no longer carry file paths.
- Spot-check `domain-pipeline` end-to-end as the prototype before mass-applying.
- Verify with grep that no residual references to the removed artifacts remain in `.claude/`.

**Not doing**:
- Building or installing CodeRLM (the user does this manually before Phase 1 — see Phase 0).
- Changing skill prose substance (architecture, design rationale, pitfalls). Only the locator/structural blocks change.
- Migrating archived plans or refactoring docs that reference the old system.
- Adding the optional `/domain-verify` drift-check skill (Option C from the discussion). Defer until drift is observed in practice.
- Touching `domain-create`'s sibling skills (`init`, `tdd`, etc.) — out of scope.

## Tasks

### Phase 0: Prerequisite — install CodeRLM (user, manual)

- [x] **Task 0: Build the server, install the plugin, verify health**
  **Files**: none (operator action)
  **What**: User runs `cd coderlm/server && cargo build --release`, starts the daemon, runs `claude /plugin marketplace add JaredStewart/coderlm` then `claude plugin install coderlm`, and confirms `curl http://127.0.0.1:3000/api/v1/health` returns `{"status":"ok"}` and `/coderlm` is visible in a fresh Claude Code session.
  **Context**: Phase 1 onwards depends on CodeRLM being available so the rewritten `domain-create` workflow can use indexed lookups during Step 4. If install fails, pause the migration — do not fall back to file-path catalogues.

### Phase 1: Rewrite `domain-create`

- [x] **Task 1: Replace Volatile References machinery with the Anchors contract in `domain-create/SKILL.md`**
  **Files**: `.claude/skills/domain-create/SKILL.md`
  **What**: Rewrite the skill so it produces Option-B-shaped domain skills. Concretely:
  - Frontmatter description: drop the "alongside domain-update" framing.
  - Body intro (around current line 9): describe domain skills as stable knowledge plus a contract-scoped Anchors section, with CodeRLM as the live index.
  - Guardrails (currently lines 39–44): replace `## Volatile References` / `scan_paths` rules with the Anchors contract — *anchors only get names that are part of the area's contract; internal helpers stay in prose; never include file paths, line numbers, function signatures, column lists, version numbers, or config default values in the body*.
  - Workflow Step 4 (currently lines 78–95): replace "From CLAUDE.md and dir listings, pick 5–10 files" with CodeRLM-driven discovery (`search`, `structure`, `callers` to map the domain). Include a fallback note: if the daemon isn't running, fall back to manual reads.
  - Workflow Step 5 (currently lines 97–101): drop the `/domain-update` reminder; optionally remind to confirm CodeRLM has indexed the project.
  - Skill Structure block (currently lines 103–149): drop `references/current-state.md` from the directory layout; replace the Volatile References template with an Anchors template.
  - "Volatile References Categories" subsection (currently lines 159–186): delete entirely; replace with a short "What belongs in Anchors" subsection that lists the contract test (does a developer in this domain talk about it by name?) and the trap names to keep out of Anchors (private helpers, internal state details).
  - Quality Checks (currently lines 190–200): rewrite — anchors are contract-only; no file paths / line numbers / signatures / column lists / version numbers / config defaults in the body; descriptions are action-oriented; pitfalls explain why; no duplicate coverage.
  **Context**: This is the source-of-truth for the new pattern — every other rewrite below should match its template. Treat the rewrite as the spec, the prototype skill (Phase 2) as the worked example. Keep the skill's overall structure (Precondition → Core Principles → Guardrails → Workflow → Skill Structure → Writing Good Descriptions → Quality Checks) so the diff is recognizable.

### Phase 2: Prototype with `domain-pipeline`

- [x] **Task 2: Convert `domain-pipeline/SKILL.md` to the Anchors shape and pause for review**
  **Files**: `.claude/skills/domain-pipeline/SKILL.md`
  **What**:
  - Insert a `## Anchors` section after the description, before `## Architecture`.
  - Anchor scope (the area's contract — verify each name is something a developer working in pipeline orchestration *talks about by name*):
    - **Worker boundary**: `runPipeline`, `runLoop`, `REAL_STEPS`, `validateWorkflowSteps`, `getWorkflowById`, `resolveDeps`, `resetStaleRunningSteps`
    - **Step contract**: `Step`, `StepContext`, `RunPipelineDeps`
    - **DB tables**: `videos`, `video_steps`
    - **Behavior-driving columns**: `videos.status`, `videos.paused`, `videos.delete_requested`, `videos.current_step`, `videos.started_at`
    - **Settings keys**: `queue_state`, `llm_provider`, `tts_provider`, `image_provider`
    - **Env vars**: `PROJECTS_DIR`
    - **Repos**: `videosRepo`, `stepsRepo`
  - Remove file paths used as locators in the body (e.g. `worker/index.ts` → "the worker entry point"; `worker/runner.ts` → "the runner"; `worker/pipeline.ts` → "the orchestrator"; `worker/steps/` → "step modules"; `src/lib/repos/` → "the repository layer"). Symbol names stay in prose.
  - Delete the "Before making changes in this area, read [references/current-state.md]" line at `domain-pipeline/SKILL.md:22`.
  - Delete the `## Volatile References` section (currently lines 157–179, end of file).
  - Pause and prompt the user to review before proceeding to Phase 3.
  **Context**: This is the worst-case skill (largest, most anchor-heavy). If this one fits cleanly under the new contract the others will too. The rewrite must preserve all architectural prose and pitfalls verbatim — only locator-style text changes.

### Phase 3: Apply Anchors shape to remaining domain skills

Each task below converts one skill: insert `## Anchors`, strip path-locators, delete the "Before making changes, read…" line, delete the `## Volatile References` block. Anchor lists below are **starting suggestions** — finalize each by verifying every entry passes the contract test ("does a developer in this domain talk about it by name?") before committing.

- [x] **Task 3: Convert `domain-workflows/SKILL.md`**
  **Files**: `.claude/skills/domain-workflows/SKILL.md`
  **What**: Apply the Anchors shape. Suggested anchors: `Workflow` interface, `getWorkflowById`, `listWorkflows`, `validateWorkflowSteps`, `REAL_STEPS`, `workflow_id` column.
  **Context**: Pointer line at line 14, Volatile References at line 94. Cross-references with `domain-pipeline` exist (e.g. "the registry side" mention) — keep those textual references intact; they don't carry paths.

- [x] **Task 4: Convert `domain-workflow-drafts/SKILL.md`**
  **Files**: `.claude/skills/domain-workflow-drafts/SKILL.md`
  **What**: Apply the Anchors shape. Anchor candidates likely include the drafts API route paths, the import helper name, the 409-overwrite helper name, the on-disk layout root (`prompts/workflows/`).
  **Context**: Pointer line at line 14, Volatile References at line 131. Verify anchor candidates by reading the skill body before finalizing the list.

- [x] **Task 5: Convert `domain-dashboard/SKILL.md`**
  **Files**: `.claude/skills/domain-dashboard/SKILL.md`
  **What**: Apply the Anchors shape. Anchor candidates: top-level page route names, the settings module exports (Zod schema names, `getSetting`/`setSetting`), key API route paths, the SQLite schema entry points.
  **Context**: Pointer line at line 20, Volatile References at line 199. Largest API surface — be deliberate about contract vs. internal helpers.

- [x] **Task 6: Convert `domain-content-gen/SKILL.md`**
  **Files**: `.claude/skills/domain-content-gen/SKILL.md`
  **What**: Apply the Anchors shape. Anchor candidates: prompt loader/interpolator function names, the LLM client entry, the chapter-writer's atomic-write strategy name, prompt template categories (by name, not file path).
  **Context**: Pointer line at line 23, Volatile References at line 101.

- [x] **Task 7: Convert `domain-media/SKILL.md`**
  **Files**: `.claude/skills/domain-media/SKILL.md`
  **What**: Apply the Anchors shape. Anchor candidates: TTS provider registry names, image provider registry names, alignment entry function, render entry function.
  **Context**: Pointer line at line 21, Volatile References at line 151. The existing `current-state.md` flagged a stale `google_flow_profile_path` setting — verify that detail isn't carried into the anchor list.

- [x] **Task 8: Convert `domain-google-flow-coordinator/SKILL.md`**
  **Files**: `.claude/skills/domain-google-flow-coordinator/SKILL.md`
  **What**: Apply the Anchors shape. Anchor candidates: the queue/account/webhook function names that form the dumb-runner contract, the reaper entry, the per-(video, account) project-mapping function, settings keys for the Google Flow fleet.
  **Context**: Pointer line at line 18, Volatile References at line 138. No existing `current-state.md` to consult — read the skill body and `app/api/flow/` symbols via CodeRLM to nail anchors.

- [x] **Task 9: Convert `domain-youforge-flow/SKILL.md`**
  **Files**: `.claude/skills/domain-youforge-flow/SKILL.md`
  **What**: Apply the Anchors shape. Anchor candidates: service-worker module names, the flow-api wrapper exports, `chrome.storage` keys, model-matrix identifier, HistForge webhook payload type names.
  **Context**: Pointer line at line 20, Volatile References at line 172. Lives outside the main TS source tree (under `extensions/youforge-flow/`) — make sure CodeRLM has that subtree indexed.

### Phase 4: Delete dead artifacts

- [x] **Task 10: Delete the `domain-update` skill**
  **Files**: `.claude/skills/domain-update/` (entire directory, including `SKILL.md`)
  **What**: Remove the skill definition and any helper files inside its directory.
  **Context**: The skill is referenced only inside `.claude/skills/` (its own files plus the soon-to-be-stripped Volatile References blocks). After Phase 1 + Phase 3 strip those references, deleting this directory is safe. Verify with `grep -r "domain-update" .claude/` returning zero hits afterward.

- [x] **Task 11: Delete generated `current-state.md` files and empty `references/` directories**
  **Files**:
  - `.claude/skills/domain-content-gen/references/current-state.md`
  - `.claude/skills/domain-dashboard/references/current-state.md`
  - `.claude/skills/domain-media/references/current-state.md`
  - `.claude/skills/domain-pipeline/references/current-state.md`
  - `.claude/skills/domain-workflows/references/current-state.md`
  - `.claude/skills/domain-youforge-flow/references/current-state.md`
  - Plus each enclosing `references/` directory (will be empty after the file deletion).
  **What**: Remove the auto-generated catalogues and their parent directories.
  **Context**: After Phase 3 removes the "Read references/current-state.md" pointer lines, nothing in the skills should link here. Confirm no skill body still references `current-state.md` before deleting.

### Phase 5: CLAUDE.md note + verification

- [x] **Task 12: Add CodeRLM note to `CLAUDE.md`**
  **Files**: `CLAUDE.md`
  **What**: Add one short line under either the "Key Conventions" section or a new "Tooling" subsection stating that CodeRLM is the live codebase index used by domain skills, so domain skills do not carry file paths or symbol locations — query CodeRLM instead.
  **Context**: The Project Skills table already excludes `domain-update` (only the eight domain skills + `tdd` are listed), so no table edits are needed. Keep the note short — one or two sentences. Place it where future-you will find it when wondering why skills don't have paths anymore.

- [x] **Task 13: Final grep verification**
  **Files**: none (verification only)
  **What**: Run two greps:
  - `Grep "domain-update|current-state\.md|Volatile References"` scoped to `.claude/` — should return zero hits.
  - `Grep "Volatile References|references/current-state.md"` scoped to repo root excluding `docs/plans/archive/` and `docs/refactoring/` — should return zero hits in live skill files.
  Report any residual hits and resolve them before marking the migration complete.
  **Context**: Frozen historical mentions in `docs/plans/archive/2026-04-17-solid-audit-01-06.md` and `docs/refactoring/solid-audit-2026-04-17.md` are expected and acceptable — those are archived snapshots, not live documentation.

## References

- Discussion log of this conversation (Option B contract, anchor scoping rules, drift profile).
- `.claude/skills/domain-create/SKILL.md` — current state, baseline for Phase 1 rewrite.
- `.claude/skills/domain-pipeline/SKILL.md` — prototype target (Phase 2), worst-case skill.
- `CLAUDE.md` — Project Skills table (already excludes the management skills; only needs the CodeRLM note).
- CodeRLM project: https://github.com/JaredStewart/coderlm
