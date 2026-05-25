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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-ready-script-flow-"));
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
  const { getDb, seedDefaultSettings, seedDefaultWorkflows } = await import(
    "@/lib/db"
  );
  const db = getDb();
  db.exec(
    "DELETE FROM video_steps; DELETE FROM videos; DELETE FROM workflow_steps; DELETE FROM workflows; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
  seedDefaultWorkflows(db);
  rmSync(projectsDir, { recursive: true, force: true });
});

describe("ready-script flow: POST /api/videos → POST /api/videos/[id]/start", () => {
  it("creates a video with provided_script, then starting it writes script/full_script.md and pre-marks the script-generation steps as done", async () => {
    // 1. POST /api/videos with provided_script (em-dash to verify sanitization carries through the whole chain).
    const { POST: createVideo } = await import("@/app/api/videos/route");
    const createRes = await createVideo(
      new Request("http://localhost/api/videos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Ready Script E2E",
          topic_info: "[ready script — generation skipped]",
          workflow_id: "comfyui",
          provided_script: "Lived—seventeen talents—enough.",
        }),
      })
    );
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    const videoId = created.video.id as string;
    expect(typeof videoId).toBe("string");
    expect(videoId.length).toBeGreaterThan(0);
    expect(created.video.provided_script).toBe(
      "Lived—seventeen talents—enough."
    );
    expect(created.video.status).toBe("new");

    // No artifacts yet — prep happens at queue time, not create time.
    expect(existsSync(join(projectsDir, videoId))).toBe(false);

    // 2. POST /api/videos/[id]/start.
    const { POST: startVideo } = await import(
      "@/app/api/videos/[id]/start/route"
    );
    const startRes = await startVideo(
      new Request(`http://localhost/api/videos/${videoId}/start`, {
        method: "POST",
      }),
      { params: { id: videoId } }
    );
    expect(startRes.status).toBe(200);

    // 3a. Script file exists with sanitized content (em-dashes → commas).
    const scriptPath = join(projectsDir, videoId, "script", "full_script.md");
    expect(existsSync(scriptPath)).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toBe(
      "Lived, seventeen talents, enough."
    );

    // 3b. Done rows match exactly: every script step from the snapshot, plus assemble_script.
    const { getDb } = await import("@/lib/db");
    const snapshotRow = getDb()
      .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
      .get(videoId) as { workflow_snapshot: string };
    const snapshot = JSON.parse(snapshotRow.workflow_snapshot) as {
      steps: { step_name: string }[];
    };
    const expected = [
      ...snapshot.steps.map((s) => s.step_name),
      "assemble_script",
    ].sort();

    const doneRows = getDb()
      .prepare(
        "SELECT step_name FROM video_steps WHERE video_id = ? AND status = 'done'"
      )
      .all(videoId) as { step_name: string }[];
    expect(doneRows.map((r) => r.step_name).sort()).toEqual(expected);

    // Video row is now queued.
    const videoRow = getDb()
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get(videoId) as { status: string };
    expect(videoRow.status).toBe("queued");
  });
});
