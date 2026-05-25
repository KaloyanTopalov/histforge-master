import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { Chunk } from "@/types";
import { appendLog } from "@/lib/logger";

/**
 * generate_clips.
 *
 * Reads `chunks/chunks.json`, filters clip chunks, and dispatches them to
 * the workflow's video provider via `ctx.videoProvider`. Outputs land at
 * `videos/clip/<chunk_id>.<ext>`. ComfyUI runs locally; Google Flow may
 * return a `DeferSignal` to yield while its queue drains. Either return
 * shape is propagated upward unchanged.
 */
export const step: Step = {
  name: "generate_clips",
  module: "video",
  label: "Generate clips",
  description:
    "Generates a video clip for each clip chunk via the workflow's video provider.",
  for_each: "chunks",
  inputs: ["chunks/chunks.json"],
  outputs: [],
  produces: ["videos/clip/*.mp4"],
  run(videoId, ctx) {
    const projectDir = join(ctx.projectsDir, videoId);
    const chunksPath = join(projectDir, "chunks", "chunks.json");
    const targetDir = join(projectDir, "videos", "clip");

    const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    const items = chunks
      .filter((c) => c.kind === "clip")
      .map((c) => ({ id: c.id, prompt: c.prompt! }));

    return ctx.videoProvider.generateBatch(items, targetDir, {
      db: ctx.db,
      log: (message) =>
        appendLog(videoId, "generate_clips", message, ctx.projectsDir),
      videoId,
      projectsDir: ctx.projectsDir,
      signal: ctx.signal,
    });
  },
  async cleanup(videoId, ctx) {
    await ctx.videoProvider.cleanup?.(videoId, {
      db: ctx.db,
      log: (message) =>
        appendLog(videoId, "generate_clips", message, ctx.projectsDir),
      projectsDir: ctx.projectsDir,
    });
  },
};
