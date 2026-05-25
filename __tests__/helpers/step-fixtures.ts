/**
 * Shared test fixtures for pipeline step tests. Provides temp-dir management,
 * in-memory DB creation, and standard seed data (topic, video, chunks).
 *
 * Usage:
 *   import { tempDir, freshDb, seedTopicAndVideo, makeChunks, seedChunks, makeStepContext, cleanup } from "../../../helpers/step-fixtures";
 *   afterEach(cleanup);
 */
import { vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import type { Step, StepContext } from "@/worker/pipeline";
import type { Chunk } from "@/types";

const tmpDirs: string[] = [];
const openDbs: DatabaseType[] = [];

export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

export function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

export function seedTopicAndVideo(db: DatabaseType): string {
  const now = Date.now();
  db.prepare(
    "INSERT INTO topics (id, title, topic_info, status, created_at, updated_at) VALUES (?, ?, ?, 'in_pipeline', ?, ?)"
  ).run("t_01", "Rome", "history", now, now);
  db.prepare(
    "INSERT INTO videos (id, topic_id, title, status, created_at) VALUES (?, ?, ?, 'in_progress', ?)"
  ).run("v_01", "t_01", "Rome", now);
  return "v_01";
}

export function makeChunks(): Chunk[] {
  const chunks: Chunk[] = [];
  // 2 clip chunks
  for (let i = 1; i <= 2; i++) {
    chunks.push({
      id: `clip_${String(i).padStart(2, "0")}`,
      kind: "clip",
      start: (i - 1) * 10,
      end: i * 10,
      text: `Clip text ${i}`,
      prompt: `clip visual prompt ${i}`,
    });
  }
  // 3 image chunks
  for (let i = 1; i <= 3; i++) {
    chunks.push({
      id: `image_${String(i).padStart(3, "0")}`,
      kind: "image",
      start: 20 + (i - 1) * 30,
      end: 20 + i * 30,
      text: `Image text ${i}`,
      prompt: `image visual prompt ${i}`,
    });
  }
  return chunks;
}

export function seedChunks(projectsDir: string, videoId: string): Chunk[] {
  const chunks = makeChunks();
  const dir = join(projectsDir, videoId, "chunks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "chunks.json"), JSON.stringify(chunks, null, 2));
  return chunks;
}

/**
 * Build a fully-populated `StepContext` for `step.run(videoId, ctx)` tests.
 * Every field has a sensible default; pass `overrides` to swap in only the
 * fields the test exercises.
 *
 * Use this helper instead of a per-step `*Deps` interface + `runX(videoId,
 * deps)` adapter. The `*Deps`/`runX` shape is warranted only when a step
 * has a *non-cross-cutting* test-only injection point that has no home on
 * `StepContext` — e.g. `spawnFn` in `07-align` or `exec`/`probe` in
 * `14-render`. Promoting those onto `StepContext` would expand the
 * cross-cutting surface for one step's benefit. Everything else just reads
 * fields already on `StepContext`, so `step.run(videoId,
 * makeStepContext({ ... }))` is the seam.
 */
export function makeStepContext(
  overrides: Partial<StepContext> = {}
): StepContext {
  return {
    db: {} as DatabaseType,
    projectsDir: "/dev/null/projects",
    promptsDir: "/dev/null/prompts",
    log: () => {},
    chat: vi.fn(),
    visualPromptChat: vi.fn(),
    visualPromptsConcurrency: 1,
    ttsProvider: {} as never,
    imageProvider: {} as never,
    videoProvider: {} as never,
    snapshot: {
      workflow_id: "",
      version: 0,
      kind: "narrative",
      script_llm_provider: "",
      tts_provider: null,
      image_provider: null,
      video_provider: null,
      music_provider: null,
      upscaler_provider: null,
      chunker_step: "chunk_clips_then_images",
      steps: [],
    },
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** Build a fake `Step` with optional behavior overrides. */
export function fakeStep(name: string, behavior: Partial<Step> = {}): Step {
  return {
    name,
    module: behavior.module ?? "glue",
    label: behavior.label ?? name,
    description: behavior.description ?? `Fake step ${name}`,
    outputs: behavior.outputs ?? [],
    run: behavior.run ?? (async () => {}),
    cleanup: behavior.cleanup,
  };
}

export function cleanup(): void {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
  }
  while (openDbs.length) {
    const db = openDbs.pop()!;
    try { db.close(); } catch { /* */ }
  }
}
