import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { AlignmentEntry, Chunk } from "@/types";
import { getImageChunkPacing } from "@/lib/settings";
import * as videosRepo from "@/lib/repos/videos";
import { findGroupEnd, makeChunk } from "./chunk-utils";

/**
 * Thrown by the defensive floor check at the tail of `chunk_images_only`'s
 * run body. Belt-and-suspenders for the forward-extend + backward-tidy
 * guarantees — under valid `AlignmentEntry[]` input these passes preclude
 * a sub-floor non-last chunk, so this throw is dead code unless a future
 * refactor loosens those invariants. When it fires, the message carries
 * the offending chunk index and resolved floor so operators can trace
 * which chunker pass to inspect.
 */
export class ChunkerFloorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkerFloorError";
  }
}

/**
 * Step 8 (workflow 2: images-only) — chunking.
 *
 * Reads `alignment/alignment.json` and partitions the narration into
 * `kind: "image"` chunks. Pacing comes from `getImageChunkPacing(video,
 * db)` — per-video columns override globals, resolver guarantees
 * `min ≤ target ≤ max`. The partition is two-pass:
 *
 *   1. Forward partition: walk sentences accumulating to `target`, then
 *      extend forward sentence-by-sentence until `min` is satisfied (or
 *      the input is exhausted — the last group can still fall short).
 *   2. Backward tidy: if the final group's duration is below `min` and
 *      there is at least one previous group, absorb the tail into the
 *      previous group.
 *
 * Two carve-outs:
 *   - Single sentence longer than `max` is emitted verbatim with a
 *     `WARN:` log line — VO has no smaller atom than a sentence.
 *   - Whole narration shorter than `min` produces a single chunk
 *     unconditionally; the defensive floor only fires when
 *     `groups.length > 1`.
 *
 * Writes `chunks/chunks.json`. All `prompt` fields are null (populated
 * by step 9 — generate_visual_prompts).
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

    const video = videosRepo.findById(ctx.db, videoId);
    const pacing = getImageChunkPacing(
      {
        image_chunk_target_seconds:
          video?.image_chunk_target_seconds ?? null,
        image_chunk_min_seconds:
          video?.image_chunk_min_seconds ?? null,
        image_chunk_max_seconds:
          video?.image_chunk_max_seconds ?? null,
      },
      ctx.db
    );

    const sentences: AlignmentEntry[] = JSON.parse(
      readFileSync(alignmentPath, "utf-8")
    );

    const groups: AlignmentEntry[][] = [];
    let pos = 0;
    while (pos < sentences.length) {
      let end = findGroupEnd(sentences, pos, pacing.target);
      let duration = sentences[end].end - sentences[pos].begin;
      while (duration < pacing.min && end < sentences.length - 1) {
        end += 1;
        duration = sentences[end].end - sentences[pos].begin;
      }
      groups.push(sentences.slice(pos, end + 1));
      pos = end + 1;
    }

    if (groups.length > 1) {
      const last = groups[groups.length - 1];
      const lastDur = last[last.length - 1].end - last[0].begin;
      if (lastDur < pacing.min) {
        const prev = groups[groups.length - 2];
        groups[groups.length - 2] = [...prev, ...last];
        groups.pop();
      }
    }

    for (const g of groups) {
      const dur = g[g.length - 1].end - g[0].begin;
      if (dur > pacing.max) {
        ctx.log(
          `WARN: chunk starting at ${g[0].begin}s exceeds max=${pacing.max}s ` +
            `(duration=${dur.toFixed(2)}s) — single oversized sentence; cannot subdivide.`
        );
      }
    }

    for (let i = 0; i < groups.length; i++) {
      const g = groups[i];
      const dur = g[g.length - 1].end - g[0].begin;
      if (dur < pacing.min && groups.length > 1) {
        throw new ChunkerFloorError(
          `chunk_images_only: chunk index ${i} duration ${dur.toFixed(2)}s ` +
            `is below floor ${pacing.min}s after forward+backward merge — chunker bug.`
        );
      }
    }

    const chunks: Chunk[] = groups.map((g, i) =>
      makeChunk(`image_${String(i + 1).padStart(3, "0")}`, "image", g)
    );

    mkdirSync(chunksDir, { recursive: true });
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  },
};
