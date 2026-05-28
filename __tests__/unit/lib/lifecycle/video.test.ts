import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import * as videoLifecycle from "@/lib/lifecycle/video";
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
    `INSERT INTO videos (id, title, topic_info, workflow_id, status, current_step, failed_step, failed_reason, started_at, finished_at, output_path, delete_requested, paused, deferred_until, provided_script, kind, song_count, repeat_factor, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
    video.paused,
    video.deferred_until,
    video.provided_script,
    video.kind,
    video.song_count,
    video.repeat_factor,
    video.created_at
  );
  return video;
}

describe("videoLifecycle.pauseIfPausable", () => {
  it("returns ok:true and flips paused=1 on a queued video", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "queued" }));
    const result = videoLifecycle.pauseIfPausable(db, "v1");
    expect(result).toEqual({ ok: true });
    const after = db.prepare("SELECT paused FROM videos WHERE id = ?").get(
      "v1"
    ) as { paused: number };
    expect(after.paused).toBe(1);
  });

  it("returns ok:true and flips paused=1 on an in_progress video", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress" }));
    const result = videoLifecycle.pauseIfPausable(db, "v1");
    expect(result).toEqual({ ok: true });
    const after = db.prepare("SELECT paused FROM videos WHERE id = ?").get(
      "v1"
    ) as { paused: number };
    expect(after.paused).toBe(1);
  });

  it("returns not_found for an unknown id and writes nothing", () => {
    const db = freshDb();
    const result = videoLifecycle.pauseIfPausable(db, "missing");
    expect(result).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_pausable when already paused", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress", paused: 1 }));
    const result = videoLifecycle.pauseIfPausable(db, "v1");
    expect(result).toEqual({ ok: false, reason: "not_pausable" });
  });

  it("returns not_pausable when delete is pending", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress", delete_requested: 1 }));
    const result = videoLifecycle.pauseIfPausable(db, "v1");
    expect(result).toEqual({ ok: false, reason: "not_pausable" });
    const after = db.prepare("SELECT paused FROM videos WHERE id = ?").get(
      "v1"
    ) as { paused: number };
    expect(after.paused).toBe(0);
  });

  it("returns not_pausable for status=new / done / failed", () => {
    const db = freshDb();
    for (const status of ["new", "done", "failed"] as const) {
      db.prepare("DELETE FROM videos").run();
      seed(db, sampleVideo({ status }));
      expect(videoLifecycle.pauseIfPausable(db, "v1")).toEqual({
        ok: false,
        reason: "not_pausable",
      });
    }
  });
});

describe("videoLifecycle.resumeIfResumable", () => {
  it("returns ok:true and flips paused=0 on a paused in_progress video", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress", paused: 1 }));
    const result = videoLifecycle.resumeIfResumable(db, "v1");
    expect(result).toEqual({ ok: true });
    const after = db.prepare("SELECT paused FROM videos WHERE id = ?").get(
      "v1"
    ) as { paused: number };
    expect(after.paused).toBe(0);
  });

  it("returns ok:true on a paused queued video", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "queued", paused: 1 }));
    expect(videoLifecycle.resumeIfResumable(db, "v1")).toEqual({ ok: true });
  });

  it("returns not_found for an unknown id", () => {
    const db = freshDb();
    expect(videoLifecycle.resumeIfResumable(db, "missing")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("returns not_resumable when not paused", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress", paused: 0 }));
    expect(videoLifecycle.resumeIfResumable(db, "v1")).toEqual({
      ok: false,
      reason: "not_resumable",
    });
  });

  it("returns not_resumable when delete is pending", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({ status: "in_progress", paused: 1, delete_requested: 1 })
    );
    const result = videoLifecycle.resumeIfResumable(db, "v1");
    expect(result).toEqual({ ok: false, reason: "not_resumable" });
    const after = db.prepare("SELECT paused FROM videos WHERE id = ?").get(
      "v1"
    ) as { paused: number };
    expect(after.paused).toBe(1);
  });
});

describe("videoLifecycle.retry", () => {
  function seedFailedWithStep(
    db: DatabaseType,
    opts: { startedAt?: number | null; finishedAt?: number | null } = {}
  ): void {
    seed(
      db,
      sampleVideo({
        status: "failed",
        failed_step: "01_research_topic",
        failed_reason: "boom",
        started_at: opts.startedAt ?? 1000,
        finished_at: opts.finishedAt ?? 2000,
        current_step: "01_research_topic",
      })
    );
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?)"
    ).run("v1", "01_research_topic", 1100, 1900);
  }

  it("returns ok and atomically resets the failed step row + clears failure on the video", () => {
    const db = freshDb();
    seedFailedWithStep(db);
    expect(videoLifecycle.retry(db, "v1")).toEqual({ ok: true });

    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("queued");
    expect(video.failed_step).toBeNull();
    expect(video.failed_reason).toBeNull();
    expect(video.finished_at).toBeNull();
    expect(video.started_at).toBe(1000); // preserved

    const step = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "01_research_topic") as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(step.status).toBe("pending");
    expect(step.started_at).toBeNull();
    expect(step.finished_at).toBeNull();
  });

  it("returns not_found for an unknown id", () => {
    const db = freshDb();
    expect(videoLifecycle.retry(db, "missing")).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("returns not_failed when status is not failed", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "queued" }));
    expect(videoLifecycle.retry(db, "v1")).toEqual({
      ok: false,
      reason: "not_failed",
    });
  });

  it("returns missing_failed_step when failed video has no failed_step", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "failed", failed_step: null }));
    expect(videoLifecycle.retry(db, "v1")).toEqual({
      ok: false,
      reason: "missing_failed_step",
    });
  });
});

describe("videoLifecycle.deleteFully", () => {
  const tempDirs: string[] = [];
  function freshProjectsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "histforge-deletefully-"));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("removes the project dir and deletes video + step rows", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "queued" }));
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, 'pending')"
    ).run("v1", "01_research_topic");

    const projectsDir = freshProjectsDir();
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "artifact.txt"), "x");

    videoLifecycle.deleteFully(db, "v1", projectsDir);

    expect(existsSync(join(projectsDir, "v1"))).toBe(false);
    expect(
      db.prepare("SELECT id FROM videos WHERE id = ?").get("v1")
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM video_steps WHERE video_id = ?").get("v1")
    ).toBeUndefined();
  });

  it("is a no-op on the FS when the project dir is missing (force:true)", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "new" }));
    const projectsDir = freshProjectsDir();
    // never created projectsDir/v1

    expect(() =>
      videoLifecycle.deleteFully(db, "v1", projectsDir)
    ).not.toThrow();

    expect(
      db.prepare("SELECT id FROM videos WHERE id = ?").get("v1")
    ).toBeUndefined();
  });
});

describe("videoLifecycle.restart", () => {
  const tempDirs: string[] = [];
  function freshProjectsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "histforge-restart-"));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("wipes FS, deletes step rows, resets video to queued (failed video)", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({
        status: "failed",
        failed_step: "voiceover",
        failed_reason: "boom",
        started_at: 1000,
        finished_at: 2000,
        current_step: "voiceover",
        output_path: "projects/v1/final.mp4",
      })
    );
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?)"
    ).run("v1", "voiceover", 1100, 1900);

    const projectsDir = freshProjectsDir();
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "artifact.txt"), "x");

    expect(videoLifecycle.restart(db, "v1", projectsDir)).toEqual({
      ok: true,
    });

    expect(existsSync(join(projectsDir, "v1"))).toBe(false);
    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("queued");
    expect(video.failed_step).toBeNull();
    expect(video.failed_reason).toBeNull();
    expect(video.started_at).toBeNull();
    expect(video.finished_at).toBeNull();
    expect(video.current_step).toBeNull();
    expect(video.output_path).toBeNull();
    expect(video.paused).toBe(0);
    expect(
      db.prepare("SELECT 1 FROM video_steps WHERE video_id = ?").get("v1")
    ).toBeUndefined();
  });

  it("succeeds on a done video too", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({
        status: "done",
        output_path: "projects/v1/final.mp4",
        finished_at: 2000,
      })
    );
    const projectsDir = freshProjectsDir();
    expect(videoLifecycle.restart(db, "v1", projectsDir)).toEqual({ ok: true });
  });

  it("returns not_found for an unknown id", () => {
    const db = freshDb();
    expect(
      videoLifecycle.restart(db, "missing", freshProjectsDir())
    ).toEqual({ ok: false, reason: "not_found" });
  });

  it("returns not_restartable for active states", () => {
    const db = freshDb();
    const projectsDir = freshProjectsDir();
    for (const status of ["new", "queued", "in_progress"] as const) {
      db.prepare("DELETE FROM videos").run();
      seed(db, sampleVideo({ status }));
      expect(videoLifecycle.restart(db, "v1", projectsDir)).toEqual({
        ok: false,
        reason: "not_restartable",
      });
    }
  });
});

describe("videoLifecycle.enterStep", () => {
  it("flips the step row to running and sets video.current_step in one txn", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress" }));
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, 'pending')"
    ).run("v1", "01_research_topic");

    videoLifecycle.enterStep(db, "v1", "01_research_topic", 1234);

    const step = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "01_research_topic") as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(step.status).toBe("running");
    expect(step.started_at).toBe(1234);
    expect(step.finished_at).toBeNull();
    const video = db
      .prepare("SELECT current_step FROM videos WHERE id = ?")
      .get("v1") as { current_step: string | null };
    expect(video.current_step).toBe("01_research_topic");
  });
});

describe("videoLifecycle.unfailToQueued", () => {
  it("resets a failed video's step row + clears failure + sets queued", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({
        status: "failed",
        failed_step: "voiceover",
        failed_reason: "boom",
        started_at: 1000,
        finished_at: 2000,
      })
    );
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'failed', ?, ?)"
    ).run("v1", "voiceover", 1100, 1900);

    videoLifecycle.unfailToQueued(db, "v1");

    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("queued");
    expect(video.failed_step).toBeNull();
    expect(video.failed_reason).toBeNull();
    expect(video.finished_at).toBeNull();
    // started_at is preserved by clearFailure (same as retry)
    expect(video.started_at).toBe(1000);

    const step = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "voiceover") as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(step.status).toBe("pending");
    expect(step.started_at).toBeNull();
    expect(step.finished_at).toBeNull();
  });

  it("is a no-op on a non-failed video", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "queued" }));
    videoLifecycle.unfailToQueued(db, "v1");
    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("queued");
  });

  it("is a no-op on a failed video with no failed_step", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "failed", failed_step: null }));
    videoLifecycle.unfailToQueued(db, "v1");
    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("failed");
  });

  it("is a no-op for a missing video", () => {
    const db = freshDb();
    expect(() => videoLifecycle.unfailToQueued(db, "missing")).not.toThrow();
  });
});

describe("videoLifecycle.rerenderLastStep", () => {
  const tempDirs: string[] = [];
  function freshProjectsDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "histforge-rerender-"));
    tempDirs.push(dir);
    return dir;
  }
  afterEach(() => {
    while (tempDirs.length) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function seedDoneMusicVideo(db: DatabaseType): void {
    seed(
      db,
      sampleVideo({
        kind: "music_video",
        workflow_id: "music-video-magnific-suno",
        status: "done",
        current_step: null,
        started_at: 1000,
        finished_at: 2000,
        output_path: "projects/v1/final.mp4",
        song_count: 6,
        repeat_factor: 4,
      })
    );
    // Seed every step row as done — the rerender flips only render_music_video.
    const insertDone = db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at, finished_at) VALUES (?, ?, 'done', ?, ?)"
    );
    for (const stepName of [
      "generate_loop_image",
      "generate_loop_clip",
      "make_thumbnail",
      "generate_music",
      "download_music",
      "render_music_video",
    ]) {
      insertDone.run("v1", stepName, 1100, 1900);
    }
  }

  function seedExpensiveArtifacts(projectsDir: string): void {
    const projDir = join(projectsDir, "v1");
    mkdirSync(projDir, { recursive: true });
    mkdirSync(join(projDir, "build"), { recursive: true });
    mkdirSync(join(projDir, "songs"), { recursive: true });
    writeFileSync(join(projDir, "final.mp4"), "final");
    writeFileSync(join(projDir, "build", "loop_clip_trimmed.mp4"), "trim");
    writeFileSync(join(projDir, "loop_clip.mp4"), "clip");
    writeFileSync(join(projDir, "loop_image.png"), "image");
    writeFileSync(join(projDir, "thumbnail.jpg"), "thumb");
    writeFileSync(join(projDir, "songs", "song1.mp3"), "song");
    writeFileSync(join(projDir, "pipeline.log"), "log");
  }

  it("happy path: wipes final.mp4 + build/, preserves loop artifacts, resets render_music_video step + flips video to queued", () => {
    const db = freshDb();
    seedDoneMusicVideo(db);
    const projectsDir = freshProjectsDir();
    seedExpensiveArtifacts(projectsDir);

    const result = videoLifecycle.rerenderLastStep(db, "v1", projectsDir);
    expect(result).toEqual({ ok: true });

    const projDir = join(projectsDir, "v1");
    // Wiped:
    expect(existsSync(join(projDir, "final.mp4"))).toBe(false);
    expect(existsSync(join(projDir, "build"))).toBe(false);
    // Preserved (the whole point of the action):
    expect(existsSync(join(projDir, "loop_clip.mp4"))).toBe(true);
    expect(existsSync(join(projDir, "loop_image.png"))).toBe(true);
    expect(existsSync(join(projDir, "thumbnail.jpg"))).toBe(true);
    expect(existsSync(join(projDir, "songs", "song1.mp3"))).toBe(true);
    expect(existsSync(join(projDir, "pipeline.log"))).toBe(true);

    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("queued");
    expect(video.current_step).toBeNull();

    const renderStep = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = 'render_music_video'"
      )
      .get("v1") as {
      status: string;
      started_at: number | null;
      finished_at: number | null;
    };
    expect(renderStep.status).toBe("pending");
    expect(renderStep.started_at).toBeNull();
    expect(renderStep.finished_at).toBeNull();

    // Other step rows stay done (the loop artifacts they produced still exist).
    const otherStep = db
      .prepare(
        "SELECT status FROM video_steps WHERE video_id = ? AND step_name = 'generate_loop_clip'"
      )
      .get("v1") as { status: string };
    expect(otherStep.status).toBe("done");
  });

  it("returns not_found for an unknown id and does not touch the filesystem", () => {
    const db = freshDb();
    const projectsDir = freshProjectsDir();
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "final.mp4"), "still here");

    expect(videoLifecycle.rerenderLastStep(db, "missing", projectsDir)).toEqual({
      ok: false,
      reason: "not_found",
    });
    // Untouched.
    expect(existsSync(join(projectsDir, "v1", "final.mp4"))).toBe(true);
  });

  it("returns wrong_kind for a narrative done video and leaves artifacts intact", () => {
    const db = freshDb();
    seed(
      db,
      sampleVideo({
        kind: "narrative",
        status: "done",
        output_path: "projects/v1/final.mp4",
      })
    );
    const projectsDir = freshProjectsDir();
    mkdirSync(join(projectsDir, "v1"), { recursive: true });
    writeFileSync(join(projectsDir, "v1", "final.mp4"), "narrative final");

    expect(videoLifecycle.rerenderLastStep(db, "v1", projectsDir)).toEqual({
      ok: false,
      reason: "wrong_kind",
    });
    expect(existsSync(join(projectsDir, "v1", "final.mp4"))).toBe(true);
    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("done");
  });

  it("returns not_done for a music_video that has not finished", () => {
    const db = freshDb();
    const projectsDir = freshProjectsDir();
    for (const status of [
      "new",
      "queued",
      "in_progress",
      "failed",
    ] as const) {
      db.prepare("DELETE FROM videos").run();
      seed(
        db,
        sampleVideo({
          kind: "music_video",
          workflow_id: "music-video-magnific-suno",
          status,
          // failed needs a failed_step to mirror reality, but the predicate
          // path runs before retry's deeper checks so any seed value is fine.
          failed_step: status === "failed" ? "render_music_video" : null,
        })
      );
      expect(videoLifecycle.rerenderLastStep(db, "v1", projectsDir)).toEqual({
        ok: false,
        reason: "not_done",
      });
    }
  });

  it("tolerates a missing project directory (rmSync force:true) and still flips DB state", () => {
    const db = freshDb();
    seedDoneMusicVideo(db);
    const projectsDir = freshProjectsDir();
    // Never created projectsDir/v1 — rmSync must not throw.

    expect(videoLifecycle.rerenderLastStep(db, "v1", projectsDir)).toEqual({
      ok: true,
    });
    const video = db
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get("v1") as { status: string };
    expect(video.status).toBe("queued");
  });
});

describe("videoLifecycle.recordStepFailure", () => {
  it("atomically flips the step row to failed and marks the video failed", () => {
    const db = freshDb();
    seed(db, sampleVideo({ status: "in_progress", current_step: "voiceover" }));
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status, started_at) VALUES (?, ?, 'running', ?)"
    ).run("v1", "voiceover", 1000);

    videoLifecycle.recordStepFailure(db, "v1", "voiceover", "boom", 2000);

    const step = db
      .prepare(
        "SELECT * FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("v1", "voiceover") as {
      status: string;
      started_at: number;
      finished_at: number;
    };
    expect(step.status).toBe("failed");
    expect(step.finished_at).toBe(2000);

    const video = db
      .prepare("SELECT * FROM videos WHERE id = ?")
      .get("v1") as Video;
    expect(video.status).toBe("failed");
    expect(video.failed_step).toBe("voiceover");
    expect(video.failed_reason).toBe("boom");
    expect(video.finished_at).toBe(2000);
    expect(video.current_step).toBeNull();
  });
});
