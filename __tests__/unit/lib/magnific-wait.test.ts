import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { waitForMagnificQueue } from "@/lib/magnific-wait";
import * as magnificRepo from "@/lib/repos/magnific";
import * as videosRepo from "@/lib/repos/videos";
import { setSetting } from "@/lib/settings";

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

function insertMusicVideo(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "T", "info", "music-video-magnific-suno", "in_progress", "music_video", 1);
}

describe("waitForMagnificQueue", () => {
  it("returns {ok: true} when every queued row for the (video, mode) is done or failed", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'done' WHERE id = ?").run(id);

    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns paused with retryAfter=now when queue_state='paused' globally", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?").run(id);
    setSetting("queue_state", "paused", db);

    const fakeNow = 1_234_567;
    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "paused",
      retryAfter: fakeNow,
    });
  });

  it("returns paused when the specific video is paused", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?").run(id);
    videosRepo.setPaused(db, "v1");

    const fakeNow = 2_222_222;
    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "paused",
      retryAfter: fakeNow,
    });
  });

  it("keeps polling while a row is still dispatched, terminating once it flips to done", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?").run(id);

    let polls = 0;
    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
      onTick: () => {
        polls++;
        if (polls === 2) {
          db.prepare("UPDATE magnific_queue SET status = 'done' WHERE id = ?").run(id);
        }
      },
    });
    expect(result).toEqual({ ok: true });
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it("ignores rows of a different mode for the same video", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    // An open image-to-video row should NOT block an image-hitl wait.
    magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-to-video",
      prompt: "motion",
      output_path: "loop_clip.mp4",
      created_at: 1,
    });

    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("returns ok:true when the queue has drained, even if delete_requested is set", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'done' WHERE id = ?").run(id);
    videosRepo.setDeleteRequested(db, "v1");

    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
    });
    expect(result).toEqual({ ok: true });
  });

  it("delete_requested takes priority over pause when both are set", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?").run(id);
    videosRepo.setPaused(db, "v1");
    videosRepo.setDeleteRequested(db, "v1");

    const fakeNow = 5_555_555;
    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "deleted",
      retryAfter: fakeNow,
    });
  });

  it("returns deleted with retryAfter=now when videos.delete_requested=1 (no signal)", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?").run(id);
    videosRepo.setDeleteRequested(db, "v1");

    const fakeNow = 4_242_424;
    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "deleted",
      retryAfter: fakeNow,
    });
  });

  it("returns deleted with retryAfter=now when the signal is aborted", async () => {
    const db = freshDb();
    insertMusicVideo(db, "v1");
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v1",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    db.prepare("UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?").run(id);

    const controller = new AbortController();
    controller.abort();
    const fakeNow = 4_242_424;
    const result = await waitForMagnificQueue("v1", "image-hitl", {
      db,
      pollIntervalMs: 1,
      signal: controller.signal,
      nowSec: () => fakeNow,
    });
    expect(result).toEqual({
      ok: false,
      reason: "deleted",
      retryAfter: fakeNow,
    });
  });
});
