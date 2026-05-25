import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
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

function seedVideo(db: DatabaseType, id = "v_1") {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "V", "info", "google-flow", "in_progress", 1);
}

describe("moderation-event repo", () => {
  it("insertModerationEvent persists every column and returns the new id", () => {
    const db = freshDb();
    seedVideo(db);

    const id = gfRepo.insertModerationEvent(db, {
      video_id: "v_1",
      chunk_id: "c_007",
      kind: "image",
      round: 1,
      original_prompt: "a brutal scene",
      rewritten_prompt: "the aftermath of a sudden tragedy",
      reason_tag: "PUBLIC_ERROR_DANGER_FILTER",
      created_at: 1_700_000,
    });

    expect(id).toBeGreaterThan(0);

    const row = db
      .prepare("SELECT * FROM moderation_events WHERE id = ?")
      .get(id);
    expect(row).toMatchObject({
      id,
      video_id: "v_1",
      chunk_id: "c_007",
      kind: "image",
      round: 1,
      original_prompt: "a brutal scene",
      rewritten_prompt: "the aftermath of a sudden tragedy",
      reason_tag: "PUBLIC_ERROR_DANGER_FILTER",
      created_at: 1_700_000,
    });
  });

  it("accepts a null reason_tag", () => {
    const db = freshDb();
    seedVideo(db);
    const id = gfRepo.insertModerationEvent(db, {
      video_id: "v_1",
      chunk_id: "c_1",
      kind: "clip",
      round: 1,
      original_prompt: "x",
      rewritten_prompt: "y",
      reason_tag: null,
      created_at: 1,
    });
    const row = db
      .prepare("SELECT reason_tag FROM moderation_events WHERE id = ?")
      .get(id) as { reason_tag: string | null };
    expect(row.reason_tag).toBeNull();
  });

  it("listModerationEventsForVideo returns rows ordered by created_at ASC, scoped to the video", () => {
    const db = freshDb();
    seedVideo(db, "v_1");
    seedVideo(db, "v_2");

    gfRepo.insertModerationEvent(db, {
      video_id: "v_1",
      chunk_id: "c_2",
      kind: "image",
      round: 1,
      original_prompt: "p2",
      rewritten_prompt: "r2",
      reason_tag: "SAFETY",
      created_at: 200,
    });
    gfRepo.insertModerationEvent(db, {
      video_id: "v_1",
      chunk_id: "c_1",
      kind: "image",
      round: 1,
      original_prompt: "p1",
      rewritten_prompt: "r1",
      reason_tag: "SAFETY",
      created_at: 100,
    });
    gfRepo.insertModerationEvent(db, {
      video_id: "v_2",
      chunk_id: "c_x",
      kind: "image",
      round: 1,
      original_prompt: "px",
      rewritten_prompt: "rx",
      reason_tag: "SAFETY",
      created_at: 50,
    });

    const events = gfRepo.listModerationEventsForVideo(db, "v_1");
    expect(events.map((e) => e.chunk_id)).toEqual(["c_1", "c_2"]);
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.video_id === "v_1")).toBe(true);
  });

  it("returns [] when the video has no moderation events", () => {
    const db = freshDb();
    seedVideo(db);
    expect(gfRepo.listModerationEventsForVideo(db, "v_1")).toEqual([]);
  });

  it("cascade-deletes moderation_events when the parent video is deleted", () => {
    const db = freshDb();
    seedVideo(db);
    gfRepo.insertModerationEvent(db, {
      video_id: "v_1",
      chunk_id: "c_1",
      kind: "image",
      round: 1,
      original_prompt: "p",
      rewritten_prompt: "r",
      reason_tag: null,
      created_at: 1,
    });
    expect(gfRepo.listModerationEventsForVideo(db, "v_1")).toHaveLength(1);

    db.prepare("DELETE FROM videos WHERE id = ?").run("v_1");

    expect(gfRepo.listModerationEventsForVideo(db, "v_1")).toEqual([]);
  });
});
