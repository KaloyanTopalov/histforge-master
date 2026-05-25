import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { AlignmentEntry, Chunk } from "@/types";
import {
  getDerivedHookChunkCount,
  getHookClipSeconds,
} from "@/lib/settings";
import {
  MAIN_TARGET_SECONDS,
  findGroupEnd,
  makeChunk,
} from "./chunk-utils";

/**
 * Step 8 (workflow 1: clips-then-images) — chunking. Spec section 10
 * (`docs/histforge-spec.md:578-595`).
 *
 * Reads `alignment/alignment.json`, splits sentences into:
 * - up to `round(hook_length_seconds / clipSeconds)` `kind: "clip"` chunks
 *   of ~clipSeconds each — the workflow-1 hook section. `clipSeconds` is
 *   the provider-resolved per-clip target (`hook_video_clip_seconds` for
 *   ComfyUI; the `google_flow_hook_clip_seconds` enum when the workflow's
 *   video_provider is google_flow). Each cut at the nearest sentence
 *   boundary; emits fewer if sentences run out before the count cap.
 * - N `kind: "image"` chunks of ~30s each covering the remainder — the
 *   workflow-1 image body.
 *
 * Both per-clip values flow through paired settings helpers
 * (`getDerivedHookChunkCount` + `getHookClipSeconds`) so the count and
 * the per-chunk target can't drift across the provider branch. The
 * helpers keep their historic "hook" prefix because their physics — the
 * per-clip target duration — survives the asset-type rename.
 *
 * Writes `chunks/chunks.json`. All `prompt` fields are null (populated by
 * step 9 — generate_visual_prompts).
 *
 * Field rename: alignment uses `begin`/`end`, chunks use `start`/`end`.
 */
export const step: Step = {
  name: "chunk_clips_then_images",
  module: "glue",
  label: "Chunk (clips + images)",
  description: "Splits aligned sentences into a leading run of clip chunks and a body of image chunks.",
  inputs: ["alignment/alignment.json"],
  outputs: ["chunks/chunks.json"],
  async run(videoId, ctx) {
    const clipSeconds = getHookClipSeconds(ctx.snapshot, ctx.db);
    const hookChunkCount = getDerivedHookChunkCount(ctx.snapshot, ctx.db);

    const projectDir = resolve(ctx.projectsDir, videoId);
    const alignmentPath = join(projectDir, "alignment", "alignment.json");
    const chunksDir = join(projectDir, "chunks");
    const chunksPath = join(chunksDir, "chunks.json");

    const sentences: AlignmentEntry[] = JSON.parse(
      readFileSync(alignmentPath, "utf-8")
    );

    const chunks: Chunk[] = [];
    let pos = 0;

    // --- Hook (clip) chunks ---
    // Walk sentences accumulating ~clipSeconds per group. Stop after
    // `hookChunkCount` chunks OR when sentences run out (short narrations
    // get fewer hook chunks rather than empty groups).
    for (let i = 0; pos < sentences.length && i < hookChunkCount; i++) {
      const end = findGroupEnd(sentences, pos, clipSeconds);
      chunks.push(
        makeChunk(`clip_${String(i + 1).padStart(2, "0")}`, "clip", sentences.slice(pos, end + 1))
      );
      pos = end + 1;
    }

    // --- Main (image) chunks ---
    // From where the hook section ended, walk sentences accumulating ~30s
    // per chunk.
    for (let i = 1; pos < sentences.length; i++) {
      const end = findGroupEnd(sentences, pos, MAIN_TARGET_SECONDS);
      chunks.push(
        makeChunk(`image_${String(i).padStart(3, "0")}`, "image", sentences.slice(pos, end + 1))
      );
      pos = end + 1;
    }

    mkdirSync(chunksDir, { recursive: true });
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
  },
};
