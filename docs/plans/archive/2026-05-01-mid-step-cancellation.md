# Plan: Mid-Step Cancellation

**Date**: 2026-05-01 (implemented 2026-05-04)
**Status**: ✅ Implemented on `bugfixing-1`. AbortSignal-on-StepContext + supervisor watcher landed; the fetch/spawn-driven provider surfaces (TTS AI33, ComfyUI image+video, Google Flow wait, ffmpeg render) consume the signal. LLM-driven steps and the WSL+aeneas align step are out of scope for this pass — see "Out of Scope".
**Related memory**: `project_long_running_step_cancellation.md`
**Related restructure plan**: `docs/plans/archive/2026-05-01-workflow-modularization.md` (landed)

---

## The Problem

The worker's delete-vs-pause contract ("delete wins over pause") used to be enforced **only at step boundaries**.

`src/worker/pipeline.ts` read `videos.delete_requested` between steps. While a step was inside `step.run()`, the orchestrator was awaiting that promise — there was no preemption path. A step that never returned blocked delete forever.

Real incident that motivated this: AI33's voiceover poll loop silently retried `"fetch failed"` for ~5 hours against a degraded upstream, leaving a video stuck with `delete_requested = 1` and `paused = 1` and no way for the user to recover without a process restart.

## What Landed

The implementation centers on **one cancellation primitive threaded through `StepContext`** rather than per-callsite hooks. SOLID-aligned:

- **SRP** — `src/worker/cancellation.ts` owns polling + abort. The orchestrator owns the controller and the wipe-on-throw branch. Providers consume the signal; they don't decide *when* cancellation fires.
- **OCP** — adding a new long-running step is "consume `ctx.signal`, pass to `fetch`/`spawn`". No new plumbing.
- **LSP** — every provider (`TtsProvider`, `ImageProvider`, `VideoProvider`) accepts the same optional `signal` shape uniformly.
- **ISP** — `StepContext.signal` is a bare `AbortSignal`, not a custom cancellation API.
- **DIP** — `runPipeline` depends on a `CancellationSource` predicate (`() => boolean`), not on the videos repo. Production wires `deleteRequestedSource(db, videoId)`; tests inject fakes.

### New module: `src/worker/cancellation.ts`

- `CancellationSource = () => boolean` — the bare predicate (DIP).
- `deleteRequestedSource(db, videoId)` — production factory closing over the videos repo.
- `startCancellationWatcher(controller, source, opts?)` — runs `source()` once synchronously at startup (so a delete that landed before the pipeline started aborts on tick zero), then a `setInterval`-backed poll that aborts the controller when the source flips. Returns a stop function. Default 2 s interval; `unref()`'d so it never blocks process exit.
- `isAbortError(err)` / `throwIfAborted(signal)` — small helpers so providers don't string-match cancellation errors.

### `StepContext` + `runPipeline`

- `StepContext.signal: AbortSignal` (required).
- `runPipeline` creates one `AbortController` per run, starts the watcher, and stops it in `finally`.
- On a step throw, the orchestrator inspects `controller.signal.aborted` (or `isAbortError(err)`):
  - **Aborted** → wipe the project dir + delete the video row (the "wipe-on-throw" branch). No `recordStepFailure`, so the user never sees a misleading "failed" blip.
  - **Not aborted** → existing failure path unchanged.
- The between-step `delete_requested` check stays as a fallback (and as the path that triggers when no long-running step is in flight).
- `RunPipelineDeps` exposes `cancellationSource?` and `cancellationIntervalMs?` for tests.

### Provider implementations

- **`src/lib/tts/ai33.ts`** — `submitTask`, `pollUntilReady`, `downloadFile` all accept `signal` and pass it to `fetch`. `pollUntilReady` checks `throwIfAborted` at the top of every iteration. Added `MAX_CONSECUTIVE_POLL_FAILURES = 60` so a permanently-down upstream surfaces as a step failure within a bounded window (~30 min at the 30 s default poll), independent of cancellation.
- **`src/lib/image/comfyui.ts`** — `submitPrompt`, `pollUntilComplete`, `pollUntilCompleteVideo`, `downloadImage` accept `signal`. Both batch entry points (`generateBatch`, `generateHookVideoBatch`) call `throwIfAborted` between items. Same failure cap as AI33.
- **`src/lib/flow-wait.ts`** — added `signal?` opt; the wait yields with `reason: "deleted"` on `signal.aborted` OR `readDeleteRequested` (whichever fires first), lowering cancellation latency to "next iteration".
- **`src/worker/steps/google-flow-common.ts`** — threads `signal` from `GoogleFlowStepDeps` into `waitForFlowQueue`'s opts.
- **`src/lib/{image,video}/google-flow.ts`** — adapters forward `opts.signal` into `GoogleFlowStepDeps`.
- **`src/lib/video/comfyui.ts`** — wrapper forwards `opts.signal` into `generateHookVideoBatch`.

### Render step (synchronous → spawn-with-signal)

- **`src/worker/steps/14-render.ts`** — `execFileSync` is gone. Production builds an async exec via `spawn("ffmpeg", ...)` with the AbortSignal; aborts kill the in-flight ffmpeg process instead of waiting for the render to complete. Stderr is buffered (capped at 64 KiB) and surfaced in the rejection message.
- **`src/lib/render.ts`** — `RenderDeps.exec` is now `(args) => void | Promise<void>`; every internal call is awaited. `vi.fn()` test mocks continue to work (a fake returning `undefined` resolves immediately).

### Per-step wiring

`06-voiceover`, `generate-main-images`, `generate-hook-video`, and `14-render` all pass `signal: ctx.signal` into their provider opts.

## Out of Scope

- **Pause-mid-step.** Pause is intentionally between-step only (spec: "delete wins over pause"). Only delete needs mid-step preemption; that is what this work covers.
- **Generic step timeout.** Useful, but a separate concern from cancellation correctness. The new `MAX_CONSECUTIVE_POLL_FAILURES` cap is the closest bounded-wait surface and is sufficient for the AI33 incident class.
- **LLM-driven steps (01-05, 09) and the moderation re-entry in `google-flow-common`.** `ChatOpts` does not yet carry `signal`; `ctx.chat` / `ctx.enrichChat` callers therefore can't propagate cancellation. Same incident shape as AI33 applies if an LLM upstream degrades — `04-write-chapters` is the worst case (one sequential HTTP call per chapter). Wiring this requires `signal` on `ChatOpts` plus pass-through in both LLM providers (`openrouter.ts`, `claude-cli.ts`); deferred to a follow-up.
- **Step 7 align (`src/lib/align.ts`).** The WSL+aeneas `spawn` is structurally the same uninterruptible-call shape that motivated the render fix, but `AlignOpts` has no `signal` and the spawn doesn't pass one. Deferred to the same follow-up.

## Tests

`__tests__/unit/worker/pipeline.test.ts` adds two coverage tests:
- "when a step throws because the signal aborted, runPipeline wipes the project + row instead of marking failed" — exercises the wipe-on-throw branch end-to-end with a fake `CancellationSource`.
- "does not wipe when a step throws a non-abort error and the signal is still live" — regression guard ensuring real failures still route through `recordStepFailure`.

Full suite: 1520 / 1520 passing after the change.
