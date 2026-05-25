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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-queue-start-"));
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

describe("POST /api/queue/start", () => {
  it("flips queue_state to running from paused", async () => {
    const { setSetting, getSetting } = await import("@/lib/settings");
    setSetting("queue_state", "paused");

    const { POST } = await import("@/app/api/queue/start/route");
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, queueState: "running" });
    expect(getSetting("queue_state")).toBe("running");
  });

  it("is idempotent when already running", async () => {
    const { getSetting } = await import("@/lib/settings");
    // Default seed is "running".
    expect(getSetting("queue_state")).toBe("running");

    const { POST } = await import("@/app/api/queue/start/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(getSetting("queue_state")).toBe("running");
  });
});
