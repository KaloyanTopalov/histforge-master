import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseType } from "better-sqlite3";
import type { MagnificQueueItem } from "@/types";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as magnificRepo from "@/lib/repos/magnific";

// The provider awaits waitForMagnificQueue to drain the slice; mock it so
// the unit test asserts the enqueue/skip behavior without real polling.
vi.mock("@/lib/magnific-wait", () => ({
  waitForMagnificQueue: vi.fn(async () => ({ ok: true })),
}));
import { waitForMagnificQueue } from "@/lib/magnific-wait";
import { magnificImageProvider } from "@/lib/image/magnific";

const mockWait = vi.mocked(waitForMagnificQueue);

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});
beforeEach(() => {
  mockWait.mockClear();
});

function insertVideo(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "T", "info", "comfyui", "in_progress", "narrative", 1);
}

// A completed image-batch row for a chunk, used to preload resume state.
function seedDoneRow(db: DatabaseType, videoId: string, chunkId: string): void {
  const id = magnificRepo.enqueueTask(db, {
    video_id: videoId,
    mode: "image-batch",
    prompt: `done-${chunkId}`,
    output_path: `images/${chunkId}.png`,
    no_timeout: 0,
    created_at: 1,
  });
  db.prepare("UPDATE magnific_queue SET status = 'done' WHERE id = ?").run(id);
}

function imageBatchRows(db: DatabaseType, videoId: string): MagnificQueueItem[] {
  return db
    .prepare(
      "SELECT * FROM magnific_queue WHERE video_id = ? AND mode = 'image-batch' ORDER BY id"
    )
    .all(videoId) as MagnificQueueItem[];
}

// Target dir is the project's images dir; it never contains files in these
// tests, so the on-disk done-signal is always false and the row-based
// done-signal is exercised.
const targetDir = join(tmpdir(), "hf-magnific-test-images");
function opts(db: DatabaseType, videoId: string) {
  return { db, videoId, projectsDir: join(tmpdir(), "hf-magnific-test") };
}

describe("magnificImageProvider.generateBatch", () => {
  it("enqueues one image-batch row per chunk with prompt + relative output_path", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    const items = [
      { id: "c1", prompt: "p1" },
      { id: "c2", prompt: "p2" },
      { id: "c3", prompt: "p3" },
    ];

    await magnificImageProvider.generateBatch(items, targetDir, opts(db, "v1"));

    const rows = imageBatchRows(db, "v1");
    expect(rows.length).toBe(3);
    expect(rows.map((r) => r.output_path)).toEqual([
      "images/c1.png",
      "images/c2.png",
      "images/c3.png",
    ]);
    expect(rows.map((r) => r.prompt)).toEqual(["p1", "p2", "p3"]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);
  });

  it("enqueues image-batch rows with no_timeout=0", async () => {
    const db = freshDb();
    insertVideo(db, "v1");

    await magnificImageProvider.generateBatch(
      [{ id: "c1", prompt: "p1" }],
      targetDir,
      opts(db, "v1")
    );

    const rows = imageBatchRows(db, "v1");
    expect(rows.length).toBe(1);
    expect(rows[0].no_timeout).toBe(0);
  });

  it("awaits waitForMagnificQueue keyed on the image-batch mode", async () => {
    const db = freshDb();
    insertVideo(db, "v1");

    await magnificImageProvider.generateBatch(
      [{ id: "c1", prompt: "p1" }],
      targetDir,
      opts(db, "v1")
    );

    expect(mockWait).toHaveBeenCalledTimes(1);
    expect(mockWait).toHaveBeenCalledWith(
      "v1",
      "image-batch",
      expect.objectContaining({ db })
    );
  });

  it("resume: skips chunks that already have a done image-batch row (6 of 10) and enqueues only the 4 remaining", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    const ids = Array.from({ length: 10 }, (_, i) => `c${i + 1}`);
    for (const id of ids.slice(0, 6)) seedDoneRow(db, "v1", id);

    const items = ids.map((id) => ({ id, prompt: `p-${id}` }));
    await magnificImageProvider.generateBatch(items, targetDir, opts(db, "v1"));

    const rows = imageBatchRows(db, "v1");
    expect(rows.length).toBe(10); // 6 done + 4 new
    const pending = rows.filter((r) => r.status === "pending");
    expect(pending.length).toBe(4);
    expect(pending.map((r) => r.output_path).sort()).toEqual([
      "images/c10.png",
      "images/c7.png",
      "images/c8.png",
      "images/c9.png",
    ]);
    // the 6 pre-existing done rows are untouched
    expect(rows.filter((r) => r.status === "done").length).toBe(6);
  });

  it("resume: a full re-run with every chunk already done enqueues zero new rows", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    const ids = Array.from({ length: 10 }, (_, i) => `c${i + 1}`);
    for (const id of ids) seedDoneRow(db, "v1", id);

    const items = ids.map((id) => ({ id, prompt: `p-${id}` }));
    await magnificImageProvider.generateBatch(items, targetDir, opts(db, "v1"));

    const rows = imageBatchRows(db, "v1");
    expect(rows.length).toBe(10);
    expect(rows.filter((r) => r.status === "pending").length).toBe(0);
  });

  it("empty chunk list enqueues nothing and never waits", async () => {
    const db = freshDb();
    insertVideo(db, "v1");

    const result = await magnificImageProvider.generateBatch(
      [],
      targetDir,
      opts(db, "v1")
    );

    expect(result).toBeUndefined();
    expect(imageBatchRows(db, "v1").length).toBe(0);
    expect(mockWait).not.toHaveBeenCalled();
  });

  it("returns a DeferSignal when the wait yields non-ok (paused/deleted)", async () => {
    const db = freshDb();
    insertVideo(db, "v1");
    mockWait.mockResolvedValueOnce({
      ok: false,
      reason: "paused",
      retryAfter: 99,
    });

    const result = await magnificImageProvider.generateBatch(
      [{ id: "c1", prompt: "p1" }],
      targetDir,
      opts(db, "v1")
    );

    expect(result).toEqual({ deferred: true, retryAfter: 99 });
  });
});
