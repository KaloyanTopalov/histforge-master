import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { AlignmentEntry, Chunk, WorkflowSnapshot } from "@/types";
import { step as chunkStep } from "@/worker/steps/08-chunk-clips-only";
import { setSetting } from "@/lib/settings";
import {
  cleanup,
  freshDb,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

// Google-Flow snapshot stand-in: forces getHookClipSeconds to read the
// Flow enum instead of the ComfyUI float (mirrors the existing
// clips-then-images test).
const FLOW_SNAPSHOT: WorkflowSnapshot = {
  workflow_id: "google-flow-clips-only",
  version: 1,
  kind: "narrative",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: null,
  video_provider: "google_flow",
  music_provider: null,
  upscaler_provider: null,
  chunker_step: "chunk_clips_only",
  steps: [],
};

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

describe("chunk_clips_only (step 8 — clips-only variant)", () => {
  it("emits only kind='clip' chunks with clip_NNN ids covering the entire narration", async () => {
    // 60 sentences × 1s = 60s narration; clipSeconds default = 8s → ~8
    // sentences per chunk → 7-8 chunks.
    const alignment = buildAlignment(60, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.kind).toBe("clip");
    }

    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].id).toBe(`clip_${String(i + 1).padStart(3, "0")}`);
    }

    // No gaps, no overlaps, full coverage.
    expect(chunks[0].start).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].start).toBe(chunks[i - 1].end);
    }
    const audioEnd = alignment[alignment.length - 1].end;
    expect(chunks[chunks.length - 1].end).toBe(audioEnd);

    for (const c of chunks) {
      expect(c.prompt).toBeNull();
    }

    for (const c of chunks) {
      expect(c).toHaveProperty("start");
      expect(c).toHaveProperty("end");
      expect(c).not.toHaveProperty("begin");
    }
  });

  it("each chunk is ~clipSeconds within sentence-boundary tolerance", async () => {
    // 200 sentences × 1s = 200s, clipSeconds=8 → 25 chunks of ~8s each.
    const alignment = buildAlignment(200, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_dur";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    for (let i = 0; i < chunks.length - 1; i++) {
      const dur = chunks[i].end - chunks[i].start;
      expect(dur).toBeCloseTo(8, 0); // 1s sentences hit the 8s target exactly
    }
  });

  it("ignores hookChunkCount cap — runs until sentences exhausted", async () => {
    // hook_length_seconds=120, clipSeconds=8 → cap = 15. With 50 chunks'
    // worth of narration available, clip-only must NOT stop at 15.
    // 400 sentences × 1s = 400s → 50 chunks of ~8s.
    const alignment = buildAlignment(400, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_no_cap";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks.length).toBeGreaterThan(15);
  });

  it("uses google_flow_hook_clip_seconds when snapshot.video_provider is google_flow", async () => {
    // Mirrors the clips-then-images Phase-2 guard: clip=4 on Flow path,
    // clip=10 on ComfyUI path. With FLOW_SNAPSHOT we expect 4s chunks.
    const alignment = buildAlignment(120, 1);
    const projectsDir = tempDir("projects");
    const videoId = "v_clips_only_flow";
    writeAlignment(projectsDir, videoId, alignment);
    const db = freshDb();
    setSetting("google_flow_hook_clip_seconds", "4", db);
    setSetting("hook_video_clip_seconds", 10, db);

    await chunkStep.run(
      videoId,
      makeStepContext({ projectsDir, db, snapshot: FLOW_SNAPSHOT })
    );
    const chunks = readChunks(projectsDir, videoId);

    expect(chunks.length).toBe(30); // 120s / 4s
    for (const c of chunks) {
      const dur = c.end - c.start;
      expect(dur).toBeGreaterThanOrEqual(3);
      expect(dur).toBeLessThanOrEqual(5);
    }
  });
});
