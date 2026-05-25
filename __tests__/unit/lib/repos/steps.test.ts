import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as stepsRepo from "@/lib/repos/steps";

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

function insertVideo(db: DatabaseType, id: string): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, "T", "info", "comfyui", "queued", 1);
}

describe("stepsRepo.upsertPending", () => {
  it("inserts a pending row the first time, is a no-op after", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    stepsRepo.upsertPending(db, "v1", "research_outline");
    stepsRepo.upsertPending(db, "v1", "research_outline");
    const rows = db
      .prepare(
        "SELECT step_name, status FROM video_steps WHERE video_id = ?"
      )
      .all("v1");
    expect(rows).toEqual([
      { step_name: "research_outline", status: "pending" },
    ]);
  });
});

describe("stepsRepo.getStatus", () => {
  it("returns the current status, or undefined when the row is missing", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    stepsRepo.upsertPending(db, "v1", "voiceover");
    expect(stepsRepo.getStatus(db, "v1", "voiceover")).toBe("pending");
    expect(stepsRepo.getStatus(db, "v1", "never_written")).toBeUndefined();
  });
});

describe("stepsRepo mark transitions", () => {
  it("markRunning stamps started_at and nulls finished_at; markDone stamps finished_at", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    stepsRepo.upsertPending(db, "v1", "chunk");

    stepsRepo.markRunning(db, "v1", "chunk", 100);
    let row = db
      .prepare(
        "SELECT status, started_at, finished_at FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "chunk") as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(row).toEqual({
      status: "running",
      started_at: 100,
      finished_at: null,
    });

    stepsRepo.markDone(db, "v1", "chunk", 500);
    row = db
      .prepare(
        "SELECT status, started_at, finished_at FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "chunk") as typeof row;
    expect(row).toEqual({
      status: "done",
      started_at: 100,
      finished_at: 500,
    });
  });

  it("markFailed flips status to failed and stamps finished_at", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    stepsRepo.upsertPending(db, "v1", "voiceover");
    stepsRepo.markRunning(db, "v1", "voiceover", 100);
    stepsRepo.markFailed(db, "v1", "voiceover", 300);
    const row = db
      .prepare(
        "SELECT status, finished_at FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "voiceover");
    expect(row).toEqual({ status: "failed", finished_at: 300 });
  });

  it("resetToPending clears both timestamps", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    stepsRepo.upsertPending(db, "v1", "voiceover");
    stepsRepo.markRunning(db, "v1", "voiceover", 100);
    stepsRepo.markFailed(db, "v1", "voiceover", 500);
    stepsRepo.resetToPending(db, "v1", "voiceover");
    const row = db
      .prepare(
        "SELECT status, started_at, finished_at FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "voiceover");
    expect(row).toEqual({
      status: "pending",
      started_at: null,
      finished_at: null,
    });
  });

  it("resetAllRunningToPending touches only 'running' rows across all videos", () => {
    const db = freshDb();
    insertVideo(db, "v_a");
    insertVideo(db, "v_b");
    stepsRepo.upsertPending(db, "v_a", "voiceover");
    stepsRepo.upsertPending(db, "v_b", "chunk");
    stepsRepo.markRunning(db, "v_a", "voiceover", 100);
    stepsRepo.markDone(db, "v_b", "chunk", 200);

    stepsRepo.resetAllRunningToPending(db);

    expect(stepsRepo.getStatus(db, "v_a", "voiceover")).toBe("pending");
    // Done row untouched.
    expect(stepsRepo.getStatus(db, "v_b", "chunk")).toBe("done");
  });
});

describe("stepsRepo.findByVideo", () => {
  it("returns rows sorted by the video's workflow.steps order", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    // Insert out of order.
    stepsRepo.upsertPending(db, "v1", "render");
    stepsRepo.upsertPending(db, "v1", "research_outline");
    stepsRepo.upsertPending(db, "v1", "voiceover");

    const names = stepsRepo.findByVideo(db, "v1").map((r) => r.step_name);
    // comfyui workflow order: research_outline < voiceover < render.
    expect(names).toEqual(["research_outline", "voiceover", "render"]);
  });

  it("drops rows whose step_name is not in the workflow (orphan-safe)", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    stepsRepo.upsertPending(db, "v1", "research_outline");
    // Manually insert an orphan name (test-only scenario).
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, 'stray', 'done')"
    ).run("v1");
    expect(stepsRepo.findByVideo(db, "v1").map((r) => r.step_name)).toEqual([
      "research_outline",
    ]);
  });

  it("returns empty array when no rows exist", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    expect(stepsRepo.findByVideo(db, "v1")).toEqual([]);
  });

  it("returns empty array when the video row is missing", () => {
    const db = freshDb();
    expect(stepsRepo.findByVideo(db, "nope")).toEqual([]);
  });
});

describe("stepsRepo.deleteAllForVideo", () => {
  it("removes only rows for the given video_id", () => {
    const db = freshDb();
    insertVideo(db, "v_a");
    insertVideo(db, "v_b");
    stepsRepo.upsertPending(db, "v_a", "research_outline");
    stepsRepo.upsertPending(db, "v_b", "voiceover");

    stepsRepo.deleteAllForVideo(db, "v_a");

    expect(stepsRepo.findByVideo(db, "v_a")).toEqual([]);
    expect(stepsRepo.findByVideo(db, "v_b").map((r) => r.step_name)).toEqual([
      "voiceover",
    ]);
  });
});

describe("stepsRepo.runtimeSnapshots", () => {
  it("returns an empty map when video_steps is empty", () => {
    const db = freshDb();
    expect(stepsRepo.runtimeSnapshots(db)).toEqual(new Map());
  });

  it("sums (finished_at - started_at) for done steps", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v1", "a", "done", 1_000, 4_000);

    const snap = stepsRepo.runtimeSnapshots(db);
    expect(snap.get("v1")).toEqual({
      runtime_ms: 3_000,
      running_step_started_at: null,
    });
  });

  it("counts a failed step (also has finished_at)", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v1", "a", "failed", 1_000, 2_500);

    const snap = stepsRepo.runtimeSnapshots(db);
    expect(snap.get("v1")).toEqual({
      runtime_ms: 1_500,
      running_step_started_at: null,
    });
  });

  it("reports running_step_started_at for an open step (started but not finished)", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v1", "a", "running", 7_777, null);

    const snap = stepsRepo.runtimeSnapshots(db);
    expect(snap.get("v1")).toEqual({
      runtime_ms: 0,
      running_step_started_at: 7_777,
    });
  });

  it("combines completed sum + running snapshot for a video mid-flight", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    const ins = db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    );
    ins.run("v1", "a", "done", 1_000, 2_000);
    ins.run("v1", "b", "done", 2_000, 5_000);
    ins.run("v1", "c", "running", 5_000, null);
    ins.run("v1", "d", "pending", null, null);

    const snap = stepsRepo.runtimeSnapshots(db);
    expect(snap.get("v1")).toEqual({
      runtime_ms: 4_000,
      running_step_started_at: 5_000,
    });
  });

  it("reports defaults for a video with only pending step rows", () => {
    const db = freshDb();
    insertVideo(db, "v1");
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    ).run("v1", "a", "pending", null, null);

    const snap = stepsRepo.runtimeSnapshots(db);
    expect(snap.get("v1")).toEqual({
      runtime_ms: 0,
      running_step_started_at: null,
    });
  });

  it("isolates per video (one entry per video_id)", () => {
    const db = freshDb();
    insertVideo(db, "v_a");
    insertVideo(db, "v_b");
    const ins = db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, ?, ?, ?)"
    );
    ins.run("v_a", "a", "done", 100, 600);
    ins.run("v_b", "b", "running", 1_234, null);

    const snap = stepsRepo.runtimeSnapshots(db);
    expect(snap.size).toBe(2);
    expect(snap.get("v_a")).toEqual({
      runtime_ms: 500,
      running_step_started_at: null,
    });
    expect(snap.get("v_b")).toEqual({
      runtime_ms: 0,
      running_step_started_at: 1_234,
    });
  });
});
