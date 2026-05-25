import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-rerender-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
  projectsDir = join(tempDir, "projects");
  mkdirSync(projectsDir, { recursive: true });
  process.env.PROJECTS_DIR = projectsDir;
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.PROJECTS_DIR;
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM video_steps; DELETE FROM videos;");
  seedDefaultSettings(db);
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

interface SeedOpts {
  status: "done" | "queued" | "in_progress" | "failed";
  kind: "music_video" | "narrative";
  withArtifacts?: boolean;
}

async function seedVideo(videoId: string, opts: SeedOpts): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  const workflow = opts.kind === "music_video"
    ? "music-video-magnific-suno"
    : "comfyui";
  db.prepare(
    `INSERT INTO videos
       (id, title, topic_info, workflow_id, kind, status, song_count, repeat_factor,
        current_step, finished_at, output_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    "Test",
    opts.kind === "music_video" ? "" : "topic info",
    workflow,
    opts.kind,
    opts.status,
    opts.kind === "music_video" ? 6 : null,
    opts.kind === "music_video" ? 4 : null,
    opts.status === "in_progress" ? "render_music_video" : null,
    opts.status === "done" ? 2000 : null,
    opts.status === "done" ? `projects/${videoId}/final.mp4` : null,
    now
  );
  if (opts.kind === "music_video") {
    for (const stepName of [
      "generate_loop_image",
      "generate_loop_clip",
      "make_thumbnail",
      "generate_music",
      "download_music",
      "render_music_video",
    ]) {
      db.prepare(
        "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, 100, 200)"
      ).run(videoId, stepName, opts.status === "done" ? "done" : "pending");
    }
  }
  if (opts.withArtifacts) {
    const projDir = join(projectsDir, videoId);
    mkdirSync(projDir, { recursive: true });
    mkdirSync(join(projDir, "build"), { recursive: true });
    writeFileSync(join(projDir, "final.mp4"), "final");
    writeFileSync(join(projDir, "build", "loop_clip_trimmed.mp4"), "trim");
    writeFileSync(join(projDir, "loop_clip.mp4"), "clip");
    writeFileSync(join(projDir, "loop_image.png"), "image");
  }
}

describe("POST /api/videos/:id/rerender-last-step", () => {
  it("200 on happy path: flips video to queued, resets render_music_video step, wipes final.mp4 + build/", async () => {
    await seedVideo("mv1", {
      status: "done",
      kind: "music_video",
      withArtifacts: true,
    });

    const { POST } = await import(
      "@/app/api/videos/[id]/rerender-last-step/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/mv1/rerender-last-step", {
        method: "POST",
      }),
      { params: { id: "mv1" } }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const projDir = join(projectsDir, "mv1");
    expect(existsSync(join(projDir, "final.mp4"))).toBe(false);
    expect(existsSync(join(projDir, "build"))).toBe(false);
    // Expensive Magnific artifacts preserved.
    expect(existsSync(join(projDir, "loop_clip.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "loop_image.png"))).toBe(true);

    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const video = db
      .prepare("SELECT status, current_step FROM videos WHERE id = 'mv1'")
      .get() as { status: string; current_step: string | null };
    expect(video.status).toBe("queued");
    expect(video.current_step).toBeNull();

    const step = db
      .prepare(
        "SELECT status FROM video_steps WHERE video_id = 'mv1' AND step_name = 'render_music_video'"
      )
      .get() as { status: string };
    expect(step.status).toBe("pending");
  });

  it("404 when the video does not exist", async () => {
    const { POST } = await import(
      "@/app/api/videos/[id]/rerender-last-step/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/nope/rerender-last-step", {
        method: "POST",
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });

  it("409 + error=wrong_kind when the video is narrative-kind", async () => {
    await seedVideo("n1", {
      status: "done",
      kind: "narrative",
      withArtifacts: true,
    });
    const { POST } = await import(
      "@/app/api/videos/[id]/rerender-last-step/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/n1/rerender-last-step", {
        method: "POST",
      }),
      { params: { id: "n1" } }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("wrong_kind");
    expect(body.message).toMatch(/music_video/i);
    // Artifacts untouched.
    expect(existsSync(join(projectsDir, "n1", "final.mp4"))).toBe(true);
  });

  it("409 + error=not_done when the music_video has not finished", async () => {
    await seedVideo("mv2", {
      status: "in_progress",
      kind: "music_video",
    });
    const { POST } = await import(
      "@/app/api/videos/[id]/rerender-last-step/route"
    );
    const res = await POST(
      new Request("http://localhost/api/videos/mv2/rerender-last-step", {
        method: "POST",
      }),
      { params: { id: "mv2" } }
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; message?: string };
    expect(body.error).toBe("not_done");
    expect(body.message).toMatch(/done/i);
  });
});
