import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  vi,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-project-"));
  process.env.DATABASE_URL = join(tempDir, "test.db");
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    /* already closed */
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec(
    "DELETE FROM google_flow_video_projects; DELETE FROM google_flow_accounts; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
});

async function seedAccount(args: { id?: string; token: string }): Promise<string> {
  const { getDb } = await import("@/lib/db");
  const id = args.id ?? "acc_01";
  getDb()
    .prepare(
      `INSERT INTO google_flow_accounts (id, name, token, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(id, "a1", args.token, Math.floor(Date.now() / 1000));
  return id;
}

async function seedVideo(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at)
       VALUES (?, ?, ?, ?, 'queued', ?)`
    )
    .run(id, "T", "info", "google-flow", Date.now());
}

function callProject(token: string, body: unknown): Promise<Response> {
  return import("@/app/api/flow/project/[token]/route").then(({ POST }) =>
    POST(
      new Request(`http://localhost/api/flow/project/${token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: { token } }
    )
  );
}

describe("POST /api/flow/project/:token", () => {
  it("401s on token mismatch", async () => {
    await seedAccount({ token: "T" });
    const res = await callProject("T-url", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "v1",
      projectId: "p1",
      projectTitle: "Title",
    });
    expect(res.status).toBe(401);
  });

  it("404s on unknown token", async () => {
    const res = await callProject("nope", {
      type: "ProjectCreated",
      accountToken: "nope",
      videoId: "v1",
      projectId: "p1",
      projectTitle: "Title",
    });
    expect(res.status).toBe(404);
  });

  it("404s when the video does not exist", async () => {
    await seedAccount({ token: "T" });
    const res = await callProject("T", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "missing-video",
      projectId: "p1",
      projectTitle: "Title",
    });
    expect(res.status).toBe(404);
  });

  it("persists the row on first POST", async () => {
    const accId = await seedAccount({ token: "T" });
    await seedVideo("v1");

    const res = await callProject("T", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "v1",
      projectId: "proj-1",
      projectTitle: "Roman Aqueducts",
    });
    expect(res.status).toBe(200);

    const gfRepo = await import("@/lib/repos/google-flow");
    const { getDb } = await import("@/lib/db");
    const row = gfRepo.findFlowProjectForAccount(getDb(), "v1", accId);
    expect(row?.flow_project_id).toBe("proj-1");
  });

  it("is idempotent on repost with the same projectId (200, row unchanged)", async () => {
    const accId = await seedAccount({ token: "T" });
    await seedVideo("v1");

    await callProject("T", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "v1",
      projectId: "proj-1",
      projectTitle: "Title",
    });
    const res = await callProject("T", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "v1",
      projectId: "proj-1",
      projectTitle: "Title",
    });
    expect(res.status).toBe(200);

    const gfRepo = await import("@/lib/repos/google-flow");
    const { getDb } = await import("@/lib/db");
    const row = gfRepo.findFlowProjectForAccount(getDb(), "v1", accId);
    expect(row?.flow_project_id).toBe("proj-1");
  });

  it("first-writer-wins: a different projectId for an existing pair logs a warning and keeps the original", async () => {
    const accId = await seedAccount({ token: "T" });
    await seedVideo("v1");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    await callProject("T", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "v1",
      projectId: "proj-1",
      projectTitle: "Title",
    });
    const res = await callProject("T", {
      type: "ProjectCreated",
      accountToken: "T",
      videoId: "v1",
      projectId: "proj-2",
      projectTitle: "Title",
    });
    expect(res.status).toBe(200);

    const gfRepo = await import("@/lib/repos/google-flow");
    const { getDb } = await import("@/lib/db");
    const row = gfRepo.findFlowProjectForAccount(getDb(), "v1", accId);
    expect(row?.flow_project_id).toBe("proj-1");
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("creates separate rows for different accounts on the same video", async () => {
    const accA = await seedAccount({ id: "acc_a", token: "T-A" });
    const accB = await seedAccount({ id: "acc_b", token: "T-B" });
    await seedVideo("v1");

    await callProject("T-A", {
      type: "ProjectCreated",
      accountToken: "T-A",
      videoId: "v1",
      projectId: "proj-A",
      projectTitle: "Title",
    });
    await callProject("T-B", {
      type: "ProjectCreated",
      accountToken: "T-B",
      videoId: "v1",
      projectId: "proj-B",
      projectTitle: "Title",
    });

    const gfRepo = await import("@/lib/repos/google-flow");
    const { getDb } = await import("@/lib/db");
    expect(gfRepo.findFlowProjectForAccount(getDb(), "v1", accA)?.flow_project_id).toBe("proj-A");
    expect(gfRepo.findFlowProjectForAccount(getDb(), "v1", accB)?.flow_project_id).toBe("proj-B");
  });

  it("rejects a body missing required fields with 400", async () => {
    await seedAccount({ token: "T" });
    const res = await callProject("T", { type: "ProjectCreated" });
    expect(res.status).toBe(400);
  });
});
