import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { Chunk } from "@/types";
import { appendLog } from "@/lib/logger";
import { getSetting } from "@/lib/settings";
import { resolveDrawOnPythonPath, runDrawOnCli } from "@/lib/draw-on-python";

const STEP_NAME = "draw_on_images";

/**
 * draw_on_images.
 *
 * Pre-render stage for doodle workflows: reads `chunks/chunks.json`,
 * filters image chunks, and produces a per-image draw-on reveal clip at
 * `clips_drawn/<chunk_id>.mp4` by spawning `python -m draw_on` once per
 * chunk. The render step (14-render) picks these up via the
 * `drawOnClipPath` branch in `buildSegmentArgs` (Phase 6); when the
 * workflow's image_style declares `reveal_effect: "draw_on"`, render
 * uses the clip instead of `-loop`-ing the still PNG.
 *
 * Sequential by design — the CLI is CPU-bound OpenCV (adaptive threshold,
 * dilated NN traversal, ~5.5s/image), and parallelism inside one video
 * duplicates the queue picker's cross-video axis. Pause/resume is
 * cheap: the loop skips chunks whose clip already exists, and an abort
 * mid-chunk kills the in-flight child via `runDrawOnCli`'s AbortSignal
 * wiring and bails the loop at the next between-iteration checkpoint.
 *
 * Failures bubble up unchanged — one bad chunk fails the step (no
 * silent fall-through to a partial clips_drawn/). The materializer
 * (Phase 5) is responsible for inserting this step only when the
 * style needs it; cinematic workflows never see it.
 */
export const step: Step = {
  name: STEP_NAME,
  module: "glue",
  label: "Draw-on reveal clips",
  description:
    "Generates per-image draw-on reveal MP4 clips for doodle image styles.",
  for_each: "chunks",
  inputs: ["chunks/chunks.json", "images"],
  outputs: ["clips_drawn"],
  produces: ["clips_drawn/*.mp4"],

  async run(videoId, ctx) {
    const projectDir = join(ctx.projectsDir, videoId);
    const chunksPath = join(projectDir, "chunks", "chunks.json");
    const imagesDir = join(projectDir, "images");
    const clipsDir = join(projectDir, "clips_drawn");

    mkdirSync(clipsDir, { recursive: true });

    const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    const imageChunks = chunks.filter((c) => c.kind === "image");

    const log = (message: string) =>
      appendLog(videoId, STEP_NAME, message, ctx.projectsDir);

    const setting = getSetting("draw_on_python_path", ctx.db);
    const pythonPath = resolveDrawOnPythonPath({ setting });

    for (const chunk of imageChunks) {
      // Between-iteration abort checkpoint. The previous iteration's
      // runDrawOnCli also receives ctx.signal and bails its own child on
      // abort; this check covers the post-resolve / pre-next-spawn gap.
      if (ctx.signal.aborted) {
        throw new Error("draw_on_images aborted between chunks");
      }

      const outputPath = join(clipsDir, `${chunk.id}.mp4`);
      if (existsSync(outputPath)) {
        log(`skip ${chunk.id} — clip already exists`);
        continue;
      }

      const imagePath = join(imagesDir, `${chunk.id}.png`);
      const durationSec = chunk.end - chunk.start;

      log(`draw ${chunk.id} (${durationSec.toFixed(2)}s)`);

      await runDrawOnCli({
        pythonPath,
        imagePath,
        durationSec,
        outputPath,
        signal: ctx.signal,
        log,
      });
    }
  },
};
