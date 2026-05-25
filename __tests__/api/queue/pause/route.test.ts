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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-queue-pause-"));
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

describe("POST /api/queue/pause", () => {
  it("flips queue_state to paused", async () => {
    const { POST } = await import("@/app/api/queue/pause/route");
    const res = await POST();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, queueState: "paused" });

    const { getSetting } = await import("@/lib/settings");
    expect(getSetting("queue_state")).toBe("paused");
  });

  it("is idempotent when already paused", async () => {
    const { setSetting, getSetting } = await import("@/lib/settings");
    setSetting("queue_state", "paused");

    const { POST } = await import("@/app/api/queue/pause/route");
    const res = await POST();
    expect(res.status).toBe(200);
    expect(getSetting("queue_state")).toBe("paused");
  });
});
