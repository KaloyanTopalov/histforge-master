# Auto-moderation of Google Flow Content-Policy Failures

## Overview

When Google Flow rejects an image or video prompt for content-policy reasons (`CHILD_DANGER`, `SAFETY`, `VIOLENCE`, `PERSON_GENERATION`, `PUBLIC_ERROR_*_FILTER`, etc.), HistForge currently fails the queue row permanently and — once any chunks fail — fails the whole step. This plan adds an in-step moderation loop that, after every wait-drain inside `runGoogleFlowStep`, batches the rejected prompts to a "moderator" LLM, rewrites them, requeues, and tries again. Bounded by a configurable round count (default 2). The dashboard surfaces both an inline indicator on the Flow progress card and a dedicated "Content moderation" panel listing every rewrite (original prompt → rewritten prompt → reason tag) per round, persisted in a new `moderation_events` table.

Scope is **Google Flow only**. ComfyUI and other providers are unchanged.

## Current State

- Step orchestration: `src/worker/steps/google-flow-common.ts:50` — `runGoogleFlowStep` enqueues per-chunk tasks, calls `waitForFlowQueue` (`src/lib/flow-wait.ts:50`) until `pending+dispatched=0`, then aggregates failures by checking missing output files (`google-flow-common.ts:127-138`) and throws if any are missing. The two Google Flow steps (`generate-main-images-google-flow.ts:15`, `generate-hook-video-google-flow.ts:15`) each delegate to this single function.
- Content-policy detection is already wired end-to-end. The extension's `extensions/youforge-flow/src/flow-error.js:19` parses Google's error envelope and tags failures with `category: 'content_policy'` and `contentPolicyTag` (e.g. `CHILD_DANGER`). The submit-result route (`src/app/api/flow/submit-result/[token]/route.ts:109,164-168`) routes those to `gfRepo.failTask()` with the raw error in `error_reason` — no retry, by design.
- Chunks: `src/types.ts:123-130`. `Chunk.prompt: string | null` is the **single** field consumed by both image and video generation; "main" chunks → images, "hook" chunks → videos (no overlap). Step 9 (`src/worker/steps/09-enrich-chunks.ts`) writes `prompt` from a per-chunk LLM call against `prompts/09_enrich_chunk.md`, persisting `chunks.json` after each chunk.
- Queue schema: `src/lib/db.ts:127`. `google_flow_queue` already has `error_reason`, `retry_count`, `status` ∈ `{pending, dispatched, done, failed}`. Repos at `src/lib/repos/google-flow.ts` (`enqueueTask:144`, `failTask:287`, `requeueTask:315`, `listFailedForVideo:349`).
- Settings: `src/lib/settings.ts` (per-key Zod), defaults at `src/lib/db.ts:11`. Settings UI: `src/app/settings/settings-form.tsx` — Google Flow tab at `:235`, advanced collapsible at `:286`.
- Flow summary plumbing: `src/lib/flow-summary.ts` (server-side build), `src/app/videos/[id]/video-detail-client.tsx:86` (FlowCountsRow) and `:339` (the "Flow progress" card with expand-failed list at `:399-427`). Page polls via `/api/flow/queue-summary/[id]` every 5s.
- LLM client: `src/lib/llm/openrouter.ts:23` — `chat(messages, opts)` with built-in 3-attempt retry; model defaults from `model_name` setting unless `opts.model` is passed.
- Existing safety guidance to seed the moderator prompt from: `prompts/09_enrich_chunk.md:15-46` (forbidden language, reframe examples). Real-world examples and the failure modes seen so far: `docs/references/content_violations.md`.

## Scope

**Doing**:
- New moderator step-internal loop inside `runGoogleFlowStep` that runs *after* the wait-drain on every iteration, detects content-policy failures, batches them to a moderator LLM, rewrites prompts in `chunks.json` + the queue rows, requeues, and re-enters the wait. Bounded by `google_flow_content_moderation_max_rounds`. **Round semantics: `max_rounds = N` means up to N rewrites past the original generation attempt — valid round numbers are 1..N inclusive, computing round=N+1 bails.**
- New shared content-policy classifier `src/lib/flow-error-classify.ts` that exports the canonical regex/predicate, imported by both `submit-result/route.ts` (replacing the inline one at `:65-71`) and the new moderation loop. Removes the worst long-term drift risk between the two call sites.
- New `moderation_events` table (per-video, cascade-deleted with the video) capturing every rewrite for audit/UI.
- New `moderation_round INTEGER NOT NULL DEFAULT 0` column on `google_flow_queue` plus a corresponding field on the `GoogleFlowQueueItem` TS type so re-blocked rewrites can be distinguished round by round.
- New `prompt_history: string[]` field on `Chunk` (in `chunks.json`), with one declared invariant: ordered list of prior `prompt` values, oldest-first, current `prompt` excluded; reset to `[]` whenever step 9 regenerates `prompt`.
- New moderator prompt template `prompts/moderate_blocked_prompts.md` derived from existing safety guidance + `docs/references/content_violations.md` examples.
- Three new settings (Google Flow tab, advanced section): `google_flow_content_moderation_enabled` (default true), `google_flow_content_moderation_max_rounds` (default 2, range 0–10), `google_flow_content_moderation_model` (string; empty = fall back to `model_name`).
- New API route `GET /api/videos/[id]/moderation` returning the moderation_events for a video.
- UI changes on the video detail page: an inline "Moderation: round N/M" indicator on the Flow progress card (derived from queue + events), and a new collapsible "Content moderation" panel listing each event (kind, chunk_id, round, original prompt, rewritten prompt, reason tag, timestamp).
- Vitest tests: moderator-batcher unit tests, end-to-end loop test for `runGoogleFlowStep` against a mocked queue + chat, schema migration test, and a unit test for the shared classifier.

**Backward compatibility note**: After this feature ships, existing failed-from-prior-runs videos have queue rows with `moderation_round = 0` (column default). On retry/restart, those rows will be picked up by the moderation loop at round 1, which is the desired behavior — the only "surprise" is that videos that were stuck in failed will now self-heal on their next pipeline pass.

**Not doing**:
- ComfyUI and any non-Google-Flow providers. ComfyUI does not surface content-policy errors the same way and is out of scope.
- A "skip-and-continue with placeholder" pathway. After max rounds the step throws (preserves the existing "any failure ⇒ step failed" contract); operators can manually edit prompts and use the existing `/api/flow/requeue-failed/[id]?force=1` to retry, or restart from `enrich_chunks` to regenerate the entire prompt set.
- A literal "moderator is calling the LLM right now" status flag. UI infers "moderation pending" from queue state + event rows.
- Reference-image / start-frame / end-frame fields on the queue. The moderator only rewrites the `prompt` text.
- Changes to the workflow registry — both Google Flow steps still appear under the same names; the new behavior is internal to `runGoogleFlowStep`.

## Tasks

### Phase 1: Schema, types, settings, prompt template

- [x] **Task 1: Add moderation_round column + moderation_events table + type updates**
  **Files**: `src/lib/db.ts`, `src/types.ts`
  **What**:
  1. In `src/lib/db.ts`, extend the `createDb` schema block to add (a) `moderation_round INTEGER NOT NULL DEFAULT 0` to `google_flow_queue` via the additive ALTER TABLE pattern at `:165-186` (duplicate-column-error swallow + rethrow), and (b) a new `moderation_events` table with `id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, chunk_id TEXT NOT NULL, kind TEXT NOT NULL, round INTEGER NOT NULL, original_prompt TEXT NOT NULL, rewritten_prompt TEXT NOT NULL, reason_tag TEXT, created_at INTEGER NOT NULL` plus an index on `(video_id, created_at)`. The cascade FK relies on `foreign_keys = ON` (already pragma'd at `db.ts:85`); the table is created via `CREATE TABLE IF NOT EXISTS` so it's idempotent on upgraded DBs.
  2. In `src/types.ts:57-78`, add `moderation_round: number;` to the `GoogleFlowQueueItem` interface so the new repo helpers and the loop typecheck.
  3. In `src/types.ts`, add a new `ModerationEvent` interface mirroring the table columns: `id: number; video_id: string; chunk_id: string; kind: GoogleFlowQueueKind; round: number; original_prompt: string; rewritten_prompt: string; reason_tag: string | null; created_at: number;`. This is the shape returned by `listModerationEventsForVideo` (Task 6b), the response body of the new API route (Task 11), and the items rendered by the dashboard panel (Task 14).
  **Context**: Spec is the source of truth per CLAUDE.md — the schema additions land in `docs/histforge-spec.md` as part of Task 19 in the same PR.

- [x] **Task 2: Seed the three new settings**
  **Files**: `src/lib/db.ts` (DEFAULT_SETTINGS), `src/lib/settings.ts` (SETTING_SCHEMAS)
  **What**: Add `google_flow_content_moderation_enabled` (`"true"`/`"false"` enum, default `"true"`), `google_flow_content_moderation_max_rounds` (`"2"`, coerced int 0–10), `google_flow_content_moderation_model` (string, default `""`). Use the same Zod patterns as the existing `google_flow_*` keys at `settings.ts:22-50`. Empty string for the model setting means "fall back to model_name" — the consumer handles that.
  **Context**: For schema migrations on existing DBs, follow the `INSERT OR IGNORE` pattern at `db.ts:201-203` so upgraded installs that don't re-run db:init still pick up the defaults.

- [x] **Task 3: Extend the Chunk type with prompt_history**
  **Files**: `src/types.ts`
  **What**: Add `prompt_history?: string[]` to the `Chunk` interface at `:123-130`. Document the invariant in a doc comment on the field: ordered list of prior `prompt` values, oldest-first, current `prompt` excluded; reset to `[]` whenever step 9 regenerates `prompt`. Optional for back-compat with existing `chunks.json` files (consumers must coalesce undefined → [] before pushing).
  **Context**: The Chunk type is the single source of truth (per the file's header at `:1-9`). Mirror the comment style. This is the single declared invariant the rest of the plan refers back to (Task 4 enforces the reset, Task 9 enforces the append).

- [x] **Task 4: Clear prompt_history on enrich_chunks rerun**
  **Files**: `src/worker/steps/09-enrich-chunks.ts`
  **What**: When writing a new `prompt` for a chunk, also set `prompt_history = []` (or omit the field). The enrich step regenerates the prompt from scratch, so the moderation lineage from any prior pipeline run is no longer relevant.
  **Context**: Make the change at `:63` where `chunks[i].prompt = reply` is set, before the `writeFileSync` at `:66`.

- [x] **Task 5: Author the moderator prompt template**
  **Files**: `prompts/moderate_blocked_prompts.md` (new)
  **What**: A prompt that takes a JSON array of `{id, kind, reason_tag, prev_text, current_text, next_text, original_prompt}` items and returns a JSON object `{rewrites: [{id, rewritten_prompt}, ...]}`. The body should:
  - Restate the no-real-people, no-graphic-violence, no-discrimination-framing rules from `prompts/09_enrich_chunk.md:15-46`.
  - List Google's policy categories the system has actually seen, drawn from `extensions/youforge-flow/src/flow-error.js:19-103` (CHILD_DANGER, SAFETY, VIOLENCE, PERSON_GENERATION, ADULT, PROFANITY, CONTENT_POLICY_VIOLATION, BLOCKED_REASON_SAFETY, PUBLIC_ERROR_*_FILTER) and the audio-filter cases from `docs/references/content_violations.md` (PUBLIC_ERROR_DANGER_FILTER, PUBLIC_ERROR_AUDIO_FILTERED).
  - Include 3–4 worked rewrite examples drawn from `docs/references/content_violations.md` (the Pazzi / Giuliano / illegitimate-boy / military-commander cases) — show the original prompt, the reason_tag, and the rewritten prompt.
  - Tell the model the rewrite must preserve the historical scene and emotional weight while removing the trigger language.
  - Specify the output as **JSON only**, no preamble, schema documented inline.
  - Note: the file will grow over time as more violation categories are added — keep the structure additive.
  **Context**: Loaded at runtime via `src/lib/prompts.ts` (same loader the enrich step uses). Use `{{batch_json}}` as the single template variable for the input array. **Pre-task check**: open `src/lib/prompts.ts` and confirm the loader handles arbitrary `{{var}}` substitution (step 9 already passes 4 named vars, so it almost certainly does — but verify). If the loader's substitution is per-key from a fixed map, no change needed; if it's tied to a hard-coded variable list, extend it.

### Phase 2: Shared classifier, repo helpers, moderator client

- [x] **Task 6a: Extract the content-policy classifier into a shared module**
  **Files**: `src/lib/flow-error-classify.ts` (new), `src/app/api/flow/submit-result/[token]/route.ts`
  **What**: Move the inline `classifyError` function from `submit-result/route.ts:65-71` into the new shared module, exporting:
  1. The existing 3-way `classifyError(raw: string): "content_policy" | "quota" | "transient"` (verbatim — submit-result imports it; no behavior change).
  2. A single-purpose predicate `isContentPolicyError(reason: string): boolean` for filtering failed queue rows.
  3. A tag extractor `extractContentPolicyTag(reason: string): string | null` that scans `reason` for the first match against the canonical policy-code list (CHILD_DANGER, SAFETY, VIOLENCE, PERSON_GENERATION, ADULT, PROFANITY, CONTENT_POLICY_VIOLATION, BLOCKED_REASON_SAFETY, POLICY_VIOLATION, PROHIBITED_CONTENT, plus the `PUBLIC_ERROR_*_FILTER(?:_FAILED|_ED)?` and `PUBLIC_ERROR_*_FILTERED` variants seen in `docs/references/content_violations.md`). Returns null when no policy code is found — the moderation loop falls back to the full `error_reason` for the moderator's `reason_tag`, which is acceptable.
  All three are imported by the moderation loop (Task 9 step 5) and the repo helper (Task 7).
  **Context**: The empirical reasoning that justifies a single regex (`/SAFETY|CHILD_DANGER|PUBLIC_ERROR_/`) for detecting content-policy among `failed` rows: quota / auth / rate_limit / stale_project / create_project_failed paths all *requeue* (never `failTask`), so they don't appear as failed rows. Transient-exhausted rows match YouForge's `TRANSIENT_RE = /5\d\d|TIMEOUT|UNAVAILABLE|ECONNRESET|FETCH|ABORT|NETWORK|UPSTREAM/` (`extensions/youforge-flow/src/flow-error.js`), which has empty intersection with the content-policy regex. So the single regex is sufficient on `error_reason` of failed rows. Document this reasoning in the new module's doc comment so a future reader doesn't reintroduce the drift.

- [x] **Task 6b: Add moderation-event repo functions**
  **Files**: `src/lib/repos/google-flow.ts` (or new `src/lib/repos/moderation.ts` — pick whichever is more in keeping with the file layout; the moderation table is intimately tied to the flow queue, so colocating in `google-flow.ts` is fine)
  **What**: `insertModerationEvent(db, {video_id, chunk_id, kind, round, original_prompt, rewritten_prompt, reason_tag, created_at})` returning the new id, and `listModerationEventsForVideo(db, videoId)` returning rows ordered by `created_at ASC`. Mirror the thin-atomic-SQL style of the existing repo file at `repos/google-flow.ts:11-15`.

- [x] **Task 7: Add helpers for moderation-round bookkeeping on queue rows**
  **Files**: `src/lib/repos/google-flow.ts`
  **What**: (a) `listFailedContentPolicyForVideo(db, videoId, kind)` — returns `failed` rows whose `error_reason` is non-null and `isContentPolicyError(error_reason)` returns true (imported from Task 6a). Implement as a SELECT of all failed rows for (video_id, kind) followed by an in-memory filter; the table is small (one row per chunk), and the regex doesn't need to live in SQL. (b) `requeueWithNewPrompt(db, id, newPrompt, newRound)` — single transactional update that sets `prompt = ?, status = 'pending', moderation_round = ?, error_reason = NULL, assigned_account_id = NULL, dispatched_at = NULL, external_task_id = NULL`. retry_count is intentionally preserved so transient retries from prior attempts still count toward the cap.
  **Context**: Follow `requeueTask:315` for the field-clearing pattern. Don't bump retry_count — moderation is a separate dimension. The classifier from Task 6a guarantees consistency with the submit-result route.

- [x] **Task 8: Add the moderator client wrapper**
  **Files**: `src/lib/moderator.ts` (new)
  **What**: `moderateBatch(items, deps): Promise<Map<chunkId, rewrittenPrompt>>` where `items: Array<{id, kind, reason_tag, prev_text, current_text, next_text, original_prompt}>`. Renders `prompts/moderate_blocked_prompts.md` via `lib/prompts.ts`, **substituting `JSON.stringify(items, null, 2)` for the `{{batch_json}}` placeholder** (pretty-printed for the LLM's benefit), calls `chat()` with `opts.model` set from `google_flow_content_moderation_model` (falling back to undefined when empty so `chat()` defaults to `model_name`), parses the JSON envelope, and returns the id→rewritten map. Throws on JSON parse failure. Two retries around the parse step (the underlying chat() already retries network errors).
  **Context**: Take `db, chat, promptsDir` as injected deps so tests can stub `chat`. Mirror the `EnrichChunksDeps` shape at `src/worker/steps/09-enrich-chunks.ts:11-19` so the chat-dep signature matches: `chat?: (messages: ChatMessage[], opts?: { db?: DatabaseType; model?: string }) => Promise<string>`. Note the additional `model` field on opts — `lib/llm/openrouter.ts:35` already supports it via `ChatOpts`, so this is just exposing it through the dep type. Don't import the OpenRouter module directly — use the same chat-injection pattern as the enrich step.

### Phase 3: Wire the moderation loop into runGoogleFlowStep

- [x] **Task 9: Refactor runGoogleFlowStep into a moderation-aware loop**
  **Files**: `src/worker/steps/google-flow-common.ts`
  **What**: After the existing `waitForFlowQueue` returns `ok` (`:113`) and **before** the existing failure aggregation throw (`:127-138`):
  1. Read `google_flow_content_moderation_enabled`. If false, fall through to existing behavior (preserves the current contract for operators who turn this off).
  2. List content-policy failures for this video + queue kind via `listFailedContentPolicyForVideo`.
  3. If empty, fall through.
  4. Determine the round number for this batch: `nextRound = max(failedRow.moderation_round) + 1` over the rows from step 2. **Round semantics: `max_rounds = N` means up to N rewrites past the original — valid `nextRound` is 1..N inclusive.** If `nextRound > google_flow_content_moderation_max_rounds`, fall through (the existing aggregation will throw with the policy reasons).
  5. Read `chunks.json`, build the batch payload (id, kind, `reason_tag` extracted from `error_reason` via `extractContentPolicyTag` from Task 6a — falling back to the full `error_reason` when the extractor returns null, prev/current/next text, original prompt from the queue row).
  6. Call the moderator. Log the round + count via `deps.log(...)`, then for each rewrite log a one-line entry: `[moderation r${nextRound}] ${chunk_id} (${reason_tag}) → ${rewrittenPrompt.slice(0, 80)}…` so pipeline.log carries enough detail for after-the-fact forensics. Mirrors the diagnostic style of the existing failed-aggregation throw at `:131-137`.
  7. **Atomic write order** (this is the critical correctness piece): build an in-memory updated copy of `chunks.json` first — for each rewrite, coalesce `chunk.prompt_history ?? []`, push the current `chunk.prompt`, set `chunk.prompt = rewritten`. Then run a single SQLite transaction that, for *every* rewrite in the batch, inserts the moderation_events row and calls `requeueWithNewPrompt(id, rewritten, nextRound)`. After the transaction commits, write the updated `chunks.json` to disk in one shot via plain `writeFileSync(chunksPath, JSON.stringify(updated, null, 2), "utf-8")` — matching the existing pattern at `09-enrich-chunks.ts:66`. Don't introduce atomic-rename here; uniformity beats marginal robustness.
     - **Crash safety reasoning**: a crash before the txn → no state changed, re-process from scratch on resume. A crash mid-txn → SQLite rolls back, same outcome. A crash between commit and the `chunks.json` write → DB has new prompts on the queue rows + events; chunks.json is slightly stale (still shows old `prompt`, missing the new prompt_history entry). This is *harmless*: chunks.json is only re-read at the *start* of the step to enqueue new chunks that lack open queue rows; the rows requeued by moderation already exist and use the queue row's `prompt` for generation. The chunks.json staleness is purely cosmetic for the prompt_history debug field; the moderation_events table holds the canonical record.
     - **Do not persist chunks.json after each rewrite** — that pattern is fine for the per-chunk LLM loop in `09-enrich-chunks.ts:65-66` because each chunk is independent; here a partial batch persisted to disk would diverge from the DB state.
  8. Re-enter `waitForFlowQueue`. Loop until either: no content-policy failures remain, or `nextRound > max_rounds`.
  9. After the loop, run the existing missing-file aggregation `:127-138` unchanged.
  **Context**: On worker resume, the loop re-enters, sees the latest `moderation_round` on each failed row (set in step 7's txn), and computes the correct next round. The "skip null prompt" branch (`google-flow-common.ts:81-84`) is unaffected — moderation only rewrites already-non-null prompts. Add a constant `MAX_MODERATION_ITERATIONS_GUARD = 10` belt-and-suspenders to prevent runaway loops if the round arithmetic is wrong. The `outputs: []` declaration on the two Google Flow step files (`generate-main-images-google-flow.ts:31`, `generate-hook-video-google-flow.ts:31`) means the orchestrator's failure-cleanup path (`pipeline.ts:160`) won't delete queue rows or moderation_events on step failure — they survive across retry/restart, which is correct (the events are tied to `videos(id)` and only cascade on video delete).

- [x] **Task 10: Inject moderator deps into the step**
  **Files**: `src/worker/steps/google-flow-common.ts`, `src/worker/steps/generate-main-images-google-flow.ts`, `src/worker/steps/generate-hook-video-google-flow.ts`
  **What**: Extend `GoogleFlowStepDeps` with optional `chat` and `promptsDir` (same shape as `EnrichChunksDeps` at `09-enrich-chunks.ts:11-19`). Both step entry points (`generate-main-images-google-flow.ts:33`, `generate-hook-video-google-flow.ts:33`) pass `ctx.chat` and `ctx.promptsDir` through to `runGoogleFlowStep`.
  **Context**: Step 9 (`09-enrich-chunks.ts:75-82`) already receives `ctx.chat` and `ctx.promptsDir`, which means the orchestrator's `Step` ctx already exposes them — no `pipeline.ts` change is required. The Google Flow steps just need to pass them through.

### Phase 4: API + dashboard

- [~] **Task 11: New API route returning moderation events** *(N/A — events folded into `FlowSummary` in Task 12; no standalone route was built. Originally specified as `GET /api/videos/[id]/moderation` returning `{events: ModerationEvent[]}`.)*

- [x] **Task 12: Surface moderation summary + events in flow-summary**
  **Files**: `src/lib/flow-summary.ts`
  **What**: Extend `FlowSummary` with a `moderation` object whose per-kind state is **nested** to mirror the rest of the FlowSummary shape (`main_image: FlowKindCounts` / `hook_video: FlowKindCounts`). Final shape: `moderation: { max_rounds: number; last_event_at: number | null; main_image: { round, pending }; hook_video: { round, pending }; events: ModerationEvent[] }`. Field semantics:
  - `max_rounds`: snapshot of `google_flow_content_moderation_max_rounds` so the UI can render "round X/N" without a separate settings fetch.
  - `last_event_at`: latest `moderation_events.created_at` for the video, or null if none.
  - `<kind>.round`: highest `moderation_round` seen across that kind's non-done queue rows (0 if none). Per-kind so a hook_video CP failure does not leak its round number into the main_image row's indicator.
  - `<kind>.pending`: count of failed-content-policy rows for that kind whose `moderation_round < max_rounds` (i.e., eligible for the next round).
  - `events`: full `ModerationEvent[]` for the video, oldest-first (powers Task 14's panel without a second poll).
  `buildFlowSummary` populates it via `listModerationEventsForVideo`.
  **Deviation from original plan**: original draft had a flat moderation block with video-wide `round` and suffix-keyed `pending_main_image` / `pending_hook_video`. The nested shape was adopted during Phase 4 review for symmetry with the rest of `FlowSummary` (every other per-kind metric is nested by kind) and to fix a per-row indicator leak.
  **Context**: Used by both `src/app/videos/[id]/page.tsx` server-side prefetch and the `/api/flow/queue-summary/[id]` route — both call sites must continue to compile after the type extension. Embedding events here folds the dashboard's moderation poll into the existing flow-summary 5s tick (one round-trip instead of two). For typical 20-chunk videos with a handful of moderations the payload stays well under a few KB; if it ever grows unwieldy, the canonical follow-up is to split events back out into a separate route (the original Task 11 shape) — but that's not the chosen path for this PR.

- [x] **Task 13: Inline moderation indicator on Flow progress card**
  **Files**: `src/app/videos/[id]/video-detail-client.tsx`
  **What**: Render a small indicator next to each `FlowCountsRow` inside the existing card (e.g., "moderating N…" or "moderation round X/M"). Per row: the main-image row reads `flowSummary.moderation.main_image.{round,pending}`, the hook-video row reads `flowSummary.moderation.hook_video.{...}`, and `max_rounds` comes from `flowSummary.moderation.max_rounds` (per the nested shape adopted in Task 12). Show "moderating N…" when that kind's `pending > 0`; otherwise show "moderation round X/M" when `round > 0`; otherwise nothing. Per-kind `round` on the server already prevents one kind's moderation state from leaking into the other kind's row, so no UI-level gate is needed. Reuse the muted/destructive color tokens already in use; do not add a new icon library.
  **Context**: Keep the indicator a derived UI artifact — no new client state. The existing flow-summary 5s poll already refreshes the data.

- [x] **Task 14: New "Content moderation" panel on the video detail page**
  **Files**: `src/app/videos/[id]/video-detail-client.tsx`, optionally a new sub-component `src/app/videos/[id]/moderation-panel.tsx` if the JSX gets long
  **What**: A collapsible card below "Flow progress" that reads `flowSummary.moderation.events` (already polled by the existing flow-summary 5s tick — no new fetch effect, no second round-trip) and lists each event grouped by round. Per row: kind, chunk_id, reason_tag (badge), original_prompt (collapsed), rewritten_prompt (collapsed). Show only when at least one event exists for the video. Mirror the look-and-feel of the existing failed-items expandable in the Flow progress card.
  **Context**: The existing detail page already has an `isFlow = video.workflow_id === "google-flow"` gate; reuse that. Truncate prompts in the list to ~120 chars with a click-to-expand affordance — full prompts can be long.

- [x] **Task 15: Add the three new settings to the Google Flow tab**
  **Files**: `src/app/settings/settings-form.tsx`
  **What**: In the existing Google Flow `Collapsible` "Advanced" section at `:286-316`, add: a `BoolField` for `google_flow_content_moderation_enabled`, a `NumberField` for `google_flow_content_moderation_max_rounds`, a `TextField` for `google_flow_content_moderation_model` (with hint "leave blank to use model_name"). Add the keys to `TAB_FIELDS["google-flow"]` at `:56-64` so the dirty-dot logic includes them.
  **Context**: Use the existing `BoolField`, `NumberField`, `TextField` primitives already defined further down the file. PATCH validation lives in `src/app/api/settings/route.ts` and is driven by the Zod schemas — once Task 2 lands, the route accepts the keys automatically. Note the bool round-trip: form holds `boolean`, save does `String(value)` → `"true"`/`"false"` → enum schema parses + transforms back to `boolean` on read; this matches the existing `voice_use_speaker_boost` pattern (`settings.ts:78-80`). A short code comment when implementing helps the next reader.

### Phase 5: Tests, docs

- [x] **Task 16: Unit-test the shared classifier and moderator wrapper**
  **Files**: `__tests__/unit/lib/flow-error-classify.test.ts` (new), `__tests__/unit/lib/moderator.test.ts` (new — match the existing test layout under `__tests__/unit/`)
  **What**:
  - Classifier tests: assert `isContentPolicyError` returns true for representative content-policy strings (`PUBLIC_ERROR_DANGER_FILTER`, `PUBLIC_ERROR_AUDIO_FILTERED`, `MEDIA_GENERATION_STATUS_FAILED ... CHILD_DANGER`, `SAFETY`) and false for transient strings (`UNAVAILABLE`, `TIMEOUT`, `503`, `download_failed: ...`). Also assert the existing 3-way `classifyError` keeps its prior return values for the strings the route already exercises (preserves submit-result behavior post-extraction). Add tests for `extractContentPolicyTag`: returns `"PUBLIC_ERROR_DANGER_FILTER"` for the full envelope `Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":3,"message":"PUBLIC_ERROR_DANGER_FILTER"}` (drawn from `docs/references/content_violations.md`), `"PUBLIC_ERROR_AUDIO_FILTERED"` for the audio variant, `"CHILD_DANGER"` and `"SAFETY"` for bare codes, and `null` for transient strings that don't contain a policy code.
  - Moderator tests: with a stubbed `chat`, verify `moderateBatch` (a) renders the prompt with the batch JSON correctly (specifically: substitutes `JSON.stringify(items, null, 2)` into `{{batch_json}}`), (b) parses a well-formed response into the id→prompt map, (c) retries on JSON parse failure, (d) throws after retries are exhausted, (e) passes `opts.model` through when the moderator-model setting is non-empty and omits it when empty.

- [x] **Task 17: Integration test for the moderation loop in runGoogleFlowStep**
  **Files**: `__tests__/unit/worker/steps/google-flow-common.test.ts` (extend existing if present, otherwise new)
  **What**: With an in-memory SQLite, a stubbed `waitForFlowQueue`, and a stubbed `chat`: simulate a queue where 2 rows fail with `PUBLIC_ERROR_DANGER_FILTER` and 3 succeed. Verify the loop (a) calls the moderator with the failed rows' prompts and context, (b) writes moderation_events rows, (c) updates `chunks.json` prompts and prompt_history (single write, after the DB transaction), (d) requeues with `moderation_round=1` and cleared error_reason, (e) on a second iteration where the moderator's rewrite succeeds, the loop exits and the existing aggregation does **not** throw, (f) when failures persist past `max_rounds`, the existing aggregation does throw with the original error reasons, (g) the disabled-flag short-circuit. Add a separate test for the *atomicity* property: simulate a chat-stub failure between batch construction and the DB transaction (e.g., the moderator throws) and assert that no moderation_events rows are written, no queue rows are requeued, and chunks.json is unchanged on disk.
  **Context**: Use the same testing conventions as existing worker step tests; check the `__tests__/unit/worker/steps/` directory for the setup helpers.

- [x] **Task 18: Schema migration test**
  **Files**: extend the existing db schema test file (`__tests__/unit/lib/db.test.ts`)
  **What**: Open a DB with a synthetic pre-migration `google_flow_queue` and `settings` (no new column / keys), call `createDb` via the migration path, and assert that the column + table exist, the new settings are seeded, and existing rows have `moderation_round = 0`.
  **Context**: Mirror the existing migration tests for `paused` / `deferred_until` if any.

- [x] **Task 19: Update the spec — lands alongside the schema/code, not after**
  **Files**: `docs/histforge-spec.md`
  **What**: Add a section describing the moderation loop (when it runs, the round semantics, the schema additions, the new settings, the new API). Per CLAUDE.md the spec is the source of truth, so this is part of the same PR as Phases 1–4.
  **Context**: Reference the relevant subsections (pipeline steps, settings, API) and link to `prompts/moderate_blocked_prompts.md`. This task is listed last in the plan for grouping convenience but should be edited in lockstep with Tasks 1–2 (schema/settings), 9 (loop semantics), and 11 (API), so the spec entries are correct as the code lands.

## References

- `src/worker/steps/google-flow-common.ts:50-141` — the function that gets the new loop
- `src/app/api/flow/submit-result/[token]/route.ts:65-71,109-174` — content-policy classification, extracted to the new shared module in Task 6a
- `extensions/youforge-flow/src/flow-error.js:19-103` — the canonical list of policy categories the extension emits, plus the `TRANSIENT_RE` that justifies the single-regex content-policy detector
- `prompts/09_enrich_chunk.md:15-46` — safety rules to seed the moderator prompt
- `docs/references/content_violations.md` — real failure examples to seed moderator prompt examples
- `src/types.ts:57-78,123-130` — `GoogleFlowQueueItem` and `Chunk` types (both extended)
- `src/lib/db.ts:127-148,165-203` — schema + migration patterns; `foreign_keys = ON` pragma at `:85` is what makes the moderation_events cascade work
- `src/lib/settings.ts:12-82` — settings schemas
- `src/lib/repos/google-flow.ts:144,287,315` — queue repo style
- `src/lib/flow-summary.ts` — UI summary plumbing
- `src/app/videos/[id]/video-detail-client.tsx:339-432` — Flow progress card to extend
- `src/app/settings/settings-form.tsx:235-317` — Google Flow settings tab + Advanced collapsible
- `src/lib/llm/openrouter.ts:23-78` — `chat()` signature; `ChatOpts.model` already supported
- `src/worker/steps/09-enrich-chunks.ts:11-19,75-82` — chat-injection deps interface + ctx fields the orchestrator already exposes
