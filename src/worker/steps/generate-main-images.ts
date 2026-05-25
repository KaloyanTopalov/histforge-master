import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { Chunk } from "@/types";
import { appendLog } from "@/lib/logger";

/**
 * generate_main_images.
 *
 * Reads `chunks/chunks.json`, filters main chunks, and dispatches them to
 * the workflow's image provider via `ctx.imageProvider`. The provider
 * writes outputs into `images/main/<chunk_id>.<ext>`. ComfyUI runs locally
 * and returns when done; Google Flow may return a `DeferSignal` to yield
 * back to the orchestrator while its queue drains. Either return shape is
 * propagated upward unchanged.
 */
export const step: Step = {
  name: "generate_main_images",
  module: "image",
  label: "Generate main images",
  description:
    "Generates main images for each chunk via the workflow's image provider.",
  for_each: "chunks",
  inputs: ["chunks/chunks.json"],
  // outputs is empty because cleanup is provider-delegated below — the
  // orchestrator's default outputs-based delete (pipeline.ts:191-198) skips
  // when a step provides its own cleanup hook.
  outputs: [],
  produces: ["images/main/*.png"],
  run(videoId, ctx) {
    const projectDir = join(ctx.projectsDir, videoId);
    const chunksPath = join(projectDir, "chunks", "chunks.json");
    const targetDir = join(projectDir, "images", "main");

    const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    const items = chunks
      .filter((c) => c.kind === "main")
      .map((c) => ({ id: c.id, prompt: c.prompt! }));

    return ctx.imageProvider.generateBatch(items, targetDir, {
      db: ctx.db,
      log: (message) =>
        appendLog(videoId, "generate_main_images", message, ctx.projectsDir),
      videoId,
      projectsDir: ctx.projectsDir,
      promptsDir: ctx.promptsDir,
      chat: ctx.chat,
      signal: ctx.signal,
    });
  },
  async cleanup(videoId, ctx) {
    await ctx.imageProvider.cleanup?.(videoId, {
      db: ctx.db,
      log: (message) =>
        appendLog(videoId, "generate_main_images", message, ctx.projectsDir),
      projectsDir: ctx.projectsDir,
    });
  },
};
