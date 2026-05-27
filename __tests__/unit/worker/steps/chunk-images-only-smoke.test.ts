import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Lay sentences with the given durations end-to-end starting at t=0.
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

describe("chunk_images_only — pacing smoke (60s, NULL overrides, defaults)", () => {
  it("emits chunks within [min,max] and mean duration within ±1.5s of global target", async () => {
    // Synthetic ~60s narration: 13 sentences with varied durations summing
    // to 60s. None is below the floor (4s) or above the ceiling (12s),
    // so the chunker has freedom to forward-merge without hitting the
    // oversized-single-sentence carve-out.
    const durations = [
      3.5, 5.0, 4.5, 5.5, 4.0,
      6.0, 5.0, 4.5, 5.0, 3.5,
      4.5, 4.5, 4.5,
    ];
    expect(durations.reduce((a, b) => a + b, 0)).toBeCloseTo(60, 1);
    const alignment = buildVariableAlignment(durations);
    const projectsDir = tempDir("projects");
    const videoId = "v_smoke";
    const alignDir = join(projectsDir, videoId, "alignment");
    mkdirSync(alignDir, { recursive: true });
    writeFileSync(
      join(alignDir, "alignment.json"),
      JSON.stringify(alignment)
    );

    const db = freshDb();
    // No `videos` row inserted — the chunker's pacing resolver tolerates
    // a missing video by treating all override columns as NULL, which
    // is exactly the "NULL overrides" condition this smoke tests.

    await chunkStep.run(videoId, makeStepContext({ projectsDir, db }));

    const chunks: Chunk[] = JSON.parse(
      readFileSync(
        join(projectsDir, videoId, "chunks", "chunks.json"),
        "utf-8"
      )
    );

    const target = 8;
    const min = 4;
    const max = 12;

    // Every chunk respects the floor/ceiling — no oversized sentences in
    // this fixture, so we can assert max strictly.
    for (const c of chunks) {
      const dur = c.end - c.start;
      expect(dur).toBeGreaterThanOrEqual(min - 1e-6);
      expect(dur).toBeLessThanOrEqual(max + 1e-6);
    }

    // Mean chunk duration tracks the global target within ±1.5s.
    const mean =
      chunks.reduce((a, c) => a + (c.end - c.start), 0) / chunks.length;
    expect(Math.abs(mean - target)).toBeLessThanOrEqual(1.5);

    // Chunk count ≈ 60/8 ≈ 7-8 → allow 5-10 inclusive.
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    expect(chunks.length).toBeLessThanOrEqual(10);

    // Step 08 is timing-only; `beat_type` is a content tag set by step 09.
    for (const c of chunks) {
      expect(c).not.toHaveProperty("beat_type");
    }
  });
});
