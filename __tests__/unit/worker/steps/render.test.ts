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
  it("reads settings from DB and passes them to the render lib (ken_burns path)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("projects");
    const videoId = "v_step14";
    setupProject(projectsDir, videoId, makeChunks());

    setSetting("aspect_ratio", "16:9", db);
    setSetting("long_edge_px", 1920, db);
    setSetting("framerate", 30, db);
    // Override the seeded "static" default so this test exercises the
    // zoompan-bearing Stage B chain. The default-static case is covered
    // by the next test.
    setSetting("render_image_motion", "ken_burns", db);

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

  it("default render_image_motion=static produces a flat scale-to-W:H vf (no zoompan)", async () => {
    // Witness that the new setting flows from DB → step 14 → render lib →
    // buildSegmentArgs. Default seeded value is "static", so without any
    // override the Stage B segment must NOT contain zoompan.
    const db = freshDb();
    const projectsDir = tempDir("projects");
    const videoId = "v_step14_static";
    setupProject(projectsDir, videoId, makeChunks());

    setSetting("aspect_ratio", "16:9", db);
    setSetting("long_edge_px", 1920, db);
    setSetting("framerate", 30, db);
    // No explicit render_image_motion set — relies on seedDefaultSettings.

    const execCalls: string[][] = [];
    const exec = vi.fn().mockImplementation((args: string[]) => {
      execCalls.push(args);
    });
    const probe = vi.fn().mockResolvedValue(10);

    await runRender(videoId, { db, projectsDir, exec, probe });

    const segCall = execCalls.find((c) => {
      const last = c[c.length - 1];
      return typeof last === "string" && /segment_\d+\.mp4$/.test(last);
    });
    expect(segCall).toBeDefined();
    const vfIdx = segCall!.indexOf("-vf");
    expect(segCall![vfIdx + 1]).toBe("scale=1920:1080,format=yuv420p");
  });

  describe("revealEffect resolution from snapshot.image_style", () => {
    // Doodle project layout: chunks.json + clips_drawn/ entries instead of
    // images/. The cinematic helper above writes to images/, which is
    // wrong for draw-on; this helper writes to clips_drawn/.
    function setupDoodleProject(
      projectsDir: string,
      videoId: string,
      chunks: Chunk[]
    ) {
      const projDir = join(projectsDir, videoId);
      mkdirSync(join(projDir, "chunks"), { recursive: true });
      mkdirSync(join(projDir, "clips_drawn"), { recursive: true });
      mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
      mkdirSync(join(projDir, "audio"), { recursive: true });
      writeFileSync(
        join(projDir, "chunks", "chunks.json"),
        JSON.stringify(chunks)
      );
      writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "");
      for (const c of chunks.filter((c) => c.kind === "image")) {
        writeFileSync(join(projDir, "clips_drawn", `${c.id}.mp4`), "");
      }
      writeFileSync(join(projDir, "audio", "narration.mp3"), "");
    }

    function snapshotWithStyle(
      imageStyle: string | null
    ): import("@/types").WorkflowSnapshot {
      return {
        workflow_id: "test",
        version: 1,
        kind: "narrative",
        script_llm_provider: "openrouter",
        tts_provider: "ai33",
        image_provider: "magnific",
        video_provider: null,
        music_provider: null,
        upscaler_provider: null,
        chunker_step: "chunk_images_only",
        image_style: imageStyle,
        steps: [],
      };
    }

    it("doodle_polished snapshot → revealEffect='draw_on' → Stage B reads clips_drawn/", async () => {
      const db = freshDb();
      const projectsDir = tempDir("projects");
      const videoId = "v_step14_doodle";
      setupDoodleProject(projectsDir, videoId, makeChunks());

      setSetting("aspect_ratio", "16:9", db);
      setSetting("long_edge_px", 1920, db);
      setSetting("framerate", 30, db);

      const execCalls: string[][] = [];
      const exec = vi.fn().mockImplementation((args: string[]) => {
        execCalls.push(args);
      });
      const probe = vi.fn().mockResolvedValue(10);
      const drawOnHealthCheck = vi.fn().mockResolvedValue(undefined);

      await runRender(videoId, {
        db,
        projectsDir,
        snapshot: snapshotWithStyle("doodle_polished"),
        drawOnHealthCheck,
        exec,
        probe,
      });

      const segCalls = execCalls.filter((c) => {
        const last = c[c.length - 1];
        return typeof last === "string" && /segment_\d+\.mp4$/.test(last);
      });
      expect(segCalls.length).toBeGreaterThan(0);
      for (const call of segCalls) {
        const iIdx = call.indexOf("-i");
        expect(call[iIdx + 1]).toMatch(/clips_drawn[\\/]image_\d+\.mp4$/);
      }
      expect(drawOnHealthCheck).toHaveBeenCalledTimes(1);
    });

    it("doodle_rough snapshot → revealEffect='draw_on' (both built-in doodle styles map through)", async () => {
      const db = freshDb();
      const projectsDir = tempDir("projects");
      const videoId = "v_step14_doodle_rough";
      setupDoodleProject(projectsDir, videoId, makeChunks());

      setSetting("aspect_ratio", "16:9", db);
      setSetting("long_edge_px", 1920, db);
      setSetting("framerate", 30, db);

      const exec = vi.fn().mockResolvedValue(undefined);
      const probe = vi.fn().mockResolvedValue(10);
      const drawOnHealthCheck = vi.fn().mockResolvedValue(undefined);

      await runRender(videoId, {
        db,
        projectsDir,
        snapshot: snapshotWithStyle("doodle_rough"),
        drawOnHealthCheck,
        exec,
        probe,
      });

      expect(drawOnHealthCheck).toHaveBeenCalledTimes(1);
    });

    it("cinematic snapshot → revealEffect='none' → no health check, reads images/ as before", async () => {
      const db = freshDb();
      const projectsDir = tempDir("projects");
      const videoId = "v_step14_cinematic";
      // Cinematic helper from outer scope — images/ populated, no clips_drawn/.
      setupProject(projectsDir, videoId, makeChunks());

      setSetting("aspect_ratio", "16:9", db);
      setSetting("long_edge_px", 1920, db);
      setSetting("framerate", 30, db);

      const exec = vi.fn().mockResolvedValue(undefined);
      const probe = vi.fn().mockResolvedValue(10);
      const drawOnHealthCheck = vi.fn();

      await runRender(videoId, {
        db,
        projectsDir,
        snapshot: snapshotWithStyle("cinematic"),
        drawOnHealthCheck,
        exec,
        probe,
      });

      expect(drawOnHealthCheck).not.toHaveBeenCalled();
    });

    it("null / undefined image_style → revealEffect='none' (legacy pre-image_style snapshot path)", async () => {
      const db = freshDb();
      const projectsDir = tempDir("projects");
      const videoId = "v_step14_legacy";
      setupProject(projectsDir, videoId, makeChunks());

      setSetting("aspect_ratio", "16:9", db);
      setSetting("long_edge_px", 1920, db);
      setSetting("framerate", 30, db);

      const exec = vi.fn().mockResolvedValue(undefined);
      const probe = vi.fn().mockResolvedValue(10);
      const drawOnHealthCheck = vi.fn();

      // image_style: null on the snapshot
      await runRender(videoId, {
        db,
        projectsDir,
        snapshot: snapshotWithStyle(null),
        drawOnHealthCheck,
        exec,
        probe,
      });

      expect(drawOnHealthCheck).not.toHaveBeenCalled();
    });

    it("unknown image_style → revealEffect='none' (graceful — same forgiving spirit as the materializer)", async () => {
      const db = freshDb();
      const projectsDir = tempDir("projects");
      const videoId = "v_step14_unknown";
      setupProject(projectsDir, videoId, makeChunks());

      setSetting("aspect_ratio", "16:9", db);
      setSetting("long_edge_px", 1920, db);
      setSetting("framerate", 30, db);

      const exec = vi.fn().mockResolvedValue(undefined);
      const probe = vi.fn().mockResolvedValue(10);
      const drawOnHealthCheck = vi.fn();

      await runRender(videoId, {
        db,
        projectsDir,
        snapshot: snapshotWithStyle("phantom_xyz"),
        drawOnHealthCheck,
        exec,
        probe,
      });

      expect(drawOnHealthCheck).not.toHaveBeenCalled();
    });

    it("no snapshot at all → revealEffect='none' (cinematic-by-default safety net)", async () => {
      // Test-only path: orchestrator always wires snapshot via ctx.snapshot
      // in production, but defending against an absent snapshot keeps the
      // step from crashing on a misconstructed deps object.
      const db = freshDb();
      const projectsDir = tempDir("projects");
      const videoId = "v_step14_no_snapshot";
      setupProject(projectsDir, videoId, makeChunks());

      setSetting("aspect_ratio", "16:9", db);
      setSetting("long_edge_px", 1920, db);
      setSetting("framerate", 30, db);

      const exec = vi.fn().mockResolvedValue(undefined);
      const probe = vi.fn().mockResolvedValue(10);
      const drawOnHealthCheck = vi.fn();

      await runRender(videoId, {
        db,
        projectsDir,
        drawOnHealthCheck,
        exec,
        probe,
      });

      expect(drawOnHealthCheck).not.toHaveBeenCalled();
    });
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
