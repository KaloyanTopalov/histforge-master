import { describe, it, expect, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { step as cleanupStep } from "@/worker/steps/15-cleanup";
import { cleanupProjectArtifacts } from "@/lib/cleanup";

const tmpDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `histforge-${prefix}-`));
  tmpDirs.push(dir);
  return dir;
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
});

function setupFullProject(projectsDir: string, videoId: string): string {
  const projDir = join(projectsDir, videoId);
  mkdirSync(projDir, { recursive: true });

  // Kept files
  writeFileSync(join(projDir, "final.mp4"), "video");
  mkdirSync(join(projDir, "script"), { recursive: true });
  writeFileSync(join(projDir, "script", "full_script.md"), "script");
  writeFileSync(join(projDir, "pipeline.log"), "log");

  // Intermediate dirs
  mkdirSync(join(projDir, "render"), { recursive: true });
  writeFileSync(join(projDir, "render", "segment_001.mp4"), "seg");
  mkdirSync(join(projDir, "images"), { recursive: true });
  writeFileSync(join(projDir, "images", "image_001.png"), "img");
  mkdirSync(join(projDir, "videos", "clip"), { recursive: true });
  writeFileSync(join(projDir, "videos", "clip", "clip_01.mp4"), "vid");
  mkdirSync(join(projDir, "audio"), { recursive: true });
  writeFileSync(join(projDir, "audio", "narration.mp3"), "audio");
  mkdirSync(join(projDir, "alignment"), { recursive: true });
  writeFileSync(join(projDir, "alignment", "alignment.json"), "[]");
  mkdirSync(join(projDir, "chunks"), { recursive: true });
  writeFileSync(join(projDir, "chunks", "chunks.json"), "[]");

  // Intermediate script files
  writeFileSync(join(projDir, "script", "01_outline.md"), "outline");
  writeFileSync(join(projDir, "script", "03_hook.md"), "hook");
  writeFileSync(join(projDir, "script", "04_outline_structured.json"), "{}");
  writeFileSync(join(projDir, "script", "04_chapter_01.md"), "ch1");
  writeFileSync(join(projDir, "script", "04_chapter_02.md"), "ch2");
  writeFileSync(join(projDir, "script", "story_so_far.md"), "sofar");

  return projDir;
}

describe("step 15 — cleanup", () => {
  it("deletes intermediate dirs and keeps final.mp4, script/full_script.md, pipeline.log", async () => {
    const projectsDir = tempDir("cleanup");
    const videoId = "vid_001";
    const projDir = setupFullProject(projectsDir, videoId);

    cleanupProjectArtifacts(projectsDir, videoId);

    // Kept
    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);

    // Deleted dirs
    expect(existsSync(join(projDir, "render"))).toBe(false);
    expect(existsSync(join(projDir, "images"))).toBe(false);
    expect(existsSync(join(projDir, "videos"))).toBe(false);
    expect(existsSync(join(projDir, "audio"))).toBe(false);
    expect(existsSync(join(projDir, "alignment"))).toBe(false);
    expect(existsSync(join(projDir, "chunks"))).toBe(false);

    // Deleted script files
    expect(existsSync(join(projDir, "script", "01_outline.md"))).toBe(false);
    expect(existsSync(join(projDir, "script", "03_hook.md"))).toBe(false);
    expect(existsSync(join(projDir, "script", "04_outline_structured.json"))).toBe(false);
    expect(existsSync(join(projDir, "script", "04_chapter_01.md"))).toBe(false);
    expect(existsSync(join(projDir, "script", "04_chapter_02.md"))).toBe(false);
    expect(existsSync(join(projDir, "script", "story_so_far.md"))).toBe(false);

    // script/ dir itself survives (contains full_script.md)
    expect(existsSync(join(projDir, "script"))).toBe(true);
  });

  it("handles a sparse project dir (only kept files exist)", async () => {
    const projectsDir = tempDir("cleanup-sparse");
    const videoId = "vid_002";
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "script"), { recursive: true });
    writeFileSync(join(projDir, "final.mp4"), "video");
    writeFileSync(join(projDir, "script", "full_script.md"), "script");
    writeFileSync(join(projDir, "pipeline.log"), "log");

    // Should not throw
    cleanupProjectArtifacts(projectsDir, videoId);

    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
  });

  it("deletes unexpected files not in the keep set", async () => {
    const projectsDir = tempDir("cleanup-extra");
    const videoId = "vid_003";
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "script"), { recursive: true });
    writeFileSync(join(projDir, "final.mp4"), "video");
    writeFileSync(join(projDir, "script", "full_script.md"), "script");
    writeFileSync(join(projDir, "pipeline.log"), "log");
    // Unexpected extra files
    writeFileSync(join(projDir, "random.txt"), "junk");
    mkdirSync(join(projDir, "unknown_dir"), { recursive: true });
    writeFileSync(join(projDir, "unknown_dir", "file.bin"), "data");

    cleanupProjectArtifacts(projectsDir, videoId);

    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "random.txt"))).toBe(false);
    expect(existsSync(join(projDir, "unknown_dir"))).toBe(false);
  });

  it("removes empty script/ dir when full_script.md is absent", async () => {
    const projectsDir = tempDir("cleanup-no-script");
    const videoId = "vid_004";
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "script"), { recursive: true });
    writeFileSync(join(projDir, "final.mp4"), "video");
    writeFileSync(join(projDir, "pipeline.log"), "log");
    // script/ exists with only intermediate files, no full_script.md
    writeFileSync(join(projDir, "script", "01_outline.md"), "outline");

    cleanupProjectArtifacts(projectsDir, videoId);

    expect(existsSync(join(projDir, "final.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);
    expect(existsSync(join(projDir, "script"))).toBe(false);
  });

  it("deletes unexpected files inside script/", async () => {
    const projectsDir = tempDir("cleanup-script-extra");
    const videoId = "vid_005";
    const projDir = join(projectsDir, videoId);
    mkdirSync(join(projDir, "script"), { recursive: true });
    writeFileSync(join(projDir, "final.mp4"), "video");
    writeFileSync(join(projDir, "pipeline.log"), "log");
    writeFileSync(join(projDir, "script", "full_script.md"), "script");
    writeFileSync(join(projDir, "script", "draft.txt"), "junk");

    cleanupProjectArtifacts(projectsDir, videoId);

    expect(existsSync(join(projDir, "script", "full_script.md"))).toBe(true);
    expect(existsSync(join(projDir, "script", "draft.txt"))).toBe(false);
  });

  it("exports a Step with name 'cleanup'", () => {
    expect(cleanupStep.name).toBe("cleanup");
    expect(typeof cleanupStep.run).toBe("function");
  });
});
