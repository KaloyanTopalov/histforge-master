# AI33 TTS — Resume Across Worker Restarts

## Overview
The voiceover step submits a task to AI33 then enters a long GET-poll loop. The submitted `task_id` lives only in a local variable, so any worker restart while the step is running causes step 6 to re-run and submit a **second** task to AI33 — the original becomes a paid orphan that nobody polls. Reproduced by the user: ~1h4m of waiting on the TTS step, then "voiceover started over" with a duplicate task visible in the AI33 queue. Fix: persist the `task_id` as a sidecar file next to the planned `narration.mp3`, resume polling on entry instead of resubmitting, and let the orchestrator's existing failure-cleanup path wipe the sidecar on terminal failure (so user-driven retries get a fresh submit).

## Current State
- **AI33 client** — `src/lib/tts/ai33.ts`. `submitTask` (`:73-114`) is called once per `synthesize` (`:231`); `pollUntilReady` (`:116-202`) holds `taskId` only in a closure local. No state persisted anywhere.
- **Voiceover step** — `src/worker/steps/06-voiceover.ts`. Thin glue: passes `outPath = projects/<id>/audio/narration.mp3` to the provider (`:36`, `:39-41`). Declared `outputs` (`:60-66`) lists three exact files — **not** the directory `audio/`.
- **Restart-driven re-entry** — confirmed pathway:
  - `src/worker/index.ts:36` → `resetStaleRunningSteps` flips `running` rows to `pending` on startup.
  - `src/worker/runner.ts:60-62` → `pickNextVideo` returns the still-`in_progress` video as a "resume".
  - `src/worker/pipeline.ts:279-281` → only `done` steps are skipped; `pending` steps get re-marked `running` and re-invoked.
  - Net effect: `runVoiceover` → `synthesize` → fresh `submitTask` whenever the worker restarts mid-step.
- **Orchestrator failure cleanup** — `src/worker/pipeline.ts:156-163`. On step throw, iterates `step.outputs` and `rmSync(join(projectDir, rel), { recursive: true, force: true })` for each entry. **It deletes the exact paths the step declared, not the parent directory.** Anything in `audio/` not in the `outputs` array survives a step failure. This is the pivot point for our cleanup design — the sidecar must be a declared output to be wiped on terminal failure.
- **Worker-crash semantics** — when the Node process dies, no throw is raised, so `recordStepFailure` never runs and cleanup never runs. The on-disk artifacts of the step persist exactly as they were at the moment of death. This is what makes a sidecar viable as a resume token.
- **Existing convention for resumable artifacts** — `src/worker/steps/09-enrich-chunks.ts` is the canonical "step persists progress to disk; on resume it picks up where it left off" example.
- **Existing convention for atomic sidecar writes** — `src/worker/steps/04-write-chapters.ts:217-221` (write to `<path>.tmp`, then `rename`) — used here so a crash mid-write never leaves a torn task_id file.
- **Tests** — `__tests__/unit/lib/tts/ai33.test.ts` mocks `fetch`, runs against in-memory SQLite + a tmp dir, and pins behavior with `retryDelayMs:0` / `pollIntervalMs:0`. Established pattern to extend.

## Scope
**Doing**:
- Persist the AI33 `task_id` to a sidecar at `<dirname(outMp3Path)>/.tts_task_id` after submit; resume polling with that ID on re-entry; delete the sidecar after successful download.
- Add `audio/.tts_task_id` to step 6's declared `outputs` so the orchestrator's existing failure cleanup wipes it on a terminal step failure (user-clicked Retry then gets a fresh submit, no orphan resume of a dead task).
- Tests covering: fresh submit writes the sidecar; sidecar present skips submit and resumes polling; sidecar removed after success; trimmed-empty sidecar treated as missing.

**Not doing**:
- ComfyUI image / video step (`src/lib/image/comfyui.ts`) — same bug class, but the user only asked about TTS and per-chunk image latency makes this less painful. Track separately.
- Generic provider-task queue refactor — out of scope.
- Cancelling the orphan task on AI33's side — AI33 has no cancel endpoint we use today; we just stop wasting submits going forward.
- Threading `taskIdPath` through the public `TtsProvider.synthesize` interface (`src/lib/tts/types.ts`) — AI33-internal by deriving the sidecar path from `outMp3Path`.
- Fixing `pollUntilReady`'s silent-spin on a 404 from an AI33-GC'd task. Pre-existing; resume makes it slightly more reachable. Tracked in References.
- Fixing the `submitTask` retry-loop's own duplicate-submit risk (lost response after a server-side accept). Pre-existing, related but distinct. Tracked in References.

## Tasks

### Phase 1: Persist + resume

- [x] **Task 1: Persist `task_id` as a sibling sidecar in AI33 client**
  **Files**: `src/lib/tts/ai33.ts`
  **What**: After a successful `submitTask`, atomically write the returned `task_id` to `<dirname(outMp3Path)>/.tts_task_id` (write to `.tts_task_id.tmp`, then `rename`). On entry to `synthesize`, if that file exists and its trimmed contents are non-empty, skip `submitTask` and feed the trimmed contents straight into `pollUntilReady`. After all downloads complete (existing `downloadFile` calls), remove the sidecar. Do **not** add any explicit cleanup-on-throw inside the AI33 client — terminal cleanup is the orchestrator's job (see Task 3) and a worker-death scenario must leave the sidecar in place to be resumable.
  **Context**:
  - Submit happens at `src/lib/tts/ai33.ts:231`; downloads at `:242-258`. Sidecar write must land between submit and the start of polling so a crash during the very first poll still yields a recoverable file.
  - `audio/` must exist before the sidecar write — `submitTask` runs before any `mkdirSync`, so the new code needs `mkdirSync(dirname(outMp3Path), { recursive: true })` ahead of the write (matches the pattern at `:210-211`).
  - Atomic-rename pattern: see `src/worker/steps/04-write-chapters.ts:217-221`.
  - Sidecar-write failure handling: best-effort. If `writeFileSync` (or the rename) throws, log via `opts.log` and proceed with polling. The `task_id` is still in memory; we can complete this run. Only a subsequent worker death within this same run loses the ID — same horizon as a death one millisecond earlier, no new failure mode.
  - Log lines: emit one of "AI33 task submitted: …" (existing, `:232`) on fresh submit and a new "AI33 resuming task <id> from sidecar" on resume so `pipeline.log` makes the resumption obvious.
  - Sidecar name `.tts_task_id` (leading dot) keeps it visually separate from declared step outputs and out of any future `audio/` listings.
  - Edge cases: trimmed-empty file → treat as missing and submit fresh (defensive against torn writes or hand-edits); non-string `task_id` from JSON parse — already handled by `submitTask:100-104`, no change needed.

- [x] **Task 2: Cover the new resume behavior with unit tests**
  **Files**: `__tests__/unit/lib/tts/ai33.test.ts`
  **What**: Add tests that pin the sidecar contract:
    1. **Fresh submit writes sidecar** — first call to `synthesize` causes a POST, sidecar file exists with the returned `task_id` after submit, then is deleted after success. Mock `fetch` to return `{ task_id }` on POST and a `done` poll response.
    2. **Resume skips submit** — pre-create the sidecar file with a known `task_id`, run `synthesize`. Assert `fetch` was **not** called with `POST`, only with `GET /v1/task/<task_id>`. Assert sidecar deleted after success.
    3. **Trimmed-empty sidecar treated as missing** — write `"   \n"` as the sidecar, run `synthesize`, assert a fresh POST happens and the sidecar is overwritten with the new task_id.
    4. **Sidecar-write failure is non-fatal** — make the sidecar directory unwritable (or stub `writeFileSync` to throw once), run `synthesize`, assert it still completes successfully via the in-memory task_id (the POST path) and surfaces a log line. (If platform-specific filesystem permission tricks are too flaky on Windows, stub `node:fs.writeFileSync` for this one test instead.)
  **Context**:
  - Existing test scaffolding (`tempDir`, `freshDb`, fetch mocking, `retryDelayMs:0`/`pollIntervalMs:0`) already lives at `__tests__/unit/lib/tts/ai33.test.ts:1-70` — reuse it; do not introduce new helpers.
  - Sidecar path the production code uses: `join(dirname(outMp3Path), ".tts_task_id")`. Tests should compute the same path from the `outMp3Path` they pass.
  - Voiceover step tests at `__tests__/unit/worker/steps/voiceover.test.ts` use a mock provider and don't exercise AI33 internals — leave them alone.
  - Do **not** add a "sidecar preserved on throw" test — terminal failure cleanup is now the orchestrator's responsibility (Task 3), not the AI33 client's, and the sidecar gets wiped on throw via the `outputs` declaration.

- [x] **Task 3: Declare the sidecar as a step 6 output so cleanup wipes it on terminal failure**
  **Files**: `src/worker/steps/06-voiceover.ts`
  **What**: Append `"audio/.tts_task_id"` to the `outputs` array on the `step` export (`:60-66`). No other change to step 6.
  **Context**:
  - Why this is necessary: orchestrator cleanup at `src/worker/pipeline.ts:159-163` only `rmSync`s exact paths from `step.outputs`; it does not recursively wipe `audio/`. Without this addition, a terminal AI33 error (`status: "error"`) would throw, cleanup would wipe the three `narration.*` files but **leave** `.tts_task_id` on disk — and a user-driven Retry would then resume the dead task and throw again in a loop.
  - Why this is the correct cleanup home (vs. a custom `cleanup` hook on the step or AI33-internal cleanup): worker *crashes* don't throw, so they don't trigger orchestrator cleanup, so they preserve the sidecar — which is exactly the resumption case we want. Step *throws* trigger orchestrator cleanup, which now includes the sidecar — which is what we want for retries against a dead task. The two scenarios partition cleanly along "did the step throw?" so a static `outputs` declaration captures the contract without any new code paths.

## References
- Bug pathway: `src/worker/index.ts:36`, `src/worker/runner.ts:60-62`, `src/worker/pipeline.ts:279-281`, `src/lib/tts/ai33.ts:116-202` and `:231-238`.
- Failure cleanup contract (key to Task 3): `src/worker/pipeline.ts:156-163` — deletes declared `outputs` paths only, not the parent directory.
- Resumable-step convention: `src/worker/steps/09-enrich-chunks.ts`.
- Atomic rename pattern: `src/worker/steps/04-write-chapters.ts:217-221`.
- Existing test patterns: `__tests__/unit/lib/tts/ai33.test.ts:1-70`.
- **Known limitation, out of scope**: `pollUntilReady` (`src/lib/tts/ai33.ts:148-153`) treats non-OK HTTP as `logOnce + continue`, so a 404 from an AI33-GC'd task spins silently forever. Pre-existing; resume makes it more reachable. Track separately if it shows up.
- **Related but separate, out of scope**: `submitTask`'s retry loop (`src/lib/tts/ai33.ts:91-112`) can itself cause a duplicate submission if attempt 1's response is lost in flight (server processed but the client never saw the body). Same bug class as this plan but a different trigger.
