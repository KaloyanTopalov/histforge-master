# Batch Chapter Writing (3 per call, 500-word summaries)

## Overview
Rewrite step 04 to generate chapters in batches of 3 instead of one at a time, and update the running summary once per batch at 500 words instead of once per chapter at 200 words. This cuts API calls from 31 to 11, reduces input token consumption by ~49% (the outline + characters context is repeated 5 times instead of 15), and improves narrative continuity since each batch writes 3 chapters with full awareness of each other.

## Current State
- Step implementation: `src/worker/steps/04-write-chapters.ts` — per-chapter loop at line 94 making 2 LLM calls per chapter (write + summarize)
- Write prompt: `prompts/04_write_chapter.md` — writes one chapter, 1100-1300 words
- Summary prompt: `prompts/04_story_so_far.md` — targets ~200 words, summarizes one chapter
- Structure extraction prompt: `prompts/04_extract_structure.md` — unchanged by this work
- LLM client: `src/lib/openrouter.ts` — sends `{ model, messages }`, no `max_tokens` (Sonnet defaults to 8,192 output tokens; 3 chapters at ~1,600 tokens = ~4,800, fits comfortably)
- Tests: `__tests__/unit/worker/steps/write-chapters.test.ts` — 5 tests covering happy path, resume, and failure
- Resume logic: `existsSync(chapterPath)` per chapter + `story_so_far.md` seeded from disk

## Scope
**Doing**: Batch the chapter-write loop into groups of 3; update summary prompt to 500 words and accept batch input; update prompt template for multi-chapter output with a parseable separator; update resume logic to work at batch granularity; update all tests.

**Not doing**: Changing chapter_count, act_distribution, or any other settings. Not touching steps 01-03, 05, or 09. Not adding max_tokens to the LLM client (default 8,192 is sufficient). Not making batch size a configurable setting (hardcoded constant for now).

## Tasks

### Phase 1: Prompt templates

- [x] **Task 1: Create batch write prompt**
  **Files**: `prompts/04_write_chapters_batch.md` (new), `prompts/04_write_chapter.md` (delete)
  **What**: A prompt that accepts multiple chapters' metadata and produces all of them in a single response, separated by a machine-parseable delimiter. Each chapter still targets 1100-1300 words.
  **Context**: The current single-chapter prompt is at `prompts/04_write_chapter.md`. The new prompt should accept `{{chapters_block}}` (a pre-formatted block of all chapter numbers/titles/summaries in the batch) instead of individual `{{number}}`/`{{chapter_title}}`/`{{chapter_summary}}` vars. Use a separator like `---CHAPTER_BREAK---` on its own line between chapters. The prompt must instruct the model to NOT put the separator before the first chapter or after the last. All existing shared fragments (`{{banned_words}}`, `{{numbers_as_letters}}`, `{{format_guidelines}}`, `{{audience_profile}}`) must still be referenced. The prompt still receives `{{outline}}`, `{{characters}}`, and `{{story_so_far}}`.

- [x] **Task 2: Update summary prompt to 500 words**
  **Files**: `prompts/04_story_so_far.md`
  **What**: Increase target from ~200 words to ~500 words. Change input from a single chapter to `{{new_chapters}}` (the full batch text). Update instructions to reflect that multiple chapters are being summarized at once.
  **Context**: Current prompt at `prompts/04_story_so_far.md:1` says "Keep it to about two hundred words" and has `{{chapter}}` as the input variable. Change to `{{new_chapters}}` and "Keep it to about five hundred words". The focus areas (character positions, emotional state, unresolved threads) should remain.

### Phase 2: Step implementation

- [x] **Task 3: Rewrite the chapter loop to batch by 3**
  **Files**: `src/worker/steps/04-write-chapters.ts`
  **What**: Replace the per-chapter loop (lines 94-149) with a batch loop that processes 3 chapters at a time, parses the separator-delimited output into individual chapter files, and calls the summary prompt once per batch.
  **Context**:
  - Define `BATCH_SIZE = 3` as a named constant (exported for tests).
  - Batch formation: iterate `i = 0; i < chapterCount; i += BATCH_SIZE`. Each batch is a slice of the `structured` array. The last batch may have fewer than 3 chapters if `chapterCount` is not divisible by 3.
  - **Resume logic**: A batch is skipped if ALL chapter files in that batch already exist on disk. If ANY chapter in the batch is missing, re-run the entire batch (overwriting any that did exist). This is simpler than partial-batch resume and the cost of re-generating 1-2 chapters is negligible.
  - Build `{{chapters_block}}` by formatting each chapter's number/title/summary, e.g. `CHAPTER 2: Title Here\nSummary text...` separated by blank lines.
  - Parse the LLM response by splitting on the `---CHAPTER_BREAK---` separator. Validate that the split produces exactly the expected number of parts; throw if not (with a clear error message).
  - Write each chapter file atomically using the existing `writeFileAtomic` helper (lines 199-203).
  - After all chapters in the batch are written, call the summary prompt with `{{new_chapters}}` set to the full batch output, then write `story_so_far.md` atomically.
  - `story_so_far.md` on disk should reflect the last completed batch (same pattern as today, just at batch granularity). Seed from disk before the loop (existing line 90-92 logic).
  - The `WriteChaptersDeps` interface and the exported `step` object stay the same shape.

### Phase 3: Test updates

- [x] **Task 4: Update test prompts and fake chat for batch mode**
  **Files**: `__tests__/unit/worker/steps/write-chapters.test.ts`
  **What**: Update `seedPrompts` to use the new `04_write_chapters_batch.md` template name and `{{chapters_block}}`/`{{new_chapters}}` variables. Update the fake `chat` routing to recognize batch-write prompts (which will contain `WRITE_BATCH|` prefix) and return multi-chapter responses joined by `---CHAPTER_BREAK---`. Update the story responder to accept `{{new_chapters}}` instead of `{{chapter}}`.
  **Context**: The `seedPrompts` function at line 57 currently writes stub templates with `WRITE|` and `STORY|` prefixes. The `makeFakeChat` function at line 109 routes on these prefixes. Both need updating to match the new prompt template names and variable names.

- [x] **Task 5: Update happy-path tests for batch behavior**
  **Files**: `__tests__/unit/worker/steps/write-chapters.test.ts`
  **What**: Update all 4 happy-path tests to reflect batch semantics.
  **Context**:
  - Test "extracts structure, writes one chapter" (line 170): `chapter_count=1` still works — it's a batch of 1. Call sequence becomes: extract, batch-write, story. Same 3 calls.
  - Test "skips Phase A when JSON exists" (line 220): Same as above minus extract. 2 calls.
  - Test "skips chapters that already exist" (line 271): `chapter_count=3`. All 3 chapters are in one batch. If all 3 exist on disk, skip the batch entirely — 0 calls (no extract since JSON exists). Need a new variant: if chapters 1-3 exist (batch 1 complete) but chapters 4-6 don't (batch 2 incomplete), only batch 2 runs.
  - Test "story_so_far accumulation" (line 339): With `chapter_count=2`, both are in one batch. The story call happens once after the batch. To test cross-batch accumulation, increase to `chapter_count=6` (2 batches of 3) and verify batch 2's write prompt sees the summary from batch 1.

- [x] **Task 6: Update failure test for batch behavior**
  **Files**: `__tests__/unit/worker/steps/write-chapters.test.ts`
  **What**: Update the failure test to verify that if the batch LLM call fails, no chapter files from that batch are written (atomic batch semantics — either all chapters in the batch are committed or none).
  **Context**: Current test at line 378 verifies per-chapter atomicity. With batching, if the write call throws, no files from that batch should exist. If the write succeeds but separator parsing fails (wrong number of parts), same — no files written. Add a test for the parsing validation: LLM returns 2 parts when 3 expected.

## References
- `src/worker/steps/04-write-chapters.ts` — current implementation
- `prompts/04_write_chapter.md` — current single-chapter prompt
- `prompts/04_story_so_far.md` — current summary prompt
- `__tests__/unit/worker/steps/write-chapters.test.ts` — current tests
- `src/lib/prompts.ts:16` — `render()` function (template rendering)
- `src/lib/openrouter.ts:51` — request body shape (no max_tokens needed)
- `src/worker/pipeline.ts:82` — `STEP_OUTPUTS` (write_chapters is `[]`, no change needed)
