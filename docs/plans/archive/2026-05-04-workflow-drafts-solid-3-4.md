# Workflow-drafts SOLID refactor — items #3 & #4

## Overview
Two seam-fix items from `docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md`. #4 moves `buildDetail`, `toApiSummary`, `WorkflowApiSummary`, `WorkflowApiDetail` out of the GET-route file `src/app/api/workflows/route.ts` so other routes and server pages stop depending on a route handler's exports. #3 hoists the duplicated `DraftRow` wire-format type into the same shared module so the GET response and its sole client consumer share one source of truth.

## Current State

**#4 — `buildDetail`/`toApiSummary` exported from a route file (5 route imports + 1 server-page import + 2 type-only consumers + 1 stale comment)**
- `src/app/api/workflows/route.ts:18-76` — `WorkflowApiSummary` (interface, JSDoc at lines 10-17), `toApiSummary` (mapper, lines 35-55), `WorkflowApiDetail` (interface, lines 57-59), `buildDetail` (DB-aware mapper using `workflowsRepo.findById` + `findStepsByWorkflow`, JSDoc at lines 61-65, body lines 66-76).
- `route.ts` itself uses both internally: `toApiSummary` at line 90 (GET handler), `buildDetail` at line 151 (POST handler).
- Import sites:
  - `src/app/api/workflows/[id]/route.ts:8` — `buildDetail` (relative `../route` — only site using `..`)
  - `src/app/api/workflows/[id]/reset/route.ts:5` — `buildDetail`
  - `src/app/api/workflows/[id]/clone/route.ts:5` — `buildDetail`
  - `src/app/api/workflows/import/route.ts:8` — `buildDetail`
  - `src/app/api/workflows/drafts/[filename]/import/route.ts:20` — `buildDetail`
  - `src/app/workflows/page.tsx:4` — `toApiSummary` (server page)
  - `src/app/workflows/workflows-table.tsx:37` — `WorkflowApiSummary` (type-only; consumed in five places in that file)
  - `__tests__/components/workflows/workflows-table.test.tsx:19` — `WorkflowApiSummary` (type-only)
- Stale prose after move: `src/app/api/workflows/[id]/export/route.ts:14` — `(toApiSummary in `../route.ts`)`.

**#3 — `DraftRow` declared twice with no compile-time link**
- `src/app/api/workflows/drafts/route.ts:16-29` — server-side definition shaping the GET response. Used by `parseDraft` return type (line 31), the `rows: DraftRow[]` accumulator (line 98), and the `NextResponse.json(rows)` body (line 105).
- `src/app/workflows/drafts-section.tsx:26-39` — client copy used as `useState<DraftRow[]>` (line 70), the fetch response cast (line 86), `onImport(row: DraftRow)` (line 112), `DraftTableRow` prop (line 309), `ProvidersCell` prop `DraftRow["providers"]` (line 384).
- Hand-identical: same five fields, same nested `providers` shape (script/tts/image/video), same `errors: string[]`. No re-export connecting them — a route-side rename or nullability tweak would only blow up at runtime on the client.

## Scope

**Doing**:
- Create `src/lib/workflows-api.ts`. Move the four #4 exports there with their JSDoc preserved.
- Update all eight reference sites + the stale comment to point at the new module.
- Add `DraftRow` (and its inner providers shape) to the same `workflows-api.ts`. Remove both private copies.
- Verification: `npm run lint`, `npm run test`, `npm run build` must pass.

**Module home decision (audit Option (c), not pre-listed)**: `src/lib/workflows-api.ts` rather than `src/app/api/workflows/_shared.ts` (audit's Option (b)). Rationale: sibling files `workflows-import.ts`, `workflows-schema.ts`, `workflows-validator.ts` already live under `src/lib/` and operate on `db: DatabaseType`; one home for all workflow wire-shape helpers. The four moved exports use `workflowsRepo` and a `Database` instance — same dependency profile as the existing `workflows-*.ts` cluster. After Phase 1 lands this is also a natural home for `DraftRow`, which the audit left in two locations (a) `src/types.ts` or (b) a co-located `_shared.ts`; co-locating it with the rest of the workflow API shapes is cleaner than either.

**Touch surface tally**: 9 sites total — 5 route imports, 1 server-page import, 1 client type-only import, 1 test type-only import, 1 stale JSDoc parenthetical (Phase 1) + 2 duplicate `DraftRow` declarations replaced by the canonical one (Phase 2).

**Skill update not required**: grepped `.claude/skills/domain-workflow-drafts/SKILL.md` and `.claude/skills/domain-workflows/SKILL.md` for `buildDetail`, `toApiSummary`, `WorkflowApiSummary`, `WorkflowApiDetail`, `DraftRow` — zero matches in either skill's anchors block, body prose, or frontmatter. The neighbouring plan at `docs/plans/2026-05-03-workflow-drafts-solid-1-2.md` Task 1.5 had to update the workflow-drafts skill because the FS-helper *path* `src/lib/workflows-import.ts` was named in the description's trigger list; the symbols this plan moves are not named anywhere in the skills, and no path-trigger change is needed (the new `workflows-api.ts` doesn't carry a domain skill home).

**Not doing** (separate items in the same audit):
- #1, #2 — already landed on this branch (see `docs/plans/2026-05-03-workflow-drafts-solid-1-2.md`).
- #5 import-error decoder, #6 `DraftsSection` size, #7 `DRAFT_FILENAME_RE` duplication.
- The cross-domain `ConfirmDialog` move flagged in the audit's "Cross-domain observation".

**Phase ordering**: Phase 1 must precede Phase 2 because Phase 2 adds `DraftRow` to the file Phase 1 creates. The two phases otherwise have no shared touch points and can be reviewed independently.

## Tasks

### Phase 1: Move `buildDetail`/`toApiSummary` out of `route.ts` (#4)

- [x] **Task 1.1: Create `src/lib/workflows-api.ts`**
  **Files**: `src/lib/workflows-api.ts` (new), `src/app/api/workflows/route.ts`
  **What**: Move the four exports (`WorkflowApiSummary`, `toApiSummary`, `WorkflowApiDetail`, `buildDetail`) from `route.ts:18-76` to the new module. Preserve the JSDoc block above `WorkflowApiSummary` (lines 10-17) and the one above `buildDetail` (lines 61-65) — both explain non-obvious choices (camelCase boundary intent, post-mutation re-read pattern). Re-import them in `route.ts` for use at line 90 (GET) and line 151 (POST). Remove the original definitions. Do **not** re-export from `route.ts` — re-exports defeat the SRP separation the audit calls for.
  **Context**: The new module's import header mirrors `route.ts:1-8`: `import type { Database as DatabaseType } from "better-sqlite3";` and `import * as workflowsRepo from "@/lib/repos/workflows";` and `import type { WorkflowRow } from "@/types";`. Sibling style references: `src/lib/workflows-schema.ts`, `src/lib/workflows-import.ts`, `src/lib/workflows-validator.ts` — same DB-aware shape. `buildDetail` calls `workflowsRepo.findById` and `workflowsRepo.findStepsByWorkflow`; `toApiSummary` is pure mapping over `WorkflowRow`.

- [x] **Task 1.2: Update API route imports (five sites)**
  **Files**: `src/app/api/workflows/[id]/route.ts`, `src/app/api/workflows/[id]/reset/route.ts`, `src/app/api/workflows/[id]/clone/route.ts`, `src/app/api/workflows/import/route.ts`, `src/app/api/workflows/drafts/[filename]/import/route.ts`
  **What**: Switch each `buildDetail` import to `@/lib/workflows-api`. These are runtime value imports (the function is invoked) — keep them as plain `import { buildDetail }`, not `import type`. The `[id]/route.ts:8` site uses a relative `../route` — replace with the alias path so all five sites use the same style.
  **Context**: `import/route.ts` and `drafts/[filename]/import/route.ts` already pull `IMPORT_ERROR_STATUS`, `ImportError`, `importWorkflowJson` from `@/lib/workflows-import` — keep the same alias style for the new import.

- [x] **Task 1.3: Update server-page + client + test imports**
  **Files**: `src/app/workflows/page.tsx`, `src/app/workflows/workflows-table.tsx`, `__tests__/components/workflows/workflows-table.test.tsx`
  **What**: Switch `toApiSummary` (page.tsx:4) and `WorkflowApiSummary` (workflows-table.tsx:37, workflows-table.test.tsx:19) to `@/lib/workflows-api`. The two type-only sites use `import type` today — preserve that.
  **Context**: `workflows-table.tsx` uses `WorkflowApiSummary` in five places (props, state, two state-machine variants, patch helper, fetch response cast at line 104). All resolve through the single import line — one edit covers them all.

- [x] **Task 1.4: Update stale prose reference**
  **Files**: `src/app/api/workflows/[id]/export/route.ts`
  **What**: In the JSDoc at lines 9-21, update only the parenthetical at line 14 — change ``(toApiSummary in `../route.ts`)`` to ``(toApiSummary in `@/lib/workflows-api`)``. Do not rewrite the surrounding sentence; it correctly contrasts this route's snake_case export shape against the camelCase API boundary.
  **Context**: Documentation correctness only. The export route does not import the moved symbols — JSDoc reference only.

- [x] **Task 1.5: Verification gate for Phase 1**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, `npm run build`. All three must pass. Acceptance check: searching for `from "../route"` or `from "@/app/api/workflows/route"` across `src/` and `__tests__/` returns zero matches — the audit's "no consumer reaches into a route file" success condition.
  **Context**: `npm run build` exercises both the Next.js bundle and the worker's `tsc-alias` post-compile pass — catches stale alias references that lint/test might miss.

### Phase 2: Hoist `DraftRow` to the shared module (#3)

- [x] **Task 2.1: Add `DraftRow` to `src/lib/workflows-api.ts`**
  **Files**: `src/lib/workflows-api.ts`
  **What**: Add the `DraftRow` interface (filename, slug, label, providers, stepCount, mtime, errors) and its inner providers shape, both exported. Sit them next to the other wire-format types added in Phase 1.
  **Context**: Both private copies are byte-identical between `drafts/route.ts:16-29` and `drafts-section.tsx:26-39` — same five fields, same nested providers, same `errors: string[]`. Do not change shape; every field is consumed by the client today (`ProvidersCell` reads all four `providers.*`; `DraftTableRow` checks `errors.includes("invalid_json")` and `errors.includes("missing_fields")`).

- [x] **Task 2.2: Switch the GET route to the shared type**
  **Files**: `src/app/api/workflows/drafts/route.ts`
  **What**: Remove the local `DraftRow` (lines 16-29). Import it from `@/lib/workflows-api`. `parseDraft`'s return annotation (line 31), the `rows: DraftRow[]` accumulator (line 98), and the `NextResponse.json(rows)` body (line 105) all resolve through the new import.
  **Context**: `SERVER_CONTROLLED_KEYS` (line 8) and `DRAFT_FILENAME_RE` (line 6) stay where they are — `DRAFT_FILENAME_RE` duplication is finding #7, deliberately out of scope here.

- [x] **Task 2.3: Switch the client section to the shared type**
  **Files**: `src/app/workflows/drafts-section.tsx`
  **What**: Remove the local `DraftRow` (lines 26-39). Add `import type { DraftRow } from "@/lib/workflows-api";` next to the existing imports. The five consumer sites (`useState<DraftRow[]>` line 70, fetch cast line 86, `onImport(row: DraftRow)` line 112, `DraftTableRow` prop line 309, `DraftRow["providers"]` line 384) resolve through the new import.
  **Context**: Other local types in this file (`ValidationWarning`, `ImportSuccessBody`, `ZodIssue`, `ImportErrorBody`, `DiscardConfirm`) are finding #5 / file-local concerns — leave them.

- [x] **Task 2.4: Verification gate for Phase 2**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, `npm run build`. All three must pass. Phase 2 adds a new export and changes two import sites — the type graph is materially different from Phase 1, so the build must run again. Acceptance checks: (a) searching `src/` for any `DraftRow` declaration (regex `(interface|type)\s+DraftRow\b`) returns exactly one match — the canonical one in `src/lib/workflows-api.ts`; (b) searching `src/app/api/workflows/drafts/route.ts` and `src/app/workflows/drafts-section.tsx` for `DraftRow` shows only references, no local declarations.
  **Context**: Phase 2 is wire-shape consolidation, not runtime behavior change — but the new export is consumed by both server and client code, so `npm run build` (Next.js bundle + worker `tsc-alias`) is the regression net.

## References
- `docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md` — finding #3 (lines 41-46), finding #4 (lines 49-53), priority action plan (lines 79-92).
- `docs/plans/2026-05-03-workflow-drafts-solid-1-2.md` — companion plan covering #1 and #2 (already landed on this branch).
- `src/lib/workflows-import.ts`, `src/lib/workflows-schema.ts`, `src/lib/workflows-validator.ts` — sibling-style references for the new `workflows-api.ts` module.
