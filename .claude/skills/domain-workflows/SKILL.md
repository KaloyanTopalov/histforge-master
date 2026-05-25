---
name: domain-workflows
description: Guide for the DB-backed workflow registry, the per-video workflow snapshot, step materialization, and the editor/import/validate API surface. Use when adding or editing a workflow, modifying the snapshot lifecycle on videos, changing routes under /api/workflows, touching the boot validator, or reasoning about how workflow rows relate to step modules and provider registries.
---

# Workflow Registry

## Anchors

- **Lib boundary**: `listWorkflows`, `getWorkflowFromDb`, `resolveSnapshot`, `computeSnapshot`, `materializeStepList`, `BUILTIN_WORKFLOWS`
- **Schema, import, validation**: `WorkflowRowSchema`, `WorkflowImportSchema`, `WorkflowPatchSchema`, `importWorkflowJson`, `validateInputAvailability`, `validateChunkerStepConsistency`
- **Public types**: `WorkflowRow`, `WorkflowSnapshot`, `WorkflowStepRow`, `SeedWorkflow`
- **Worker boot**: `bootValidate`
- **Provider registries** (enumerated by the schema route, resolved per-run by the orchestrator): `llmProviders`, `ttsProviders`, `imageProviders`, `videoProviders`, `getLlmProvider`, `getTtsProvider`, `getImageProvider`, `getVideoProvider`, `LLM_PROVIDER_NAMES`
- **DB tables**: `workflows`, `workflow_steps`
- **Behavior-driving columns**: `videos.workflow_id`, `videos.workflow_snapshot`, `workflows.script_llm_provider`, `workflows.tts_provider`, `workflows.image_provider`, `workflows.video_provider`, `workflows.chunker_step`
- **Chunker slugs** (picked per workflow via `chunker_step`): `chunk_clips_then_images`, `chunk_images_only`, `chunk_clips_only`

## Architecture

A **workflow** is a row in the `workflows` table plus an ordered list of script-module step slugs in `workflow_steps`. Builtins ship in `BUILTIN_WORKFLOWS` and are idempotently seeded on DB init. Operators add user workflows via the editor, the import endpoint, or the AI-skill drafts pipeline.

A workflow row carries four **provider columns** plus a **chunker selector** and the usual versioning/label columns. The media-provider columns are nullable; null **drops** the corresponding module step at materialization time. The chunker column is NOT NULL — it always picks one chunker slug, which decides which `Chunk.kind` distribution lands in `chunks/chunks.json`.

Every video stores both a foreign key (`videos.workflow_id`) **and** a JSON snapshot (`videos.workflow_snapshot`) pinned at create/queue/edit time. The orchestrator runs videos against the snapshot, never the live workflow row. This makes in-flight runs immune to workflow edits and gives the dashboard a stable view of "what this video is configured to do" even after its workflow was renamed/edited/reset.

**Why a registry exists.** Different videos need different pipelines (ComfyUI, Google Flow, future providers) without forking step code. Most steps are near-universal (research, writing, audio, visual-prompt generation, render, cleanup); only the LLM provider for scripting and the media providers differ. Encoding this per-video as a snapshot — rather than as a monolithic step list with `if (provider === ...)` branches inside steps — keeps each step single-purpose and lets the editor surface meaningful provider choices without leaking provider internals into step code.

## Snapshot Lifecycle (Invariant B)

`computeSnapshot` is called at every lifecycle hook on the videos repo that can change a video's pipeline identity — draft creation, draft edits that change `workflow_id`, and the new→queued transitions (single and bulk). Each call is inside a transaction so a partial failure never leaves a half-pinned row. The new→queued hook re-resolves against the *current* live workflow, not whatever the draft saw, so an operator can edit the workflow between drafting and queuing.

After `queued`, the snapshot is immutable. The PATCH videos route rejects pipeline edits on non-`new` rows; this is what makes "edit a workflow without breaking running videos" safe. Anything that wants to change a queued/in-flight video's pipeline must restart it (which re-snapshots).

## Materialization

The snapshot stores **only** the script-module step list — the user-authored editorial steps. Glue (assemble, align, the chunker slot, visual-prompt generation, render, cleanup) and the media-module steps (voiceover, generate_images, generate_clips) are inserted by `materializeStepList` in a fixed canonical order, gated by the snapshot's provider + chunker columns. A null media-provider column drops its step entirely; the chunker slot always emits exactly one of the three chunker slugs.

The chunker and the provider gates have a **consistency rule**: `chunk_clips_then_images` requires both image and video providers; `chunk_images_only` requires image-only; `chunk_clips_only` requires video-only. Materializing an inconsistent snapshot would produce an unrunnable pipeline (the chunker emits chunks with `kind` values that have no module step to consume them), so `validateChunkerStepConsistency` catches this before save and `bootValidate` re-checks every workflow row on worker start.

The media-step slug emitted is provider-agnostic (`generate_images`, not `generate_images_comfyui`). Runtime dispatch happens inside the step via `ctx.imageProvider` / `ctx.videoProvider`, which the orchestrator's per-run dependency resolution looks up from the snapshot's provider field. This is the post-Phase-5 design — the old slug-per-provider mapping is gone, and `bootValidate` rejects snapshots that still carry legacy slug names.

## Three Orthogonal Concerns

A common confusion is treating workflows, step modules, and provider registries as the same axis. They aren't — they compose, and the orthogonality is load-bearing:

1. **Step files** are the concrete units of work. Each exports a `Step` with a unique slug and a `module` classification (`script | tts | image | video | glue`), plus metadata used by the editor and the input-availability validator. Step files know nothing about workflows.
2. **Provider registries** (LLM, TTS, image, video) pick an *implementation* for a capability. Provider selection is **per snapshot field** — the orchestrator reads the snapshot and looks up the named provider once per pipeline run.
3. **Workflows** pick an *ordered list of script-module steps* plus the four provider names. Selection is **per video**, frozen via the snapshot.

The split matters when two providers don't share a step interface — e.g., ComfyUI's image flow is HTTP-based and synchronous; Google Flow's is queue-driven and async. Both are surfaced as the same `generate_images` slug because the step file delegates to `ctx.imageProvider`; the provider registry hides the protocol differences.

## Provider Registry Shape

Each of the four provider registries is keyed by the provider slugs operators see in the editor and the schema endpoint. **The shape of the value is not uniform across registries**, and the asymmetry is deliberate:

- `llmProviders` and `ttsProviders` store **singleton instances** directly. Their providers are stateless (or hold only HTTP-client state); a single instance can serve any run.
- `imageProviders` and `videoProviders` store **either a singleton or a factory function**. Factory entries receive a per-run `deps` bag (currently the `PromptModerator`) at lookup time. The Google Flow image/video providers are factories because they close over the per-run moderator; ComfyUI's stay as singletons.

The `getXxxProvider` helpers normalize the call site: callers always invoke with a name + deps; the helper unwraps singletons or invokes factories transparently. This means **`Object.keys(<registry>)` is still the canonical enumeration** — the schema endpoint can list provider names without caring whether each entry is a singleton or a factory.

When adding a new provider that needs per-run wiring (a moderator, a token, anything constructed once per video), prefer the factory shape over hoisting that state into a singleton's constructor; the registry contract already supports it.

## Step Modules and the Editor Catalog

`Step.module` drives both the Zod schema's allowed-step enum and the editor's catalog. The schema derives its script-step enum from the subset of `REAL_STEPS` whose `module === "script"` — those are the only slugs the editor and import path will accept inside `steps[]`. Adding a new script step is enough to make it pickable; no schema edit needed. Adding a glue/media step is implicitly handled by `materializeStepList` (or by the canonical order it embeds).

Step metadata (label, description, `for_each`) is surfaced verbatim in the editor. `Step.inputs` and `Step.produces` drive the input-availability validator (advisory warnings; saves are never blocked).

The `script_llm_provider` enum is derived from `LLM_PROVIDER_NAMES` rather than from `Object.keys(llmProviders)` because the LLM registry carries a compile-time assertion that the registry keys match the canonical name tuple exactly. Adding an LLM provider therefore requires editing both the tuple and the registry; the schema route picks it up automatically once both are in place.

## Boot Validator (Invariant C)

`bootValidate` runs once at worker startup, after the DB opens but before any state-mutating call. Any failure throws and exits non-zero so a supervisor notices. It enforces, in summary:

- Every `workflow_steps` row and every non-terminal video's snapshot resolve to slugs registered in `REAL_STEPS` — this is what catches stale pre-Phase-5 snapshots, which operators must drain or wipe before deploying a worker that no longer recognizes them.
- Every workflow row's chunker-vs-provider combo passes `validateChunkerStepConsistency` (the same advisory check the editor surfaces, run here as a hard gate so drafts imported outside the editor can't bypass it).
- Every artifact-grouping rule references a known step.
- No non-terminal video carries on-disk legacy artifacts from the hook/main → clip/image rename. Refuse-to-boot is the policy because mid-pipeline auto-rewriting filenames and directories is unsafe — downstream steps name assets by `chunk.id`, which also renamed — so the operator must drain or restart the affected video.

Video-scoped checks intentionally ignore `done` and `failed` rows; those are dormant. A re-queued `failed` row re-snapshots from the live workflow row at the new→queued transition.

Because the validator runs at boot, **don't add runtime slug-existence checks** elsewhere — the invariant is already guaranteed for all videos the worker will pick up. Tests that construct fake workflows either run them through `bootValidate` explicitly or restrict slugs to names registered in their test-local `steps` array.

## Editing, Versioning, Cloning, Resetting

The PATCH route uses optimistic concurrency: every successful write bumps `version`, and the next PATCH must echo it back via `expected_version` or get `409 version_conflict` with the current value. This keeps two operators editing the same workflow from clobbering each other; the editor reloads on conflict.

The slug (`workflows.id`) is **immutable** — Zod strips it from the PATCH body. Renaming requires Clone (which copies the row + steps under a new slug). DELETE blocks builtins, blocks workflows still referenced by videos (`409 workflow_in_use` with a count), and otherwise cascades step rows via the FK.

Reset is builtin-only: it reads from `BUILTIN_WORKFLOWS` and overwrites the live row + steps. Operators can freely edit a builtin row in the editor; Reset is the explicit "go back to defaults" path. The seed itself is **idempotent and additive** — `INSERT OR IGNORE` — so re-running init never overwrites operator edits. Picking up an updated builtin definition requires the Reset route, not a re-seed.

## Authoring Surfaces

Two surfaces author workflows; both land in the same place:

- **Editor** — Server shell reads the row + snapshot via the lib boundary and serializes the script-step catalog (filtered by `module === "script"`) into a client form. The form mutates a local copy and posts the whole snapshot back via PATCH. The Validate-now button hits a stateless validate route that returns advisory warnings.
- **Import** — Accepts a full `WorkflowImportSchema` JSON; reuses `importWorkflowJson` (shared with the drafts pipeline). Overwriting an existing slug requires opting in via query param; without it, slug collisions return `409 workflow_id_exists`.

A third surface — the AI-skill drafts inbox — sits **alongside** the registry, not inside it. The drafts pipeline reuses `WorkflowImportSchema` and `importWorkflowJson`; everything else (filesystem layout, atomic commit-then-archive, advisory unknown-field handling, test-injection of the prompts directory) is the drafts skill's concern. For anything in the drafts API, the drafts UI section, or the on-disk layout, see `domain-workflow-drafts`.

The schema route serves a stable, DB-free catalog of step metadata and provider names. Both the editor and the AI skill consume it. Provider arrays come from the four registries, so adding a provider to a registry surfaces it here without further wiring.

## Common Pitfalls

- **Editing a workflow does NOT affect in-flight videos.** The snapshot pin is intentional — `videos.workflow_snapshot` is the source of truth for any video past `new`, including provider identity, not just the materialized step list. To "fix" a queued or in-flight video, restart it (which re-snapshots from the live row). Re-running the seed won't help either; it's `INSERT OR IGNORE` and the orchestrator never reads the live workflow row.
- **`script_llm_provider` drives every LLM-driven step in a run, not just script writing.** Visual-prompt generation and Google Flow content-policy moderation also resolve through the snapshot's `script_llm_provider`; the legacy global enrichment provider setting was removed. The orchestrator builds `ctx.chat` and `ctx.visualPromptChat` from the same workflow-pinned provider, and resolves `ctx.visualPromptsConcurrency` from the same provider's per-purpose concurrency setting. The two callables exist so each call site can pick a different default model, but the provider identity is unified.
- **Don't add per-video step overrides.** The orchestrator deliberately resolves snapshot → step list with no per-video overlay. If a subset of videos needs a variant pipeline, create a new workflow. Mixing per-video step lists with snapshot-driven defaults would fork the validator, the editor, and the snapshot's whole contract.
- **The slug emitted for media steps is provider-agnostic.** Don't try to add provider-suffixed media slugs (`generate_images_comfyui`, `generate_clips_google_flow`) to a workflow's `workflow_steps` rows or to a snapshot — `bootValidate` will reject it. Provider dispatch happens inside the step via `ctx.imageProvider` / `ctx.videoProvider`; setting the corresponding provider column to null is what removes the slug entirely. For factory-shaped providers, the factory is invoked once per run and per-run state (e.g. `PromptModerator`) is closed over — step code does not need to re-thread it.
- **The chunker slot is variant, not optional.** Every snapshot picks exactly one chunker; null isn't a valid value. The three chunker slugs are not interchangeable — they emit different `Chunk.kind` distributions, and the consistency rule (image-only chunker requires image-only providers, etc.) is enforced both by the editor's validator and by `bootValidate`. Adding a fourth video-type shape means adding a fourth chunker slug + a matching artifact-grouping rule + extending the consistency rule, not parameterizing an existing chunker.
- **Builtin slug ids and `workflows.id` are effectively immutable.** `BUILTIN_WORKFLOWS` is consulted by the Reset route by id; renaming a builtin in the seed array would orphan reset for any DB that already had the old id. And `videos.workflow_id` has `ON DELETE RESTRICT`, so the registry can't drop a workflow that any video still references. To retire a builtin, disable it or leave the row in place — never delete — so already-pinned videos keep working off their snapshots.
