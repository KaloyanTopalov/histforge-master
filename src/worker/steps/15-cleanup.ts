import type { Step } from "@/worker/pipeline";
import { cleanupProjectArtifacts } from "@/lib/cleanup";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";

export const step: Step = {
  name: "cleanup",
  module: "glue",
  label: "Cleanup",
  description: "Deletes intermediate artifacts; keeps final.mp4 and full_script.md.",
  inputs: [],
  // A failed cleanup leaves the project half-tidied; manual recovery only.
  outputs: [],
  async run(videoId, ctx) {
    // Operator-gated: setting=false (the default) short-circuits the
    // step BEFORE any FS work so a failed image batch leaves
    // intermediates on disk for recovery. The gate must remain the
    // first statement — cleanup-step-gating.test.ts's ORDER pin asserts
    // cleanupProjectArtifacts is never called when the setting is false.
    // Operators can still trigger cleanup manually via the video detail
    // page regardless of this setting.
    if (!getSetting("auto_cleanup_after_render", getDb())) {
      return;
    }
    cleanupProjectArtifacts(ctx.projectsDir, videoId);
  },
};
