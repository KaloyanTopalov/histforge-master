import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

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

/**
 * Wipes every artifact in `<projectsDir>/<videoId>/` except the keep set.
 * Pure function — no DB reads, no settings checks. Step 15 and the
 * operator-triggered cleanup endpoint both call this; the gating lives at
 * the call sites so the wipe behavior stays a single source of truth.
 */
export function cleanupProjectArtifacts(
  projectsDir: string,
  videoId: string
): void {
  const projDir = join(projectsDir, videoId);

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
}
