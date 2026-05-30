import { describe, it, expect, afterEach, vi } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import { runRender } from "@/worker/steps/14-render";
import type { Chunk } from "@/types";

const tmpDirs: string[] = [];
const openDbs: DatabaseType[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
}

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore Windows lock races
    }
  }
  while (openDbs.length) {
    openDbs.pop()!.close();
  }
});

function makeChunks(): Chunk[] {
  return [
    { id: "clip_01", kind: "clip", start: 0, end: 10, text: "a", prompt: "p" },
    { id: "image_001", kind: "image", start: 10, end: 40, text: "b", prompt: "p" },
    { id: "image_002", kind: "image", start: 40, end: 65, text: "c", prompt: "p" },
  ];
}

function setupProject(projectsDir: string, videoId: string, chunks: Chunk[]) {
  const projDir = join(projectsDir, videoId);
  mkdirSync(join(projDir, "chunks"), { recursive: true });
  mkdirSync(join(projDir, "images"), { recursive: true });
  mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
  mkdirSync(join(projDir, "audio"), { recursive: true });
  writeFileSync(join(projDir, "chunks", "chunks.json"), JSON.stringify(chunks));
  writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
  writeFileSync(join(projDir, "images", "image_001.png"), "");
  writeFileSync(join(projDir, "images", "image_002.png"), "");
  writeFileSync(join(projDir, "audio", "narration.mp3"), "");
}

describe("render step (step 14)", () => {
  it("reads settings from DB and passes them to the render lib", async () => {
    const db = freshDb();
    const projectsDir = tempDir("projects");
    const videoId = "v_step14";
    setupProject(projectsDir, videoId, makeChunks());

    setSetting("aspect_ratio", "16:9", db);
    setSetting("long_edge_px", 1920, db);
    setSetting("framerate", 30, db);

    const execCalls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => {
      execCalls.push(args);
    });
    const probe = vi.fn().mockResolvedValue(10);

    await runRender(videoId, { db, projectsDir, exec, probe });

    // Should have called exec multiple times (stages A-E)
    expect(exec).toHaveBeenCalled();
    // Stage B segment should use 1920x1080 resolution (zoompan `s=` param)
    const segCall = execCalls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /segment_\d+\.mp4$/.test(last);
    });
    expect(segCall).toBeDefined();
    const vfIdx = segCall!.indexOf("-vf");
    expect(segCall![vfIdx + 1]).toContain("s=1920x1080");
  });

  it("logs to pipeline.log via appendLog", async () => {
    const db = freshDb();
    const projectsDir = tempDir("projects");
    const videoId = "v_step14_log";
    const chunks = makeChunks();
    setupProject(projectsDir, videoId, chunks);

    setSetting("aspect_ratio", "16:9", db);
    setSetting("long_edge_px", 1920, db);
    setSetting("framerate", 30, db);
    setSetting("video_encoder", "libx264", db);

    const exec = vi.fn();
    const probe = vi.fn().mockResolvedValue(10);
    await runRender(videoId, { db, projectsDir, exec, probe });

    // Pipeline.log should be written via appendLog wiring on step 14.
    // The placeholder-substitution log line that previously witnessed this
    // is gone (structural-safety baseline removed the placeholder fallback);
    // use the always-emitted `Encoder: <encoder>` line at render.ts:658 as
    // the new wiring witness — it fires on every render regardless of
    // chunk content.
    const { readFileSync } = await import("node:fs");
    const logPath = join(projectsDir, videoId, "pipeline.log");
    const logContent = readFileSync(logPath, "utf-8");
    expect(logContent).toContain("[render]");
    expect(logContent).toContain("Encoder: libx264");
  });
});
