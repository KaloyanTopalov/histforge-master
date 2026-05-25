import { getDb } from "@/lib/db";
import type { PromptModerator } from "@/lib/moderator";
import {
  runGoogleFlowStep,
  type GoogleFlowStepDeps,
} from "@/worker/steps/google-flow-common";
import type { ImageProvider } from "./types";

/**
 * Google Flow as an `ImageProvider`. The provider is a thin adapter over
 * `runGoogleFlowStep` — it carries no state of its own; the queue and
 * webhook plumbing live in `lib/repos/google-flow` and `app/api/flow/`.
 *
 * Constructed per-run by the coordinator with the run's `PromptModerator`
 * closed over; the moderator's chat source folds the run's AbortSignal in
 * upstream in `runPipeline`. `cleanup` is a deliberate no-op: deleting
 * `images/` mid-flight would orphan dispatched-but-unfetched queue rows
 * keyed off the directory contents.
 */
export function makeGoogleFlowImageProvider(
  moderator: PromptModerator
): ImageProvider {
  return {
    async generateBatch(_items, _targetDir, opts) {
      const deps: GoogleFlowStepDeps = {
        db: opts.db ?? getDb(),
        projectsDir: opts.projectsDir,
        log: opts.log ?? (() => {}),
        moderator,
        pollIntervalMs: opts.pollIntervalMs,
        nowSec: opts.nowSec,
        nowMs: opts.nowMs,
        signal: opts.signal,
      };
      return runGoogleFlowStep(opts.videoId, deps, {
        stepName: "generate_images",
        chunkKind: "image",
        queueKind: "image",
        mode: "createImage",
        outputDir: "images",
        outputExt: ".png",
      });
    },
    cleanup: async () => {
      // intentional no-op — preserves in-flight queue rows
    },
  };
}
