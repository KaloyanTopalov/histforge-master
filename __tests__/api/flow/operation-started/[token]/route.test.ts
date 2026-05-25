import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDir: string;

beforeAll(() => {
  tempDir = mkdtempSync(join(tmpdir(), "histforge-flow-op-started-"));
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
    "DELETE FROM google_flow_queue; DELETE FROM google_flow_accounts; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
});

async function seedAccount(token: string): Promise<string> {
  const { getDb } = await import("@/lib/db");
  const id = "acc_01";
  getDb()
    .prepare(
      `INSERT INTO google_flow_accounts (id, name, token, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(id, "a1", token, Math.floor(Date.now() / 1000));
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

async function seedDispatched(args: {
  videoId: string;
  externalTaskId: string;
  accountId: string;
  status?: "dispatched" | "done" | "failed" | "pending";
}): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const gfRepo = await import("@/lib/repos/google-flow");
  const now = Math.floor(Date.now() / 1000);
  const id = gfRepo.enqueueTask(db, {
    video_id: args.videoId,
    chunk_id: "c1",
    kind: "clip",
    mode: "text",
    prompt: "p",
    output_path: "videos/clip/c1.mp4",
    created_at: now,
  });
  db.prepare(
    `UPDATE google_flow_queue
        SET status = ?,
            assigned_account_id = ?,
            dispatched_at = ?,
            external_task_id = ?
      WHERE id = ?`
  ).run(args.status ?? "dispatched", args.accountId, now, args.externalTaskId, id);
  return id;
}

function callOperationStarted(
  token: string,
  body: unknown
): Promise<Response> {
  return import("@/app/api/flow/operation-started/[token]/route").then(
    ({ POST }) =>
      POST(
        new Request(`http://localhost/api/flow/operation-started/${token}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
        { params: { token } }
      )
  );
}

describe("POST /api/flow/operation-started/:token", () => {
  it("writes google_operation_id + project_id on a dispatched row", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      externalTaskId: "10_111",
      accountId: accId,
    });

    const res = await callOperationStarted("T", {
      type: "OperationStarted",
      accountToken: "T",
      taskId: "10_111",
      operationName: "operations/op-abc",
      projectId: "proj-xyz",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT status, google_operation_id, google_operation_project_id FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      status: string;
      google_operation_id: string | null;
      google_operation_project_id: string | null;
    };
    expect(row.status).toBe("dispatched");
    expect(row.google_operation_id).toBe("operations/op-abc");
    expect(row.google_operation_project_id).toBe("proj-xyz");
  });

  it("state-tolerant: unknown taskId → 200 success, no DB write", async () => {
    await seedAccount("T");
    const res = await callOperationStarted("T", {
      type: "OperationStarted",
      accountToken: "T",
      taskId: "999_999",
      operationName: "operations/op-stale",
      projectId: "proj-stale",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });

  it("state-tolerant: task not in 'dispatched' (e.g. done) → 200 success, no DB write", async () => {
    const accId = await seedAccount("T");
    await seedVideo("v1");
    const id = await seedDispatched({
      videoId: "v1",
      externalTaskId: "20_222",
      accountId: accId,
      status: "done",
    });

    const res = await callOperationStarted("T", {
      type: "OperationStarted",
      accountToken: "T",
      taskId: "20_222",
      operationName: "operations/op-late",
      projectId: "proj-late",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });

    const { getDb } = await import("@/lib/db");
    const row = getDb()
      .prepare(
        "SELECT google_operation_id, google_operation_project_id FROM google_flow_queue WHERE id = ?"
      )
      .get(id) as {
      google_operation_id: string | null;
      google_operation_project_id: string | null;
    };
    expect(row.google_operation_id).toBeNull();
    expect(row.google_operation_project_id).toBeNull();
  });

  it("401 on token mismatch", async () => {
    await seedAccount("T-real");
    const res = await callOperationStarted("T-url", {
      type: "OperationStarted",
      accountToken: "T-real",
      taskId: "1_1",
      operationName: "operations/op-x",
      projectId: "proj-x",
    });
    expect(res.status).toBe(401);
  });

  it("400 on body missing required fields", async () => {
    await seedAccount("T");
    const res = await callOperationStarted("T", {
      type: "OperationStarted",
      accountToken: "T",
    });
    expect(res.status).toBe(400);
  });
});
