# Workflow-drafts SOLID refactor — items #5 & #6

## Overview
Two follow-up items from `docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md` after items #1-#4 landed on this branch. #5 replaces the duplicated import-error if-else chains with a shared typed decoder co-located with `runImport`. #6 (audit-flagged "watch-out, dependent on #2 and #5") then re-evaluates `DraftsSection` size and extracts a fetch hook + presentational sibling if it remains over the audit's ~350-line threshold.

## Current State

**#5 — Two import surfaces, two divergent error decoders, two duplicated `ZodIssue` types**
- `src/app/workflows/drafts-section.tsx:39-47` — local `ZodIssue` + `ImportErrorBody`. Decoder chain at lines 141-158: six branches (`invalid_input`, `invalid_json`, `invalid_filename`, `draft_not_found` (with `loadDrafts()` side-effect), `workflow_id_exists`, generic) plus the `issues?.[0]?.message ?? "schema mismatch"` lookup at 143.
- `src/app/workflows/workflows-table.tsx:49-52` — local `ZodIssue` (hand-identical to drafts-section's). Decoder at lines 245-251: only `invalid_input` (with same `?.[0]?.message ?? "schema mismatch"` lookup at 247) plus generic fallback. Falls through silently for every other code.
- Server-side error codes the decoders must cover: `IMPORT_ERROR_STATUS` in `src/lib/workflows-import.ts:42-46` lists `invalid_input | workflow_id_exists | invalid_filename`; the drafts route at `src/app/api/workflows/drafts/[filename]/import/route.ts:46,53` adds two route-only codes (`draft_not_found` 404, `invalid_json` 400). The file-picker route at `src/app/api/workflows/import/route.ts` produces only `IMPORT_ERROR_STATUS` codes.
- Asymmetry is intentional but uncompiled: file-picker can't hit `draft_not_found` or `invalid_json` (those live in the drafts route only). Adding a fourth `ImportErrorCode` today is a two-place edit with no compile-time guarantee both surfaces handle it.
- Existing home for shared import logic: `src/app/workflows/use-import-with-overwrite.tsx` (131 lines, exports `runImport`, `useOverwriteConfirm`, `ImportAttempt`, `RunImportOptions`). Both surfaces already import from it.

**#6 — `DraftsSection` size after #2 + #3 landed**
- `src/app/workflows/drafts-section.tsx` — 401 lines (was 453 before #2). Items #2 and #3 already trimmed the dialog block + `DraftRow` declaration. After #5 (Phase 1 of this plan) lands, expect ~30 lines off the decoder + the two interface declarations, putting the file around ~370 lines.
- Concerns currently mixed in the file:
  1. Data fetch + lifecycle state (`loadDrafts` 65-79, `loading`/`refreshing` 57-58, `onRefresh` 88-96, init effect 81-86).
  2. Discard flow (state 49-52 + 61-63, `onDiscardConfirmed` 167-197, dialog JSX 271-283).
  3. Import flow (`busyFilename` state 59, `onImport` 98-165 — invocation + decoder chain + success toast + archive-error followup + post-import navigation).
  4. Layout (`Card`/`CardHeader`/`CardContent` shell, the `Table`).
  5. Inline presentational helpers: `DraftTableRow` (lines 288-365, ~78 lines), `ProvidersCell` (367-380, ~14 lines), `showImportSuccessToast` (382-401, ~20 lines).
- Audit's threshold: extract if still > ~350 lines after #2 and #5. Audit's specific extractions: `useDraftsList()` hook owning fetch + lifecycle, `DraftTableRow` + `ProvidersCell` to a sibling file (`drafts-table-row.tsx`). `showImportSuccessToast` stays co-located unless a future toast-builder centralization happens.
- Reference precedent the audit cites: the videos-client refactor on 2026-04-30 — see `docs/plans/archive/2026-04-30-video-detail-client-modular-split.md` for the extraction shape (hook + sibling presentational components, no behavior change).

## Scope

**Doing**:
- Phase 1 (#5): Add a typed `decodeImportError` dispatcher to `src/app/workflows/use-import-with-overwrite.tsx` along with the shared `ZodIssue` / `ImportErrorBody` types. Cover all six error codes the drafts surface decodes today plus the `IMPORT_ERROR_STATUS` codes; surface the `draft_not_found` side-effect (refetch drafts list) via a context object the caller passes in. Wire `drafts-section.tsx` and `workflows-table.tsx` through it; remove their local `ZodIssue` types and decoder chains.
- Phase 2 (#6, conditional): Re-measure `drafts-section.tsx` after Phase 1 lands. If still over ~350 lines, extract `useDraftsList()` (fetch + `loading`/`refreshing` + `loadDrafts`/`onRefresh`) and move `DraftTableRow` + `ProvidersCell` to `drafts-table-row.tsx`. Leave `showImportSuccessToast` co-located.
- Verification gate after each phase: `npm run lint`, `npm run test`, `npm run build`. Phase 2 also adds a brief manual smoke (load `/workflows`, refresh drafts, trigger one import-error path) — the extractions are pure refactors but the audit-cited videos-client precedent had a regression that lint+tests didn't catch.

**Decoder API shape (Phase 1 contract — pre-decided so the implementer has one fewer call to make)**:
- `interface ImportErrorContext { reloadDrafts?: () => Promise<void> }` — surface-specific side-effects flow in here.
- `decodeImportError(body, status, ctx)` returns `{ kind: "toast"; level: "error" | "warning"; message: string; sideEffect?: () => Promise<void> }`.
- The decoder does **not** call `toast` itself — it returns a description the caller invokes. Same separation as `runImport`/`useOverwriteConfirm` (see `use-import-with-overwrite.tsx`'s comment block at lines 3-12: framework-agnostic, caller-driven).
- Cover the union: `invalid_input` (with the `issues?.[0]?.message ?? "schema mismatch"` lookup), `invalid_json`, `invalid_filename`, `draft_not_found` (sets `sideEffect = ctx.reloadDrafts`), `workflow_id_exists` (the post-cancel concurrent-insert generic-conflict message), generic fallback. The file-picker passes no `reloadDrafts` and naturally never hits `draft_not_found` — that's an asymmetry the type system now expresses (optional ctx field) instead of via silent fall-through.

**Phase 2 conditionality (explicit so it isn't a judgment call mid-implement)**:
- Skip gate: if `wc -l src/app/workflows/drafts-section.tsx` after Phase 1 reports ≤ 350, do **not** start Phase 2 and close the plan; mark the task `[skipped — file at <N> lines, below threshold]`. The audit explicitly says "don't pre-extract".
- Soft gate: if 350 < lines ≤ 380, run only Task 2.2 — the `DraftTableRow`/`ProvidersCell` sibling extraction (~92 lines off, the higher-leverage half). Re-measure; only run Task 2.3 if still > 350.
- Hard gate: if > 380, run both Task 2.2 then Task 2.3 (sibling first because it removes the larger chunk and de-risks the hook extraction's diff size).

**Not doing**:
- #1, #2, #3, #4, #7 — already landed (#1-#4) or out of scope (#7 — separate one-touch follow-up after #1).
- Any change to `runImport`'s signature or `useOverwriteConfirm`'s API. Both are explicitly preserved per the audit's "Positive patterns" section.
- Centralizing `showImportSuccessToast` into a shared toast-builder. Audit says "stay co-located if not reused" — it isn't reused yet.
- The cross-domain `ConfirmDialog` move flagged in the audit's "Cross-domain observation".
- Skill update: grepped `.claude/skills/domain-workflow-drafts/SKILL.md` for `decodeImportError`, `ImportErrorBody`, `ZodIssue`, `useDraftsList`, `DraftTableRow`, `ProvidersCell`, `drafts-table-row` — zero matches in any anchors block, body prose, or frontmatter. The new module + sibling are not named in any skill, so no skill update is required. (Item #1's plan needed one only because the path `src/lib/workflows-import.ts` was in the trigger list.)

**Phase ordering**: Phase 1 must precede Phase 2. Phase 2's conditionality measures `drafts-section.tsx` line count *after* Phase 1's decoder removal — running Phase 2 first would over-extract.

## Tasks

### Phase 1: Shared import-error decoder (#5)

- [x] **Task 1.1: Add `decodeImportError` + shared types to `use-import-with-overwrite.tsx`**
  **Files**: `src/app/workflows/use-import-with-overwrite.tsx`
  **What**: Add and export `ZodIssue`, `ImportErrorBody`, `ImportErrorContext`, and `decodeImportError(body: ImportErrorBody | null, status: number, ctx: ImportErrorContext): { kind: "toast"; level: "error" | "warning"; message: string; sideEffect?: () => Promise<void> }`. Mirror the union the drafts surface decodes today (`invalid_input` / `invalid_json` / `invalid_filename` / `draft_not_found` / `workflow_id_exists` / generic). The `draft_not_found` arm sets `sideEffect = ctx.reloadDrafts` (no-op when caller didn't pass one). Inline the `issues?.[0]?.message ?? "schema mismatch"` lookup once inside the decoder, not at every call site. Preserve every wording string verbatim from `drafts-section.tsx:142-158` — wording drift is finding #5 itself; do not introduce more here.
  **Context**: Module's existing JSDoc header at `use-import-with-overwrite.tsx:3-12` already frames it as the "shared import surface" home. The decoder is framework-agnostic by the same pattern as `runImport` (lines 35-50): pure data in/out, caller invokes side-effects. Every code in this task's union returns `level: "error"`; the union with `"warning"` is encoded so a future code can return that level without a breaking signature change.

- [x] **Task 1.2: Switch `DraftsSection` to the decoder**
  **Files**: `src/app/workflows/drafts-section.tsx`
  **What**: Remove local `ZodIssue` (lines 39-42) and `ImportErrorBody` (44-47) declarations; import the shared types from `./use-import-with-overwrite`. Replace the if-else chain at lines 141-158 with a single `decodeImportError(err, result.status, { reloadDrafts: loadDrafts })` call followed by `toast.error(decoded.message)` and `await decoded.sideEffect?.()`. The `result.body as ImportErrorBody | null` cast at line 141 stays — same shape, now imported instead of locally typed.
  **Context**: `loadDrafts` is already a stable `useCallback` (line 65); passing it as `reloadDrafts` is safe across re-renders. The success-path block (lines 119-135) and the `try/catch/finally` skeleton (159-164) are unrelated and stay untouched — only the decoder branches change.

- [x] **Task 1.3: Switch `WorkflowsTable` to the decoder**
  **Files**: `src/app/workflows/workflows-table.tsx`
  **What**: Remove local `ZodIssue` declaration (lines 49-52); the type is now `import type { ZodIssue, ImportErrorBody } from "./use-import-with-overwrite"`. Replace the inline decoder at lines 245-251 (the `if (body.error === "invalid_input") { ... } toast.error(\`Import failed (${result.status})\`)` branch) with `decodeImportError(body, result.status, {})` and `toast.error(decoded.message)`. No `reloadDrafts` is passed — the file-picker surface doesn't have one and never hits `draft_not_found`. The `result.body` cast at line 245 narrows from the inline shape to `ImportErrorBody | null`.
  **Context**: The `onCloneSubmitted` handler at lines 167-200 also uses `errBody.issues?.[0]?.message ?? \`Clone failed (${res.status})\`` (line 193) — leave it alone. That's the clone API's error shape, not the import API's; same type *literal* but a different contract that should not be coupled to import-error decoding. (Audit also did not flag this site.)

- [x] **Task 1.4: Verification gate for Phase 1**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, `npm run build`. All three must pass. Acceptance checks: (a) `grep -n "interface ZodIssue" src/app/workflows/drafts-section.tsx src/app/workflows/workflows-table.tsx` returns zero matches — both locals removed; (b) `grep -n "result.body as ImportErrorBody" src/app/workflows/drafts-section.tsx` and `grep -n "as { error?: string" src/app/workflows/workflows-table.tsx` confirm only the canonical cast shape remains; (c) `wc -l src/app/workflows/drafts-section.tsx` — record the result, this is Phase 2's gate input.
  **Context**: `npm run build` covers the Next.js bundle and the worker `tsc-alias` pass — stale alias references are caught here even when lint/tests pass.

### Phase 2: `DraftsSection` extraction (#6, conditional on Phase 1's `wc -l` result)

- [x] **Task 2.1: Decide which extractions Phase 2 covers**
  **Files**: (none — decision step)
  **What**: Apply the gates from the Scope section against the `wc -l` measured in Task 1.4. Mark which sub-tasks below run and which are skipped, with the line count cited as justification. Then proceed.
  **Context**: This is the audit's "don't pre-extract" rule made executable. Skipping Phase 2 entirely when the file is already short is a valid outcome — close the plan rather than forcing make-work.

- [x] **Task 2.2: Extract `DraftTableRow` + `ProvidersCell` to a sibling file** (runs under soft or hard gate)
  **Files**: `src/app/workflows/drafts-table-row.tsx` (new), `src/app/workflows/drafts-section.tsx`
  **What**: Move `DraftTableRow` (currently at `drafts-section.tsx:288-365`) and `ProvidersCell` (367-380) verbatim to the new sibling. Both are pure presentational and take their data via props — no state to migrate. Keep their props shapes byte-identical; the parent now imports them. Sibling file marks itself `"use client"` only if needed (icons + Badge/Button imports — same as parent).
  **Context**: `DraftRow` and `DraftRowProviders` already live in `@/lib/workflows-api` (item #3 hoisted them) — both the parent and the sibling import from the same shared module, no new prop-shape coupling between them. Reference shape: see `src/app/videos/` for the videos-client extraction precedent — the audit cites `docs/plans/archive/2026-04-30-video-detail-client-modular-split.md` as the established pattern in this codebase.

- [x] **Task 2.3: Extract `useDraftsList` hook** (runs under hard gate, or under soft gate if Task 2.2 alone leaves the file > 350 lines)
  **Files**: `src/app/workflows/use-drafts-list.ts` (new), `src/app/workflows/drafts-section.tsx`
  **What**: Move the fetch + lifecycle state into a hook returning `{ drafts: DraftRow[]; loading: boolean; refreshing: boolean; reload: () => Promise<void> }`. The hook owns `useState<DraftRow[]>`, `loading`, `refreshing`, the `loadDrafts` `useCallback`, the init `useEffect`, and the `onRefresh` wrapper. The component consumes the hook and re-exposes only what its JSX uses. The decoder side-effect from Task 1.2 swaps from `loadDrafts` to the hook's `reload`.
  **Context**: Hook does not need `"use client"` itself (TS-only file); the consumer is already client. Be careful about the toast invocation inside `loadDrafts` (current `drafts-section.tsx:69` and `:74-77`) — keep it inside the hook; it's a network-error UX concern, not a layout concern, so it belongs with the fetch.

- [x] **Task 2.4: Verification gate for Phase 2**
  **Files**: (none — validation step)
  **What**: Run `npm run lint`, `npm run test`, `npm run build`. All three must pass. Then `npm run dev`, navigate to `/workflows`, and exercise: (a) drafts list loads (loading state then rows or empty-state copy); (b) Refresh button shows the spinner and re-fetches; (c) trigger one import-error path the decoder owns — e.g. delete `prompts/workflows/drafts/<file>.json` between list-load and Import click to provoke `draft_not_found`, confirm the toast fires *and* the list refetches automatically. Final acceptance for `wc -l src/app/workflows/drafts-section.tsx`: ≤ ~280 if both 2.2 and 2.3 ran; ≤ ~290 if only 2.2 ran (the soft-gate common case).
  **Context**: Lint and tests verify wiring; the manual smoke verifies the auto-refetch side-effect threaded through `decodeImportError → reloadDrafts → useDraftsList.reload` survives the indirection. The audit-cited videos-client precedent had a state-sync bug that only surfaced in the browser.

## References
- `docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md` — finding #5 (lines 57-61), finding #6 (lines 65-69), priority-action-plan placement of #6 (lines 91-92).
- `docs/plans/2026-05-03-workflow-drafts-solid-1-2.md`, `docs/plans/2026-05-04-workflow-drafts-solid-3-4.md` — sibling plans on this branch covering the prerequisites (#1-#4).
- `src/app/workflows/use-import-with-overwrite.tsx` — module that grows the decoder; existing JSDoc header documents the "shared import-surface kit" intent.
- `docs/plans/archive/2026-04-30-video-detail-client-modular-split.md` — precedent for the hook + sibling presentational extraction shape (audit-cited).
