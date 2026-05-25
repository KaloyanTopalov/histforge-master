import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { setSetting } from "@/lib/settings";
import {
  pickNextVideo,
  resetStaleRunningSteps,
  runLoop,
  tickOnce,
} from "@/worker/runner";

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

function insertVideo(
  db: DatabaseType,
  id: string,
  status: string,
  createdAt: number,
  startedAt: number | null = null
): void {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, started_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "Title", "info", "comfyui", status, startedAt, createdAt);
}

function insertStep(
  db: DatabaseType,
  videoId: string,
  stepName: string,
  status: string
): void {
  db.prepare(
    "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, ?)"
  ).run(videoId, stepName, status);
}

describe("resetStaleRunningSteps", () => {
  it("flips every video_steps row in 'running' state to 'pending'", () => {
    const db = freshDb();
    insertVideo(db, "vid_1", "in_progress", 1);
    insertStep(db, "vid_1", "research_outline", "done");
    insertStep(db, "vid_1", "write_hook", "running");
    insertStep(db, "vid_1", "voiceover", "pending");

    resetStaleRunningSteps(db);

    const rows = db
      .prepare(
        "SELECT step_name, status FROM video_steps WHERE video_id = ? ORDER BY step_name"
      )
      .all("vid_1") as Array<{ step_name: string; status: string }>;

    expect(rows).toEqual([
      { step_name: "research_outline", status: "done" },
      { step_name: "voiceover", status: "pending" },
      { step_name: "write_hook", status: "pending" },
    ]);
  });
});

describe("pickNextVideo", () => {
  it("returns an in_progress video (resume on startup) before any queued video", () => {
    const db = freshDb();
    insertVideo(db, "vid_old_queued", "queued", 1);
    insertVideo(db, "vid_resumed", "in_progress", 5);

    const result = pickNextVideo(db);

    expect(result).toEqual({ id: "vid_resumed", reason: "resume" });
  });

  it("returns the oldest queued video by created_at when nothing is in_progress", () => {
    const db = freshDb();
    insertVideo(db, "vid_newer", "queued", 100);
    insertVideo(db, "vid_oldest", "queued", 10);
    insertVideo(db, "vid_middle", "queued", 50);

    const result = pickNextVideo(db);

    expect(result).toEqual({ id: "vid_oldest", reason: "start" });
  });

  it("returns null when no videos exist", () => {
    const db = freshDb();
    expect(pickNextVideo(db)).toBeNull();
  });

  it("does not pick up videos with status='new' (awaiting user Start)", () => {
    const db = freshDb();
    insertVideo(db, "vid_new", "new", 1);
    expect(pickNextVideo(db)).toBeNull();
  });

  it("still skips 'new' even when it is older than a queued video", () => {
    const db = freshDb();
    insertVideo(db, "vid_new_older", "new", 1);
    insertVideo(db, "vid_queued_newer", "queued", 100);
    expect(pickNextVideo(db)).toEqual({
      id: "vid_queued_newer",
      reason: "start",
    });
  });

  it("returns null when queue_state='paused' even if a queued video is waiting", () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1);
    setSetting("queue_state", "paused", db);

    expect(pickNextVideo(db)).toBeNull();
  });

  it("returns null when queue_state='paused' even if an in_progress video exists", () => {
    const db = freshDb();
    insertVideo(db, "vid_resumed", "in_progress", 1);
    setSetting("queue_state", "paused", db);

    expect(pickNextVideo(db)).toBeNull();
  });

  it("does not fall through to a queued video when the only in_progress video is paused", () => {
    // Preserves the one-at-a-time invariant: if an in_progress row exists
    // (even paused), the worker must idle rather than start a second video.
    const db = freshDb();
    insertVideo(db, "vid_in_progress_paused", "in_progress", 1);
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run(
      "vid_in_progress_paused"
    );
    insertVideo(db, "vid_queued", "queued", 5);

    expect(pickNextVideo(db)).toBeNull();
  });

  it("skips a paused queued video and picks the next unpaused one", () => {
    const db = freshDb();
    insertVideo(db, "vid_paused", "queued", 1);
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("vid_paused");
    insertVideo(db, "vid_ok", "queued", 2);

    expect(pickNextVideo(db)).toEqual({ id: "vid_ok", reason: "start" });
  });

  it("picks a paused in_progress video when delete_requested=1 (delete wins over pause)", () => {
    // Without the delete short-circuit, the paused=0 filter on
    // findInProgressId would return nothing and the runner would idle,
    // leaving the user's delete request stranded indefinitely.
    const db = freshDb();
    insertVideo(db, "vid_stuck", "in_progress", 1);
    db.prepare(
      "UPDATE videos SET paused = 1, delete_requested = 1 WHERE id = ?"
    ).run("vid_stuck");

    expect(pickNextVideo(db)).toEqual({
      id: "vid_stuck",
      reason: "resume",
    });
  });

  it("picks a delete_requested video even when queue_state='paused'", () => {
    const db = freshDb();
    insertVideo(db, "vid_stuck", "in_progress", 1);
    db.prepare("UPDATE videos SET delete_requested = 1 WHERE id = ?").run(
      "vid_stuck"
    );
    setSetting("queue_state", "paused", db);

    expect(pickNextVideo(db)).toEqual({
      id: "vid_stuck",
      reason: "resume",
    });
  });
});

describe("tickOnce", () => {
  it("picks up a queued video, sets it to in_progress, and invokes runPipeline with its id", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1);

    const calls: string[] = [];
    const runPipeline = async (id: string) => {
      calls.push(id);
    };

    const result = await tickOnce(db, runPipeline);

    expect(calls).toEqual(["vid_a"]);
    expect(result).toBe("worked");
    const status = (
      db.prepare("SELECT status FROM videos WHERE id = ?").get("vid_a") as {
        status: string;
      }
    ).status;
    expect(status).toBe("in_progress");
  });

  it("stamps started_at on a fresh queued pickup", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1, null);

    const before = Date.now();
    await tickOnce(db, async () => {});
    const after = Date.now();

    const startedAt = (
      db.prepare("SELECT started_at FROM videos WHERE id = ?").get("vid_a") as {
        started_at: number;
      }
    ).started_at;
    expect(startedAt).not.toBeNull();
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(startedAt).toBeLessThanOrEqual(after);
  });

  it("preserves an existing started_at when resuming an in_progress video", async () => {
    const db = freshDb();
    // Resume case — video is already in_progress with a started_at from a
    // previous worker run (e.g., crashed mid-step or FreepikSessionLost).
    insertVideo(db, "vid_a", "in_progress", 1, /* startedAt */ 12345);

    await tickOnce(db, async () => {});

    const startedAt = (
      db.prepare("SELECT started_at FROM videos WHERE id = ?").get("vid_a") as {
        started_at: number;
      }
    ).started_at;
    expect(startedAt).toBe(12345);
  });

  it("does not propagate runPipeline errors (failure isolation)", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1);

    const runPipeline = async () => {
      throw new Error("step blew up");
    };

    // Must not throw out of tickOnce — the loop has to keep going.
    const result = await tickOnce(db, runPipeline);
    expect(result).toBe("worked");
  });

  it("returns 'idle-empty' when no work exists", async () => {
    const db = freshDb();

    const result = await tickOnce(db, async () => {});

    expect(result).toBe("idle-empty");
  });

  it("returns 'idle-empty' (no busy-spin) when the only in_progress video is paused and queued rows exist", async () => {
    // Without the anyInProgressExists gate in pickNextVideo, tickOnce
    // would fall through to the queued row and return "worked" — meaning
    // the run loop sleeps 0ms and spins every tick. This asserts the
    // 5s idle sleep kicks in while the in_progress video is paused.
    const db = freshDb();
    insertVideo(db, "vid_in_flight", "in_progress", 1);
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("vid_in_flight");
    insertVideo(db, "vid_waiting", "queued", 2);

    const calls: string[] = [];
    const result = await tickOnce(db, async (id) => {
      calls.push(id);
    });

    expect(result).toBe("idle-empty");
    expect(calls).toEqual([]);
  });

  it("returns 'idle-empty' when queue_state is paused, regardless of queued work", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1);
    setSetting("queue_state", "paused", db);

    const calls: string[] = [];
    const result = await tickOnce(db, async (id) => {
      calls.push(id);
    });

    expect(result).toBe("idle-empty");
    expect(calls).toEqual([]);
  });
});

describe("runLoop", () => {
  it("processes queued videos one at a time until stop signal", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1);
    insertVideo(db, "vid_b", "queued", 2);

    const processed: string[] = [];
    let remaining = 2;
    const runPipeline = async (id: string) => {
      processed.push(id);
      // Mark "done" so the FIFO scan moves on.
      db.prepare(
        "UPDATE videos SET status = 'done' WHERE id = ?"
      ).run(id);
    };

    await runLoop(db, runPipeline, {
      sleep: async () => {},
      shouldStop: () => --remaining < 0,
    });

    // Both videos picked up in FIFO order; loop stops cleanly after queue
    // drains and shouldStop returns true on the idle iteration.
    expect(processed).toEqual(["vid_a", "vid_b"]);
  });

  it("uses sleep durations matching the result type", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "queued", 1);

    const sleeps: number[] = [];
    let iterations = 0;
    const runPipeline = async (id: string) => {
      db.prepare("UPDATE videos SET status = 'done' WHERE id = ?").run(id);
    };

    await runLoop(db, runPipeline, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      shouldStop: () => ++iterations >= 3,
    });

    // Iteration 1: vid_a runs → "worked" → sleep 0 (immediate retry)
    // Iteration 2: queue empty → "idle-empty" → sleep 5000
    // Iteration 3: queue empty → "idle-empty" → sleep 5000 → stop fires
    expect(sleeps).toEqual([0, 5000, 5000]);
  });

});
