import type { VideoStep } from "@/types";

export function humanizeStepName(name: string): string {
  return name
    .split("_")
    .filter(Boolean)
    .join(" ")
    .replace(/^./, (c) => c.toUpperCase());
}

export interface ArtifactGroup {
  // `LOGS_GROUP_KEY` is a synthetic, unnumbered category pinned above
  // step-owned groups. `OTHER_GROUP_KEY` collects unowned paths and sinks
  // to the bottom. Anything else is a real step name from the pipeline.
  stepName: string;
  stepIndex: number | null;
  artifacts: string[];
}

export const LOGS_GROUP_KEY = "__logs__";
export const OTHER_GROUP_KEY = "__other__";

/**
 * A rule maps a producer step's slug to a predicate over artifact paths
 * (relative to `projects/<video_id>/`). A rule fires only when its `step`
 * is a member of the current video's step list (see `groupArtifactsByStep`).
 */
export interface StepArtifactRule {
  step: string;
  match: (path: string) => boolean;
}

/**
 * Step → artifact-path rule table. Each producer step has exactly one
 * rule; the unified `generate_images` / `generate_clips` steps dispatch
 * via the workflow's image/video provider at runtime, so the artifact
 * rule is provider-agnostic.
 *
 * Slugs are cross-validated against `REAL_STEPS` at worker boot
 * (`bootValidate` in `src/worker/boot.ts`).
 */
export const STEP_ARTIFACT_RULES: readonly StepArtifactRule[] = [
  { step: "research_outline", match: (p) => p === "script/01_outline.md" },
  { step: "write_hook", match: (p) => p === "script/03_hook.md" },
  // Brittle: assumes write_chapters writes its outputs under script/04_*.md.
  // If the chapter-file naming convention changes (e.g. drops the numeric
  // prefix), chapter artifacts will silently fall into the Other bucket.
  {
    step: "write_chapters",
    match: (p) => p.startsWith("script/04_") || p === "script/story_so_far.md",
  },
  { step: "assemble_script", match: (p) => p === "script/full_script.md" },
  { step: "voiceover", match: (p) => p.startsWith("audio/narration.") },
  { step: "align", match: (p) => p.startsWith("alignment/") },
  // chunks/chunks.json is the chunk step's output; generate_visual_prompts
  // mutates it in place and intentionally has no rule of its own —
  // attribution tracks the file's creator, not whoever edited it last.
  { step: "chunk_clips_then_images", match: (p) => p.startsWith("chunks/") },
  { step: "chunk_images_only", match: (p) => p.startsWith("chunks/") },
  { step: "chunk_clips_only", match: (p) => p.startsWith("chunks/") },
  { step: "generate_images", match: (p) => p.startsWith("images/") },
  { step: "generate_clips", match: (p) => p.startsWith("videos/clip/") },
  // final.mp4 sits at the project root rather than under render/, but it's
  // the render step's output — keep both shapes mapped to the same group.
  { step: "render", match: (p) => p.startsWith("render/") || p === "final.mp4" },
];

export function groupArtifactsByStep(
  artifacts: string[],
  steps: VideoStep[]
): ArtifactGroup[] {
  const stepIndex = new Map<string, number>();
  steps.forEach((s, i) => stepIndex.set(s.step_name, i + 1));

  function ownerStep(path: string): string {
    if (path.endsWith(".log")) return LOGS_GROUP_KEY;
    for (const rule of STEP_ARTIFACT_RULES) {
      if (stepIndex.has(rule.step) && rule.match(path)) return rule.step;
    }
    return OTHER_GROUP_KEY;
  }

  const groups = new Map<string, ArtifactGroup>();
  for (const a of artifacts) {
    const owner = ownerStep(a);
    let group = groups.get(owner);
    if (!group) {
      // `?? null` only fires for the synthetic LOGS_GROUP_KEY / OTHER_GROUP_KEY
      // sentinels — every rule-derived `owner` has already passed
      // `stepIndex.has(rule.step)` in `ownerStep`, so the lookup hits.
      group = {
        stepName: owner,
        stepIndex: stepIndex.get(owner) ?? null,
        artifacts: [],
      };
      groups.set(owner, group);
    }
    group.artifacts.push(a);
  }

  return Array.from(groups.values()).sort((a, b) => {
    // Logs pinned to the top, Other sinks to the bottom, real steps in the
    // middle ordered by their 1-based position in the steps array.
    if (a.stepName === LOGS_GROUP_KEY) return -1;
    if (b.stepName === LOGS_GROUP_KEY) return 1;
    if (a.stepName === OTHER_GROUP_KEY) return 1;
    if (b.stepName === OTHER_GROUP_KEY) return -1;
    if (a.stepIndex === null) return 1;
    if (b.stepIndex === null) return -1;
    return a.stepIndex - b.stepIndex;
  });
}
