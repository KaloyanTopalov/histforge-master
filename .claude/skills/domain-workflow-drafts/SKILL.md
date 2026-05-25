---
name: domain-workflow-drafts
description: Guide for the AI-skill workflow-drafts pipeline — the filesystem inbox under `prompts/workflows/`, the drafts API routes, the Drafts section on `/workflows`, the shared 409-overwrite helper, and the round-trip JSON contract with the schema endpoint. Use when modifying drafts API routes, the drafts filesystem helper, the importer entry point, the Drafts section UI, the on-disk drafts/imported directory layout, or the AI-skill JSON contract; pair with `domain-workflows` for registry mechanics and `domain-dashboard` for the `/workflows` page shell.
---

# Workflow Drafts (AI-Skill Inbox)

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Importer (shared with file-picker route)**: `importWorkflowJson`, `ImportError`, `IMPORT_ERROR_STATUS`, `WorkflowImportSchema`
- **Drafts FS helper**: `getPromptsRoot`, `getDraftsDir`, `getImportedDir`, `ensureDraftsDirs`, `validateDraftFilename`
- **Drafts API routes**: `GET /api/workflows/drafts`, `POST /api/workflows/drafts/[filename]/import`, `DELETE /api/workflows/drafts/[filename]`, `GET /api/workflows/schema`
- **Draft response shape**: `DraftRow`, `DraftRowProviders` — surfaces `chunker_step` on each row so the drafts table can show the chunker choice before import
- **Drafts UI**: `DraftsSection`, `DraftTableRow`, `useDraftsList`
- **Shared 409 dance**: `runImport`, `useOverwriteConfirm`, `decodeImportError`
- **Drafts error codes (response `error` strings)**: `invalid_json`, `missing_fields`, `unknown_field`, `invalid_filename`, `draft_not_found`
- **Env var**: `HISTFORGE_PROMPTS_DIR`

## Architecture

A filesystem-backed inbox that lets an out-of-codebase AI skill author workflow JSON without authenticating to the dashboard. The skill drops a snake-case JSON file into a `drafts/` directory; the dashboard surfaces pending files in a Drafts section above the main workflows table on `/workflows`; one click commits the row and atomically moves the file into a sibling `imported/` directory. Discard removes the file without importing.

This is the second import surface alongside the file-picker upload on the same page (the file-picker side is owned by `domain-workflows` via its `/api/workflows/import` route). **Both surfaces go through one backend helper (`importWorkflowJson`) and one frontend conflict-resolution helper (`runImport`)** so the file-picker / drafts paths cannot drift in behavior. The dual surface is intentional: file-picker for one-off downloads/edits/re-uploads, drafts for the AI-skill loop.

## The Filesystem Layout

Two sibling directories under the prompts root: a `drafts/` directory (pending, written by the AI skill or any external tool) and an `imported/` directory (archived copies of drafts that committed successfully).

Sibling layout is load-bearing: the post-commit move is a same-volume `renameSync`, atomic on POSIX only when source and destination share a volume (no `EXDEV`). Putting `imported/` under the project root or splitting the two directories across volumes would force a copy-then-unlink fallback and reintroduce a torn-state window where the workflow row exists but the source file is half-moved.

Both directories are created lazily on the first drafts API call. The prompts root is **user-and-AI-generated only**; bundled default workflows are seeded into the workflows registry by `domain-workflows`'s boot path — do not ship template JSON files inside the drafts directory.

## The AI-Skill Loop Contract

The AI skill's contract with HistForge is three things, in order:

1. **`GET /api/workflows/schema`** returns `{ modules, steps, providers }`. The four `providers.*` arrays come from `Object.keys(<registry>)` (see `domain-workflows`); a provider added to one of the provider registries automatically becomes valid in drafts without a skill update. The chunker slugs appear under `steps[]` with `module: "glue"`; the skill picks one and writes it into the draft's `chunker_step` field.
2. **JSON shape** identical to the workflow export route — snake-case, flat, with the four provider columns + `chunker_step` + `enabled` + a `steps[]` of script-module slugs only. `chunker_step` is optional on the wire, but the skill should always emit it explicitly so the operator sees the intended video shape in the drafts table before importing. The `chunker_step` ↔ provider consistency rule (image-only chunker requires image-only providers, etc.) is enforced by the validator at save and by the boot validator at worker start; drafts that violate it import but produce an unrunnable pipeline, so the skill is the right layer to keep them consistent. Round-trip parity (export → re-import) is the contract guarantor; the canonical reference lives in the spec under "AI workflow drafts."
3. **The skill writes the file**, the operator clicks Import. The dashboard does not poll the filesystem and does not auto-import; the operator stays in the loop.

Fields the skill must **omit**:
- `for_each` — lives on step-file metadata, not workflow JSON.
- `is_builtin`, `version`, `created_at`, `updated_at` — server-controlled, hardcoded by the import path.

All four are silently stripped on import, but the drafts list parser surfaces each one as an `unknown_field` advisory so the skill author notices during iteration. See _Advisory `unknown_field` Pattern_ below.

## Atomic Import Sequencing

The draft-import route is a commit-then-archive flow: basename-validate, read+parse, commit through the shared importer, then archive. The order is deliberate — archive after commit, never before. A failed insert (schema, collision, FK) must leave the source in place so the operator can fix and retry. Reversing the order would create a state where the source file disappeared but no row exists, with no audit trail.

The archived filename uses the **canonical row id** (post-commit re-read), not the source filename. A draft saved under one filename whose JSON declares a different `id` lands in the imported directory under the declared slug. The slug is the canonical identifier; the source filename is incidental.

### `archiveError` Is a Top-Level Response Field

When the commit succeeds but the rename fails (disk full, EPERM, antivirus lock), the route returns 201/200 with an `archiveError` string at the response root and logs to the server console. The DB row is the source of truth; the UI fires an additional `toast.error` telling the operator to discard the file manually from the drafts list. Don't bubble this as a 5xx — the import _did_ succeed, and the operator does not need to retry the import, only clean up the orphan file.

## The 409-Overwrite Dance

Both import surfaces (file picker, drafts) share `runImport` plus a confirm-dialog hook. The helper sequences a first POST, a caller-supplied `onConflict` promise on 409, and a retry POST with `?overwrite=1`. The caller owns request construction and dialog state; the helper just sequences the two calls.

**Don't fork these helpers for new import surfaces.** A third import surface should plug into the same two pieces — that's how the conflict-resolution UX stays consistent, and how there remains a single place that captures "what happens on a 409." `decodeImportError` is the companion that maps non-ok response bodies to toast wording; both surfaces must route through it so error copy also stays in lockstep.

### Spinner-During-Retry Lifecycle

A subtle pattern: when the user clicks "Overwrite," the dialog **stays mounted** with a `busy` flag while the second POST is in flight, so the user sees a spinner instead of a flicker-then-toast. Closing the dialog on the confirm click instead would make the user see the dialog vanish before the import completes — which looks like the click did nothing, then a toast pops up several seconds later.

Radix `AlertDialogAction` auto-fires `onOpenChange(false)` after a click, which would route through the cancel path. The hook tracks `busy` in a **ref** (not state) so the cancel path can short-circuit while a retry POST is in flight. Reading `busy` from React state would see the pre-update value and let the dialog dismiss itself mid-retry.

## Advisory `unknown_field` Pattern

The drafts list parser walks each file looking for the server-controlled keys (`is_builtin`, `version`, `created_at`, `updated_at`). When any are present, the row carries an `unknown_field` advisory and the table renders a badge — but **import still proceeds**.

Why advisory and not blocking:
- Zod's default `.strip()` mode silently drops these on import, so they are harmless at the DB layer.
- An AI skill iterating on its prompt template needs the *signal* — silent strip means the skill author wouldn't notice they're emitting forbidden fields.
- A blocking error would fight Zod's strip semantics: switching the import schema to `.strict()` would also break legitimate forward-compat fields a future skill might emit.

The other two error codes — `invalid_json` and `missing_fields` — *do* block import; the Drafts table disables Import for those rows. The list response uses an `errors` **array** (not a scalar) so multiple advisories can stack on one row.

## The `HISTFORGE_PROMPTS_DIR` Override

The prompts-root getter reads `process.env.HISTFORGE_PROMPTS_DIR` **at call time**, not at module load. This is what lets tests inject a tempdir _after_ importing the helper module. If you ever need a cached value for performance, scope the cache to a single request, not module load — otherwise tests can't swap the path.

## Strict Basename Filtering Is a Feature, Not a Bug

The drafts list silently filters filenames that don't match the slug regex (which is the same regex as the workflow `id`). The strictness is intentional: it doubles as a path-traversal defense (basename validation runs before any FS read on the import / delete routes) and as a slug-shape check — a file that passes basename validation can be safely used as a workflow id.

Operator-facing consequence: a mismatched filename just doesn't show up in the Drafts list. Operators authoring drafts manually who report "my draft isn't appearing" should check the filename first.

## Common Pitfalls

- **`archiveError` is a top-level field on a 2xx response, not a thrown error.** The import succeeded; the UI fires a separate toast telling the operator to clean up. Why: promoting this to a 5xx would suggest the row was not committed, leading the operator to retry an import that already succeeded and producing a duplicate-id collision on the second attempt.
- **Don't fork the shared import helpers for new import surfaces.** Both current surfaces share `runImport`, the overwrite-confirm hook, and `decodeImportError` precisely so the 409 UX cannot drift. Why: the spinner-during-retry lifecycle is subtle (Radix auto-closes the dialog on action click, the hook suppresses that with a `busy` ref) and a hand-rolled second copy will reintroduce flicker-then-toast bugs that have already been fixed once.
- **`unknown_field` is advisory, not blocking.** Adding a new server-controlled key to the advisory list does not block import — Zod still strips it silently. Why: the AI-skill loop needs *signal* to iterate against, and switching the import schema to `.strict()` would also reject any forward-compat fields a future skill version might emit.
- **The prompts root is resolved lazily.** Tests inject the env-var override after module import; any helper that needs the prompts root must call the getter, not capture it at module scope. Why: a module-load const would freeze the path before tests can swap it for a tempdir.
- **Round-trip parity is the cross-skill invariant.** If the workflow export shape changes, the AI-skill draft contract changes too — and vice versa. Why: the contract guarantees "export → re-import is a no-op," and the spec's "AI workflow drafts" section is the single source of truth that both this skill and `domain-workflows` cite. Drift breaks the AI skill silently.
- **The drafts directory is not a place for bundled defaults.** Built-in workflows are seeded into the registry by `domain-workflows`. Why: shipping template JSON in the drafts directory would re-import the same workflow on every operator click and pollute the AI skill's working area.
