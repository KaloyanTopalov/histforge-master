import type { AlignmentEntry, Chunk, ChunkKind } from "@/types";

/**
 * Shared chunker primitives. The three chunker variants
 * (`chunk_clips_then_images`, `chunk_images_only`, `chunk_clips_only`)
 * all walk sentences in groups bounded by a target duration and emit
 * `Chunk`s with normalized `start`/`end`/`text`. The variation between
 * chunkers is only: (1) the partition target per group, and (2) the
 * `kind` + `id` prefix assigned to each chunk.
 */

export const MAIN_TARGET_SECONDS = 30;

/**
 * Walk sentences from `pos` accumulating ~`targetSeconds` of duration,
 * returning the index of the sentence whose `end` is the nearest boundary
 * to `pos.begin + targetSeconds`. Always returns at least `pos` (one
 * sentence per group, never empty).
 */
export function findGroupEnd(
  sentences: AlignmentEntry[],
  pos: number,
  targetSeconds: number
): number {
  const target = sentences[pos].begin + targetSeconds;
  let bestIdx = pos;
  for (let i = pos; i < sentences.length; i++) {
    bestIdx = i;
    if (sentences[i].end >= target) {
      if (
        i > pos &&
        target - sentences[i - 1].end < sentences[i].end - target
      ) {
        bestIdx = i - 1;
      }
      break;
    }
  }
  return bestIdx;
}

export function makeChunk(
  id: string,
  kind: ChunkKind,
  sentences: AlignmentEntry[]
): Chunk {
  return {
    id,
    kind,
    start: sentences[0].begin,
    end: sentences[sentences.length - 1].end,
    text: sentences.map((s) => s.text).join(" "),
    prompt: null,
  };
}
