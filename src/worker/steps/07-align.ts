import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { align, type AlignOpts } from "@/lib/align";

/**
 * Deliberate exception to the {@link makeStepContext} convention used by
 * the other doer-steps. This module keeps a `*Deps` shape + named `runAlign`
 * function because its test-only injection point (`spawnFn` — the aeneas
 * child-process spawn) is non-cross-cutting and has no home on
 * `StepContext`. Promoting it would expand the cross-cutting surface for
 * one step's benefit. See docs/handoffs/2026-05-16-step-deps-collapse-plan.md
 * for the design call.
 */
export interface AlignStepDeps extends AlignOpts {
  projectsDir?: string;
}

/**
 * Step 7 — alignment. Thin glue: constructs paths from the project layout
 * and delegates to `lib/align.ts` which handles sentence splitting, file
 * I/O, and WSL/aeneas invocation. See `docs/histforge-spec.md:398-432`.
 */
export async function runAlign(
  videoId: string,
  deps: AlignStepDeps = {}
): Promise<void> {
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";

  const projectDir = join(projectsDir, videoId);
  const audioPath = join(projectDir, "audio", "narration.mp3");
  const scriptPath = join(projectDir, "script", "full_script.md");
  const outPath = join(projectDir, "alignment", "alignment.json");

  await align(audioPath, scriptPath, outPath, deps);
}

export const step: Step = {
  name: "align",
  module: "glue",
  label: "Align",
  description: "Aligns the script against narration audio with aeneas.",
  inputs: ["script/full_script.md", "audio/narration.mp3"],
  outputs: ["alignment/sentences.txt", "alignment/alignment.json"],
  // sentences.txt is intermediate, not consumed downstream.
  produces: ["alignment/alignment.json"],
  run(videoId, ctx) {
    return runAlign(videoId, { projectsDir: ctx.projectsDir });
  },
};
