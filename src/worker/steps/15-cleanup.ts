import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";

/**
 * The keep set: after cleanup only these paths (relative to the project dir)
 * remain. Spec line 280: "After cleanup: only `final.mp4`,
 * `script/full_script.md`, and `pipeline.log` remain."
 *
 * Implemented as an enumerate-and-delete against the keep set rather than a
 * delete list — more robust to accidental file additions.
 */
const KEEP = new Set(["final.mp4", "pipeline.log"]);
const KEEP_IN_SCRIPT = new Set(["full_script.md"]);

export const step: Step = {
  name: "cleanup",
  module: "glue",
  label: "Cleanup",
  description: "Deletes intermediate artifacts; keeps final.mp4 and full_script.md.",
  inputs: [],
  // A failed cleanup leaves the project half-tidied; manual recovery only.
  outputs: [],
  async run(videoId, ctx) {
    const projDir = join(ctx.projectsDir, videoId);

    for (const entry of readdirSync(projDir)) {
      if (KEEP.has(entry)) continue;

      const fullPath = join(projDir, entry);

      if (entry === "script") {
        // Clean inside script/ but keep full_script.md
        for (const child of readdirSync(fullPath)) {
          if (KEEP_IN_SCRIPT.has(child)) continue;
          rmSync(join(fullPath, child), { recursive: true, force: true });
        }
        // Remove script/ itself if empty (e.g. full_script.md was never created)
        if (readdirSync(fullPath).length === 0) {
          rmSync(fullPath, { recursive: true, force: true });
        }
        continue;
      }

      rmSync(fullPath, { recursive: true, force: true });
    }
  },
};
