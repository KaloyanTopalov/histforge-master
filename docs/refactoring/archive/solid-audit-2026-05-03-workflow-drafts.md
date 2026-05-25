# SOLID Audit — 2026-05-03 (workflow-drafts)

**Mode**: Single-domain
**Scope**: AI-skill workflow-drafts pipeline — three drafts API routes, the schema route, the shared `importWorkflowJson` + drafts FS helpers, the `runImport` 409-overwrite helper, the `DraftsSection` UI, and the symmetric file-picker import surface in `WorkflowsTable` insofar as it shares contracts with drafts.
**Domains analyzed**: domain-workflow-drafts (paired with domain-workflows for registry context, domain-dashboard for the `/workflows` page shell)

## Summary

The pipeline is well-architected on the backend: `importWorkflowJson` is correctly shared between the file-picker and drafts import routes, the four-phase commit-then-archive sequence is documented and defended by tests, and the `runImport` helper cleanly sequences the 409-overwrite dance. The bulk of the SOLID drift is at the *seams* between modules — duplicated types, duplicated regexes, duplicated overwrite-confirm dialog state, route files importing helpers from sibling route files, and a single `workflows-import.ts` module quietly housing two unrelated concerns (DB import semantics and drafts FS layout). None of these are urgent; together they are the kind of small frictions that compound the next time a third import surface or a new advisory key is added. Seven findings, mostly small effort.

## Findings Overview

| ID  | Domain                  | Principle | Severity | Effort | Files                                                                                                       |
|-----|-------------------------|-----------|----------|--------|-------------------------------------------------------------------------------------------------------------|
| 1   | domain-workflow-drafts  | SRP       | medium   | small  | `src/lib/workflows-import.ts`                                                                               |
| 2   | domain-workflow-drafts  | DRY/ISP   | medium   | medium | `src/app/workflows/drafts-section.tsx`, `src/app/workflows/workflows-table.tsx`                             |
| 3   | domain-workflow-drafts  | ISP/DIP   | medium   | small  | `src/app/api/workflows/drafts/route.ts`, `src/app/workflows/drafts-section.tsx`                             |
| 4   | domain-workflow-drafts  | DIP       | medium   | small  | `src/app/api/workflows/route.ts`, `…/import/route.ts`, `…/drafts/[filename]/import/route.ts`, `…/workflows/page.tsx` |
| 5   | domain-workflow-drafts  | OCP/DRY   | medium   | small  | `src/app/workflows/drafts-section.tsx`, `src/app/workflows/workflows-table.tsx`                             |
| 6   | domain-workflow-drafts  | SRP       | low      | medium | `src/app/workflows/drafts-section.tsx`                                                                      |
| 7   | domain-workflow-drafts  | DRY       | low      | small  | `src/lib/workflows-import.ts`, `src/app/api/workflows/drafts/route.ts`                                      |

## Findings Detail

### #1 — `workflows-import.ts` mixes DB-side import semantics with drafts FS layout
**Domain:** domain-workflow-drafts | **Principle:** SRP | **Severity:** medium | **Effort:** small
**Files:** `src/lib/workflows-import.ts` (lines 1-123 = DB concern, lines 125-158 = FS concern)
**Recommendation:** Split into two modules. Keep `src/lib/workflows-import.ts` for the DB-side pieces (`importWorkflowJson`, `ImportError`, `ImportErrorCode`, `ImportResult`, `ImportStatus`). Move the FS-layout helpers (`getPromptsRoot`, `getDraftsDir`, `getImportedDir`, `ensureDraftsDirs`, `validateDraftFilename`, the `DRAFT_FILENAME_RE` regex) into a sibling module like `src/lib/workflows-drafts-fs.ts`. Update the three drafts routes to import from both as needed. Optional bonus: while splitting, co-locate the `ImportError.code → HTTP status` mapping (today inlined as `err.code === "invalid_input" ? 400 : 409` in two routes) next to `ImportError` itself as `IMPORT_ERROR_STATUS: Record<ImportErrorCode, number>`, so adding a new code is one-touch.
**Why:** The file is split-by-comment-only today — line 12's header comment documents only the DB concern, line 125 has a separator block-comment for "Filesystem layout for the AI-skill drafts pipeline", and the symbol map confirms the two halves never reference each other. Callers feel this leak: `drafts/[filename]/route.ts` imports `ImportError` (DB) alongside `ensureDraftsDirs`, `getDraftsDir`, `validateDraftFilename` (FS) from the same module — and the file-picker import route at `app/api/workflows/import/route.ts` imports only the DB half but pays the parse cost of the FS half. A future change to either concern (e.g. swapping FS for object storage, or restructuring `ImportError` codes) re-bundles the unrelated half through every importer. The status-mapping co-location piggybacks on the same churn — today both import routes hardcode the same ternary, so adding a third import code (Phase 7?) is two-place edit.

---

### #2 — Overwrite-confirm dialog state and JSX hand-duplicated across the two import surfaces
**Domain:** domain-workflow-drafts | **Principle:** DRY, ISP | **Severity:** medium | **Effort:** medium
**Files:** `src/app/workflows/drafts-section.tsx` (`OverwriteConfirm` type lines 63-67, dialog block lines 303-321), `src/app/workflows/workflows-table.tsx` (`OverwriteConfirm` type lines 45-49, dialog block lines 460-477)
**Recommendation:** Extract a `useOverwriteConfirm()` hook (or a small `<OverwriteConfirmDialog />` portal component) co-located with `runImport` in `src/app/workflows/use-import-with-overwrite.ts`. The hook owns the `OverwriteConfirm` state, exposes a `requestConfirm(slug): Promise<boolean>` method that `onConflict` can hand straight to `runImport`, and renders the dialog itself. Both consumers replace ~25 lines of state + JSX with a couple of lines. The skill's "Spinner-During-Retry Lifecycle" pattern (the `busy: true` retain across the second POST, then `setOverwriteConfirm(null)` after `runImport` returns) becomes invariant of the hook rather than a rule the next caller has to remember.
**Why:** The skill itself flags this as a landmine: *"Both surfaces should keep this lifecycle in lockstep"* and *"Don't fork this helper for new import surfaces"*. Today the lockstep is enforced by manual code review — both files have nearly identical `OverwriteConfirm` types, identical `onCancel`/`onConfirm` handlers, identical guard against `if (overwriteConfirm.busy) return`, and identical post-resolve `setOverwriteConfirm(null)` cleanup. They already differ in dialog wording (`drafts-section`: *"Workflow \"X\" already exists. Overwrite it with the imported draft?"* vs. `workflows-table`: *"A workflow with id \"X\" already exists. Overwrite it with the imported file?"*) — drift has begun. Future "import from URL" or any third surface inherits the same boilerplate and the same correction-only-applied-to-one-surface risk. Bundling the busy-retention rule into the hook makes it impossible to forget. This is the highest-leverage refactor in this audit because (a) it consolidates a documented landmine and (b) it materially shrinks both consumers, paving the way for #6.

---

### #3 — `DraftRow` interface defined twice with no compile-time link between producer and consumer
**Domain:** domain-workflow-drafts | **Principle:** ISP, DIP | **Severity:** medium | **Effort:** small
**Files:** `src/app/api/workflows/drafts/route.ts` (lines 16-29 — server-side definition shaping the GET response), `src/app/workflows/drafts-section.tsx` (lines 26-39 — client-side definition typing `setDrafts`)
**Recommendation:** Hoist `DraftRow` and its inner `providers` shape to a shared module. Two acceptable homes: (a) `src/types.ts` if you treat it as a file-format/wire type alongside `WorkflowSnapshot`, or (b) a new `src/app/api/workflows/drafts/types.ts` (or `_shared.ts`) co-located with the route. The route exports it as the GET response type; the client `import type { DraftRow }`s it. Remove both private copies.
**Why:** Today the GET response shape and the consumer's expected shape are byte-identical by hand. A field rename, a nullability tweak, or a new `errors` code on the route side won't trip the type-checker on the client side until something blows up at runtime. `parseDraft`'s return is even typed as the local `DraftRow` — so the route's compiler has no idea the wire format is part of a contract. The test suite covers the happy path and the error-shape variants well, so a regression would surface, but the type system should catch this category at edit time. Same friction class as #4 (buildDetail) — module boundaries that should be source-of-truth contracts but are instead duplicated.

---

### #4 — Route files importing internals from sibling route files
**Domain:** domain-workflow-drafts | **Principle:** DIP | **Severity:** medium | **Effort:** small
**Files:** `src/app/api/workflows/route.ts` (defines and exports `buildDetail`, `toApiSummary`, `WorkflowApiSummary`, `WorkflowApiDetail`), `src/app/api/workflows/import/route.ts` (line 4 imports `buildDetail`), `src/app/api/workflows/drafts/[filename]/import/route.ts` (line 17 imports `buildDetail`), `src/app/workflows/page.tsx` (line 4 imports `toApiSummary`)
**Recommendation:** Move `buildDetail`, `toApiSummary`, `WorkflowApiSummary`, and `WorkflowApiDetail` out of the GET-route file into a non-route module. Two reasonable homes: (a) `src/app/api/workflows/_shared.ts` (Next.js underscore-prefix convention — files starting with `_` are not route handlers), or (b) `src/lib/workflows-api.ts` (sit them alongside the other workflow-shaped helpers in `lib/`). Update three import sites.
**Why:** Routes are an HTTP boundary, not a public lib API — once `route.ts` exports helpers used by *other* `route.ts` files and by server components, two things go wrong. First, refactoring `route.ts`'s GET handler (e.g. adding caching headers, switching to a Route Segment Config option) carries the risk of churning unrelated importers. Second, the dependency direction is the wrong way — high-level surfaces (server pages, sibling routes) should depend on lib-level abstractions, not on each other's request handlers. Today this only spans four files, but the drafts-import route and the file-picker import route already prove the pattern is metastasizing. Fix once before a fifth surface adopts it. Severity is medium because nothing's broken, but the architectural smell is the kind that quietly makes future refactors harder to scope.

---

### #5 — Frontend import-error decoder is an if-else chain with bespoke side-effects, decoded inconsistently across surfaces
**Domain:** domain-workflow-drafts | **Principle:** OCP, DRY | **Severity:** medium | **Effort:** small
**Files:** `src/app/workflows/drafts-section.tsx` (lines 175-192 — six `else if` branches plus default), `src/app/workflows/workflows-table.tsx` (lines 257-263 — handles only `invalid_input`, falls through everything else to a generic message)
**Recommendation:** Define a typed import-error map alongside the import surfaces — e.g. `interface ImportErrorBody { error: string; issues?: ZodIssue[]; current_version?: number }` plus a small dispatcher `decodeImportError(body, status, ctx): { toast: ToastInvocation; sideEffect?: () => Promise<void> }` co-located with `runImport`. Both surfaces call the dispatcher and pass any surface-specific side-effect (e.g. drafts-section wants `loadDrafts()` on `draft_not_found`; the file-picker surface doesn't). Lift `ZodIssue` to the same shared module — it's currently typed identically in both files (drafts-section lines 53-56, workflows-table lines 54-57). The Zod issue lookup pattern (`issues?.[0]?.message ?? "schema mismatch"`) is also duplicated.
**Why:** The drafts surface decodes six error codes (`invalid_input`, `invalid_json`, `invalid_filename`, `draft_not_found`, `workflow_id_exists`, generic fallback); the file-picker surface decodes one (`invalid_input`) and falls through to a generic toast for the rest. That asymmetry might be intentional — the file-picker can't hit `draft_not_found` — but today there's no compile-time guarantee that a code added to `ImportError` actually reaches the user on either surface. Adding a new code requires editing both consumers and remembering the mapping; a shared decoder turns that into one-touch. The skill's contract is *"both surfaces share `runImport`"* — same logic should apply to error decoding, and the cleaner abstraction is a sibling decoder module rather than a hand-typed branch table per file.

---

### #6 — `DraftsSection` is 453 lines mixing fetch, two confirm-dialog flows, six-branch error decoding, layout, and inline helpers
**Domain:** domain-workflow-drafts | **Principle:** SRP | **Severity:** low | **Effort:** medium
**Files:** `src/app/workflows/drafts-section.tsx` (whole file)
**Recommendation:** Watch-out item, **dependent on #2 and #5**. After those two land, the remaining concerns are: data fetch + lifecycle (`loadDrafts`/`refreshing`/`loading`), the discard flow (state + confirmed handler), the import flow (busyFilename + invocation), layout, and the inline `DraftTableRow` / `ProvidersCell` / `showImportSuccessToast` helpers. If the file is still over ~350 lines after #2 and #5, extract a `useDraftsList()` hook that owns the fetch + lifecycle states. Move `DraftTableRow` and `ProvidersCell` into a sibling file (`drafts-table-row.tsx`). `showImportSuccessToast` can stay co-located if it's not reused, but if a future toast-builder centralization happens, it goes there. Don't pre-extract — wait to see how much #2 and #5 already shrink the file.
**Why:** Today the file is at the edge of "still readable" — six pieces of state, two flow handlers around 50 lines each, and an inline `onImport` that does runImport invocation, error decoding (the #5 chain), success toast formatting, archive-error followup, and post-import navigation. The team has a track record of extracting at this size (see the videos-client refactor on 2026-04-30). Severity is low because today it works and is well-tested, and because #2 and #5 will already subtract ~70 lines combined. Re-evaluate after those land.

---

### #7 — `DRAFT_FILENAME_RE` regex literal duplicated between the lib helper and the GET route
**Domain:** domain-workflow-drafts | **Principle:** DRY | **Severity:** low | **Effort:** small
**Files:** `src/lib/workflows-import.ts` (line 152), `src/app/api/workflows/drafts/route.ts` (line 6)
**Recommendation:** Export the regex from its canonical location (after the #1 split, this would be `workflows-drafts-fs.ts`) and import it in the GET route. Alternatively, expose a `isDraftFilename(name: string): boolean` predicate alongside the throwing `validateDraftFilename`, and have the GET route filter through the predicate instead of the regex. The predicate option is cleaner because it keeps the regex literal in exactly one place and lets the two callers (filter vs. validate) declare their intent at the call site rather than duplicating the regex test.
**Why:** Today the regex is identical in both files, and both files have inline comments referencing the strict-basename-as-feature pattern. A future tweak (e.g. allowing dots for versioning, raising the slug length cap) requires touching both literally — and the test suite would only catch the divergence if both behaviours are tested. The skill's contract treats this regex as a single source of truth (*"This is the same regex as the workflow `id` slug"*); the code should reflect that.

## Priority Action Plan

### Most valuable
- **#2** — Extract `useOverwriteConfirm`. The skill flags this as a documented landmine; both consumers already differ in dialog wording. Highest-leverage because it consolidates one of the contract surfaces the skill explicitly cites and shrinks both consumer files.
- **#1** — Split `workflows-import.ts` into DB-import + drafts-FS modules; co-locate the error→status table while there. Cheap, clean, removes a mixed-concern hot spot.

### Cleanups
- **#3** — Hoist `DraftRow`. One-shot type-safety upgrade across the wire boundary.
- **#4** — Move `buildDetail`/`toApiSummary` out of `route.ts`. Architecturally important; cheap to land.
- **#5** — Shared import-error decoder. Pair with #2 and land both as a single "import-surface kit" PR — they consolidate the same lockstep concern from two angles (UI state + error decoding).
- **#7** — Export `DRAFT_FILENAME_RE` (or `isDraftFilename`) from one place. Tiny.

### Watch-out (no immediate action)
- **#6** — `DraftsSection` size. Re-evaluate after #2 and #5 land — likely below the extraction threshold once those subtract.

## How to Act on This

```
/create-plan Refactor items #1, #2, #5 from docs/refactoring/solid-audit-2026-05-03-workflow-drafts.md
```

(Items #3, #4, #7 are independent and small enough to bundle into the same plan if desired; #6 is gated on #2 + #5 and should be re-reviewed after.)

## Notes

**Positive patterns worth preserving** (resist any urge to "normalize" them):

- **`runImport` is correctly framework-agnostic and caller-driven.** The helper sequences the two POSTs without owning URL/body construction or dialog state — the caller injects both. This is exactly the right separation; #2 builds on top of `runImport` rather than replacing it. The skill's *"Don't fork this helper"* rule remains absolute.
- **The four-phase commit-then-archive sequence (validate → parse → commit → archive) and `archiveError` as a top-level success-response field.** This is a load-bearing design choice — the order is documented, the test suite exercises both the happy path and the EPERM branch, and the skill's "Don't archive before committing" pitfall is well-documented. Do not let any refactor reorder these phases or promote `archiveError` to a 5xx.
- **`getPromptsRoot()` is a function, not a module-load const.** The skill explicitly explains why (test-time env injection). #1's split must keep this function-form.
- **`SERVER_CONTROLLED_KEYS` as a registration array iterated by both the parser and the test matrix.** Adding an advisory key is a one-line change with automatic test coverage. This is the clean OCP pattern; not flagged.
- **`importWorkflowJson` returning a typed `ImportResult` and throwing `ImportError` for control-flow errors.** Both routes that consume it map error codes to HTTP status uniformly; the only minor smell is the duplicated mapping table, addressed in #1.

**Cross-domain observation (out of scope, noted for context):**

- `ConfirmDialog` is imported from `@/app/videos/confirm-dialog` by both `drafts-section.tsx` and `workflows-table.tsx`. That cross-feature import predates the workflow-drafts work and applies to every workflow page. It belongs in a shared component directory (`src/components/ui/confirm-dialog.tsx` next to the existing primitives). This is not workflow-drafts-specific and would be more naturally addressed in a domain-dashboard or cross-cutting cleanup pass.

**Verified non-issues** (deliberately not flagged):

- The drafts-import route's three `findById` reads in the happy path (existing-row check inside the transaction, post-commit re-read inside `importWorkflowJson`, third re-read inside `buildDetail`) is intentional — each serves correctness (transaction-local view, fresh-row return, response-shape uniformity). Not a SOLID concern.
- The drafts list's silent filtering of non-matching basenames is a documented feature (path-traversal defense + slug-shape lint). The skill explicitly addresses operator confusion. Not flagged.
- `enrich_chunks_llm_provider`, `is_builtin`, etc. being silently stripped by Zod's `.strip()` mode while *also* being surfaced as advisory `unknown_field` is the documented contract — the parser surfaces what Zod absorbs. Both layers are intentionally separate concerns. Not flagged.
