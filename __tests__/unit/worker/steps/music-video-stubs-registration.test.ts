import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import { computeSnapshot } from "@/lib/workflows";
import { bootValidate } from "@/worker/boot";
import { REAL_STEPS, STEP_OUTPUTS } from "@/worker/steps";

const openDbs: DatabaseType[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  openDbs.push(db);
  return db;
}

afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

const MUSIC_VIDEO_STUB_SLUGS = [
  "generate_loop_image",
  "generate_loop_clip",
  "make_thumbnail",
  "generate_music",
  "download_music",
  "render_music_video",
] as const;

describe("music-video stub registration", () => {
  it("includes every music-video stub slug in REAL_STEPS", () => {
    const slugs = new Set(REAL_STEPS.map((s) => s.name));
    for (const slug of MUSIC_VIDEO_STUB_SLUGS) {
      expect(slugs.has(slug), `REAL_STEPS missing "${slug}"`).toBe(true);
    }
  });

  it("derives STEP_OUTPUTS entries for every music-video stub", () => {
    for (const slug of MUSIC_VIDEO_STUB_SLUGS) {
      expect(STEP_OUTPUTS[slug]).toBeDefined();
    }
    // Spot-check the artifact paths the Phase 1.3 gate asserts on disk.
    expect(STEP_OUTPUTS["generate_loop_image"]).toEqual(["loop_image.png"]);
    expect(STEP_OUTPUTS["generate_loop_clip"]).toEqual(["loop_clip.mp4"]);
    expect(STEP_OUTPUTS["make_thumbnail"]).toEqual(["thumbnail.jpg"]);
    expect(STEP_OUTPUTS["generate_music"]).toEqual([]);
    expect(STEP_OUTPUTS["download_music"]).toEqual(["songs/"]);
    expect(STEP_OUTPUTS["render_music_video"]).toEqual(["final.mp4"]);
  });

  it("tags every music-video stub with module='music_video' so the script-step picker stays clean", () => {
    for (const slug of MUSIC_VIDEO_STUB_SLUGS) {
      const step = REAL_STEPS.find((s) => s.name === slug);
      expect(step, `REAL_STEPS missing "${slug}"`).toBeDefined();
      expect(step!.module).toBe("music_video");
    }
  });

  it("lets bootValidate pass against a non-terminal music_video row (full materialize round-trip)", () => {
    const db = freshDb();
    const snapshot = computeSnapshot(db, "music-video-magnific-suno");
    const now = Date.now();
    db.prepare(
      `INSERT INTO videos
         (id, title, topic_info, workflow_id, workflow_snapshot, status, kind,
          magnific_image_prompt, suno_style_prompt, song_count, repeat_factor, created_at)
       VALUES (?, ?, '', ?, ?, 'queued', 'music_video', 'mp', 'sp', 3, 3, ?)`
    ).run("v_mv_boot", "MV", "music-video-magnific-suno", snapshot, now);

    expect(() => bootValidate(db, "/dev/null/no-projects")).not.toThrow();
  });
});
