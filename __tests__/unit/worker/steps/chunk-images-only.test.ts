import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AlignmentEntry, Chunk } from "@/types";
import { setSetting } from "@/lib/settings";
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
    // 60 sentences × 5s = 300s narration. With the default 8s target,
    // the chunker emits many short image chunks; this test only asserts
    // structural invariants (ordering, coverage, IDs), not chunk count.
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

  it("honors the default image_chunk_target_seconds (8s) within sentence-boundary tolerance", async () => {
    // 200 sentences × 2s = 400s. Default 8s target with 2s sentences →
    // 4 sentences per chunk = 8s exact.
    const alignment = buildAlignment(200, 2);
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
      // 2s sentences → tolerance ±2s around the 8s target.
      expect(dur).toBeGreaterThanOrEqual(6);
      expect(dur).toBeLessThanOrEqual(10);
    }

    const lastDur =
      chunks[chunks.length - 1].end - chunks[chunks.length - 1].start;
    expect(lastDur).toBeGreaterThan(0);
  });

  it("honors a non-default image_chunk_target_seconds value", async () => {
    // 60 sentences × 2s = 120s. Override target to 20s → 10 sentences
    // per chunk = 20s exact. Verifies the chunker actually reads the
    // setting (not the legacy constant) on each run.
    const alignment = buildAlignment(60, 2);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_custom";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("image_chunk_target_seconds", 20, db);

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    for (let i = 0; i < chunks.length - 1; i++) {
      const dur = chunks[i].end - chunks[i].start;
      // 2s sentences → tolerance ±2s around the 20s target.
      expect(dur).toBeGreaterThanOrEqual(18);
      expect(dur).toBeLessThanOrEqual(22);
    }
  });

  it("handles very short narrations as a single chunk", async () => {
    // 3 sentences × 2s = 6s. Less than one 8s chunk → one chunk emitted.
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
