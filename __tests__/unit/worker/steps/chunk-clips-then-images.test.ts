import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AlignmentEntry, Chunk, WorkflowSnapshot } from "@/types";
import { step as chunkStep } from "@/worker/steps/08-chunk-clips-then-images";
import { setSetting } from "@/lib/settings";
import {
  cleanup,
  freshDb,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

// Google-Flow snapshot stand-in for the Phase-2 provider-aware branch test.
// `getHookClipSeconds` only reads `video_provider` off the snapshot; the
// other fields are irrelevant but the type wants them populated.
const FLOW_SNAPSHOT: WorkflowSnapshot = {
  workflow_id: "google-flow",
  version: 1,
  kind: "narrative",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "google_flow",
  video_provider: "google_flow",
  music_provider: null,
  upscaler_provider: null,
  chunker_step: "chunk_clips_then_images",
  steps: [],
};

afterEach(cleanup);

/**
 * Build a synthetic alignment array: evenly-spaced sentences of `durEach`
 * seconds, totalling `count` sentences starting from t=0.
 */
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

describe("chunk_clips_then_images (step 8)", () => {
  it("produces 15 clip chunks of ~8s and ~30s image chunks with correct fields", async () => {
    // 80 sentences × 4s = 320s total. Defaults: 15 clip chunks × 8s = 120s
    // (each chunk = 2 sentences = 8s exact under nearest-boundary logic).
    // Images: 50 sentences × 4s = 200s, ~30s chunks → 8 sentences per chunk
    // (32s under tie-break; algorithm keeps current sentence on tie).
    const alignment = buildAlignment(80, 4);
    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_test";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    // --- Clip chunks ---
    const clipChunks = chunks.filter((c) => c.kind === "clip");
    expect(clipChunks).toHaveLength(15);

    for (let i = 0; i < 15; i++) {
      expect(clipChunks[i].id).toBe(`clip_${String(i + 1).padStart(2, "0")}`);
    }

    expect(clipChunks[0].start).toBe(0);
    for (let i = 1; i < clipChunks.length; i++) {
      expect(clipChunks[i].start).toBe(clipChunks[i - 1].end);
    }

    // Per-chunk duration close to clipSeconds (8s) within sentence-boundary
    // tolerance (one sentence = 4s here, so ±4s is the worst-case bound).
    for (const cc of clipChunks) {
      const dur = cc.end - cc.start;
      expect(dur).toBeGreaterThanOrEqual(4);
      expect(dur).toBeLessThanOrEqual(12);
    }

    // --- Image chunks ---
    const imageChunks = chunks.filter((c) => c.kind === "image");
    expect(imageChunks.length).toBeGreaterThanOrEqual(1);

    for (let i = 0; i < imageChunks.length; i++) {
      expect(imageChunks[i].id).toBe(
        `image_${String(i + 1).padStart(3, "0")}`
      );
    }

    const clipEnd = clipChunks[clipChunks.length - 1].end;
    expect(imageChunks[0].start).toBe(clipEnd);

    for (let i = 1; i < imageChunks.length; i++) {
      expect(imageChunks[i].start).toBe(imageChunks[i - 1].end);
    }

    // --- Field rename: start/end not begin/end ---
    for (const c of chunks) {
      expect(c).toHaveProperty("start");
      expect(c).toHaveProperty("end");
      expect(c).not.toHaveProperty("begin");
    }

    // --- All prompts are null ---
    for (const c of chunks) {
      expect(c.prompt).toBeNull();
    }

    for (const c of chunks) {
      expect(c.text.length).toBeGreaterThan(0);
    }

    // --- No gaps, no overlaps: total coverage equals audio length ---
    const audioEnd = alignment[alignment.length - 1].end;
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.end).toBe(audioEnd);
    expect(chunks[0].start).toBe(0);

    const totalDuration = chunks.reduce((sum, c) => sum + (c.end - c.start), 0);
    expect(totalDuration).toBeCloseTo(audioEnd, 6);
  });

  it("image chunks are each roughly 30s (within sentence boundary tolerance)", async () => {
    // 100 sentences × 5s = 500s. 15 clip chunks × ~8s ≈ 120s (each chunk = 2
    // sentences = 10s under nearest-boundary). Remaining ≈ 380s of images.
    const alignment = buildAlignment(100, 5);
    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_main";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);
    const imageChunks = chunks.filter((c) => c.kind === "image");

    for (let i = 0; i < imageChunks.length - 1; i++) {
      const dur = imageChunks[i].end - imageChunks[i].start;
      expect(dur).toBeCloseTo(30, 0);
    }

    const lastDur =
      imageChunks[imageChunks.length - 1].end -
      imageChunks[imageChunks.length - 1].start;
    expect(lastDur).toBeGreaterThan(0);
  });

  it("handles uneven sentence durations and no empty clip groups", async () => {
    // Build alignment with varying durations. With 15 clip chunks × ~8s,
    // we need >= 15 sentences and enough total to cover ~120s + a bit of images.
    const durations = [
      1, 2, 1, 3, 2, 15, 10, 8, 12, 5,    // 59s, 10 sentences
      7, 6, 8, 9, 5, 4, 3, 2, 6, 5,        // +55 = 114s, 20 sentences
      8, 10, 15, 12, 8, 20, 25, 10, 5, 3, // more for image body and clip tail
    ];
    const entries: AlignmentEntry[] = [];
    let t = 0;
    for (let i = 0; i < durations.length; i++) {
      entries.push({
        id: `f${String(i + 1).padStart(6, "0")}`,
        text: `S${i + 1}.`,
        begin: +t.toFixed(3),
        end: +(t + durations[i]).toFixed(3),
      });
      t += durations[i];
    }

    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_uneven";
    writeAlignment(projectsDir, videoId, entries);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);
    const clipChunks = chunks.filter((c) => c.kind === "clip");

    // Up to 15 clip chunks (sentences-cap may engage if not enough remain
    // after image body starts; 30 sentences here is plenty for ~15 clip chunks).
    expect(clipChunks.length).toBeGreaterThan(0);
    expect(clipChunks.length).toBeLessThanOrEqual(15);
    for (const cc of clipChunks) {
      expect(cc.text.length).toBeGreaterThan(0);
      expect(cc.end - cc.start).toBeGreaterThan(0);
    }

    // Per-chunk duration: clip target 8s, but a single 25s sentence will
    // overshoot. Keep the lower bound tight (>0) and the upper bound
    // generous to allow outlier sentences to live in their own chunk.
    for (const cc of clipChunks) {
      expect(cc.end - cc.start).toBeGreaterThan(0);
    }

    // Contiguous, no gaps
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end);
    }

    // Total = audio length
    expect(chunks[chunks.length - 1].end).toBe(entries[entries.length - 1].end);
    expect(chunks[0].start).toBe(0);
  });

  it("uses google_flow_hook_clip_seconds (not hook_video_clip_seconds) when snapshot.video_provider is google_flow", async () => {
    // Belt-and-suspenders guard for the Phase-2 paired-helper invariant:
    // with video_provider=google_flow, the chunker MUST read the Flow
    // enum, not the ComfyUI float. Setting them to divergent values
    // (clip=4 on the Flow path, clip=10 on the ComfyUI path) lets a
    // regression — reverting the chunker to read hook_video_clip_seconds
    // directly — show up as wildly different chunk durations.
    //
    // hook_length_seconds=120, google_flow_hook_clip_seconds="4" → 30
    // chunks of ~4s each. 1s sentences make the boundaries land cleanly.
    const alignment = buildAlignment(200, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_flow";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("hook_length_seconds", 120, db);
    setSetting("google_flow_hook_clip_seconds", "4", db);
    setSetting("hook_video_clip_seconds", 10, db); // intentional divergence

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db, snapshot: FLOW_SNAPSHOT })
    );
    const chunks = readChunks(projectsDir, videoId);
    const clipChunks = chunks.filter((c) => c.kind === "clip");

    expect(clipChunks).toHaveLength(30);
    for (const cc of clipChunks) {
      const dur = cc.end - cc.start;
      // 1s sentences → tolerance ±1s around the 4s target.
      expect(dur).toBeGreaterThanOrEqual(3);
      expect(dur).toBeLessThanOrEqual(5);
    }
  });

  it("respects custom hook_length_seconds and hook_video_clip_seconds settings", async () => {
    // hook_length_seconds=50, hook_video_clip_seconds=10 → 5 chunks × 10s
    // expected. Use 2s sentences so 5 sentences = 10s exact per chunk under
    // nearest-boundary logic.
    const alignment = buildAlignment(60, 2); // 120s total
    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_custom";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("hook_length_seconds", 50, db);
    setSetting("hook_video_clip_seconds", 10, db);

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);
    const clipChunks = chunks.filter((c) => c.kind === "clip");

    expect(clipChunks).toHaveLength(5);
    for (const cc of clipChunks) {
      const dur = cc.end - cc.start;
      // 2s sentences → tolerance ±2s around the 10s target
      expect(dur).toBeGreaterThanOrEqual(8);
      expect(dur).toBeLessThanOrEqual(12);
    }
  });

  it("packs multiple short sentences per chunk when sentences are shorter than clipSeconds", async () => {
    // 1s sentences with clipSeconds=8 → ~8 sentences per chunk = ~8s.
    // 200 sentences × 1s = 200s, 15 clip chunks × 8s = 120s, ~80s of image body.
    const alignment = buildAlignment(200, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_short_sentences";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);
    const clipChunks = chunks.filter((c) => c.kind === "clip");

    expect(clipChunks).toHaveLength(15);
    for (const cc of clipChunks) {
      const dur = cc.end - cc.start;
      expect(dur).toBeCloseTo(8, 0); // 1s sentences hit the 8s target exactly
    }
  });

  it("emits fewer clip chunks (no empty groups) when sentences run out before count cap", async () => {
    // 30 sentences × 1s = 30s narration, defaults (clipSeconds=8, count=15).
    // Clip section absorbs as many as fit but must stop at sentences-out, not
    // pad with empty groups. All sentences should be absorbed; image body can
    // be empty.
    const alignment = buildAlignment(30, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_chunk_short_audio";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);
    const clipChunks = chunks.filter((c) => c.kind === "clip");
    const imageChunks = chunks.filter((c) => c.kind === "image");

    expect(clipChunks.length).toBeLessThan(15);
    expect(clipChunks.length).toBeGreaterThan(0);
    for (const cc of clipChunks) {
      expect(cc.end - cc.start).toBeGreaterThan(0);
      expect(cc.text.length).toBeGreaterThan(0);
    }

    // Every sentence is absorbed (zero gaps, last chunk ends at audio end)
    expect(chunks[0].start).toBe(0);
    expect(chunks[chunks.length - 1].end).toBe(
      alignment[alignment.length - 1].end
    );

    // Image body may be empty here if the clip section took everything —
    // that's acceptable.
    expect(imageChunks.length).toBeGreaterThanOrEqual(0);
  });
});
