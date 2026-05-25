# 0009 — Per-step harness with internal side-effects

The `runPipeline` per-step loop interleaved six concerns (boundary delete
check, boundary pause check, skip-if-done, mark-running transition,
build-context + `step.run`, outcome interpretation). Depth-audit suggestion #6
proposed extracting a `runOneStep` returning a 6-variant `StepOutcome`
discriminated union; we extracted instead to
`runStep(deps, perRun, step, videoId, signal)` in `src/worker/run-step.ts`
with two scope cuts: (1) the three boundary checks (delete / pause /
skip-if-done) stay in the loop because they're caused by the boundary
observer, not by the step body; (2) the four step-body outcome side-effects
(`markDone` / `setDeferredUntil` / `deleteFully` / `recordStepFailure`) live
inside `runStep`, which returns only `{ kind: "continue" | "stop" }` to the
loop. The rich 4-variant outcome union (`StepOutcome`) is file-private; only
the 1-bit `StepRunResult` crosses the seam.

## Considered Options

- **Audit's 6-variant `StepOutcome` (skip + pause as harness outcomes).** Skip
  and pause aren't caused by `step.run` executing; modelling them as harness
  outcomes leaks the loop's boundary observer into a function named "run a
  step," and asymmetrically — the post-loop boundary does the identical check
  with no step to run.
- **Rich union escapes to loop; loop dispatches side-effects.** Loses the
  stated benefit (*step-row transitions live in `runStep`*) — the loop still
  owns every side-effect call, just behind a switch.
- **Same-file extraction in `pipeline.ts`.** Names the function but not the
  concept; the new file co-locates `buildStepContext`, `recordStepFailure`,
  and `isDeferSignal`, each of which has exactly one caller after extraction.
