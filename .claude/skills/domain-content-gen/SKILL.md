---
name: domain-content-gen
description: Guide for LLM content generation, prompt templating, and the script-writing pipeline. Use when modifying steps 01-05 or 09 (research, writing, assembly, visual-prompt generation), editing prompt templates, tuning the LLM client, or changing how scripts/outlines/chapters are structured.
---

# Content Generation & Prompt Engineering

## Anchors

Contract names for this domain. Resolve against the current codebase.

- **Step slugs**: `research_outline`, `write_hook`, `write_chapters`, `assemble_script`, `generate_visual_prompts`
- **Prompt system**: `render`, `prompts/_shared/`
- **LLM provider registry**: `LlmProvider`, `ChatMessage`, `ChatOpts`, `getLlmProvider`, `llmProviders`, `LLM_PROVIDER_NAMES`, `LLM_PROVIDER_LABELS`
- **Provider modules**: `openrouterProvider`, `claudeCliProvider`
- **StepContext fields**: `chat`, `visualPromptChat`, `visualPromptsConcurrency`
- **Cross-step exports**: `sanitizeScript`, `getDerivedChapterCount`
- **Settings keys**: `openrouter_script_model`, `openrouter_visual_model`, `claude_cli_script_model`, `claude_cli_visual_model`, `style_prompt_default`, `script_length_minutes`, `visual_prompts_batch_size`, `claude_cli_visual_prompts_concurrency`, `openrouter_visual_prompts_concurrency`
- **Workflow snapshot column**: `script_llm_provider`

## Architecture

Content generation spans five pipeline steps that progressively turn a topic into prose, plus the shared libraries that power them:

1. **`research_outline`** — Title + topic_info + derived chapter count → outline (LLM, with repair/trim loop)
2. **`write_hook`** — Title + outline → hook narration (LLM)
3. **`write_chapters`** — Structure extraction + batched chapter generation with a running `story_so_far` summary (LLM)
4. **`assemble_script`** — Concatenates hook + chapters into `full_script.md` with em-dash sanitization (no LLM)
5. **`generate_visual_prompts`** — Batched, concurrent visual-prompt generation per chunk (LLM, runs after voiceover/align/chunk)

Steps `research_outline`, `write_hook`, and `write_chapters` form the "script module" (`module: "script"` on each `Step`); `assemble_script` and `generate_visual_prompts` are `module: "glue"`. The script-module steps are the only ones that vary by the workflow snapshot's `script_llm_provider`. See `domain-pipeline` for module taxonomy and `domain-workflows` for how the workflow snapshot pins providers.

Steps never import an LLM client directly — they receive `chat` / `visualPromptChat` callables on the `StepContext` that the orchestrator threads into every step run. Topic inputs are read from the video row (no `topics` table exists — it was removed in the overhaul); everything else flows through files. Ready-script videos bypass the script-module steps entirely — `applyReadyScriptArtifacts` (owned by `domain-pipeline`) pre-writes the assembled script and marks the script steps `done` at queue time.

## File-Based Step Handoff

Content steps communicate exclusively through per-video files on disk, not through the DB or in-memory state. Each step reads its predecessor's output files and writes its own.

Why this matters:
- Steps are independently testable — provide input files, assert output files.
- Changing one step's output format means auditing every downstream reader.
- The DB is read by content steps only for the video row's title/topic_info and for settings — never to pass inter-step data.

## Derived Chapter Count

`script_length_minutes` is the only operator-facing knob for script shape. The chapter count is derived from a fixed minutes-per-chapter cadence via `getDerivedChapterCount` and read fresh at the top of every step that needs it. There is no `chapter_count` or `act_distribution` setting any more, and the per-chapter word target is a step-local constant — the dual of the derivation cadence at a fixed words-per-minute assumption — not a setting. Treat the derivation as the contract: changing the cadence is a coordinated edit of the chapter step's word target and the divisor inside `getDerivedChapterCount`.

## Prompt System

### Template Rendering

`render` implements `{{var}}` substitution. Templates are read fresh on every call — there is no caching — so an operator can edit a prompt file mid-run and the change takes effect at the next step invocation without restarting the worker. Preserve this behavior: do not add module-level caching of template text.

### Shared Fragments

Every file in the shared-prompt directory is auto-loaded into a template variable whose name is the file basename. Shared fragments are merged with caller-supplied variables; caller values win on collision. This is the mechanism for injecting cross-cutting context (audience profile, banned words, format rules, numbers-as-letters) into multiple prompts without duplicating the text.

### Unresolved Variables Throw

If a template contains `{{var}}` and no matching variable is supplied (neither from the caller nor from `_shared/`), `render` throws immediately. This is a deliberate safety net — a typo or a missing shared fragment surfaces as a hard step failure, not a silently-degraded prompt. Don't catch this error in step code; let it propagate.

## LLM Provider Registry

The LLM provider registry mirrors the TTS and image provider registries: a types module, an index module exposing `getLlmProvider` + `llmProviders` (with a compile-time guard that the registry's keys match `LLM_PROVIDER_NAMES` exactly), a name module exposing the canonical roster, and one module per backend. Today's two providers are `openrouter` (HTTP, with exponential-backoff retries) and `claude_cli` (shells out to a local `claude` binary, no retry loop).

The orchestrator resolves provider + per-purpose model once per pipeline run and exposes two callables on the `StepContext`:

- **`ctx.chat`** — workflow-pinned provider × **script model**. Used by the script-module steps. Bound to the snapshot's `script_llm_provider` with the matching `*_script_model` setting as the default model.
- **`ctx.visualPromptChat`** — workflow-pinned provider × **visual model**. Used by `generate_visual_prompts` and by the Google Flow content-policy moderator (see `domain-google-flow-coordinator`). Same provider as `ctx.chat`, but with the matching `*_visual_model` setting as the default model.

Both callables resolve from the **same** snapshot-pinned provider — there is no separate global visual-model provider. Both wrappers are also signal-folded once in the orchestrator so the per-run AbortController fires through every LLM call without each step repeating the signal opt. Changing the workflow row mid-run does not affect the in-flight pipeline (Invariant B: snapshot is authoritative). The two callables exist so the orchestrator can pass a different default model per purpose without each step needing to know which model to pick.

Shared behaviors any provider must honor:
- **Pure transport** — providers require the model opt explicitly and throw if it is missing or empty. The pipeline (not the provider) owns purpose-to-model resolution.
- **Plain-string content return** — the assistant's reply is returned verbatim as a string. Steps write it to disk as-is; no post-processing at the client level.
- **Test-friendly retry knob** — a retry-delay opt exists so tests can pass zero and skip the real backoff. Adding a new provider must accept this option even if the new backend doesn't retry.
- **AbortSignal honoring** — the signal opt must abort the in-flight transport (cancel the fetch, kill the spawned process) and surface an AbortError-shape to the caller. An eager-abort check before any network/spawn cost is also required, because abort-event listeners do not fire on an already-aborted signal.
- **Error surfacing** — exhausted retries (or non-retrying spawn failure for the CLI) throw to the orchestrator, which marks the step failed.

Adding a new backend is a one-file drop-in: implement `chat`, register it in `llmProviders`, and add the slug to `LLM_PROVIDER_NAMES`. A compile-time check fails if either edit lands without the other. The slug becomes a workflow-row `script_llm_provider` value and an option in the Script settings UI.

## Research Outline — Repair/Trim Loop

`research_outline` makes the initial outline call, then defends the contract that `script_length_minutes` implies. The chapter-count detector (`countChapterBlocks`) tolerates two formats: the prompt-requested bold-wrapped title line per chapter AND ATX heading titles (some OpenRouter→Bedrock Claude variants prefer ATX). The two styles rarely coexist in one reply, so the max of the two counts is taken.

If the count doesn't match the derived target, the step enters a symmetric repair loop:
- **Under-delivery** → an extend prompt grows the outline, keeping every existing chapter verbatim and slotting new chapters where the arc is thin.
- **Over-delivery** → a trim prompt consolidates adjacent chapters, preserving every dated event, named actor, and hard number from the original draft.

The latest reply is persisted to disk after each attempt so an operator can inspect even a failed run. After the repair ceiling is exhausted with a still-wrong count, the step throws — orchestrator cleanup deletes the partial outline and the dashboard's retry button rolls again. **Why fail here:** catching the count mismatch in the outline step is much cheaper than letting the chapter step's structure-extraction phase discover it two LLM calls later, and the error message points the operator at the actionable knobs (`script_length_minutes` or the script LLM provider).

## Write Chapters — The Complex Step

`write_chapters` is the most intricate content step. It runs in two phases, both idempotent on resume.

**Phase A — Structure extraction.** Calls the LLM once to convert the prose outline into a JSON array of `{number, title, summary}`. The reply is passed through a fence-stripper that also normalizes literal newlines inside JSON string values (LLMs often emit raw newline escapes mid-string, which strict JSON parsers reject). Persisted alongside the prose chapters. Skipped on resume if the file exists. The parsed array is validated against the derived chapter count — mismatched numbers, gaps, or duplicate entries throw before the batch loop starts, so a survivor of the outline step that still misbehaves at extraction time fails fast instead of wasting batches.

**Phase B — Batched chapter generation.** Chapters are produced a fixed batch at a time (a step-local constant, not a setting), with one prompt that contains all batch chapters' titles + summaries and emits their full text separated by a `---CHAPTER_BREAK---` sentinel. Per batch:
- If *all* chapter files in the batch already exist on disk, skip (resume fast path).
- If *any* are missing, re-run the entire batch.
- Parse the response on the sentinel and filter empty parts — LLMs sometimes emit a stray leading/trailing separator, especially on single-chapter final batches. The non-empty-parts count must match the batch size or throw.
- Write each chapter file atomically (tmp-then-rename) — only after the full batch response is parsed and validated, so a failed batch leaves no torn files.
- After a successful batch, call the LLM once more to update the running summary (also atomic).

**Why batching:** Single-chapter prompts amortize prompt tokens poorly over a long chapter list and produce weaker pacing because the model can't see the arc across adjacent chapters. Batching trades a smaller number of larger calls for better narrative coherence and cost.

**Why atomic writes:** The tmp-then-rename pattern is why this step declares no `outputs` for default orchestrator cleanup — indiscriminate file deletion on failure would force a full re-run, but atomic writes guarantee every file on disk is complete, so sub-resume can safely pick up from the next missing chapter without risking a torn read. Preserve the atomic-write pattern if you modify this step. The accompanying `produces` field documents what the step actually emits for the workflow validator (see `domain-workflows`).

## Assemble Script — Sanitization Seam

`assemble_script` concatenates hook + chapters, then runs the result through `sanitizeScript` before writing the assembled script. The sanitizer's surface is intentionally tiny — today it only rewrites em-dashes — but it exists because one TTS backend crashes on em-dashes, and TTS + alignment both consume the assembled script directly and cannot tolerate having different views of the prose. The sanitizer therefore lives in its own module and is shared between this step and the ready-script ingestion path so both writers leave the same canonical text on disk.

## Visual Prompt Generation

`generate_visual_prompts` runs batched, ID-keyed JSON envelopes through `ctx.visualPromptChat` with provider-specific concurrency. Already-prompted chunks are skipped on entry — re-running the step directly fills missing prompts only. To force regeneration from scratch, the operator rolls back to the chunking step, which rewrites the chunks file with empty prompts everywhere.

**Style prompt source.** Only `style_prompt_default` — there is no per-video override. The old per-topic style override mechanism was removed when the topics table was eliminated. If an operator needs style variation between videos, they change the setting between runs.

**Batched JSON envelope.** Chunks in the to-regenerate subset are sliced into batches sized by `visual_prompts_batch_size`. Each batch is rendered with prev/next neighbour text drawn from the *full* chunks array so neighbourliness is global, not per-batch; the LLM returns an envelope keyed by chunk ID, and the step validates it (parseable envelope, exact ID-set match, every prompt a non-empty string). A batch size of one is the documented escape hatch. The envelope shape mirrors the content moderator's; the moderator is owned by `domain-google-flow-coordinator`.

**Per-provider concurrency.** Batches run in parallel, bounded by `ctx.visualPromptsConcurrency`, which is sourced from the workflow-pinned provider's `*_visual_prompts_concurrency` setting. OpenRouter (HTTP-bound) gets a wider knob than Claude CLI (process-spawn-bound). Mirrors the per-purpose resolution pattern that already produces `ctx.chat` vs `ctx.visualPromptChat`.

**Parse-failure recovery.** On a strict-validation failure the same batch is retried once with a stricter envelope reminder appended to the prompt. On a second failure the batch falls back to per-chunk calls through the same prompt template — other in-flight batches keep running at full concurrency. A per-chunk call that itself parse-fails twice is a step failure. Transport errors (network, abort) are *not* a parse failure and propagate up to the orchestrator unchanged — only parse failures trigger the per-chunk fallback.

**Eager `prompt_history` reset.** Before any LLM call, the step zeroes `prompt_history` on every chunk in the to-regenerate subset and persists the chunks file once. This closes the inconsistent-partial-state window that an in-loop reset would open — a crash mid-step leaves a consistent file. (For the moderator's `prompt_history` accumulation across rewrites, see `domain-google-flow-coordinator`.)

**Persistence.** The chunks file is rewritten once per settled batch through an in-process async mutex so concurrent batches can't tear JSON. A shared stop flag short-circuits sibling workers once one has thrown — without it, a failed step would keep burning LLM calls + disk writes while the orchestrator was already marking it failed.

## Common Pitfalls

- **`script_length_minutes` drives shape; the filesystem is just storage.** Assembly concatenates chapter files indexed by the derived count, not whatever chapter files happen to be on disk. Lowering `script_length_minutes` between runs leaves stale files — they're ignored by assembly but still live in the project directory until cleanup. *Why*: settings are the source of truth for shape. A step that decided "how many chapters" by counting files would tear on resume after a setting change.
- **`ctx.chat` and `ctx.visualPromptChat` are different callables.** Crossing them (script step calls `visualPromptChat`, or vice versa) silently uses the wrong default model — the call still works, but ignores the per-purpose model split. *Why*: the orchestrator binds two callables specifically because script writing and visual-prompt generation legitimately want different default models on the same workflow-pinned provider; the per-purpose concurrency knob follows the same split.
- **Don't bypass `ctx.chat` / `ctx.visualPromptChat` inside a step.** Reading provider settings or importing a provider module directly inside a step skips the orchestrator's signal folding (so the step won't cancel on delete-request) and skips the test-seeded callable (so unit tests can't intercept). *Why*: dependency injection is how every step in this area stays both cancellable and testable; the StepContext is the only correct entry point.
- **Shared fragments are name-based.** Renaming a shared-prompt file silently changes the variable name in every template that references it, and the renderer's strict-throw only surfaces the breakage at runtime. *Why*: there is no compile-time check between template `{{var}}` references and either caller-supplied or shared-fragment-supplied variables. Prefer editing the contents of an existing shared file over renaming it, and when adding a new `{{var}}` cross-check the rendering call site.
- **`story_so_far` can go stale on crash.** If a chapter batch succeeds in writing chapter files but crashes before updating the running summary, the resume regenerates subsequent chapters using the older summary. *Why*: the summary is a contextual hint, not a hard constraint, and forcing it transactional would complicate the atomic-write story. Accepted as a minor inconsistency, not a bug.
