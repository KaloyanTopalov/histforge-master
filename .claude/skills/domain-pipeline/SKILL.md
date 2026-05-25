---
name: domain-pipeline
description: Guide for working on the worker process, pipeline orchestration, queue picker, step lifecycle, pause/resume/defer/delete coordination, mid-step cancellation, and crash recovery. Use when modifying how steps execute, adding new steps, changing queue behavior, error handling, or the AbortSignal threading.
---

# Pipeline Orchestration & Worker

## Anchors

- **Worker boundary**: `runPipeline`, `runLoop`, `tickOnce`, `pickNextVideo`, `bootValidate`, `resetStaleRunningSteps`
- **Step contract**: `Step`, `StepContext`, `RunPipelineDeps`, `DeferSignal`, `REAL_STEPS`, `runStep`, `StepRunResult`
- **Cancellation**: `CancellationSource`, `deleteRequestedSource`, `startCancellationWatcher`, `isAbortError`, `throwIfAborted`
- **Lifecycle composer**: `videoLifecycle.enterStep`, `videoLifecycle.recordStepFailure`, `videoLifecycle.deleteFully`
- **Artifact grouping**: `STEP_ARTIFACT_RULES`, `groupArtifactsByStep`
- **DB shape**: `videos`, `video_steps`, `videos.status`, `videos.paused`, `videos.delete_requested`, `videos.deferred_until`, `videos.workflow_snapshot`, `videos.current_step`
- **Runtime config**: `queue_state`, `PROJECTS_DIR`

## Architecture

The worker is a long-running Node process separate from the Next.js server. It polls SQLite for runnable videos, picks one at a time, and runs that video's pipeline step-by-step. Three layers:

1. **Entry** — Process bootstrap. Runs `bootValidate` (fail-fast schema/registry consistency check), normalizes stale `running` step rows, flips stuck Google Flow `dispatched` rows back to `pending`, starts the Flow reaper, then enters the main loop. SIGINT/SIGTERM flips a shutdown flag the loop honors after its current tick.
2. **Runner** — Queue picker + tick loop. Pipeline failures are swallowed at this layer so the loop never dies.
3. **Pipeline** — Step orchestrator. Resolves the video's pinned `workflow_snapshot` to a concrete step list, iterates it, owns every DB state transition (`pending` → `running` → `done` / `failed`), checks delete/pause at every boundary, runs a cancellation watcher in parallel, and cleans up artifacts on failure.

Steps are stateless modules. Each step reads inputs from disk and writes outputs to disk; the orchestrator owns every DB transition and never lets a step touch `videos` / `video_steps` directly. Multi-row writes (`enterStep`, `recordStepFailure`, `deleteFully`) are named composers in the lifecycle module — each opens its own `db.transaction()` and stitches together the atomic repo helpers. Single-statement transitions stay in the repos.

The **workflow registry** is orthogonal to steps. A video's `workflow_snapshot` (pinned at queue time) materializes into a `Step[]` at the start of every pipeline run. Step files and workflow definitions evolve independently. See `domain-workflows` for the registry, snapshot lifecycle, and step materialization.

## Step Lifecycle

State machine owned entirely by the orchestrator:

```
pending → running → done
                 ↘ failed   (with artifact cleanup)
                 ↘ deferred (step row stays running, video gets deferred_until)
                 ↘ aborted  (delete-requested wipe; no failure recorded)
                 ↘ paused   (orchestrator returns; step stays pending)
```

Rules:
- Steps never write to `videos` / `video_steps`. The orchestrator calls into the lifecycle composer for every multi-row transition, so the dashboard never sees the step row and `videos.current_step` disagree.
- Steps signal failure by throwing. The orchestrator catches, logs the stack to the per-step log file, runs the step's `cleanup` hook (or deletes the paths declared in `Step.outputs`), and marks the step + video `failed` atomically via `videoLifecycle.recordStepFailure`.
- Steps signal "come back later" by returning a `DeferSignal` (`{ deferred: true, retryAfter }`). The orchestrator stamps `videos.deferred_until` and returns; the step row stays in `running` so the next entry recognizes it as resumable. The step body owns idempotency.
- Pause/delete are checked **between** steps. Cancellation (signal-driven) is checked **during** steps — the cancellation watcher aborts the controller, providers see the abort via `ctx.signal`, and the resulting `AbortError` short-circuits the rest of the run.

**Loop vs harness.** A pipeline run is two seams. The loop (`runPipeline`) owns between-step boundaries — delete, pause, skip-if-done — and the post-loop video `markDone`. The per-step harness (`runStep`) owns within-step work: `enterStep`, the `step.run` call, outcome discrimination (continue / defer / cancel / fail), and the matching side-effect for each (`markDone` / `setDeferredUntil` / `deleteFully` / `recordStepFailure`). The harness collapses its internal four-way outcome to a binary `StepRunResult` so the loop never branches on step-body details — it advances or unwinds. Adding a new outcome type means extending the harness's internal union and its side-effect switch, not the loop. See ADR-0009 and the *Per-step harness* entry in CONTEXT.md.

## Queue Picker Resolution Order

`pickNextVideo` walks a strict priority chain:

1. **Delete-requested short-circuit** — `findDeleteRequestedId` ignores every pause / defer gate. Otherwise the orchestrator's between-step delete hook would never run on a paused or deferred video and the row + artifacts would stay stuck.
2. **Global pause** — if `queue_state` is `paused`, idle.
3. **Resume an in-progress video** — `findInProgressId` filters by unpaused AND past-defer.
4. **One-at-a-time guard** — if step 3 returned nothing but `anyInProgressExists` (UNFILTERED) sees a paused/deferred in-progress row, idle rather than fall through. Picking a fresh queued video while another in-progress one exists would violate the one-at-a-time invariant the rest of the system depends on.
5. **FIFO** — `findOldestQueuedId` (filtered by unpaused AND past-defer) returns the oldest eligible queued video.

`new` videos are never picked up — they wait for the operator to click Start (per-row) or Start All, which transitions them to `queued` (and re-pins their snapshot).

Sleep happens **after** the tick so the loop is responsive to shutdown signals; a worked tick re-enters immediately while an idle tick waits before polling again.

## Pause Semantics

Two independent pause axes, both OR'd:

- **Global pause** — `queue_state === 'paused'`. Set by the dashboard's queue toolbar (see `domain-dashboard`). Affects every video.
- **Per-video pause** — `videos.paused === 1`. Set by the per-row Pause button. Affects exactly one video.

The runner enforces both at the picker level (above). The orchestrator enforces both **between every step** during a pipeline run, in this order: delete check → pause check → already-done short-circuit → `enterStep` → run → markDone. After the loop, the same delete + pause checks gate the final `markDone` on the video.

When the orchestrator returns due to pause:
- `videos.status` stays `in_progress`.
- `videos.current_step` retains whatever the last successful step left.
- The next-to-run `video_steps` row stays `pending`.
- The runner's filters keep the video off the picker until the flag clears.

**Delete wins over pause.** Both checks run at every boundary; delete is first, so a video flagged for deletion gets torn down even if it was also paused. Paused videos are picked up specifically *because* the operator's most recent action — the explicit delete — must take precedence.

The post-loop pause check exists because pause/delete can land in the gap between the final step's `markDone` and the video's `markDone`. Without it, a late pause would silently flip a freshly-paused video to `done`.

## Defer Semantics

Defer is a soft yield used by Google Flow steps when every account is in cooldown — the step has nothing useful to do but isn't failing. The orchestrator stamps `videos.deferred_until`, leaves the step row in `running`, and returns. The runner's pick filters skip the video until the timestamp passes, then re-enter the same step, which is expected to be idempotent.

`anyInProgressExists` is the one place that **must not** filter by defer — the one-at-a-time guard depends on seeing deferred rows so the runner idles instead of stealing a queued pick while a defer is outstanding. Don't add the defer filter there. See `domain-google-flow-coordinator` for the producer/consumer step that emits `DeferSignal`.

## Mid-Step Cancellation

`StepContext.signal` is the single `AbortSignal` threaded through providers. The orchestrator owns one `AbortController` per pipeline run; `startCancellationWatcher` polls a `CancellationSource` predicate and aborts the controller when the source returns true. Production wires the source to `videos.delete_requested` via `deleteRequestedSource`; tests inject a fake predicate.

Long-running steps must consume `ctx.signal` — pass it into `fetch`, `child_process.spawn`, provider opts, etc. — so a delete request aborts an in-flight HTTP / ffmpeg / subprocess call promptly instead of waiting for it to run to completion. **Do not invent a parallel `shouldCancel` mechanism**; the AbortSignal is the canonical interrupt and code in providers, the moderator, and the Flow watcher already plumbs through it.

The chat wrappers are **signal-folded once** at the top of the pipeline run, so steps don't repeat `{ signal: ctx.signal }` on every call. The moderator closes over the folded `visualPromptChat`, and the image/video providers close over the moderator — the moderation seam therefore inherits cancellation without leaking signal handling into provider opts. See `domain-google-flow-coordinator` for the moderator ADR.

`isAbortError` exists because abort errors arrive in two incompatible shapes (`fetch` vs `child_process`); callers should not string-match error messages to detect cancellation. `throwIfAborted` is the canonical way to surface cancellation eagerly at poll boundaries where a long await wouldn't otherwise consume the signal.

When a step throws an abort-shaped error, the orchestrator skips `recordStepFailure` and goes straight to the wipe path — no misleading "failed" blip in the dashboard between the abort and the eventual delete.

## Delete-Requested Handling

Deleting a video mid-pipeline can't safely interrupt a running step on its own (steps hold open HTTP / ffmpeg / Playwright sessions). The DELETE API route flips `delete_requested` and acknowledges asynchronously. Two mechanisms then converge:

1. The orchestrator checks `videos.delete_requested` (or the already-aborted controller) at every step boundary and at the post-loop check.
2. The cancellation watcher polls the same flag and flips the controller mid-step, so providers consuming `ctx.signal` abort their in-flight work.

When either trigger fires, the orchestrator calls `videoLifecycle.deleteFully`, which wipes the project directory on disk **before** the DB transaction (filesystem ops can't participate in SQLite transactions; a partial wipe with files gone but rows still here is recoverable on the next run), then deletes the `video_steps` + `videos` rows in a single transaction.

For pre-pipeline (`new` / `queued`) or terminal-failure (`failed`) videos, DELETE is synchronous — no orchestrator involvement. `done` videos cannot be deleted through this path.

## Step Interface and StepContext

Every step module exports a `step: Step` object — see the type for the exact field shape.

- **`outputs`** declares the per-video artifact paths the default cleanup deletes on failure. An empty array means either there's nothing to delete or the step ships its own `cleanup` hook (some steps use atomic `.tmp`+rename writes so partial outputs can never exist on disk).
- **`run`** returns `Promise<void | DeferSignal>`. Throwing is failure; returning normally is success; returning a `DeferSignal` is "yield and try later".
- **`ctx` (StepContext)** is built fresh per step invocation. It carries the shared DB handle, the project paths, a step-scoped logger (bound to the step name so callers never repeat it), the resolved provider entry points (chat / visual-prompt chat / TTS / image / video), the resolved per-provider visual-prompts concurrency, the pinned `snapshot` (so steps can branch on provider without re-reading the column), and the cancellation `signal`.

**Why `StepContext` instead of module-level singletons:** provider and path resolution happens once per pipeline run and threads in. Steps receive what they need without re-reading DB / settings sprinkled through every step body. Tests pass fakes via `RunPipelineDeps` and the orchestrator merges them into the context the step sees.

**Provider-resolution-at-boundary** is deliberate: if a configured provider id is unknown, the video fails *before* step 01 rather than mid-pipeline after a long LLM run.

`chat` and `visualPromptChat` both resolve from the snapshot's pinned LLM provider (per-run stability), differing only in default model. `ttsProvider` resolves from the snapshot at the same boundary. `imageProvider` and `videoProvider` are built later in a per-run setup block because they need to close over the moderator, which in turn needs the signal-folded `visualPromptChat`. The per-provider visual-prompts concurrency is resolved from the provider-specific setting at the boundary. See `domain-workflows` for snapshot pinning rules.

## Adding a New Step

A new step requires three coordinated touches: a `Step` export wired into `REAL_STEPS`, a `STEP_ARTIFACT_RULES` entry if it writes artifacts (otherwise its outputs sink to the Other bucket in the dashboard), and at least one workflow row referencing its slug. `bootValidate` catches dangling slugs at worker startup — both unknown workflow refs and stale `workflow_snapshot` rows pinned with retired slugs — so a half-wired step fails fast at boot rather than mid-pipeline. See `domain-workflows` for the registry side.

## Artifact Grouping

`STEP_ARTIFACT_RULES` maps each producer step to a path-predicate; `groupArtifactsByStep` walks a video's artifact list and bins each path under its owning step. Logs pin to the top, real steps appear in their pipeline order, unowned paths sink to `OTHER_GROUP_KEY`. The grouping is consumed by the dashboard's artifacts panel; `bootValidate` cross-checks every rule's `step` against `REAL_STEPS` so a renamed step doesn't silently strand its artifacts in the Other bucket.

Rules are intentionally provider-agnostic — `generate_images` and `generate_clips` dispatch to whichever image/video provider the workflow pins, but the artifact path layout is the same regardless of provider. The chunker slot has three sibling rules — `chunk_clips_then_images`, `chunk_images_only`, `chunk_clips_only` — that all match `chunks/`; each workflow's snapshot picks exactly one and `ownerStep` filters rules against the materialized step list, so only the selected chunker's rule attributes the artifact.

## Dependency Injection for Testing

`runPipeline` accepts a `RunPipelineDeps` override covering everything in `StepContext` that isn't built per-step / per-run, plus the step list, the cancellation seam (source predicate + poll cadence), and the moderator seam. Tests pass fakes for the subset they need — fake steps typically don't consume the provider fields, so the seeded defaults stay harmless. `runLoop` separately accepts sleep + stop overrides so tests can run many ticks without real delays.

Production `REAL_STEPS` is imported lazily during dep resolution to avoid the import cycle (steps import the `Step` type from the pipeline module).

## Common Pitfalls

- **DB transitions are atomic; cleanup is not.** Multi-row state changes go through the lifecycle composer, which wraps them in `db.transaction()`. Filesystem cleanup (deleting step artifacts on failure, wiping the project dir on delete) runs **before** the corresponding DB transaction because filesystem ops can't participate in SQLite transactions. A partial filesystem wipe is recoverable on the next run; partial DB state isn't. **Why:** SQLite transactions don't extend to `rmSync`; sequencing matters when reasoning about crashes mid-cleanup.

- **Pause/delete are checked between steps; cancellation runs during them.** An in-flight step finishes its current await before the orchestrator notices a pause. For prompt interruption, thread `ctx.signal` through every long-running call — that's how delete actually aborts mid-step. **Why:** the orchestrator can't yank a step mid-fetch on its own; the AbortSignal is the only mechanism that reaches into provider code.

- **`StepContext.signal` is the canonical cancellation primitive.** Don't invent parallel `shouldCancel` callbacks, polling helpers, or per-provider cancel flags. Pass `ctx.signal` into `fetch`, `child_process.spawn`, provider opts. Use `throwIfAborted(signal)` at poll boundaries when a long await doesn't naturally consume the signal. **Why:** every provider, the moderator, and the Flow watcher already cooperate with this signal; a sibling mechanism would silently drift out of sync with the orchestrator's abort.

- **Pause check has TWO sources OR'd; delete-pick has THREE bypasses.** Global `queue_state === 'paused'` and per-video `videos.paused === 1` both gate the orchestrator. The delete picker bypasses both pause flags **and** `deferred_until`. Don't simplify either predicate — they encode distinct operator intents that converge in one code path. **Why:** treating the two pause sources as one would conflate global vs per-row toolbar actions; making delete respect pause/defer would orphan a stuck-on-deletion video forever.

- **`anyInProgressExists` is intentionally UNFILTERED.** The one-at-a-time invariant depends on it seeing paused AND deferred in-progress rows. If you "fix" it to filter by `paused = 0` or `deferred_until <= now`, the runner will pick a fresh queued video while another in-progress one exists, and any consumer that assumes `findInProgressId` returns at most one will break. **Why:** this isn't dead defensiveness — it's the load-bearing half of a pair of helpers that must disagree.

- **The post-loop pause/delete checks are not redundant.** Pause/delete can land in the narrow gap between the final step's `markDone` and the video's `markDone`. Removing the post-loop checks would silently flip a freshly-paused video to `done` or skip the wipe on a freshly-deleted one. **Why:** the operator's most recent action must win; without these checks, the race between the user clicking Pause/Delete and the pipeline finishing is observable as lost intent.

- **Don't read settings or open providers inside `step.run`.** Use `ctx.chat` / `ctx.visualPromptChat` / `ctx.ttsProvider` / `ctx.imageProvider` / `ctx.videoProvider` (and `ctx.snapshot` for provider-aware branching) so the snapshot-pinned and test-seeded providers are honored. If a step needs a setting that isn't on `StepContext`, read it once at the top of `run`, not per-iteration. **Why:** mid-step `getSetting` would re-read live settings inside a snapshot-pinned run, breaking workflow stability and bypassing test fakes.

- **`videos.current_step` is denormalized — `video_steps` is authoritative.** `current_step` is a convenience column for the dashboard, updated in the same transaction as `enterStep` for atomicity. When querying step state in worker code, read from `video_steps`. **Why:** treating `current_step` as the source of truth means missing the failed/done distinction and any sub-resume state.
