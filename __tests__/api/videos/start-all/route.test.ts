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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-start-all-"));
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
  status: string,
  createdAt: number
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(videoId, "T", "info", "comfyui", status, createdAt);
}

async function seedNewReadyScriptVideo(
  videoId: string,
  script: string,
  createdAt: number
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const videosRepo = await import("@/lib/repos/videos");
  videosRepo.createNewVideo(getDb(), {
    id: videoId,
    title: "T",
    topic_info: "[ready script — generation skipped]",
    workflow_id: "comfyui",
    provided_script: script,
    created_at: createdAt,
  });
}

describe("POST /api/videos/start-all", () => {
  it("moves every new video to queued and returns the count", async () => {
    await seedVideo("v1", "new", 1);
    await seedVideo("v2", "new", 2);
    await seedVideo("v3", "queued", 3);

    const { POST } = await import("@/app/api/videos/start-all/route");
    const res = await POST(
      new Request("http://localhost/api/videos/start-all", {
        method: "POST",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);

    const { getDb } = await import("@/lib/db");
    const rows = getDb()
      .prepare("SELECT id, status FROM videos ORDER BY id")
      .all() as { id: string; status: string }[];
    expect(rows).toEqual([
      { id: "v1", status: "queued" },
      { id: "v2", status: "queued" },
      { id: "v3", status: "queued" },
    ]);
  });

  it("returns count=0 when there are no new videos", async () => {
    const { POST } = await import("@/app/api/videos/start-all/route");
    const res = await POST(
      new Request("http://localhost/api/videos/start-all", {
        method: "POST",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(0);
  });

  it("writes ready-script artifacts for each ready-script video and skips topic-driven videos", async () => {
    await seedNewReadyScriptVideo("v_rs1", "Alpha—one.", 1);
    await seedNewReadyScriptVideo("v_rs2", "Beta—two.", 2);
    const { getDb } = await import("@/lib/db");
    const videosRepo = await import("@/lib/repos/videos");
    videosRepo.createNewVideo(getDb(), {
      id: "v_topic",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 3,
    });

    const { POST } = await import("@/app/api/videos/start-all/route");
    const res = await POST(
      new Request("http://localhost/api/videos/start-all", {
        method: "POST",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(3);

    expect(
      readFileSync(
        join(projectsDir, "v_rs1", "script", "full_script.md"),
        "utf8"
      )
    ).toBe("Alpha, one.");
    expect(
      readFileSync(
        join(projectsDir, "v_rs2", "script", "full_script.md"),
        "utf8"
      )
    ).toBe("Beta, two.");
    expect(existsSync(join(projectsDir, "v_topic"))).toBe(false);

    const doneRows = getDb()
      .prepare(
        "SELECT video_id FROM video_steps WHERE status = 'done' AND step_name = 'assemble_script'"
      )
      .all() as { video_id: string }[];
    expect(doneRows.map((r) => r.video_id).sort()).toEqual([
      "v_rs1",
      "v_rs2",
    ]);
  });

  it("surfaces per-row prep failures in the response without aborting peers", async () => {
    // Force a realistic FS failure for one video: pre-create a regular
    // file where its project dir would go, so mkdirSync throws ENOTDIR.
    // The peer with a clean path must still get its prep written.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    await seedNewReadyScriptVideo("v_ok", "Healthy—script.", 1);
    await seedNewReadyScriptVideo("v_broken", "Whatever", 2);
    mkdirSync(projectsDir, { recursive: true });
    // A *file* at projectsDir/v_broken — mkdirSync(...,{recursive:true})
    // throws ENOTDIR when an ancestor is a file.
    writeFileSync(join(projectsDir, "v_broken"), "blocker");

    const { POST } = await import("@/app/api/videos/start-all/route");
    const res = await POST(
      new Request("http://localhost/api/videos/start-all", {
        method: "POST",
      })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.count).toBe(2);
    expect(body.errors).toBeDefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0].id).toBe("v_broken");
    expect(typeof body.errors[0].message).toBe("string");

    // Peer prep still happened.
    expect(
      readFileSync(
        join(projectsDir, "v_ok", "script", "full_script.md"),
        "utf8"
      )
    ).toBe("Healthy, script.");
  });
});
