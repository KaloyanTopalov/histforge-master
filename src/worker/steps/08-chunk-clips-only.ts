import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { AlignmentEntry, Chunk } from "@/types";
import { getHookClipSeconds } from "@/lib/settings";
import { findGroupEnd, makeChunk } from "./chunk-utils";

/**
 * Step 8 (workflow 3: clips-only) — chunking.
 *
 * Reads `alignment/alignment.json`, partitions the entire narration into
 * `kind: "clip"` chunks of ~`clipSeconds` each (resolved by
 * `getHookClipSeconds`, the same provider-aware helper the
 * clips-then-images chunker uses for its hook section). No
 * `hookChunkCount` cap: every chunk pairs with a generated clip at
 * `videos/clip/<id>.mp4`.
 *
 * The helper's historic "hook" name is a documented artifact — the
 * per-clip target physics survive the asset-type rename, so renaming
 * adds churn without benefit.
 *
 * Writes `chunks/chunks.json`. All `prompt` fields are null (populated
 * by step 9 — generate_visual_prompts).
 */
export const step: Step = {
  name: "chunk_clips_only",
  module: "glue",
  label: "Chunk (clips only)",
  description: "Splits aligned sentences into clip-paired chunks covering the full narration.",
  inputs: ["alignment/alignment.json"],
  outputs: ["chunks/chunks.json"],
  async run(videoId, ctx) {
    const clipSeconds = getHookClipSeconds(ctx.snapshot, ctx.db);

    const projectDir = resolve(ctx.projectsDir, videoId);
    const alignmentPath = join(projectDir, "alignment", "alignment.json");
    const chunksDir = join(projectDir, "chunks");
    const chunksPath = join(chunksDir, "chunks.json");

    const sentences: AlignmentEntry[] = JSON.parse(
      readFileSync(alignmentPath, "utf-8")
    );

    // 3-digit padding matches `chunk_images_only`'s `image_NNN`: both
    // chunkers are unbounded, so they span the full narration and can
    // realistically produce >99 chunks (worst case here: hook_length=400 /
    // clipSeconds=4 = 100). The clip-section ids in
    // `chunk_clips_then_images` stay 2-digit because that section is
    // capped at `hookChunkCount` and existing on-disk artifacts use the
    // narrower format.
    const chunks: Chunk[] = [];
    let pos = 0;
    for (let i = 1; pos < sentences.length; i++) {
      const end = findGroupEnd(sentences, pos, clipSeconds);
      chunks.push(
        makeChunk(`clip_${String(i).padStart(3, "0")}`, "clip", sentences.slice(pos, end + 1))
      );
      pos = end + 1;
    }

    mkdirSync(chunksDir, { recursive: true });
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  },
};
