import { type Step } from "@/worker/pipeline";
import { step as research_outline } from "./01-research-outline";
import { step as write_hook } from "./03-write-hook";
import { step as write_chapters } from "./04-write-chapters";
import { step as assemble_script } from "./05-assemble-script";
import { step as voiceover } from "./06-voiceover";
import { step as align } from "./07-align";
import { step as chunk_clips_then_images } from "./08-chunk-clips-then-images";
import { step as chunk_images_only } from "./08-chunk-images-only";
import { step as chunk_clips_only } from "./08-chunk-clips-only";
import { step as generate_visual_prompts } from "./09-generate-visual-prompts";
import { step as generate_images } from "./generate-images";
import { step as generate_clips } from "./generate-clips";
import { step as draw_on_images } from "./draw-on-images";
import { step as render } from "./14-render";
import { step as cleanup } from "./15-cleanup";
import { step as generate_loop_image } from "./generate-loop-image";
import { step as generate_loop_clip } from "./generate-loop-clip";
import { step as make_thumbnail } from "./make-thumbnail";
import { step as generate_music } from "./generate-music";
import { step as download_music } from "./download-music";
import { step as render_music_video } from "./render-music-video";

/**
 * Production step list. The DB-backed workflow registry (`workflows`
 * table, seeded by `seedDefaultWorkflows`) owns step ordering per
 * workflow row. Adding a new step: create the file, add it here, and
 * reference the slug from at least one workflow row's `workflow_steps`
 * children (or rely on the static glue/module insertion in
 * `materializeStepList`). `bootValidate(db)` (`src/worker/boot.ts`)
 * catches dangling slugs at worker startup.
 *
 * Music-video stubs are grouped below the narrative steps for
 * readability; ordering here does NOT drive runtime order — the
 * materializer's kind-switch (`lib/workflows.ts`) does.
 */
export const REAL_STEPS: readonly Step[] = [
  research_outline,
  write_hook,
  write_chapters,
  assemble_script,
  voiceover,
  align,
  chunk_clips_then_images,
  chunk_images_only,
  chunk_clips_only,
  generate_visual_prompts,
  generate_images,
  generate_clips,
  draw_on_images,
  render,
  cleanup,
  generate_loop_image,
  generate_loop_clip,
  make_thumbnail,
  generate_music,
  download_music,
  render_music_video,
];

/**
 * Per-step output paths (relative to `projects/<video_id>/`). Derived
 * from each step's own `outputs` declaration. Kept for test/consumer
 * convenience; the orchestrator reads `step.outputs` directly.
 */
export const STEP_OUTPUTS: Record<string, readonly string[]> =
  Object.fromEntries(REAL_STEPS.map((s) => [s.name, s.outputs]));
