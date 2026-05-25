---
status: accepted
date: 2026-05-13
---

# Batched, concurrent, resumable visual-prompt generation (step 09)

## Context

Step 09 today (`enrich_chunks`) generates one visual prompt per chunk via a strictly sequential `for` loop, one LLM call per chunk. At default settings (90-min script, ~191 chunks), the step takes ~16 min on OpenRouter and ~60 min on Claude CLI. Each call repeats a ~3000-token static safety preamble, and on Claude CLI each call spawns a fresh `claude -p` process. The step also lacks a skip-already-enriched resume path: a crash mid-step regenerates every chunk on resume. Research: [`docs/research/2026-05-13-enrich-chunks-speedup.md`](../research/2026-05-13-enrich-chunks-speedup.md).

## Decision

Rewrite step 09 around **batched, ID-keyed JSON envelopes** with **operator-tunable concurrency**, optimized for **Claude CLI first** (symmetric implementation gives OpenRouter the win for free). Target: a 191-chunk default video finishes the step in under 10 minutes on Claude CLI.

The change comprises seven coupled decisions:

1. **Rename** `enrich_chunks` → `generate_visual_prompts`. The new name matches the canonical domain noun ("visual prompt") already defined in [`CONTEXT.md`](../../CONTEXT.md) and the verb-noun pattern of its downstream neighbours (`generate_main_images`, `generate_hook_video`). Filesystem (`src/worker/steps/09-generate-visual-prompts.ts`), registry entries, the pipeline helper (`ctx.enrichChat` → `ctx.visualPromptChat`), spec, tests, and existing DB `steps.name` rows all change in one shot via a boot-time migration (`UPDATE steps SET name='generate_visual_prompts' WHERE name='enrich_chunks'`). Prompt template renamed to `prompts/09_generate_visual_prompts.md`.

2. **Batching with JSON envelopes (moderator pattern).** Each LLM call processes K chunks. Input: JSON array of `{id, prev_text, current_text, next_text}`. Output: JSON envelope `{"prompts": [{"id": "<chunk_id>", "prompt": "<string>"}]}`. Follows the existing precedent in [`src/lib/moderator.ts`](../../src/lib/moderator.ts) (whose envelope is `{"rewrites": [{"id": "...", "rewritten_prompt": "..."}]}`) and its prompt template [`prompts/moderate_blocked_prompts.md`](../../prompts/moderate_blocked_prompts.md). ID-keyed I/O makes validation precise (it identifies missing, extra, and duplicate IDs by name) and decouples output ordering from correctness. K is operator-tunable via a single setting `visual_prompts_batch_size` (default 8, range 1–16). K=1 disables batching as an escape hatch.

3. **Provider-specific concurrency** via two new settings:
   - `claude_cli_visual_prompts_concurrency` — default 2, range 1–8 (Claude Code Max RPM cap + ~200 MB per process).
   - `openrouter_visual_prompts_concurrency` — default 8, range 1–32 (HTTP-bound, headroom on visual-tier models).
   Mirrors the `chatterbox_fast_workers` operator-tunable-parallelism precedent.

4. **Parse-failure recovery: retry-then-per-chunk fallback.** A batch reply must pass strict JSON validation: parseable envelope, exact ID set match (no missing, no extra, no duplicates), every `prompt` a non-empty string. On first failure, retry the same batch once with a stricter envelope reminder (same shape as moderator's `MAX_PARSE_ATTEMPTS = 2`). On second failure, fall back to **per-chunk calls for that batch only** — the rest of the step continues at full batched speed; only the offending batch's K chunks degrade to the slow path.

5. **Resume = skip if already enriched; force re-run = roll back to step 08.** Step entry skips any chunk where `chunk.prompt !== null`. To force regeneration from scratch, the operator rolls back to step 08 (`chunk`), which rewrites `chunks.json` with `prompt: null` everywhere. This kills the previous behavior where re-running step 09 directly regenerated everything (spec §11, line 814) — that line is rewritten as part of this change. `chunk.prompt_history` is eagerly reset to `[]` in a single sweep *before* batching for the to-regenerate subset (chunks with `prompt === null`), closing the inconsistent partial-state window the old "reset inside the loop" opened on crash.

6. **Persistence: in-process async mutex + plain `writeFileSync` per settled batch.** Writes happen once per batch (not per chunk), serialized by a mutex to prevent interleaving under concurrency. Atomic `tmp + rename` is **deferred** to a separate change with broader scope (all `chunks.json` writers, not just this step). Worst-case crash loss = up to `concurrency × K` chunks (2 × 8 = 16 chunks under defaults) — strictly better than today's whole-step regen.

7. **OpenRouter parity: core path is symmetric.** Batching, JSON envelope, skip-resume, mutex writes, parse fallback, and the rename all apply identically to OpenRouter. The two **OpenRouter-only** optimizations from the research — `undici.Agent` HTTP keepalive and `cache_control` breakpoint with system/user message split — are **deferred** to separate follow-on changes. They require either a different transport detail (keepalive) or a `messages` array refactor incompatible with Claude CLI's stdin-piped single-prompt model (`cache_control`). Doing them inside this change would couple two unrelated transports together for no near-term benefit, since batching alone takes OpenRouter from ~16 min to ~1 min.

## Considered options (rejected alternatives worth recording)

- **Bisection on parse failure** (recursively split a failing batch in half until per-chunk). Rejected in favor of "retry once, then per-chunk fallback" because parse failures from the moderator-style envelope are rare in practice (well under 1% empirically) — the added complexity of recursion and the harder-to-reason-about worst-case time aren't justified by the marginal win when the bad chunk is in the middle of a batch.

- **Orchestrator-driven resume distinction** (step inspects its row status: `failed`/`rerun_requested` → regenerate all; `running` → skip already-prompted). Rejected because it requires inventing a new "operator-requested re-run" signal in the orchestrator — `src/worker/pipeline.ts:424` today transitions through `pending → running → done/failed` with no distinguishable "this is a fresh re-run" marker. The rollback-to-step-08 path achieves the same outcome with zero new orchestrator concepts and matches the existing pattern in `generate-main-images` ("to regenerate, delete the output first").

- **Markdown-separator output** (like `prompts/04_write_chapters_batch.md` with `---CHAPTER_BREAK---`). Rejected because visual prompts need precise ID-keyed validation; positional matching can't distinguish "missing chunk c025" from "shifted order starting at c025", and that diagnostic is load-bearing for the per-chunk fallback in (4).

- **Atomic `tmp + rename` writes in scope here.** Deferred. The non-atomic-write hazard for `chunks.json` is pre-existing and affects multiple writers (this step, the moderator, the Google Flow rewrites in [`src/worker/steps/google-flow-common.ts`](../../src/worker/steps/google-flow-common.ts), API routes). Right scope is a standalone `lib/atomic-write.ts` helper that converts all of them — separate artifact, separate plan.

- **Claude CLI concurrency higher than 2.** Rejected as default but kept reachable as a setting. The "2" reflects worst-case Claude Code Max RPM (~5–10 RPM in practice); Anthropic-API-key operators with 50+ RPM can raise to 4–8 via the setting. Hard-coding the default to a higher number would silently throttle Max-tier users.

- **`cache_control` for Claude CLI.** Not applicable: the `claude -p` binary accepts a single user prompt over stdin (see [`src/lib/llm/claude-cli.ts:36`](../../src/lib/llm/claude-cli.ts)); there's no surface to inject the `messages`-array-with-`cache_control` shape. Claude Code may auto-cache on its own session, but we don't control that from the worker. The OpenRouter follow-on covers the case where caching is controllable.

## Consequences

- **Spec rewrites.** `docs/histforge-spec.md` §11 (Enrichment) becomes §11 (Visual prompt generation); line 814 ("Re-running `enrich_chunks` regenerates `prompt` from scratch") is rewritten to "Re-running `generate_visual_prompts` directly fills missing prompts only (skip if `prompt !== null`); to regenerate from scratch, roll back to step 08." §16 step list updates the step name.

- **DB migration.** Boot-time `UPDATE steps SET name='generate_visual_prompts' WHERE name='enrich_chunks'`. One-shot, irreversible. Runs from the worker boot path; same place future migrations would live.

- **Test rewrites.** The main step test (`__tests__/unit/worker/steps/enrich-chunks.test.ts`) is renamed and rewritten: the "calls LLM once per chunk" and "resets `prompt_history` on every iteration" assertions become obsolete, replaced with batched-call shape, ID-keyed parse validation, retry-then-per-chunk fallback, skip-already-enriched, eager `prompt_history` reset sweep, and mutex-serialized concurrent writes. The other test files that reference the literal `"enrich_chunks"` string — `__tests__/unit/worker/pipeline.test.ts`, `__tests__/unit/worker/pipeline-workflow.test.ts`, `__tests__/unit/lib/workflows.test.ts`, `__tests__/unit/lib/workflows-edit.test.ts`, `__tests__/api/workflows/schema/route.test.ts`, and its snapshot `__tests__/api/workflows/schema/__snapshots__/schema.json` — change in lockstep with the rename.

- **Domain-skill doc updates.** All five domain skills that reference the old step name need updates: `domain-content-gen` (currently documents the per-chunk persistence loop and the `prompt_history` reset semantics), `domain-pipeline`, `domain-workflows`, `domain-google-flow-coordinator` (references `enrich_chunks` in the moderation-loop anchors), and `domain-media`.

- **Operator surface.** Three new settings appear in the Settings UI (`visual_prompts_batch_size`, `claude_cli_visual_prompts_concurrency`, `openrouter_visual_prompts_concurrency`); their defaults are safe so most operators never touch them. The dashboard "re-run step" affordance for `generate_visual_prompts` now behaves as resume (not regen) — operators who want regen take the rollback-to-08 path.

- **Follow-on artifacts** (intentionally out of scope, each its own plan):
  - `lib/atomic-write.ts` helper + migration of all `chunks.json` writers
  - OpenRouter `undici.Agent` HTTP keepalive
  - OpenRouter `cache_control` breakpoint with system/user `messages` split (requires reordering the prompt template)
  - Operator-side guidance on `claude_cli_visual_model` (haiku-4-5 vs opus-4-7 for this step)
