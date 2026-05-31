# Performance notes

Observed costs and capacity headroom for HistForge subsystems. Add an
entry when a change introduces a measurable cost worth tracking; remove
when a follow-up optimization eliminates it.

---

## Step 09 (`generate_visual_prompts`) — doodle metaphor skill injection

**Added:** image-styles PR, Session 1, Task 6 (2026-05-31).

**What:** Doodle variants (`doodle_polished`, `doodle_rough`) append the
narration-to-visual-metaphor skill (`prompts/09_doodle_visual_metaphor_skill.md`)
to the LLM system prompt. Cinematic / null image_style is unaffected.

**Skill size:**
- 189 lines / ~2,091 words / 13,185 characters
- Token estimate: ~3.5K–4K Claude tokens (at ~3.5 chars/token for English).

**LLM call cadence:** **per-batch**, NOT per-chunk. Confirmed at
`src/worker/steps/09-generate-visual-prompts.ts:464` — `deps.chat(...)`
runs once per batch inside `callBatchWithRetry`, retried at most once
on parse failure.

- Batch size K = `visual_prompts_batch_size` setting, default **8**.
- A 200-chunk video at K=8 → **25 batches** → 25 LLM calls.
- A 60-chunk video at K=8 → **8 batches** → 8 LLM calls.

**Skill is loaded once per step run** (single `readFileSync` at step
entry), then the same composed system prompt is sent on every batch call
— no per-batch file I/O.

**Per-call context size with skill:**
- System: ~3.5K tokens (skill + bare `SYSTEM_INSTRUCTION` ≈ 50 tokens)
- User: ~1–2K tokens for the batch JSON (8 chunks × ~150 tokens each)
- Total per call: **~5K tokens**
- Well under any current Claude model's context window (100K–1M).
  **NOT a correctness risk** — no single call comes close to a limit.

**Per-video injection cost:**
| Chunk count | Batches | Total skill tokens injected per run |
|---|---|---|
| 60 | 8 | ~28K |
| 100 | 13 | ~45K |
| 200 | 25 | ~87K |
| 400 | 50 | ~175K |

Each row is the per-doodle-video billable overhead from skill injection
alone (the skill content sent N times = N × ~3.5K). The 15 few-shots in
the skill are the bulk of those tokens; the rules section is shorter.

**Not optimized in this PR — deliberate. Follow-up candidates:**

1. **Anthropic prompt caching.** The system prompt is byte-identical
   across all batches in a single step run. If the LLM provider supports
   ephemeral prompt caching (Anthropic's `cache_control: ephemeral` on
   the system message), every batch after the first hits cache for the
   skill chunk. Saves ~96% of the skill cost on a multi-batch run. The
   chat client wrapper at `src/lib/llm/` would need a cache-control
   hint plumbed through — not free, but small.
2. **Condense the skill.** The 15 few-shots are the biggest budget
   item. A condensed version (rules + 5 representative few-shots) could
   plausibly steer almost as well at ~1/3 the tokens. Would need
   side-by-side eval against the reference channel to confirm quality
   parity before shipping.
3. **One LLM call per video.** Step 09 currently batches; a redesign
   that sends the whole script in a single call would amortize the
   skill to 1× per video instead of N×. Largest refactor; probably not
   worth it unless the per-batch retry-and-fallback machinery is also
   being rethought.

Decide based on observed bills once doodle workflows are in regular use.
None of these is a Session 1 / Session 2 deliverable.
