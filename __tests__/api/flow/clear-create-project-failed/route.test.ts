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
  tempDir = mkdtempSync(
    join(tmpdir(), "histforge-clear-create-project-failed-")
  );
  process.env.DATABASE_URL = join(tempDir, "test.db");
});

afterAll(async () => {
  const { getDb } = await import("@/lib/db");
  try {
    getDb().close();
  } catch {
    // already closed
  }
  rmSync(tempDir, { recursive: true, force: true });
});

beforeEach(async () => {
  const { getDb, seedDefaultSettings } = await import("@/lib/db");
  const db = getDb();
  db.exec("DELETE FROM settings;");
  seedDefaultSettings(db);
});

describe("POST /api/flow/clear-create-project-failed", () => {
  it("clears the flow_create_project_failed setting", async () => {
    const { setSetting, getSetting } = await import("@/lib/settings");
    setSetting(
      "flow_create_project_failed",
      JSON.stringify({
        errorCode: "createProject_envelope_drift",
        httpStatus: 200,
        taskId: "task_1",
        when: 1000,
        accountId: "acc_01",
      })
    );
    expect(getSetting("flow_create_project_failed")).not.toBe("");

    const { POST } = await import(
      "@/app/api/flow/clear-create-project-failed/route"
    );
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    expect(getSetting("flow_create_project_failed")).toBe("");
  });

  it("is idempotent when the setting is already empty", async () => {
    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("flow_create_project_failed")).toBe("");

    const { POST } = await import(
      "@/app/api/flow/clear-create-project-failed/route"
    );
    const res = await POST();
    expect(res.status).toBe(200);
    expect(getSetting("flow_create_project_failed")).toBe("");
  });
});
