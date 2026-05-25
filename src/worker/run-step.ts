/**
 * The per-step harness — build the step context, run the step, interpret
 * the outcome, write side-effects. One named cycle between boundary
 * checks in `runPipeline`.
 *
 * The boundary checks (delete, pause, skip-if-done) stay in the loop in
 * `pipeline.ts`; everything that happens once a step body is dispatched
 * — `markRunning` + `setCurrentStep` via `videoLifecycle.enterStep`,
 * `step.run` invocation, outcome discrimination (success / defer /
 * cancel / fail), and the matching side-effects (`markDone` /
 * `setDeferredUntil` / `deleteFully` / `recordStepFailure`) — lives here.
 *
 * See ADR-0009 (`docs/adr/0009-per-step-harness-with-internal-side-effects.md`)
 * and the **Per-step harness** entry in CONTEXT.md.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { appendLog } from "@/lib/logger";
import * as videosRepo from "@/lib/repos/videos";
import * as stepsRepo from "@/lib/repos/steps";
import * as videoLifecycle from "@/lib/lifecycle/video";
import { isAbortError } from "./cancellation";
import {
  type DeferSignal,
  type PerRunDeps,
  type ResolvedDeps,
  type Step,
  type StepContext,
} from "./pipeline";

/**
 * Type guard for the defer sentinel returned by `step.run`. Lives here
 * because `runStep` is its only consumer; the `DeferSignal` type itself
 * stays in `pipeline.ts` as part of the `Step.run` return contract.
 * Re-export (or duplicate the shape) if a future caller needs to detect
 * a defer outside the harness.
 */
function isDeferSignal(value: unknown): value is DeferSignal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { deferred?: unknown }).deferred === true &&
    typeof (value as { retryAfter?: unknown }).retryAfter === "number"
  );
}

/**
 * Build the per-step `StepContext` handed to `step.run` / `step.cleanup`.
 * Everything cross-cutting from `ResolvedDeps` plus a step-scoped `log`
 * that prepends the step name. Per-run primitives (signal-folded chats
 * and moderator-dependent providers) come from `perRun`, pre-built once
 * in `runPipeline`.
 */
function buildStepContext(
  deps: ResolvedDeps,
  perRun: PerRunDeps,
  videoId: string,
  stepName: string,
  signal: AbortSignal
): StepContext {
  return {
    db: deps.db,
    projectsDir: deps.projectsDir,
    promptsDir: deps.promptsDir,
    log: (message) => appendLog(videoId, stepName, message, deps.projectsDir),
    chat: perRun.chat,
    visualPromptChat: perRun.visualPromptChat,
    visualPromptsConcurrency: deps.visualPromptsConcurrency,
    ttsProvider: deps.ttsProvider,
    imageProvider: perRun.imageProvider,
    videoProvider: perRun.videoProvider,
    snapshot: deps.snapshot,
    signal,
  };
}

/**
 * Handle a generic step failure: log the stack, clean up the step's
 * artifacts (custom hook or default `STEP_OUTPUTS` deletion), and mark
 * both the step row and the video row failed. Spec :310, :312, :776.
 */
async function recordStepFailure(
  deps: ResolvedDeps,
  videoId: string,
  step: Step,
  ctx: StepContext,
  err: unknown
): Promise<void> {
  const { db } = deps;
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack ?? message : String(err);
  const now = Date.now();

  appendLog(videoId, step.name, stack, deps.projectsDir);

  // A step may declare its own cleanup hook (e.g., write_chapters only
  // deletes the in-flight chapter file). Otherwise the orchestrator
  // deletes the paths the step declared in STEP_OUTPUTS — and *only*
  // those, so previous steps' artifacts survive. Cleanup runs OUTSIDE
  // the transaction because it touches the filesystem, not the DB.
  if (step.cleanup) {
    await step.cleanup(videoId, ctx);
  } else {
    const projectDir = join(deps.projectsDir, videoId);
    for (const rel of step.outputs) {
      rmSync(join(projectDir, rel), { recursive: true, force: true });
    }
  }

  // DB-side: atomic step-failed + video-failed. Qualified call —
  // `videoLifecycle.recordStepFailure` is a sibling of this wrapper.
  videoLifecycle.recordStepFailure(db, videoId, step.name, message, now);
}

/**
 * Public outcome — the binary signal the loop in `runPipeline` needs to
 * decide whether to advance to the next step or unwind the pipeline run.
 * The rich four-variant discrimination is kept file-private (see
 * `StepOutcome`); callers only see the loop-level decision.
 */
export type StepRunResult = { kind: "continue" } | { kind: "stop" };

/**
 * Internal step-body outcome — switch-discriminated to pick the side-effect
 * (`markDone` / `setDeferredUntil` / `deleteFully` / `recordStepFailure`)
 * before collapsing to the binary `StepRunResult` for the loop. The `err`
 * payload on `fail` carries the caught error through to `recordStepFailure`
 * without exception-rethrow gymnastics.
 */
type StepOutcome =
  | { kind: "continue" }
  | { kind: "defer"; retryAfter: number }
  | { kind: "cancel" }
  | { kind: "fail"; err: unknown };

/**
 * Per-step harness. Owns step-row state transitions and outcome side-effects
 * for one step body between the loop's boundary checks. `signal` (not the
 * full controller) is intentionally passed — `runStep` reads `aborted` but
 * never triggers cancellation; that's the watcher's job in `runPipeline`.
 *
 * Outcome → side-effect mapping (ADR-0009 §2):
 *   continue → stepsRepo.markDone → { kind: "continue" }
 *   defer    → videosRepo.setDeferredUntil → { kind: "stop" }
 *   cancel   → videoLifecycle.deleteFully → { kind: "stop" }
 *   fail     → recordStepFailure (FS-precedes-DB) → { kind: "stop" }
 */
export async function runStep(
  deps: ResolvedDeps,
  perRun: PerRunDeps,
  step: Step,
  videoId: string,
  signal: AbortSignal
): Promise<StepRunResult> {
  const { db } = deps;

  // Mark step running. Lifecycle method owns the atomic two-write
  // (step row + videos.current_step) so the dashboard never sees
  // the two columns disagree about which step is in flight.
  videoLifecycle.enterStep(db, videoId, step.name, Date.now());

  const ctx = buildStepContext(deps, perRun, videoId, step.name, signal);

  let outcome: StepOutcome;
  try {
    const result: void | DeferSignal = await step.run(videoId, ctx);
    if (isDeferSignal(result)) {
      outcome = { kind: "defer", retryAfter: result.retryAfter };
    } else {
      outcome = { kind: "continue" };
    }
  } catch (err) {
    // Abort path: the throw is the signal-driven cancellation, not a
    // real failure. Skipping recordStepFailure prevents a misleading
    // "failed" blip in the dashboard between the abort and the eventual
    // wipe. Either side of the OR is sufficient: signal.aborted catches
    // AbortError-shaped throws, the explicit `isAbortError` covers race
    // cases where the throw arrived first.
    if (signal.aborted || isAbortError(err)) {
      outcome = { kind: "cancel" };
    } else {
      outcome = { kind: "fail", err };
    }
  }

  switch (outcome.kind) {
    case "continue":
      stepsRepo.markDone(db, videoId, step.name, Date.now());
      return { kind: "continue" };
    case "defer":
      // Yield back to the orchestrator. Step row stays 'running' so the
      // next entry recognizes the step as resumable (its body owns
      // idempotency); the video stays in_progress with current_step set.
      videosRepo.setDeferredUntil(db, videoId, outcome.retryAfter);
      return { kind: "stop" };
    case "cancel":
      videoLifecycle.deleteFully(db, videoId, deps.projectsDir);
      return { kind: "stop" };
    case "fail":
      await recordStepFailure(deps, videoId, step, ctx, outcome.err);
      return { kind: "stop" };
  }
}
