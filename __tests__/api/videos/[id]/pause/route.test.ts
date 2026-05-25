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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-video-pause-"));
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
  db.exec("DELETE FROM video_steps; DELETE FROM videos;");
  seedDefaultSettings(db);
});

async function seedVideo(
  videoId: string,
  overrides: Partial<{
    status: string;
    delete_requested: 0 | 1;
    paused: 0 | 1;
  }> = {}
): Promise<void> {
  const { getDb } = await import("@/lib/db");
  const db = getDb();
  const now = Date.now();
  db.prepare(
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, delete_requested, paused, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    videoId,
    "T",
    "info",
    "comfyui",
    overrides.status ?? "queued",
    overrides.delete_requested ?? 0,
    overrides.paused ?? 0,
    now
  );
}

async function readPausedFlag(videoId: string): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const row = getDb()
    .prepare("SELECT paused FROM videos WHERE id = ?")
    .get(videoId) as { paused: number };
  return row.paused;
}

describe("POST /api/videos/:id/pause", () => {
  it("sets paused=1 on a queued video", async () => {
    await seedVideo("v1", { status: "queued" });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await readPausedFlag("v1")).toBe(1);
  });

  it("sets paused=1 on an in_progress video", async () => {
    await seedVideo("v1", { status: "in_progress" });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(200);
    expect(await readPausedFlag("v1")).toBe(1);
  });

  it("returns 409 when already paused", async () => {
    await seedVideo("v1", { status: "in_progress", paused: 1 });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "not_pausable" });
    expect(await readPausedFlag("v1")).toBe(1);
  });

  it("returns 409 when delete is pending", async () => {
    await seedVideo("v1", {
      status: "in_progress",
      delete_requested: 1,
    });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
    expect(await readPausedFlag("v1")).toBe(0);
  });

  it("returns 409 when status is new", async () => {
    await seedVideo("v1", { status: "new" });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 409 when status is done", async () => {
    await seedVideo("v1", { status: "done" });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 409 when status is failed", async () => {
    await seedVideo("v1", { status: "failed" });
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/v1/pause", {
        method: "POST",
      }),
      { params: { id: "v1" } }
    );
    expect(res.status).toBe(409);
  });

  it("returns 404 for unknown id", async () => {
    const { POST } = await import("@/app/api/videos/[id]/pause/route");
    const res = await POST(
      new Request("http://localhost/api/videos/nope/pause", {
        method: "POST",
      }),
      { params: { id: "nope" } }
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});
