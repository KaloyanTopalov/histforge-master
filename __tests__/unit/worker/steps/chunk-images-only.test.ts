import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AlignmentEntry, Chunk } from "@/types";
import { step as chunkStep } from "@/worker/steps/08-chunk-images-only";
import {
  cleanup,
  freshDb,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

afterEach(cleanup);

function buildAlignment(
  count: number,
  durEach: number
): AlignmentEntry[] {
  const entries: AlignmentEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      id: `f${String(i + 1).padStart(6, "0")}`,
      text: `Sentence ${i + 1}.`,
      begin: +(i * durEach).toFixed(3),
      end: +((i + 1) * durEach).toFixed(3),
    });
  }
  return entries;
}

function writeAlignment(
  projectsDir: string,
  videoId: string,
  alignment: AlignmentEntry[]
): void {
  const alignDir = join(projectsDir, videoId, "alignment");
  mkdirSync(alignDir, { recursive: true });
  writeFileSync(
    join(alignDir, "alignment.json"),
    JSON.stringify(alignment)
  );
}

function readChunks(projectsDir: string, videoId: string): Chunk[] {
  const chunksPath = join(projectsDir, videoId, "chunks", "chunks.json");
  return JSON.parse(readFileSync(chunksPath, "utf-8"));
}

describe("chunk_images_only (step 8 — images-only variant)", () => {
  it("emits only kind='image' chunks with image_NNN ids covering the entire narration", async () => {
    // 60 sentences × 5s = 300s narration. Target 30s per chunk → ~10
    // chunks of ~6 sentences each.
    const alignment = buildAlignment(60, 5);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.kind).toBe("image");
    }

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].id).toBe(`image_${String(i + 1).padStart(3, "0")}`);
    }

    // No gaps, no overlaps, full coverage.
    expect(chunks[0].start).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end);
    }
    const audioEnd = alignment[alignment.length - 1].end;
    expect(chunks[chunks.length - 1].end).toBe(audioEnd);

    // All prompts null until step 9 enriches them.
    for (const c of chunks) {
      expect(c.prompt).toBeNull();
    }

    // Field rename invariant: chunks use start/end, not begin/end.
    for (const c of chunks) {
      expect(c).toHaveProperty("start");
      expect(c).toHaveProperty("end");
      expect(c).not.toHaveProperty("begin");
    }
  });

  it("each chunk is ~30s within sentence-boundary tolerance (last chunk may be shorter)", async () => {
    // 100 sentences × 5s = 500s. 30s target → 6 sentences per chunk = 30s exact.
    const alignment = buildAlignment(100, 5);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_dur";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    for (let i = 0; i < chunks.length - 1; i++) {
      const dur = chunks[i].end - chunks[i].start;
      // 5s sentences → tolerance ±5s around the 30s target.
      expect(dur).toBeGreaterThanOrEqual(25);
      expect(dur).toBeLessThanOrEqual(35);
    }

    const lastDur =
      chunks[chunks.length - 1].end - chunks[chunks.length - 1].start;
    expect(lastDur).toBeGreaterThan(0);
  });

  it("handles very short narrations as a single chunk", async () => {
    // 3 sentences × 2s = 6s. Less than one 30s chunk → one chunk emitted.
    const alignment = buildAlignment(3, 2);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_short";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].kind).toBe("image");
    expect(chunks[0].id).toBe("image_001");
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].end).toBe(6);
  });
});
