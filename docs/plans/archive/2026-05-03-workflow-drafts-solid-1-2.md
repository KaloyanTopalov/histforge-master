# Workflow-drafts SOLID refactor — items #1 & #2

## Overview
Address findings #1 and #2 from `docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md`. #1 splits `src/lib/workflows-import.ts` into a DB-import module and a drafts-FS module, and co-locates the `ImportError.code → HTTP status` mapping. #2 extracts the duplicated overwrite-confirm dialog state + JSX from the two import surfaces into a hook that lives next to `runImport`.

## Current State

**#1 — `src/lib/workflows-import.ts` (158 lines, two unrelated halves)**
- DB-import (lines 1-123): `ImportStatus`, `ImportResult`, `ImportErrorCode`, `ImportError`, `importWorkflowJson`. Block-comment header at line 12 documents only this concern.
- FS layout (lines 125-158): `getPromptsRoot`, `getDraftsDir`, `getImportedDir`, `ensureDraftsDirs`, `DRAFT_FILENAME_RE` (line 152), `validateDraftFilename`. Separator comment at line 125.
- Five consumers (one mixes both halves):
  - `src/app/api/workflows/import/route.ts:3` — DB only.
  - `src/app/api/workflows/drafts/route.ts:4` — FS only (also re-declares `DRAFT_FILENAME_RE` at line 6 — finding #7 territory, do **not** address here).
  - `src/app/api/workflows/drafts/[filename]/route.ts:4-9` — mixed.
  - `src/app/api/workflows/drafts/[filename]/import/route.ts:9-16` — mixed.
  - `__tests__/unit/lib/workflows-import.test.ts` — both halves (FS tests at lines 221-296 use dynamic `await import("@/lib/workflows-import")`).
- Two routes inline an identical `err.code === "invalid_input" ? 400 : 409` ternary: `import/route.ts:18` and `drafts/[filename]/import/route.ts:60`.

**#2 — Overwrite-confirm dialog duplicated in two client files**
- `src/app/workflows/drafts-section.tsx` — `OverwriteConfirm` type at lines 63-67; state at line 80; `setOverwriteConfirm({ slug, resolve, busy: false })` inside `onConflict` at line 137-143; post-resolve `setOverwriteConfirm(null)` at line 150; dialog JSX at lines 303-321.
- `src/app/workflows/workflows-table.tsx` — `OverwriteConfirm` type at lines 45-49; state at line 77; `onConflict` setter at line 245; post-resolve cleanup at line 250; dialog JSX at lines 460-477. Note `destructive` prop **is** set here (line 465); not set in drafts-section.
- Helper they share: `src/app/workflows/use-import-with-overwrite.ts` — `runImport({ post, onConflict })`, no UI/state.
- Wording already drifts: drafts-section says *"Workflow \"X\" already exists. Overwrite it with the imported draft?"*; workflows-table says *"A workflow with id \"X\" already exists. Overwrite it with the imported file?"*. The audit lists this as the leading symptom.
- The lifecycle invariant: `onConfirm` sets `busy: true` and resolves `true`; the dialog stays mounted with the spinner through the retry POST; the *caller* drops it via `setOverwriteConfirm(null)` after `runImport` returns. Both files implement this manually.

## Scope

**Doing**:
- Split `workflows-import.ts` into a DB module (existing path) and a new `src/lib/workflows-drafts-fs.ts`.
- Add an `IMPORT_ERROR_STATUS: Record<ImportErrorCode, number>` table next to `ImportError`; switch both import routes to use it.
- Update all five consumers and the test file to import from the correct module.
- Update the `description` frontmatter field of `.claude/skills/domain-workflow-drafts/SKILL.md` (this is what the harness uses for trigger matching) and any body prose that names `workflows-import.ts` as the home of the FS helpers.
- Extract a `useOverwriteConfirm` hook (or `<OverwriteConfirmDialog />` component) co-located with `runImport` in `src/app/workflows/use-import-with-overwrite.ts`. The hook owns the `OverwriteConfirm` state, exposes a `requestConfirm` API for `onConflict`, renders the dialog itself, and bakes in the busy-retain-through-retry-POST lifecycle. `runImport`'s exported signature does **not** change — the hook composes on top.
- Wire both `drafts-section.tsx` and `workflows-table.tsx` through the hook; remove their local `OverwriteConfirm` types, state, dialog blocks.
- After each phase lands: `npm run lint`, `npm run test`, and (Phase 1 only) `npm run build` must pass before the phase is considered done.

**Module dependency direction (#1)**: FS module may import from DB-import module; the reverse is forbidden. Re-exporting FS helpers *from* `workflows-import.ts` is forbidden — defeats the SRP split. The one cross-module dependency is `validateDraftFilename` reaching for an error class (decided in Task 1.1 below).

**User-visible side effect (#2)**: the overwrite-confirm dialog wording on the drafts surface changes when the hook lands (a single shared message replaces the two divergent ones). Acceptable per audit's "drift has begun" framing, but flagged here so it's not a surprise.

**Not doing** (called out in audit, separate items):
- #3 `DraftRow` hoist, #4 `buildDetail` move, #5 import-error decoder, #6 `DraftsSection` size, #7 `DRAFT_FILENAME_RE` duplication. (Note: after Phase 1, #7's recommended home — `workflows-drafts-fs.ts` — exists, so #7 becomes a one-touch follow-up.)
- A broader copywriting pass on dialog text beyond the single shared overwrite-confirm message.
- The cross-domain `ConfirmDialog` move out of `@/app/videos/` flagged in the audit's "Cross-domain observation" section.

## Tasks

### Phase 1: Split workflows-import.ts (#1)

- [x] **Task 1.1: Create `src/lib/workflows-drafts-fs.ts`**
  **Files**: `src/lib/workflows-drafts-fs.ts` (new), `src/lib/workflows-import.ts`
  **What**: Move `getPromptsRoot`, `getDraftsDir`, `getImportedDir`, `ensureDraftsDirs`, `DRAFT_FILENAME_RE`, `validateDraftFilename` to the new module. `getPromptsRoot` must remain a function (env-read at call time, **not** a module-load const) — tests inject `HISTFORGE_PROMPTS_DIR` after module import, see `__tests__/unit/lib/workflows-import.test.ts:227-230` and SKILL.md §"Positive patterns". For the `validateDraftFilename` error class, keep `ImportError` / `ImportErrorCode` as the shared error type (callers across two import routes `instanceof ImportError`-check, and `invalid_filename` is one of those codes by contract); the FS module imports `ImportError` from `./workflows-import`. This is the only allowed cross-module reference, and it points FS → DB-import (the safe direction per the dependency rule in Scope).
  **Context**: Block comment at `workflows-import.ts:125-134` documents the FS concern verbatim — move it with the code. Leave DB half (lines 1-123) in place.

- [x] **Task 1.2: Add `IMPORT_ERROR_STATUS` and consolidate inlined status ternaries**
  **Files**: `src/lib/workflows-import.ts`, `src/app/api/workflows/import/route.ts`, `src/app/api/workflows/drafts/[filename]/import/route.ts`
  **What**: Export `IMPORT_ERROR_STATUS: Record<ImportErrorCode, number>` next to `ImportError` (`invalid_input → 400`, `workflow_id_exists → 409`, `invalid_filename → 400`). Replace `err.code === "invalid_input" ? 400 : 409` at `import/route.ts:18` and `drafts/[filename]/import/route.ts:60` with `IMPORT_ERROR_STATUS[err.code]`.
  **Context**: Audit's "optional bonus" — adding a fourth `ImportErrorCode` should be a one-line edit, not a two-place find-and-replace.

- [x] **Task 1.3: Update route consumers' imports**
  **Files**: `src/app/api/workflows/drafts/route.ts`, `src/app/api/workflows/drafts/[filename]/route.ts`, `src/app/api/workflows/drafts/[filename]/import/route.ts`
  **What**: Move FS-helper imports to `@/lib/workflows-drafts-fs`. Keep `ImportError` (and `importWorkflowJson` / `IMPORT_ERROR_STATUS` where used) on `@/lib/workflows-import`. `import/route.ts` and `drafts/route.ts` need single-module imports each; the two mixed routes need both.
  **Context**: Existing import groupings are visible at `drafts/[filename]/route.ts:4-9` and `drafts/[filename]/import/route.ts:9-16`. No re-exports from `workflows-import.ts` (per the dependency rule in Scope). Acceptance check: `import/route.ts` should no longer transitively pull any FS helper — confirm with `grep -E "drafts-fs|getDraftsDir|ensureDraftsDirs" src/app/api/workflows/import/route.ts` returning zero matches.

- [x] **Task 1.4: Update test imports**
  **Files**: `__tests__/unit/lib/workflows-import.test.ts`
  **What**: Switch the FS-helper dynamic imports (lines 221-296: `getPromptsRoot`, `getDraftsDir`, `getImportedDir`, `ensureDraftsDirs`, `validateDraftFilename`) to `@/lib/workflows-drafts-fs`. The DB-import tests above stay on `@/lib/workflows-import`. `validateDraftFilename`'s `ImportError` cross-import is still under `@/lib/workflows-import` (see Task 1.1).
  **Context**: All FS imports are dynamic (`await import(...)`) — safer for the env-var manipulation pattern at line 207-219; preserve that style.

- [x] **Task 1.5: Update domain-workflow-drafts skill**
  **Files**: `.claude/skills/domain-workflow-drafts/SKILL.md`
  **What**: Edit the YAML frontmatter `description:` field (this is what the harness uses for trigger matching) so the path-trigger list includes `src/lib/workflows-drafts-fs.ts` alongside the existing `src/lib/workflows-import.ts`. Anchors block (line 12) names symbols, not paths — leave symbol names as-is. In body prose, update any sentence that names `workflows-import.ts` as the home of FS helpers (`getPromptsRoot`, `getDraftsDir`, `getImportedDir`, `ensureDraftsDirs`, `validateDraftFilename`, `DRAFT_FILENAME_RE`) to point at the new module.
  **Context**: Skill is loaded whenever a matching path is touched; the new module needs its own trigger entry. Frontmatter edit is functional, body edit is documentation-correctness.

- [x] **Task 1.6: Verification gate for Phase 1**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, and `npm run build`. All three must pass. The test file changes from Task 1.4 are the highest-risk surface — confirm the FS-helper tests (`__tests__/unit/lib/workflows-import.test.ts:221-296`) still pass under the new module path.
  **Context**: `npm run build` covers both the Next.js bundle and the worker `tsc-alias` pass — catches stale `@/lib/workflows-import` references that lint/test might miss.

### Phase 2: Extract useOverwriteConfirm hook (#2)

- [x] **Task 2.1: Add hook + dialog to `use-import-with-overwrite.ts`**
  **Files**: `src/app/workflows/use-import-with-overwrite.ts`
  **What**: Add a `useOverwriteConfirm()` hook that owns `OverwriteConfirm` state (currently typed at `drafts-section.tsx:63-67` and `workflows-table.tsx:45-49`) and renders `<ConfirmDialog>` itself. Pick a shared dialog message that reads naturally for both the file-picker and the drafts surface — neutral phrasing referencing the workflow id, no draft- or file-specific wording. Enable `destructive` styling on the dialog (workflows-table sets it today, drafts-section does not — overwrite is destructive; prefer the stronger styling for both).

  Hook API (decide on one of these two shapes during implementation; both encapsulate the lifecycle correctly, plan does not pre-pick):
  - `requestConfirm` returns a richer object — e.g. `{ proceed: boolean, release: () => void }` — where `proceed: true` means the dialog is still mounted with `busy: true` for the retry POST, and the caller invokes `release()` (or equivalent) once `runImport` returns to unmount.
  - `requestConfirm` returns `Promise<boolean>` and the hook auto-unmounts when the consumer signals completion via a separate `endRequest()` / disposable returned alongside.

  The non-negotiable invariants (today implemented manually in both consumers, must be baked into the hook):
  1. On user-cancel: dialog unmounts immediately, promise resolves `false`.
  2. On user-confirm: dialog stays mounted with `busy: true` through the retry POST so the user sees the spinner; promise resolves `true` immediately so `runImport` can issue the second POST.
  3. After `runImport` returns (cancelled or otherwise), the dialog is unmounted exactly once. No path leaves the dialog mounted.

  **Context**: Imports `ConfirmDialog` from `@/app/videos/confirm-dialog` (same source the two consumers use today). The hook must be `"use client"`. The lifecycle is implemented at `drafts-section.tsx:146-150` and `workflows-table.tsx:248-251` — read both before designing the API. `runImport`'s exported signature does **not** change (separate concern, not a fork — see SKILL.md §"Positive patterns": *"`runImport` is correctly framework-agnostic and caller-driven"*).

- [x] **Task 2.2: Switch `DraftsSection` to the hook**
  **Files**: `src/app/workflows/drafts-section.tsx`
  **What**: Remove local `OverwriteConfirm` type (lines 63-67), `overwriteConfirm` state (lines 80-81), the `setOverwriteConfirm({ ... })` block inside `onConflict` (lines 138-143), the post-resolve `setOverwriteConfirm(null)` cleanup (line 150), and the dialog JSX block (lines 303-321). Wire to the hook from Task 2.1 — pass the slug `row.slug ?? row.filename` through whatever `requestConfirm` shape Task 2.1 settles on; render the hook's dialog where the old JSX block was.
  **Context**: Audit anticipates ~25 lines removed here. The discard-confirm dialog at lines 322-334 is unrelated — leave it alone (finding #6 may revisit).

- [x] **Task 2.3: Switch `WorkflowsTable` to the hook**
  **Files**: `src/app/workflows/workflows-table.tsx`
  **What**: Same as Task 2.2 but for `workflows-table.tsx`: remove the type at lines 45-49, the state at lines 77-78, the `onConflict` setter at lines 244-246, the cleanup at line 250, and the dialog block at lines 460-477. Wire through the hook. The slug here is the parsed JSON `id` (line 222-228) — pass it to `requestConfirm`.
  **Context**: This file also has unrelated `confirm` and `clone` dialogs — leave them. Only the `overwriteConfirm` slice changes.

- [ ] **Task 2.4: Verification gate for Phase 2 (lint + tests + smoke)**
  **Files**: (none — validation step)
  **What**: Run `npm run lint` and `npm run test` first; both must pass. Then `npm run dev` and land on `/workflows`. Trigger overwrite-confirm via both surfaces against a workflow id that already exists: (a) drop a draft into `prompts/workflows/drafts/foo.json` whose id collides with an existing workflow, click Import; (b) export an existing workflow via the Export button, click "Import workflow" and re-upload it. For each: confirm modal opens with the new shared message and destructive styling; clicking Overwrite shows the busy spinner through the retry POST; success toast fires; modal closes exactly once. Cancel path: click Cancel, modal closes immediately, no second POST in DevTools network panel.
  **Context**: Type-check and tests verify wiring; the lifecycle invariants from Task 2.1 ("dialog stays open with spinner through retry POST", "unmounted exactly once") are runtime UX behaviors the audit explicitly wants preserved — only a real browser proves them.

## References
- `docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md` — findings #1 (lines 25-30), #2 (lines 33-38), positive patterns (lines 104-110).
- `.claude/skills/domain-workflow-drafts/SKILL.md` — Anchors block, Positive patterns section.
- `docs/histforge-spec.md § 19a` — AI workflow drafts contract (round-trip JSON shape — should not be affected by this refactor).
