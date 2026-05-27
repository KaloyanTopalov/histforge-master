import { describe, it, expect, afterEach, vi } from "vitest";
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

/**
 * Build an alignment from an explicit list of sentence durations, laying
 * sentences contiguously starting at t=0. Used by the pacing-constraint
 * cases below where varying durations are the point of the test.
 */
function buildVariableAlignment(durations: number[]): AlignmentEntry[] {
  const entries: AlignmentEntry[] = [];
  let t = 0;
  for (let i = 0; i < durations.length; i++) {
    const begin = +t.toFixed(3);
    const end = +(t + durations[i]).toFixed(3);
    entries.push({
      id: `f${String(i + 1).padStart(6, "0")}`,
      text: `Sentence ${i + 1}.`,
      begin,
      end,
    });
    t = end;
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
    // Pair the higher target with a wider ceiling — the resolver
    // enforces min ≤ target ≤ max, and the default max=12 would
    // otherwise reject target=20.
    setSetting("image_chunk_max_seconds", 25, db);

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

  it("emits chunks within [min, max] under tight pacing constraints with no duration drift", async () => {
    // ~50 sentences of varying length summing to ~200s. Target=4/min=4/
    // max=10 squeezes the chunker — each chunk must clear the floor and
    // (modulo the single-oversized-sentence carve-out) stay under max.
    // The sum of chunk durations must equal the sum of input sentence
    // durations: chunks are derived from real alignment timestamps, so
    // any drift would mean the chunker re-timed sentences (which it
    // must not — step 14's render reads chunk.start/end as truth).
    const durations: number[] = [];
    for (let i = 0; i < 50; i++) {
      // Cycle through 2/3/4/5/6 so the partition has to make non-trivial
      // grouping choices to satisfy min without overshooting max.
      durations.push(2 + (i % 5));
    }
    const alignment = buildVariableAlignment(durations);
    const totalNarration =
      alignment[alignment.length - 1].end - alignment[0].begin;

    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_constraints";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("image_chunk_target_seconds", 4, db);
    setSetting("image_chunk_min_seconds", 4, db);
    setSetting("image_chunk_max_seconds", 10, db);

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      const dur = c.end - c.start;
      // Single-sentence chunks may exceed max (carve-out). All others
      // must sit inside [min, max].
      expect(dur).toBeGreaterThanOrEqual(4);
      if (dur > 10) {
        // Oversize is only legal when the chunk holds a single sentence
        // — assert the chunk's text is one sentence (period-terminated).
        const sentenceCount = c.text.split(". ").length;
        expect(sentenceCount).toBe(1);
      }
    }

    // No drift — chunks fully cover [0, totalNarration].
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(totalNarration);
    const summed = chunks.reduce((acc, c) => acc + (c.end - c.start), 0);
    expect(summed).toBeCloseTo(totalNarration, 3);
  });

  it("forward-merges a short sentence into the next chunk to satisfy min", async () => {
    // 3 normal 5s sentences, then a synthetic 1s sentence ("The moon."),
    // then 3 more 5s sentences. With min=4, the 1s sentence cannot
    // stand alone — it must be absorbed into the following group.
    const alignment = buildVariableAlignment([5, 5, 5, 1, 5, 5, 5]);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_forward_merge";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("image_chunk_target_seconds", 4, db);
    setSetting("image_chunk_min_seconds", 4, db);
    setSetting("image_chunk_max_seconds", 12, db);

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    // No chunk under the floor.
    for (const c of chunks) {
      expect(c.end - c.start).toBeGreaterThanOrEqual(4);
    }

    // The 1s sentence spans [15, 16]. The chunk that contains it must
    // also extend past 16 — i.e. it absorbed at least one subsequent
    // sentence rather than emitting [15, 16] standalone.
    const owning = chunks.find((c) => c.start <= 15 && c.end > 16);
    expect(owning).toBeDefined();
    expect(owning!.end).toBeGreaterThan(16);
  });

  it("backward-tidies a sub-floor tail into the previous chunk", async () => {
    // 5 normal 5s sentences (25s) followed by a 2s tail. min=4 means
    // the 2s tail cannot stand alone. Forward partition would emit
    // [..., last] with last.dur=2; the backward-tidy pass absorbs it.
    const alignment = buildVariableAlignment([5, 5, 5, 5, 5, 2]);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_tidy";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("image_chunk_target_seconds", 4, db);
    setSetting("image_chunk_min_seconds", 4, db);
    setSetting("image_chunk_max_seconds", 12, db);

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    // Final chunk satisfies min — the 2s tail was absorbed, not emitted
    // as its own chunk.
    const lastDur =
      chunks[chunks.length - 1].end - chunks[chunks.length - 1].start;
    expect(lastDur).toBeGreaterThanOrEqual(4);

    // Total coverage unchanged.
    expect(chunks[chunks.length - 1].end).toBe(27);
  });

  it("emits a single-sentence chunk exceeding max with a logged warning, not a throw", async () => {
    // The oversize carve-out: a 15s sentence at max=10 cannot be
    // subdivided (sentence is the smallest atom). The chunker emits the
    // chunk verbatim and logs a WARN so operators can see the long
    // sentence in their pipeline output.
    const alignment = buildVariableAlignment([5, 15, 5]);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_oversize";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("image_chunk_target_seconds", 4, db);
    setSetting("image_chunk_min_seconds", 4, db);
    setSetting("image_chunk_max_seconds", 10, db);

    const logMock = vi.fn();
    await expect(
      chunkStep.run(
        videoId,
        makeStepContext({ projectsDir, db, log: logMock })
      )
    ).resolves.toBeUndefined();
    const chunks = readChunks(projectsDir, videoId);

    // The 15s sentence spans [5, 20]. Its owning chunk has start=5 and
    // duration ≥ 15 (it may have absorbed neighbors but cannot subdivide).
    const owning = chunks.find((c) => c.start <= 5 && c.end >= 20);
    expect(owning).toBeDefined();
    expect(owning!.end - owning!.start).toBeGreaterThanOrEqual(15);

    // Log was called with a WARN-prefixed message naming the max bound.
    const warns = logMock.mock.calls
      .map((args) => String(args[0]))
      .filter((m) => /WARN/.test(m));
    expect(warns.length).toBeGreaterThan(0);
    expect(warns.some((m) => /max=10/.test(m))).toBe(true);
  });

  it("accepts a single chunk under the floor when the whole narration is shorter than min", async () => {
    // 1 sentence × 2s, default min=4. The defensive floor only fires
    // when groups.length > 1 — a whole-video-shorter-than-min is the
    // intended single-chunk edge case and must be emitted unconditionally.
    const alignment = buildAlignment(1, 2);
    const projectsDir = tempDir("projects");
    const videoId = "v_images_only_tiny";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].start).toBe(0);
    expect(chunks[0].end).toBe(2);
  });
});
