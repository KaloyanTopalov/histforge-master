import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import type { Video } from "@/types";

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

/**
 * Build a Video row with sensible defaults, overridable per-test. Note
 * that `topic_id` is gone in the post-overhaul schema — callers supply
 * `workflow_id` + `topic_info` instead.
 */
function sampleVideo(overrides: Partial<Video> = {}): Video {
  return {
    id: "v1",
    title: "T",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "queued",
    current_step: null,
    failed_step: null,
    failed_reason: null,
    started_at: null,
    finished_at: null,
    output_path: null,
    delete_requested: 0,
    paused: 0,
    deferred_until: null,
    provided_script: null,
    visual_style_id: null,
    visual_style_snapshot: null,
    kind: "narrative",
    magnific_image_prompt: null,
    magnific_motion_prompt: null,
    suno_style_prompt: null,
    song_count: null,
    repeat_factor: null,
    image_chunk_target_seconds: null,
    image_chunk_min_seconds: null,
    image_chunk_max_seconds: null,
    magnific_project_id: null,
    created_at: 100,
    ...overrides,
  };
}

function seed(db: DatabaseType, video: Video): Video {
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, current_step, failed_step, failed_reason, started_at, finished_at, output_path, delete_requested, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(
    video.id,
    video.title,
    video.topic_info,
    video.workflow_id,
    video.status,
    video.current_step,
    video.failed_step,
    video.failed_reason,
    video.started_at,
    video.finished_at,
    video.output_path,
    video.delete_requested,
    video.created_at
  );
  return video;
}

describe("videosRepo.findById / existsById", () => {
  it("findById returns the row, existsById returns true", () => {
    const db = freshDb();
    seed(db, sampleVideo());
    expect(videosRepo.findById(db, "v1")?.id).toBe("v1");
    expect(videosRepo.existsById(db, "v1")).toBe(true);
  });

  it("findById returns undefined, existsById returns false on missing rows", () => {
    const db = freshDb();
    expect(videosRepo.findById(db, "v_nope")).toBeUndefined();
    expect(videosRepo.existsById(db, "v_nope")).toBe(false);
  });
});

describe("videosRepo.list", () => {
  it("returns rows ordered by created_at DESC", () => {
    const db = freshDb();
    seed(db, sampleVideo({ id: "v_a", created_at: 10 }));
    seed(db, sampleVideo({ id: "v_b", created_at: 30 }));
    seed(db, sampleVideo({ id: "v_c", created_at: 20 }));
    expect(videosRepo.list(db).map((v) => v.id)).toEqual([
      "v_b",
      "v_c",
      "v_a",
    ]);
  });
});

describe("videosRepo mutations", () => {
  it("markFailed sets status, failed_step, failed_reason, finished_at; clears current_step", () => {
    const db = freshDb();
    seed(db, sampleVideo({ current_step: "voiceover" }));
    videosRepo.markFailed(db, "v1", "voiceover", "boom", 500);
    const row = videosRepo.findById(db, "v1")!;
    expect(row).toMatchObject({
      status: "failed",
      failed_step: "voiceover",
      failed_reason: "boom",
      finished_at: 500,
      current_step: null,
    });
  });

  it("markDone sets status, output_path, finished_at, nulls current_step", () => {
    const db = freshDb();
    seed(db, sampleVideo({ current_step: "render" }));
    videosRepo.markDone(db, "v1", "projects/v1/final.mp4", 999);
    const row = videosRepo.findById(db, "v1")!;
    expect(row).toMatchObject({
      status: "done",
      output_path: "projects/v1/final.mp4",
      finished_at: 999,
      current_step: null,
    });
  });

  it("clearFailure nulls failure fields without touching status", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({
        status: "failed",
        failed_step: "voiceover",
        failed_reason: "boom",
        finished_at: 500,
      })
    );
    videosRepo.clearFailure(db, "v1");
    const row = videosRepo.findById(db, "v1")!;
    expect(row).toMatchObject({
      status: "failed", // unchanged — caller sets queued separately
      failed_step: null,
      failed_reason: null,
      finished_at: null,
    });
  });

  it("resetToQueued nulls every per-run field and flips status", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({
        status: "done",
        current_step: null,
        failed_step: null,
        failed_reason: null,
        started_at: 42,
        finished_at: 999,
        output_path: "projects/v1/final.mp4",
      })
    );
    videosRepo.resetToQueued(db, "v1");
    const row = videosRepo.findById(db, "v1")!;
    expect(row).toMatchObject({
      status: "queued",
      current_step: null,
      failed_step: null,
      failed_reason: null,
      started_at: null,
      finished_at: null,
      output_path: null,
    });
  });

  it("resetToQueued also clears paused so restart actually runs the video", () => {
    // A video paused mid-flight can still reach a terminal state (the
    // pipeline's between-step pause check leaves status='in_progress',
    // but a step that fails before the next boundary still calls
    // markFailed). Without clearing paused here, Restart would drop the
    // row into queued+paused=1 and the runner's paused=0 filter would
    // skip it — restart button looks broken.
    const db = freshDb();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_paused_done", "T", "info", "comfyui", "done", 1, 1);
    videosRepo.resetToQueued(db, "v_paused_done");
    const row = videosRepo.findById(db, "v_paused_done")!;
    expect(row.status).toBe("queued");
    expect(row.paused).toBe(0);
  });

  it("markInProgress preserves an existing started_at (resume) but sets it on first pickup", () => {
    const db = freshDb();
    seed(db, sampleVideo({ id: "v_fresh" }));
    seed(
      db,
      sampleVideo({ id: "v_resume", started_at: 42 })
    );

    videosRepo.markInProgress(db, "v_fresh", 1000);
    videosRepo.markInProgress(db, "v_resume", 2000);

    expect(videosRepo.findById(db, "v_fresh")!.started_at).toBe(1000);
    // resume: original started_at preserved.
    expect(videosRepo.findById(db, "v_resume")!.started_at).toBe(42);
    // but status flipped in both cases.
    expect(videosRepo.findById(db, "v_fresh")!.status).toBe("in_progress");
    expect(videosRepo.findById(db, "v_resume")!.status).toBe("in_progress");
  });

  it("findOldestQueuedId returns the oldest queued video by created_at", () => {
    const db = freshDb();
    seed(db, sampleVideo({ id: "v_2", created_at: 2 }));
    seed(db, sampleVideo({ id: "v_1", created_at: 1 }));
    seed(db, sampleVideo({ id: "v_3", created_at: 3 }));
    expect(videosRepo.findOldestQueuedId(db)).toBe("v_1");
  });

  it("findOldestQueuedId returns undefined when no queued videos exist", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "done" }));
    expect(videosRepo.findOldestQueuedId(db)).toBeUndefined();
  });

  it("findInProgressId returns the in_progress video's id, or undefined", () => {
    const db = freshDb();
    expect(videosRepo.findInProgressId(db)).toBeUndefined();
    seed(db, sampleVideo({ status: "in_progress" }));
    expect(videosRepo.findInProgressId(db)).toBe("v1");
  });
});

// ─── New-schema helpers (post-overhaul) ──────────────────────────────
// Uses direct SQL bypassing the (broken) sampleVideo/seed helpers above.
function seedNewSchemaVideo(
  db: DatabaseType,
  overrides: {
    id?: string;
    status?: string;
    delete_requested?: 0 | 1;
  } = {}
): string {
  const id = overrides.id ?? "v1";
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, status, delete_requested, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    id,
    "Title",
    "info",
    "comfyui",
    overrides.status ?? "in_progress",
    overrides.delete_requested ?? 0,
    1
  );
  return id;
}

describe("videosRepo.readDeleteRequested", () => {
  it("returns false when the video's delete_requested flag is 0", () => {
    const db = freshDb();
    seedNewSchemaVideo(db);
    expect(videosRepo.readDeleteRequested(db, "v1")).toBe(false);
  });

  it("returns true when the video's delete_requested flag is 1", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { delete_requested: 1 });
    expect(videosRepo.readDeleteRequested(db, "v1")).toBe(true);
  });

  it("returns false when the video does not exist", () => {
    const db = freshDb();
    expect(videosRepo.readDeleteRequested(db, "nope")).toBe(false);
  });
});

describe("videosRepo.deleteVideoFullyRemoved", () => {
  it("deletes video_steps rows and the videos row atomically", () => {
    const db = freshDb();
    seedNewSchemaVideo(db);
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, ?)"
    ).run("v1", "research_outline", "done");
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, ?)"
    ).run("v1", "write_hook", "pending");

    videosRepo.deleteVideoFullyRemoved(db, "v1");

    expect(videosRepo.findById(db, "v1")).toBeUndefined();
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM video_steps WHERE video_id = ?")
      .get("v1") as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("leaves other videos and their steps untouched", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { id: "v1" });
    seedNewSchemaVideo(db, { id: "v2" });
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, ?)"
    ).run("v2", "research_outline", "done");

    videosRepo.deleteVideoFullyRemoved(db, "v1");

    expect(videosRepo.findById(db, "v2")).toBeDefined();
    const v2Steps = db
      .prepare("SELECT COUNT(*) AS n FROM video_steps WHERE video_id = ?")
      .get("v2") as { n: number };
    expect(v2Steps.n).toBe(1);
  });
});

describe("videosRepo.createNewVideo", () => {
  it("inserts a row with status='new' and the supplied fields", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "Title",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 42,
    });
    const row = videosRepo.findById(db, "v1");
    expect(row).toMatchObject({
      id: "v1",
      title: "Title",
      topic_info: "info",
      workflow_id: "comfyui",
      status: "new",
      created_at: 42,
      delete_requested: 0,
    });
  });

  it("persists provided_script when supplied; defaults to null otherwise", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_with",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      provided_script: "Hello, world.",
      created_at: 1,
    });
    videosRepo.createNewVideo(db, {
      id: "v_without",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 2,
    });
    expect(videosRepo.findById(db, "v_with")!.provided_script).toBe(
      "Hello, world."
    );
    expect(videosRepo.findById(db, "v_without")!.provided_script).toBeNull();
  });

  // Plan 1 Phase 1.1 Task 5: createNewVideo accepts a `kind` discriminator
  // and the four music-video-only typed columns. The repo enforces the
  // per-kind required/forbidden invariants at the function boundary so the
  // API route validator can stay thin.

  it("inserts a narrative row with kind='narrative' by default; music-video columns land null", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_default_narrative",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 10,
    });
    const row = videosRepo.findById(db, "v_default_narrative")!;
    expect(row.kind).toBe("narrative");
    expect(row.magnific_image_prompt).toBeNull();
    expect(row.suno_style_prompt).toBeNull();
    expect(row.song_count).toBeNull();
    expect(row.repeat_factor).toBeNull();
  });

  it("inserts a music_video row with the five typed columns populated", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_mv",
      title: "MV title",
      workflow_id: "music-video-magnific-suno",
      kind: "music_video",
      magnific_image_prompt: "A cosmic landscape",
      magnific_motion_prompt: "slow pan across nebula",
      suno_style_prompt: "Synthwave",
      song_count: 5,
      repeat_factor: 3,
      created_at: 20,
    });
    const row = videosRepo.findById(db, "v_mv")!;
    expect(row.kind).toBe("music_video");
    expect(row.magnific_image_prompt).toBe("A cosmic landscape");
    expect(row.magnific_motion_prompt).toBe("slow pan across nebula");
    expect(row.suno_style_prompt).toBe("Synthwave");
    expect(row.song_count).toBe(5);
    expect(row.repeat_factor).toBe(3);
  });

  it("throws when kind='music_video' is missing any of the four typed fields", () => {
    const db = freshDb();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_mv_missing",
        title: "MV",
        workflow_id: "music-video-magnific-suno",
        kind: "music_video",
        // magnific_image_prompt missing
        magnific_motion_prompt: "slow loop",
        suno_style_prompt: "Synthwave",
        song_count: 5,
        repeat_factor: 3,
        created_at: 30,
      })
    ).toThrow();
  });

  // Plan — Magnific motion-prompt field (Task 1.2): magnific_motion_prompt
  // joins the existing four music-video columns as required-for-music_video.
  it("throws when kind='music_video' is missing magnific_motion_prompt", () => {
    const db = freshDb();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_mv_no_motion",
        title: "MV",
        workflow_id: "music-video-magnific-suno",
        kind: "music_video",
        magnific_image_prompt: "still image",
        // magnific_motion_prompt missing
        suno_style_prompt: "Synthwave",
        song_count: 5,
        repeat_factor: 3,
        created_at: 31,
      })
    ).toThrow();
  });

  it("throws when kind='music_video' is passed topic_info / provided_script / visual_style_id", () => {
    const db = freshDb();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_mv_with_topic",
        title: "MV",
        topic_info: "should not be set",
        workflow_id: "music-video-magnific-suno",
        kind: "music_video",
        magnific_image_prompt: "p",
        suno_style_prompt: "s",
        song_count: 1,
        repeat_factor: 1,
        created_at: 40,
      })
    ).toThrow();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_mv_with_script",
        title: "MV",
        workflow_id: "music-video-magnific-suno",
        kind: "music_video",
        magnific_image_prompt: "p",
        suno_style_prompt: "s",
        song_count: 1,
        repeat_factor: 1,
        provided_script: "no",
        created_at: 41,
      })
    ).toThrow();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_mv_with_style",
        title: "MV",
        workflow_id: "music-video-magnific-suno",
        kind: "music_video",
        magnific_image_prompt: "p",
        suno_style_prompt: "s",
        song_count: 1,
        repeat_factor: 1,
        visual_style_id: "vs1",
        created_at: 42,
      })
    ).toThrow();
  });

  it("throws when kind='narrative' is passed any of the five music-video fields", () => {
    const db = freshDb();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_narr_with_mv",
        title: "T",
        topic_info: "info",
        workflow_id: "comfyui",
        kind: "narrative",
        magnific_image_prompt: "leaked",
        created_at: 50,
      })
    ).toThrow();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_narr_with_motion",
        title: "T",
        topic_info: "info",
        workflow_id: "comfyui",
        kind: "narrative",
        magnific_motion_prompt: "leaked",
        created_at: 51,
      })
    ).toThrow();
  });

  it("throws when kind='narrative' is passed empty topic_info", () => {
    const db = freshDb();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v_narr_empty_topic",
        title: "T",
        topic_info: "",
        workflow_id: "comfyui",
        kind: "narrative",
        created_at: 60,
      })
    ).toThrow();
  });
});

describe("videosRepo.updateVideoDraft", () => {
  it("updates only supplied fields on a status='new' row", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "new" });
    videosRepo.updateVideoDraft(db, "v1", {
      title: "Edited",
      workflow_id: "google-flow",
    });
    const row = videosRepo.findById(db, "v1")!;
    expect(row.title).toBe("Edited");
    expect(row.workflow_id).toBe("google-flow");
    // topic_info untouched
    expect(row.topic_info).toBe("info");
  });

  it("no-ops when the video is past 'queued' (in_progress / failed / done)", () => {
    // The repo guard widened from `status='new'` to
    // `status IN ('new','queued')` to match the API route's existing
    // 409 contract. Patches still no-op on terminal/in-flight states.
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "in_progress" });
    videosRepo.updateVideoDraft(db, "v1", { title: "Edited" });
    expect(videosRepo.findById(db, "v1")!.title).toBe("Title");
  });

  it("no-ops for an empty patch", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "new" });
    expect(() => videosRepo.updateVideoDraft(db, "v1", {})).not.toThrow();
    expect(videosRepo.findById(db, "v1")!.title).toBe("Title");
  });

  // Plan — Magnific motion-prompt field (Task 1.2): updateVideoDraft must
  // accept magnific_motion_prompt and persist it on a draft row, mirroring
  // the existing magnific_image_prompt round-trip.
  it("round-trips magnific_motion_prompt on a status='new' row", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "new" });
    videosRepo.updateVideoDraft(db, "v1", {
      magnific_motion_prompt: "aggressive push-in",
    });
    expect(videosRepo.findById(db, "v1")!.magnific_motion_prompt).toBe(
      "aggressive push-in"
    );
  });
});

describe("videosRepo per-video pause helpers", () => {
  it("setPaused / clearPaused flip the flag and readPaused reports it", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "in_progress" });

    expect(videosRepo.readPaused(db, "v1")).toBe(false);

    videosRepo.setPaused(db, "v1");
    expect(videosRepo.readPaused(db, "v1")).toBe(true);

    videosRepo.clearPaused(db, "v1");
    expect(videosRepo.readPaused(db, "v1")).toBe(false);
  });

  it("readPaused returns false for a missing video", () => {
    const db = freshDb();
    expect(videosRepo.readPaused(db, "nope")).toBe(false);
  });
});

describe("videosRepo.findOldestQueuedId — paused filter", () => {
  it("skips paused queued videos", () => {
    const db = freshDb();
    // Older row is paused — must be skipped in favour of the younger unpaused one.
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_old_paused", "T", "info", "comfyui", "queued", 1, 1);
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_new_run", "T", "info", "comfyui", "queued", 0, 5);

    expect(videosRepo.findOldestQueuedId(db)).toBe("v_new_run");
  });

  it("returns undefined when every queued row is paused", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("vp", "T", "info", "comfyui", "queued", 1, 1);
    expect(videosRepo.findOldestQueuedId(db)).toBeUndefined();
  });
});

describe("videosRepo.findInProgressId — paused filter", () => {
  it("returns undefined when the only in_progress video is paused", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_p", "T", "info", "comfyui", "in_progress", 1, 1);
    expect(videosRepo.findInProgressId(db)).toBeUndefined();
  });

  it("returns the in_progress id when not paused", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_r", "T", "info", "comfyui", "in_progress", 0, 1);
    expect(videosRepo.findInProgressId(db)).toBe("v_r");
  });
});

describe("videosRepo.anyInProgressExists — unfiltered", () => {
  it("returns true when a paused in_progress row exists", () => {
    // Preserves the one-at-a-time invariant: a paused in_progress row
    // must still count so the runner idles rather than falling through
    // to pick a queued video.
    const db = freshDb();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_p", "T", "info", "comfyui", "in_progress", 1, 1);
    expect(videosRepo.anyInProgressExists(db)).toBe(true);
  });

  it("returns false when no in_progress rows exist at all", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "queued" });
    expect(videosRepo.anyInProgressExists(db)).toBe(false);
  });
});

describe("videosRepo.setDeleteRequested", () => {
  it("sets delete_requested=1 for the target video", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "in_progress" });
    videosRepo.setDeleteRequested(db, "v1");
    expect(videosRepo.readDeleteRequested(db, "v1")).toBe(true);
  });
});

describe("videosRepo.findDeleteRequestedId", () => {
  it("returns the id of a video with delete_requested=1", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, {
      status: "in_progress",
      delete_requested: 1,
    });
    expect(videosRepo.findDeleteRequestedId(db)).toBe("v1");
  });

  it("returns undefined when no video has delete_requested=1", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "in_progress", delete_requested: 0 });
    expect(videosRepo.findDeleteRequestedId(db)).toBeUndefined();
  });

  it("still returns a paused + deferred in_progress video (no gating filters — delete wins)", () => {
    // This is the point of the helper: gates that keep a video from
    // being picked for normal processing must not also strand a
    // delete request.
    const db = freshDb();
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, deferred_until, delete_requested, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(
      "v_stuck",
      "T",
      "info",
      "comfyui",
      "in_progress",
      1,
      future,
      1,
      1
    );
    expect(videosRepo.findDeleteRequestedId(db)).toBe("v_stuck");
  });
});

describe("videosRepo.transitionNewToQueued", () => {
  it("transitions a new video to queued", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "new" });
    const result = videosRepo.transitionNewToQueued(db, "v1");
    expect(result.changes).toBe(1);
    expect(videosRepo.findById(db, "v1")!.status).toBe("queued");
  });

  it("no-ops when the video is not in status='new'", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "queued" });
    const result = videosRepo.transitionNewToQueued(db, "v1");
    expect(result.changes).toBe(0);
    expect(videosRepo.findById(db, "v1")!.status).toBe("queued");
  });
});

describe("videosRepo.transitionAllNewToQueued", () => {
  it("flips every new video to queued and returns the list of flipped ids", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { id: "n1", status: "new" });
    seedNewSchemaVideo(db, { id: "n2", status: "new" });
    seedNewSchemaVideo(db, { id: "q1", status: "queued" });
    seedNewSchemaVideo(db, { id: "d1", status: "done" });

    const ids = videosRepo.transitionAllNewToQueued(db);
    expect(Array.isArray(ids)).toBe(true);
    // Caller (bulk-start route) reads `result.length` for the count field.
    expect(ids).toHaveLength(2);
    expect([...ids].sort()).toEqual(["n1", "n2"]);

    expect(videosRepo.findById(db, "n1")!.status).toBe("queued");
    expect(videosRepo.findById(db, "n2")!.status).toBe("queued");
    expect(videosRepo.findById(db, "q1")!.status).toBe("queued");
    expect(videosRepo.findById(db, "d1")!.status).toBe("done");
  });

  it("returns an empty array when there are no new videos", () => {
    const db = freshDb();
    seedNewSchemaVideo(db, { status: "queued" });
    expect(videosRepo.transitionAllNewToQueued(db)).toEqual([]);
  });
});

// ─── Snapshot lifecycle (Invariant B) ────────────────────────────────
// `videos.workflow_snapshot` is the per-video pinned JSON of the
// workflow row + step list, written at create / queue time. Pipeline
// reads only the snapshot, so an edit to the live workflow row does not
// affect any video already past `queued`.

describe("snapshot capture — createNewVideo", () => {
  it("writes a non-null workflow_snapshot to the row", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    const row = db
      .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
      .get("v1") as { workflow_snapshot: string | null };
    expect(row.workflow_snapshot).not.toBeNull();
    const parsed = JSON.parse(row.workflow_snapshot!);
    expect(parsed.workflow_id).toBe("comfyui");
    expect(parsed.steps.map((s: { step_name: string }) => s.step_name)).toEqual(
      ["research_outline", "write_hook", "write_chapters"]
    );
  });

  it("throws (no row inserted) when workflow_id does not resolve", () => {
    const db = freshDb();
    expect(() =>
      videosRepo.createNewVideo(db, {
        id: "v1",
        title: "T",
        topic_info: "info",
        workflow_id: "ghost",
        created_at: 1,
      })
    ).toThrow(/ghost/);
    expect(videosRepo.findById(db, "v1")).toBeUndefined();
  });
});

describe("snapshot capture — updateVideoDraft", () => {
  it("refreshes the snapshot when workflow_id changes on a 'new' video", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.updateVideoDraft(db, "v1", { workflow_id: "google-flow" });
    const row = db
      .prepare("SELECT workflow_id, workflow_snapshot FROM videos WHERE id = ?")
      .get("v1") as { workflow_id: string; workflow_snapshot: string };
    expect(row.workflow_id).toBe("google-flow");
    const parsed = JSON.parse(row.workflow_snapshot);
    expect(parsed.workflow_id).toBe("google-flow");
    expect(parsed.image_provider).toBe("google_flow");
  });

  it("also accepts patches on 'queued' videos (widened guard)", () => {
    // Spec Task 5: the SQL guard widens from `status='new'` to
    // `status IN ('new','queued')` so the repo matches the API route's
    // existing 409 contract.
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v1");
    expect(videosRepo.findById(db, "v1")!.status).toBe("queued");

    videosRepo.updateVideoDraft(db, "v1", { workflow_id: "google-flow" });
    const row = db
      .prepare("SELECT workflow_id, workflow_snapshot FROM videos WHERE id = ?")
      .get("v1") as { workflow_id: string; workflow_snapshot: string };
    expect(row.workflow_id).toBe("google-flow");
    expect(JSON.parse(row.workflow_snapshot).workflow_id).toBe("google-flow");
  });

  it("leaves snapshot untouched when only non-workflow fields change", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    const before = db
      .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
      .get("v1") as { workflow_snapshot: string };
    videosRepo.updateVideoDraft(db, "v1", { title: "Edited" });
    const after = db
      .prepare("SELECT workflow_snapshot, title FROM videos WHERE id = ?")
      .get("v1") as { workflow_snapshot: string; title: string };
    expect(after.title).toBe("Edited");
    expect(after.workflow_snapshot).toBe(before.workflow_snapshot);
  });

  it("rejects patches on in_progress / failed / done videos", () => {
    const db = freshDb();
    for (const status of ["in_progress", "failed", "done"]) {
      videosRepo.createNewVideo(db, {
        id: `v_${status}`,
        title: "T",
        topic_info: "info",
        workflow_id: "comfyui",
        created_at: 1,
      });
      db.prepare("UPDATE videos SET status = ? WHERE id = ?").run(
        status,
        `v_${status}`
      );

      videosRepo.updateVideoDraft(db, `v_${status}`, { title: "Edited" });
      const row = videosRepo.findById(db, `v_${status}`)!;
      expect(row.title).toBe("T");
    }
  });
});

describe("snapshot capture — transitionNewToQueued", () => {
  it("re-resolves the snapshot from the current workflow row", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });

    // Simulate a workflow row edit between create and queue. (Phase 1
    // has no edit API yet, but the lifecycle rule still holds.)
    db.prepare("UPDATE workflows SET version = 99 WHERE id = ?").run("comfyui");

    videosRepo.transitionNewToQueued(db, "v1");
    const row = db
      .prepare("SELECT status, workflow_snapshot FROM videos WHERE id = ?")
      .get("v1") as { status: string; workflow_snapshot: string };
    expect(row.status).toBe("queued");
    const parsed = JSON.parse(row.workflow_snapshot);
    expect(parsed.version).toBe(99);
  });
});

describe("snapshot capture — transitionAllNewToQueued", () => {
  it("re-resolves the snapshot for every flipped row", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "n1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.createNewVideo(db, {
      id: "n2",
      title: "T",
      topic_info: "info",
      workflow_id: "google-flow",
      created_at: 2,
    });

    db.prepare("UPDATE workflows SET version = 7 WHERE id = ?").run("comfyui");
    db.prepare("UPDATE workflows SET version = 11 WHERE id = ?").run(
      "google-flow"
    );

    const ids = videosRepo.transitionAllNewToQueued(db);
    expect(ids).toHaveLength(2);

    const rows = db
      .prepare(
        "SELECT id, status, workflow_snapshot FROM videos ORDER BY id"
      )
      .all() as Array<{
      id: string;
      status: string;
      workflow_snapshot: string;
    }>;
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    const byId = Object.fromEntries(
      rows.map((r) => [r.id, JSON.parse(r.workflow_snapshot)])
    );
    expect(byId.n1.version).toBe(7);
    expect(byId.n2.version).toBe(11);
  });
});

describe("videosRepo.findOldestQueuedId — deferred filter", () => {
  it("skips queued videos whose deferred_until is in the future", () => {
    const db = freshDb();
    const future = Math.floor(Date.now() / 1000) + 3600;
    // Older row is deferred to the future — must be skipped in favor of
    // the younger non-deferred one.
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, deferred_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("v_old_deferred", "T", "info", "comfyui", "queued", 0, future, 1);
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_new_run", "T", "info", "comfyui", "queued", 0, 5);

    expect(videosRepo.findOldestQueuedId(db)).toBe("v_new_run");
  });

  it("returns videos whose deferred_until is in the past (stale defer)", () => {
    const db = freshDb();
    const past = Math.floor(Date.now() / 1000) - 60;
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, deferred_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("v_stale", "T", "info", "comfyui", "queued", 0, past, 1);
    expect(videosRepo.findOldestQueuedId(db)).toBe("v_stale");
  });

  it("returns videos whose deferred_until is NULL", () => {
    const db = freshDb();
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_null", "T", "info", "comfyui", "queued", 0, 1);
    expect(videosRepo.findOldestQueuedId(db)).toBe("v_null");
  });
});

describe("videosRepo.findInProgressId — deferred filter", () => {
  it("returns undefined when the only in_progress video is deferred to the future", () => {
    const db = freshDb();
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, deferred_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("v_d", "T", "info", "comfyui", "in_progress", 0, future, 1);
    expect(videosRepo.findInProgressId(db)).toBeUndefined();
  });

  it("returns the in_progress id once the deferred_until has passed", () => {
    const db = freshDb();
    const past = Math.floor(Date.now() / 1000) - 1;
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, deferred_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("v_ok", "T", "info", "comfyui", "in_progress", 0, past, 1);
    expect(videosRepo.findInProgressId(db)).toBe("v_ok");
  });
});

describe("videosRepo.anyInProgressExists — deferred NOT filtered", () => {
  it("still returns true for a deferred in_progress video", () => {
    // anyInProgressExists is deliberately unfiltered: it enforces the
    // one-at-a-time invariant. A deferred in_progress video must still
    // count so the runner idles rather than picking a queued row.
    const db = freshDb();
    const future = Math.floor(Date.now() / 1000) + 3600;
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, paused, deferred_until, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run("v_d", "T", "info", "comfyui", "in_progress", 0, future, 1);
    expect(videosRepo.anyInProgressExists(db)).toBe(true);
  });
});

describe("videosRepo defer lifecycle", () => {
  it("setDeferredUntil writes the timestamp, clearDeferredUntil clears it", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress" }));

    videosRepo.setDeferredUntil(db, "v1", 1_800_000);
    expect(videosRepo.findById(db, "v1")!.deferred_until).toBe(1_800_000);

    videosRepo.clearDeferredUntil(db, "v1");
    expect(videosRepo.findById(db, "v1")!.deferred_until).toBeNull();
  });

  it("setDeferredUntil(null) also clears the value", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress" }));
    videosRepo.setDeferredUntil(db, "v1", 1_800_000);
    videosRepo.setDeferredUntil(db, "v1", null);
    expect(videosRepo.findById(db, "v1")!.deferred_until).toBeNull();
  });
});

describe("videosRepo.setMagnificProjectId", () => {
  const UUID = "329f5c65-05dc-441d-8515-89b8d6915006";

  it("persists a Project UUID and is idempotent on repeat", () => {
    const db = freshDb();
    seed(db, sampleVideo());
    expect(videosRepo.findById(db, "v1")!.magnific_project_id).toBeNull();

    videosRepo.setMagnificProjectId(db, "v1", UUID);
    expect(videosRepo.findById(db, "v1")!.magnific_project_id).toBe(UUID);

    // Re-setting the same value is a no-op (row-level idempotent UPDATE).
    videosRepo.setMagnificProjectId(db, "v1", UUID);
    expect(videosRepo.findById(db, "v1")!.magnific_project_id).toBe(UUID);
  });

  it("setMagnificProjectId(null) clears the value", () => {
    const db = freshDb();
    seed(db, sampleVideo());
    videosRepo.setMagnificProjectId(db, "v1", UUID);
    videosRepo.setMagnificProjectId(db, "v1", null);
    expect(videosRepo.findById(db, "v1")!.magnific_project_id).toBeNull();
  });
});

// ─── Visual-style snapshot lifecycle ─────────────────────────────────
// `videos.visual_style_snapshot` mirrors `workflow_snapshot`: pinned at
// create, re-pinned on draft-edit when `visual_style_id` changes, and
// re-pinned at queue time from the live FK. Decision 13: if the gallery
// row was deleted between create and queue, the snapshot is NULL — step
// 09 reads that as the empty "Default (no style)" prompt.

function seedVisualStyle(
  db: DatabaseType,
  id: string,
  title = "Cinematic noir",
  prompt = "noir style prompt"
): void {
  const now = Date.now();
  db.prepare(
    "INSERT INTO visual_styles (id, title, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(id, title, prompt, now, now);
}

describe("visual-style snapshot capture — createNewVideo", () => {
  it("pins a snapshot JSON when visual_style_id is supplied", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1", "Cinematic noir", "noir style prompt");
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });
    const row = videosRepo.findById(db, "v1")!;
    expect(row.visual_style_id).toBe("vs1");
    expect(row.visual_style_snapshot).not.toBeNull();
    const parsed = JSON.parse(row.visual_style_snapshot!);
    expect(parsed).toEqual({
      id: "vs1",
      title: "Cinematic noir",
      prompt: "noir style prompt",
    });
  });

  it("writes NULL FK and NULL snapshot when visual_style_id is omitted", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    const row = videosRepo.findById(db, "v1")!;
    expect(row.visual_style_id).toBeNull();
    expect(row.visual_style_snapshot).toBeNull();
  });
});

describe("visual-style snapshot capture — updateVideoDraft", () => {
  it("re-pins the snapshot when visual_style_id changes", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1", "Noir", "noir");
    seedVisualStyle(db, "vs2", "Sunlit", "sunlit");
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });

    videosRepo.updateVideoDraft(db, "v1", { visual_style_id: "vs2" });
    const row = videosRepo.findById(db, "v1")!;
    expect(row.visual_style_id).toBe("vs2");
    const parsed = JSON.parse(row.visual_style_snapshot!);
    expect(parsed.id).toBe("vs2");
    expect(parsed.title).toBe("Sunlit");
  });

  it("clears the snapshot when visual_style_id is set to null", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1");
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });

    videosRepo.updateVideoDraft(db, "v1", { visual_style_id: null });
    const row = videosRepo.findById(db, "v1")!;
    expect(row.visual_style_id).toBeNull();
    expect(row.visual_style_snapshot).toBeNull();
  });

  it("leaves snapshot untouched when only non-style fields change", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1");
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });
    const before = videosRepo.findById(db, "v1")!.visual_style_snapshot;
    videosRepo.updateVideoDraft(db, "v1", { title: "Edited" });
    const after = videosRepo.findById(db, "v1")!;
    expect(after.title).toBe("Edited");
    expect(after.visual_style_snapshot).toBe(before);
  });
});

describe("visual-style snapshot capture — transitionNewToQueued", () => {
  it("re-pins the snapshot from the live FK at queue time", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1", "Original title", "original prompt");
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });
    // Edit the live row between create and queue.
    db.prepare(
      "UPDATE visual_styles SET title = ?, prompt = ? WHERE id = ?"
    ).run("Edited title", "edited prompt", "vs1");

    videosRepo.transitionNewToQueued(db, "v1");
    const row = videosRepo.findById(db, "v1")!;
    expect(row.status).toBe("queued");
    const parsed = JSON.parse(row.visual_style_snapshot!);
    expect(parsed.title).toBe("Edited title");
    expect(parsed.prompt).toBe("edited prompt");
  });

  it("writes NULL snapshot when the FK row was deleted before queue (decision 13)", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1");
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });
    // Operator deletes the gallery row before queue — FK is nulled by
    // ON DELETE SET NULL, so the live FK at queue time is null.
    db.prepare("DELETE FROM visual_styles WHERE id = ?").run("vs1");

    videosRepo.transitionNewToQueued(db, "v1");
    const row = videosRepo.findById(db, "v1")!;
    expect(row.status).toBe("queued");
    expect(row.visual_style_id).toBeNull();
    expect(row.visual_style_snapshot).toBeNull();
  });

  it("leaves snapshot NULL when the video had no style to begin with", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v1");
    const row = videosRepo.findById(db, "v1")!;
    expect(row.status).toBe("queued");
    expect(row.visual_style_snapshot).toBeNull();
  });
});

describe("visual-style snapshot capture — transitionAllNewToQueued", () => {
  it("re-pins the snapshot for every flipped row", () => {
    const db = freshDb();
    seedVisualStyle(db, "vs1", "S1", "p1");
    seedVisualStyle(db, "vs2", "S2", "p2");
    videosRepo.createNewVideo(db, {
      id: "n1",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs1",
      created_at: 1,
    });
    videosRepo.createNewVideo(db, {
      id: "n2",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      visual_style_id: "vs2",
      created_at: 2,
    });

    db.prepare("UPDATE visual_styles SET prompt = ? WHERE id = ?").run(
      "edited1",
      "vs1"
    );
    db.prepare("UPDATE visual_styles SET prompt = ? WHERE id = ?").run(
      "edited2",
      "vs2"
    );

    const ids = videosRepo.transitionAllNewToQueued(db);
    expect(ids).toHaveLength(2);

    const rows = db
      .prepare(
        "SELECT id, status, visual_style_snapshot FROM videos ORDER BY id"
      )
      .all() as Array<{
      id: string;
      status: string;
      visual_style_snapshot: string;
    }>;
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    const byId = Object.fromEntries(
      rows.map((r) => [r.id, JSON.parse(r.visual_style_snapshot)])
    );
    expect(byId.n1.prompt).toBe("edited1");
    expect(byId.n2.prompt).toBe("edited2");
  });
});
