import { getDb } from "@/lib/db";
import type { PromptModerator } from "@/lib/moderator";
import {
  runGoogleFlowStep,
  type GoogleFlowStepDeps,
} from "@/worker/steps/google-flow-common";
import type { VideoProvider } from "./types";

/**
 * Google Flow as a `VideoProvider`. Mirrors `makeGoogleFlowImageProvider`,
 * differing only in the spec fed to `runGoogleFlowStep`. `cleanup` is a
 * no-op for the same reason — preserves dispatched-but-unfetched queue
 * rows keyed off the directory contents.
 */
export function makeGoogleFlowVideoProvider(
  moderator: PromptModerator
): VideoProvider {
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
        stepName: "generate_clips",
        chunkKind: "clip",
        queueKind: "clip",
        mode: "text",
        outputDir: "videos/clip",
        outputExt: ".mp4",
      });
    },
    cleanup: async () => {
      // intentional no-op — preserves in-flight queue rows
    },
  };
}
