import type { Database as DatabaseType } from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Step } from "@/worker/pipeline";
import type { AlignmentEntry, Chunk } from "@/types";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";

const MAIN_TARGET_SECONDS = 30;

export interface ChunkDeps {
  projectsDir?: string;
  db?: DatabaseType;
}

/**
 * Step 8 — chunking. Spec section 10 (`docs/histforge-spec.md:578-595`).
 *
 * Reads `alignment/alignment.json`, splits sentences into:
 * - up to `hook_chunk_count` hook chunks of ~`hook_video_clip_seconds` each
 *   (each cut at the nearest sentence boundary; emits fewer if sentences
 *   run out before the count cap)
 * - N main chunks of ~30s each covering the remainder
 *
 * Writes `chunks/chunks.json`. All `prompt` fields are null (populated by
 * step 9 — enrich_chunks).
 *
 * Field rename: alignment uses `begin`/`end`, chunks use `start`/`end`.
 */
export async function runChunk(
  videoId: string,
  deps: ChunkDeps = {}
): Promise<void> {
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";
  const db = deps.db ?? getDb();
  const clipSeconds = getSetting("hook_video_clip_seconds", db);
  const hookChunkCount = getSetting("hook_chunk_count", db);

  const projectDir = resolve(projectsDir, videoId);
  const alignmentPath = join(projectDir, "alignment", "alignment.json");
  const chunksDir = join(projectDir, "chunks");
  const chunksPath = join(chunksDir, "chunks.json");

  const sentences: AlignmentEntry[] = JSON.parse(
    readFileSync(alignmentPath, "utf-8")
  );

  const chunks: Chunk[] = [];
  let pos = 0;

  // --- Hook chunks ---
  // Walk sentences accumulating ~clipSeconds per group. Stop after
  // `hookChunkCount` chunks OR when sentences run out (short narrations
  // get fewer hook chunks rather than empty groups).
  for (let i = 0; pos < sentences.length && i < hookChunkCount; i++) {
    const end = findGroupEnd(sentences, pos, clipSeconds);
    chunks.push(
      makeChunk(`hook_${String(i + 1).padStart(2, "0")}`, "hook", sentences.slice(pos, end + 1))
    );
    pos = end + 1;
  }

  // --- Main chunks ---
  // From where hook ended, walk sentences accumulating ~30s per chunk.
  for (let i = 1; pos < sentences.length; i++) {
    const end = findGroupEnd(sentences, pos, MAIN_TARGET_SECONDS);
    chunks.push(
      makeChunk(`main_${String(i).padStart(3, "0")}`, "main", sentences.slice(pos, end + 1))
    );
    pos = end + 1;
  }

  mkdirSync(chunksDir, { recursive: true });
  writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
}

/**
 * Walk sentences from `pos` accumulating ~`targetSeconds` of duration,
 * returning the index of the sentence whose `end` is the nearest boundary
 * to `pos.begin + targetSeconds`. Always returns at least `pos` (one
 * sentence per group, never empty).
 */
function findGroupEnd(
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

function makeChunk(
  id: string,
  kind: "hook" | "main",
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

export const step: Step = {
  name: "chunk",
  module: "glue",
  label: "Chunk",
  description: "Splits aligned sentences into hook and main scene chunks.",
  inputs: ["alignment/alignment.json"],
  outputs: ["chunks/chunks.json"],
  run(videoId, ctx) {
    return runChunk(videoId, { projectsDir: ctx.projectsDir, db: ctx.db });
  },
};
