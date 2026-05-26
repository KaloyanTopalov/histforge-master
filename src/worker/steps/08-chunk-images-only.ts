import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { AlignmentEntry, Chunk } from "@/types";
import { getSetting } from "@/lib/settings";
import { findGroupEnd, makeChunk } from "./chunk-utils";

/**
 * Step 8 (workflow 2: images-only) — chunking.
 *
 * Reads `alignment/alignment.json`, partitions the entire narration into
 * `kind: "image"` chunks of ~`image_chunk_target_seconds` (default 8s)
 * each. No clip (hook) section: every chunk pairs with a still image at
 * `images/<id>.png`. The target is read per-run from settings so operators
 * can tune image cadence without redeploying.
 *
 * Writes `chunks/chunks.json`. All `prompt` fields are null (populated by
 * step 9 — generate_visual_prompts).
 */
export const step: Step = {
  name: "chunk_images_only",
  module: "glue",
  label: "Chunk (images only)",
  description: "Splits aligned sentences into image-paired chunks covering the full narration.",
  inputs: ["alignment/alignment.json"],
  outputs: ["chunks/chunks.json"],
  async run(videoId, ctx) {
    const projectDir = resolve(ctx.projectsDir, videoId);
    const alignmentPath = join(projectDir, "alignment", "alignment.json");
    const chunksDir = join(projectDir, "chunks");
    const chunksPath = join(chunksDir, "chunks.json");

    const targetSeconds = getSetting("image_chunk_target_seconds", ctx.db);

    const sentences: AlignmentEntry[] = JSON.parse(
      readFileSync(alignmentPath, "utf-8")
    );

    const chunks: Chunk[] = [];
    let pos = 0;
    for (let i = 1; pos < sentences.length; i++) {
      const end = findGroupEnd(sentences, pos, targetSeconds);
      chunks.push(
        makeChunk(`image_${String(i).padStart(3, "0")}`, "image", sentences.slice(pos, end + 1))
      );
      pos = end + 1;
    }

    mkdirSync(chunksDir, { recursive: true });
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  },
};
