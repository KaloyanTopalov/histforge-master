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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-restart-"));
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
  // Wipe projects dir between tests.
  rmSync(projectsDir, { recursive: true, force: true });
  mkdirSync(projectsDir, { recursive: true });
});

interface SeedOpts {
  status: "failed" | "done" | "in_progress" | "queued";
  withProjectFiles?: boolean;
  provided_script?: string | null;
}

async function seedVideo(
  videoId: string,
  opts: SeedOpts
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const { resolveSnapshot, materializeStepList, computeSnapshot } = await import(
    "@/lib/workflows"
  );
  const db = getDb();
  const now = Date.now();
  const snapshot = computeSnapshot(db, "comfyui");
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, provided_script, status, current_step, failed_step, failed_reason, started_at, finished_at, output_path, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    "topic",
    "info",
    "comfyui",
    snapshot,
    opts.provided_script ?? null,
    opts.status,
    opts.status === "in_progress" ? "voiceover" : null,
    opts.status === "failed" ? "voiceover" : null,
    opts.status === "failed" ? "boom" : null,
    42,
    opts.status === "done" || opts.status === "failed" ? 999 : null,
    opts.status === "done" ? `projects/${videoId}/final.mp4` : null,
    now
  );
  const slugs = materializeStepList(resolveSnapshot(db, "comfyui"));
  const insertStep = db.prepare(
    "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, 'done')"
  );
  for (const stepName of slugs) {
    insertStep.run(videoId, stepName);
  }

  if (opts.withProjectFiles) {
    const dir = join(projectsDir, videoId);
    mkdirSync(join(dir, "script"), { recursive: true });
    writeFileSync(join(dir, "pipeline.log"), "[research_outline] hi\n");
    writeFileSync(join(dir, "script", "full_script.md"), "hello world");
  }
}

describe("POST /api/videos/:id/restart", () => {
  it("wipes project dir, deletes step rows, and resets the video row to queued", async () => {
    await seedVideo("v1", { status: "failed", withProjectFiles: true });
    expect(existsSync(join(projectsDir, "v1", "script", "full_script.md"))).toBe(
      true
    );

    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    // Project dir gone.
    expect(existsSync(join(projectsDir, "v1"))).toBe(false);

    const { getDb } = await import("@/lib/db");
    const db = getDb();

    // No step rows left.
    const stepRows = db
      .prepare("SELECT * FROM video_steps WHERE video_id = ?")
      .all("v1");
    expect(stepRows).toHaveLength(0);

    // Video row reset.
    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as {
      status: string;
      failed_step: string | null;
      failed_reason: string | null;
      started_at: number | null;
      finished_at: number | null;
      current_step: string | null;
      output_path: string | null;
    };
    expect(video).toMatchObject({
      status: "queued",
      failed_step: null,
      failed_reason: null,
      started_at: null,
      finished_at: null,
      current_step: null,
      output_path: null,
    });
  });

  it("works on a done video (the fresh-run-after-review case)", async () => {
    await seedVideo("v1", { status: "done", withProjectFiles: true });
    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
  });

  it("returns 409 for an in_progress video", async () => {
    await seedVideo("v1", { status: "in_progress" });
    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 409 for a queued video (nothing to restart)", async () => {
    await seedVideo("v1", { status: "queued" });
    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 when the video does not exist", async () => {
    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/nope/restart", {
        method: "POST",
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });

  it("tolerates a missing project directory", async () => {
    // Seed a failed video WITHOUT creating any project files.
    await seedVideo("v1", { status: "failed", withProjectFiles: false });
    expect(existsSync(join(projectsDir, "v1"))).toBe(false);

    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
  });

  it("re-prepares ready-script artifacts after restart (script file + done rows)", async () => {
    await seedVideo("v1", {
      status: "failed",
      withProjectFiles: true,
      provided_script: "Lived—seventeen talents.",
    });

    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    // Project dir was wiped then re-created with the script file.
    const scriptPath = join(projectsDir, "v1", "script", "full_script.md");
    expect(existsSync(scriptPath)).toBe(true);
    const written = (await import("node:fs")).readFileSync(scriptPath, "utf8");
    // sanitizeScript replaces em-dashes for TTS.
    expect(written).not.toContain("—");

    // Script-generation step rows should be done (not pending).
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const doneSteps = db
      .prepare(
        "SELECT step_name FROM video_steps WHERE video_id = ? AND status = 'done'"
      )
      .all("v1") as Array<{ step_name: string }>;
    const doneNames = doneSteps.map((r) => r.step_name);
    expect(doneNames).toContain("research_outline");
    expect(doneNames).toContain("assemble_script");
  });

  it("does NOT create a script directory when restarting a topic-driven video", async () => {
    await seedVideo("v1", {
      status: "failed",
      withProjectFiles: true,
      provided_script: null,
    });

    const { POST } = await import("@/app/api/videos/[id]/restart/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/restart", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    expect(existsSync(join(projectsDir, "v1"))).toBe(false);

    // No pre-marked done rows — orchestrator's upsertPending will create
    // pending rows on the next tick.
    const { getDb } = await import("@/lib/db");
    const db = getDb();
    const stepRows = db
      .prepare("SELECT * FROM video_steps WHERE video_id = ?")
      .all("v1");
    expect(stepRows).toHaveLength(0);
  });
});
