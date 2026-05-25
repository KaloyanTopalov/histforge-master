import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;
let projectsDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-start-"));
  projectsDir = join(tempDir, "projects");
  process.env.DATABASE_URL = join(tempDir, "test.db");
  process.env.PROJECTS_DIR = projectsDir;
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  delete process.env.PROJECTS_DIR;
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM video_steps; DELETE FROM videos;");
  seedDefaultSettings(db);
  rmSync(projectsDir, { recursive: true, force: true });
});

async function seedVideo(
  videoId: string,
  status: string
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(videoId, "T", "info", "comfyui", status, now);
}

async function seedNewReadyScriptVideo(
  videoId: string,
  script: string
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const videosRepo = await import("@/lib/repos/videos");
  videosRepo.createNewVideo(getDb(), {
    id: videoId,
    title: "T",
    topic_info: "[ready script — generation skipped]",
    workflow_id: "comfyui",
    provided_script: script,
    created_at: Date.now(),
  });
}

describe("POST /api/videos/:id/start", () => {
  it("transitions a new video to queued", async () => {
    await seedVideo("v1", "new");
    const { POST } = await import("@/app/api/videos/[id]/start/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/start", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get("v1") as { status: string };
    expect(row.status).toBe("queued");
  });

  it("returns 409 when the video is not new", async () => {
    await seedVideo("v1", "queued");
    const { POST } = await import("@/app/api/videos/[id]/start/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/start", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for unknown id", async () => {
    const { POST } = await import("@/app/api/videos/[id]/start/route");
    const res = await POST(
      new Request("http://localhost/api/videos/nope/start", {
        method: "POST",
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
  });

  it("writes script/full_script.md and pre-marks script-generation steps as done for a ready-script video", async () => {
    await seedNewReadyScriptVideo("v_rs", "Lived—seventeen talents—enough.");
    const { POST } = await import("@/app/api/videos/[id]/start/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v_rs/start", {
        method: "POST",
      }),
      { params: { id: "v_rs" } }
    );
    expect(res.status).toBe(200);

    const scriptPath = join(projectsDir, "v_rs", "script", "full_script.md");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toBe(
      "Lived, seventeen talents, enough."
    );

    const { getDb } = await import("@/lib/db");
    const rows = getDb()
      .prepare(
        "SELECT step_name FROM video_steps WHERE video_id = ? AND status = 'done'"
      )
      .all("v_rs") as { step_name: string }[];
    expect(rows.map((r) => r.step_name).sort()).toEqual([
      "assemble_script",
      "research_outline",
      "write_chapters",
      "write_hook",
    ]);
  });

  it("does not create a project dir or step rows for a topic-driven video (no provided_script)", async () => {
    const { getDb } = await import("@/lib/db");
    const videosRepo = await import("@/lib/repos/videos");
    videosRepo.createNewVideo(getDb(), {
      id: "v_topic",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: Date.now(),
    });
    const { POST } = await import("@/app/api/videos/[id]/start/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v_topic/start", {
        method: "POST",
      }),
      { params: { id: "v_topic" } }
    );
    expect(res.status).toBe(200);

    expect(existsSync(join(projectsDir, "v_topic"))).toBe(false);
    const rowCount = getDb()
      .prepare("SELECT COUNT(*) AS n FROM video_steps WHERE video_id = ?")
      .get("v_topic") as { n: number };
    expect(rowCount.n).toBe(0);
  });
});
