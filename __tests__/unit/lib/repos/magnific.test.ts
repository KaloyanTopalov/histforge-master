import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb } from "@/lib/db";
import * as magnificRepo from "@/lib/repos/magnific";

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

function seedMusicVideo(db: DatabaseType, id = "v_mv") {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "MV", "info", "music-video-magnific-suno", "in_progress", "music_video", 1);
}

describe("magnific repo — enqueue + lookup", () => {
  it("enqueueTask + findTaskById round-trip", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "a vibe",
      output_path: "loop_image.png",
      no_timeout: 1,
      created_at: 100,
    });
    const row = magnificRepo.findTaskById(db, id)!;
    expect(row).toMatchObject({
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "a vibe",
      output_path: "loop_image.png",
      status: "pending",
      no_timeout: 1,
      reference_image: null,
      retry_count: 0,
      external_task_id: null,
      result_url: null,
      dispatched_at: null,
      completed_at: null,
    });
  });

  it("enqueueTask defaults no_timeout to 0 and reference_image to null", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "motion",
      output_path: "loop_clip.mp4",
      created_at: 100,
    });
    const row = magnificRepo.findTaskById(db, id)!;
    expect(row.no_timeout).toBe(0);
    expect(row.reference_image).toBeNull();
  });

  it("enqueueTask stores reference_image when supplied", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "motion",
      output_path: "loop_clip.mp4",
      reference_image: "loop_image.png",
      created_at: 100,
    });
    expect(magnificRepo.findTaskById(db, id)!.reference_image).toBe(
      "loop_image.png"
    );
  });

  it("findTaskByExternalId returns the row matching external_task_id", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    const claimed = magnificRepo.takeNextTask(db, 5_000)!;
    expect(magnificRepo.findTaskByExternalId(db, claimed.external_task_id!)?.id).toBe(
      id
    );
  });
});

describe("magnific repo — findOpenTaskForVideo (keyed on video + mode)", () => {
  it("returns the pending row for the matching (video, mode)", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    expect(
      magnificRepo.findOpenTaskForVideo(db, "v_mv", "image-hitl")?.id
    ).toBe(id);
  });

  it("does not return a row for a different mode (same video)", () => {
    const db = freshDb();
    seedMusicVideo(db);
    magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    expect(
      magnificRepo.findOpenTaskForVideo(db, "v_mv", "image-to-video")
    ).toBeUndefined();
  });

  it("excludes done and failed rows", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    magnificRepo.failTask(db, id, "boom");
    expect(
      magnificRepo.findOpenTaskForVideo(db, "v_mv", "image-hitl")
    ).toBeUndefined();
  });
});

describe("magnific repo — takeNextTask (atomic claim)", () => {
  it("claims one pending row and mints external_task_id; second call returns null", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    const claim = magnificRepo.takeNextTask(db, 1_700_000)!;
    expect(claim.id).toBe(id);
    expect(claim.status).toBe("dispatched");
    expect(claim.dispatched_at).toBe(1_700_000);
    expect(claim.external_task_id).toBe(`${id}_1700000`);

    expect(magnificRepo.takeNextTask(db, 1_700_001)).toBeNull();
  });

  it("skips rows whose parent video is paused", () => {
    const db = freshDb();
    seedMusicVideo(db);
    db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("v_mv");
    magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    expect(magnificRepo.takeNextTask(db, 1_700_000)).toBeNull();
  });

  it("returns null when no pending row exists", () => {
    const db = freshDb();
    seedMusicVideo(db);
    expect(magnificRepo.takeNextTask(db, 1_700_000)).toBeNull();
  });
});

describe("magnific repo — completion + failure", () => {
  it("submitResult flips a row to done with result_url + completed_at", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    magnificRepo.takeNextTask(db, 100);
    magnificRepo.submitResult(db, id, "https://cdn/x.png", 200);

    const row = magnificRepo.findTaskById(db, id)!;
    expect(row.status).toBe("done");
    expect(row.result_url).toBe("https://cdn/x.png");
    expect(row.completed_at).toBe(200);
  });

  it("failTask flips a row to failed with error_reason", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    magnificRepo.failTask(db, id, "session expired");

    const row = magnificRepo.findTaskById(db, id)!;
    expect(row.status).toBe("failed");
    expect(row.error_reason).toBe("session expired");
  });
});

describe("magnific repo — requeue + reset", () => {
  it("requeueTask resets to pending, clears dispatch fields, preserves retry_count", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    magnificRepo.takeNextTask(db, 100);
    db.prepare("UPDATE magnific_queue SET retry_count = 3 WHERE id = ?").run(id);

    magnificRepo.requeueTask(db, id);

    const row = magnificRepo.findTaskById(db, id)!;
    expect(row.status).toBe("pending");
    expect(row.dispatched_at).toBeNull();
    expect(row.external_task_id).toBeNull();
    expect(row.retry_count).toBe(3);
  });

  it("resetAllDispatchedOnStartup flips every dispatched row back to pending", () => {
    const db = freshDb();
    seedMusicVideo(db, "v_a");
    seedMusicVideo(db, "v_b");
    const a = magnificRepo.enqueueTask(db, {
      video_id: "v_a",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    const b = magnificRepo.enqueueTask(db, {
      video_id: "v_b",
      mode: "image-to-video",
      prompt: "p",
      output_path: "loop_clip.mp4",
      created_at: 2,
    });
    magnificRepo.takeNextTask(db, 100);
    magnificRepo.takeNextTask(db, 101);

    magnificRepo.resetAllDispatchedOnStartup(db);

    expect(magnificRepo.findTaskById(db, a)!.status).toBe("pending");
    expect(magnificRepo.findTaskById(db, b)!.status).toBe("pending");
    expect(magnificRepo.findTaskById(db, a)!.dispatched_at).toBeNull();
    expect(magnificRepo.findTaskById(db, b)!.dispatched_at).toBeNull();
  });
});

describe("magnific repo — setNoTimeout / clearNoTimeout", () => {
  it("setNoTimeout flips no_timeout to 1; clearNoTimeout flips it back to 0", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "p",
      output_path: "loop_clip.mp4",
      created_at: 1,
    });
    expect(magnificRepo.findTaskById(db, id)!.no_timeout).toBe(0);

    magnificRepo.setNoTimeout(db, id);
    expect(magnificRepo.findTaskById(db, id)!.no_timeout).toBe(1);

    magnificRepo.clearNoTimeout(db, id);
    expect(magnificRepo.findTaskById(db, id)!.no_timeout).toBe(0);
  });
});

describe("magnific repo — countByStatusForVideo", () => {
  it("returns a zero-filled histogram for a (video, mode)", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const a = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      created_at: 1,
    });
    const b = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image_2.png",
      created_at: 2,
    });
    magnificRepo.takeNextTask(db, 100); // a → dispatched
    magnificRepo.submitResult(db, a, "https://cdn/a.png", 200);
    magnificRepo.failTask(db, b, "boom");

    const counts = magnificRepo.countByStatusForVideo(db, "v_mv", "image-hitl");
    expect(counts).toEqual({
      pending: 0,
      dispatched: 0,
      done: 1,
      failed: 1,
    });

    // Other mode reports all zeros.
    const empty = magnificRepo.countByStatusForVideo(
      db,
      "v_mv",
      "image-to-video"
    );
    expect(empty).toEqual({ pending: 0, dispatched: 0, done: 0, failed: 0 });
  });
});

describe("magnific repo — listStaleDispatched", () => {
  it("returns dispatched rows older than maxAgeSec when onlyNoTimeoutZero is true", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const stale = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "p",
      output_path: "loop_clip.mp4",
      created_at: 1,
    });
    magnificRepo.takeNextTask(db, 1_000); // dispatched_at = 1000

    // 30 min age cap (1800 s); nowUnix = 5000 → cutoff = 3200, dispatched_at=1000 < cutoff.
    const rows = magnificRepo.listStaleDispatched(db, 1_800, 5_000, true);
    expect(rows.map((r) => r.id)).toEqual([stale]);
  });

  it("excludes rows with no_timeout=1 when onlyNoTimeoutZero is true", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const hitl = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      no_timeout: 1,
      created_at: 1,
    });
    magnificRepo.takeNextTask(db, 1_000);

    const rows = magnificRepo.listStaleDispatched(db, 1_800, 5_000, true);
    expect(rows.map((r) => r.id)).not.toContain(hitl);
  });

  it("includes no_timeout=1 rows when onlyNoTimeoutZero is false", () => {
    const db = freshDb();
    seedMusicVideo(db);
    const hitl = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "p",
      output_path: "loop_image.png",
      no_timeout: 1,
      created_at: 1,
    });
    magnificRepo.takeNextTask(db, 1_000);

    const rows = magnificRepo.listStaleDispatched(db, 1_800, 5_000, false);
    expect(rows.map((r) => r.id)).toContain(hitl);
  });

  it("returns nothing when no dispatched row is older than the cutoff", () => {
    const db = freshDb();
    seedMusicVideo(db);
    magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "p",
      output_path: "loop_clip.mp4",
      created_at: 1,
    });
    magnificRepo.takeNextTask(db, 4_500); // dispatched_at = 4500

    // 30 min age cap (1800 s); nowUnix = 5000 → cutoff = 3200, dispatched_at=4500 >= cutoff.
    expect(magnificRepo.listStaleDispatched(db, 1_800, 5_000, true)).toEqual(
      []
    );
  });
});
