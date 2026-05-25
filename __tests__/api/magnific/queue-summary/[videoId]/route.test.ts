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
  tempDir = mkdtempSync(join(tmpdir(), "histforge-magnific-queue-summary-"));
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
    "DELETE FROM magnific_queue; DELETE FROM videos; DELETE FROM settings;"
  );
  seedDefaultSettings(db);
});

async function seedVideo(id: string): Promise<void> {
  const { getDb } = await import("@/lib/db");
  getDb()
    .prepare(
      `INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, created_at)
       VALUES (?, ?, ?, ?, 'queued', 'music_video', ?)`
    )
    .run(id, "T", "info", "music-video-magnific-suno", Date.now());
}

async function insertRow(args: {
  video_id: string;
  mode: "image-hitl" | "image-to-video";
  status: "pending" | "dispatched" | "done" | "failed";
  no_timeout: 0 | 1;
  prompt?: string;
}): Promise<number> {
  const { getDb } = await import("@/lib/db");
  const info = getDb()
    .prepare(
      `INSERT INTO magnific_queue (
         video_id, mode, prompt, output_path, status, no_timeout,
         created_at, dispatched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      args.video_id,
      args.mode,
      args.prompt ?? "prompt-text",
      args.mode === "image-hitl" ? "loop_image.png" : "loop_clip.mp4",
      args.status,
      args.no_timeout,
      1,
      args.status === "dispatched" ? 2 : null
    );
  return Number(info.lastInsertRowid);
}

async function getSummary(videoId: string): Promise<Response> {
  const { GET } = await import(
    "@/app/api/magnific/queue-summary/[videoId]/route"
  );
  return GET(
    new Request(`http://localhost/api/magnific/queue-summary/${videoId}`),
    { params: { videoId } }
  );
}

describe("GET /api/magnific/queue-summary/:videoId", () => {
  it("404s on unknown video", async () => {
    const res = await getSummary("does-not-exist");
    expect(res.status).toBe(404);
  });

  it("returns zeroed counts + no hitl_pending for a video with no queue rows", async () => {
    await seedVideo("vid1");
    const res = await getSummary("vid1");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.counts).toEqual({
      pending: 0,
      dispatched: 0,
      done: 0,
      failed: 0,
    });
    expect(body.hitl_pending).toBeNull();
  });

  it("counts aggregate rows across both modes", async () => {
    await seedVideo("vid2");
    await insertRow({
      video_id: "vid2",
      mode: "image-hitl",
      status: "done",
      no_timeout: 1,
    });
    await insertRow({
      video_id: "vid2",
      mode: "image-to-video",
      status: "pending",
      no_timeout: 0,
    });
    await insertRow({
      video_id: "vid2",
      mode: "image-to-video",
      status: "failed",
      no_timeout: 0,
    });

    const res = await getSummary("vid2");
    const body = await res.json();
    expect(body.counts).toEqual({
      pending: 1,
      dispatched: 0,
      done: 1,
      failed: 1,
    });
  });

  it("surfaces hitl_pending when a dispatched no_timeout=1 row exists", async () => {
    await seedVideo("vid3");
    const rowId = await insertRow({
      video_id: "vid3",
      mode: "image-hitl",
      status: "dispatched",
      no_timeout: 1,
      prompt: "a Roman aqueduct at sunset",
    });

    const res = await getSummary("vid3");
    const body = await res.json();
    expect(body.hitl_pending).toEqual({
      row_id: rowId,
      mode: "image-hitl",
      prompt: "a Roman aqueduct at sunset",
    });
  });

  it("does NOT surface hitl_pending for a dispatched row with no_timeout=0", async () => {
    // image-to-video rows are not operator-blocking; they ride the reaper
    // requeue path on hang. The banner only cares about HITL gates.
    await seedVideo("vid4");
    await insertRow({
      video_id: "vid4",
      mode: "image-to-video",
      status: "dispatched",
      no_timeout: 0,
    });

    const res = await getSummary("vid4");
    const body = await res.json();
    expect(body.hitl_pending).toBeNull();
  });

  it("does NOT surface hitl_pending for a pending (not yet dispatched) no_timeout=1 row", async () => {
    // Until the extension claims the row, the operator can't act on
    // Magnific's UI. The banner pops only once the row is dispatched.
    await seedVideo("vid5");
    await insertRow({
      video_id: "vid5",
      mode: "image-hitl",
      status: "pending",
      no_timeout: 1,
    });

    const res = await getSummary("vid5");
    const body = await res.json();
    expect(body.hitl_pending).toBeNull();
  });

  it("scopes both counts and hitl_pending to the requested video (no cross-video leak)", async () => {
    await seedVideo("vid6");
    await seedVideo("other");
    await insertRow({
      video_id: "other",
      mode: "image-hitl",
      status: "dispatched",
      no_timeout: 1,
      prompt: "wrong video",
    });
    await insertRow({
      video_id: "other",
      mode: "image-to-video",
      status: "done",
      no_timeout: 0,
    });

    const res = await getSummary("vid6");
    const body = await res.json();
    expect(body.counts).toEqual({
      pending: 0,
      dispatched: 0,
      done: 0,
      failed: 0,
    });
    expect(body.hitl_pending).toBeNull();
  });
});
