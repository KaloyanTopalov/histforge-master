import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runStep } from "@/worker/run-step";
import type {
  PerRunDeps,
  ResolvedDeps,
  StepContext,
} from "@/worker/pipeline";
import { computeSnapshot } from "@/lib/workflows";
import * as stepsRepo from "@/lib/repos/steps";
import type { WorkflowSnapshot } from "@/types";
import {
  cleanup,
  fakeStep,
  freshDb,
  tempDir,
} from "../../helpers/step-fixtures";

afterEach(cleanup);

function insertVideo(
  db: DatabaseType,
  id: string,
  workflowId = "comfyui"
): void {
  const snapshot = computeSnapshot(db, workflowId);
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "Title", "info", workflowId, snapshot, "in_progress", 1);
}

function makeSnapshot(): WorkflowSnapshot {
  return {
    workflow_id: "",
    version: 0,
    kind: "narrative",
    script_llm_provider: "",
    tts_provider: null,
    image_provider: null,
    video_provider: null,
    music_provider: null,
    upscaler_provider: null,
    chunker_step: "chunk_clips_then_images",
    steps: [],
  };
}

function makeDeps(
  db: DatabaseType,
  projectsDir: string,
  overrides: Partial<ResolvedDeps> = {}
): ResolvedDeps {
  return {
    steps: [],
    db,
    projectsDir,
    promptsDir: "/dev/null/prompts",
    chat: async () => "",
    visualPromptChat: async () => "",
    visualPromptsConcurrency: 1,
    ttsProvider: {} as never,
    snapshot: makeSnapshot(),
    ...overrides,
  };
}

function makePerRun(overrides: Partial<PerRunDeps> = {}): PerRunDeps {
  return {
    chat: async () => "",
    visualPromptChat: async () => "",
    imageProvider: {} as never,
    videoProvider: {} as never,
    ...overrides,
  };
}

describe("runStep success path", () => {
  it("returns { kind: 'continue' } and marks the step row done on a successful run", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-success");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "only_step");

    const result = await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("only_step"),
      "vid_a",
      new AbortController().signal
    );

    expect(result).toEqual({ kind: "continue" });
    const row = db
      .prepare(
        "SELECT status, finished_at FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("vid_a", "only_step") as { status: string; finished_at: number | null };
    expect(row.status).toBe("done");
    expect(row.finished_at).not.toBeNull();
  });

  it("sets videos.current_step and the step row to 'running' during step.run()", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-running");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "alpha");

    let observed: { current_step: string | null; row_status: string } | null =
      null;
    const peek = fakeStep("alpha", {
      run: async (_videoId: string, _ctx: StepContext) => {
        const v = db
          .prepare("SELECT current_step FROM videos WHERE id = ?")
          .get("vid_a") as { current_step: string | null };
        const s = db
          .prepare(
            "SELECT status FROM video_steps WHERE video_id = ? AND step_name = ?"
          )
          .get("vid_a", "alpha") as { status: string };
        observed = { current_step: v.current_step, row_status: s.status };
      },
    });

    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      peek,
      "vid_a",
      new AbortController().signal
    );

    expect(observed).toEqual({ current_step: "alpha", row_status: "running" });
  });
});

describe("runStep failure path", () => {
  it("returns { kind: 'stop' } and marks both the step row and the video row failed when step.run throws", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-fail-marks");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "bad_step");

    const result = await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("bad_step", {
        run: async () => {
          throw new Error("kaboom");
        },
      }),
      "vid_a",
      new AbortController().signal
    );

    expect(result).toEqual({ kind: "stop" });

    const video = db
      .prepare(
        "SELECT status, failed_step, failed_reason, finished_at FROM videos WHERE id = ?"
      )
      .get("vid_a") as {
      status: string;
      failed_step: string | null;
      failed_reason: string | null;
      finished_at: number | null;
    };
    expect(video.status).toBe("failed");
    expect(video.failed_step).toBe("bad_step");
    expect(video.failed_reason).toBe("kaboom");
    expect(video.finished_at).not.toBeNull();

    const stepRow = db
      .prepare(
        "SELECT status, finished_at FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("vid_a", "bad_step") as { status: string; finished_at: number | null };
    expect(stepRow.status).toBe("failed");
    expect(stepRow.finished_at).not.toBeNull();
  });

  it("deletes only the failing step's STEP_OUTPUTS files (not previous steps')", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-fail-outputs");
    const projectDir = join(projectsDir, "vid_a");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "bad_step");

    // Pre-seed a previous step's output on disk — runStep must NOT touch it.
    mkdirSync(join(projectDir, "script"), { recursive: true });
    writeFileSync(join(projectDir, "script", "ok.md"), "ok content");

    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("bad_step", {
        outputs: ["audio/narration.mp3"],
        run: async () => {
          mkdirSync(join(projectDir, "audio"), { recursive: true });
          writeFileSync(join(projectDir, "audio", "narration.mp3"), "data");
          throw new Error("kaboom");
        },
      }),
      "vid_a",
      new AbortController().signal
    );

    expect(existsSync(join(projectDir, "audio", "narration.mp3"))).toBe(false);
    expect(existsSync(join(projectDir, "script", "ok.md"))).toBe(true);
  });

  it("invokes a step's custom cleanup hook instead of the default STEP_OUTPUTS deletion", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-fail-cleanup");
    const projectDir = join(projectsDir, "vid_a");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "custom_step");

    const cleanupCalls: string[] = [];
    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("custom_step", {
        // The default cleanup would delete this file — must be skipped
        // because the step provided its own cleanup.
        outputs: ["script/default_output.md"],
        run: async () => {
          mkdirSync(join(projectDir, "script"), { recursive: true });
          writeFileSync(
            join(projectDir, "script", "default_output.md"),
            "default"
          );
          writeFileSync(join(projectDir, "script", "preserved.md"), "keep me");
          throw new Error("nope");
        },
        cleanup: async (videoId) => {
          cleanupCalls.push(videoId);
          // Emulates step 4's per-chapter cleanup: targets a non-outputs file.
          rmSync(join(projectDir, "script", "preserved.md"), { force: true });
        },
      }),
      "vid_a",
      new AbortController().signal
    );

    expect(cleanupCalls).toEqual(["vid_a"]);
    // Custom cleanup deleted "preserved.md"; default-cleanup-target is intact.
    expect(existsSync(join(projectDir, "script", "preserved.md"))).toBe(false);
    expect(existsSync(join(projectDir, "script", "default_output.md"))).toBe(
      true
    );
  });

  it("appends the failing step's stack trace to pipeline.log under the step name", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-fail-log");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "bad_step");

    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("bad_step", {
        run: async () => {
          throw new Error("kaboom");
        },
      }),
      "vid_a",
      new AbortController().signal
    );

    const log = readFileSync(
      join(projectsDir, "vid_a", "pipeline.log"),
      "utf-8"
    );
    // Per spec :776 — log line is prefixed with [<step_name>] and contains
    // the error message; stack frames are appended.
    expect(log).toMatch(/\[bad_step\]/);
    expect(log).toContain("kaboom");
    expect(log).toMatch(/\bat\s/);
  });
});

describe("runStep mid-step cancellation", () => {
  it("returns { kind: 'stop' } and wipes the project + row when the step throws AbortError after the signal aborts (instead of marking failed)", async () => {
    // The original AI33 incident in `runPipeline` form: a long-running
    // step's poll loop notices the abort and surfaces it as an
    // AbortError. runStep's catch branch must route to the wipe path
    // (cancel outcome → deleteFully), not recordStepFailure.
    const db = freshDb();
    const projectsDir = tempDir("run-step-cancel-abort");
    const projectDir = join(projectsDir, "vid_cancel");
    insertVideo(db, "vid_cancel");
    stepsRepo.upsertPending(db, "vid_cancel", "long");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "scratch.txt"), "step in flight");

    const controller = new AbortController();
    const longStep = fakeStep("long", {
      run: async () => {
        // Mid-step: the cancellation watcher would flip the controller
        // and the step's in-flight fetch / spawn would throw AbortError.
        // Simulate both halves of that sequence deterministically.
        controller.abort("delete_requested");
        const err = new Error("Cancelled: delete_requested");
        err.name = "AbortError";
        throw err;
      },
    });

    const result = await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      longStep,
      "vid_cancel",
      controller.signal
    );

    expect(result).toEqual({ kind: "stop" });
    // Project dir wiped, video row gone — the wipe path, not recordStepFailure.
    expect(existsSync(projectDir)).toBe(false);
    const row = db
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("vid_cancel");
    expect(row).toBeUndefined();
  });

  it("does not wipe when a step throws a non-abort error and the signal is still live", async () => {
    // Regression guard for the abort-vs-failure branch — a regular failure
    // with a live signal must still go through recordStepFailure.
    const db = freshDb();
    const projectsDir = tempDir("run-step-cancel-nonabort");
    insertVideo(db, "vid_real_fail");
    stepsRepo.upsertPending(db, "vid_real_fail", "real_failure");

    const controller = new AbortController(); // never aborted

    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("real_failure", {
        run: async () => {
          throw new Error("genuine error, not cancellation");
        },
      }),
      "vid_real_fail",
      controller.signal
    );

    const video = db
      .prepare("SELECT status, failed_step FROM videos WHERE id = ?")
      .get("vid_real_fail") as { status: string; failed_step: string | null };
    expect(video.status).toBe("failed");
    expect(video.failed_step).toBe("real_failure");
  });

  it("routes to the cancel branch when signal.aborted is already true, even if the step throws a non-AbortError", async () => {
    // Explicit coverage for the `signal.aborted ||` side of the OR in
    // run-step.ts's catch branch. A delete that landed before runStep was
    // invoked (watcher's fast-path abort) should still wipe the row even
    // if the step body throws a generic error before noticing the signal.
    const db = freshDb();
    const projectsDir = tempDir("run-step-cancel-prearmed");
    const projectDir = join(projectsDir, "vid_prearmed");
    insertVideo(db, "vid_prearmed");
    stepsRepo.upsertPending(db, "vid_prearmed", "any_step");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "scratch.txt"), "would be wiped");

    const controller = new AbortController();
    controller.abort("delete_requested");

    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("any_step", {
        run: async () => {
          // Generic error — not AbortError-shaped. The signal.aborted
          // check is what must route this to cancel.
          throw new Error("plain failure");
        },
      }),
      "vid_prearmed",
      controller.signal
    );

    expect(existsSync(projectDir)).toBe(false);
    const row = db
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("vid_prearmed");
    expect(row).toBeUndefined();
  });
});

describe("runStep defer sentinel", () => {
  it("returns { kind: 'stop' }, sets videos.deferred_until, and leaves the step row 'running' when a step returns a DeferSignal", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-defer-set");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "defer_step");

    const later = Math.floor(Date.now() / 1000) + 1800;
    const result = await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("defer_step", {
        run: async () => ({ deferred: true, retryAfter: later }),
      }),
      "vid_a",
      new AbortController().signal
    );

    expect(result).toEqual({ kind: "stop" });

    const video = db
      .prepare(
        "SELECT status, current_step, deferred_until FROM videos WHERE id = ?"
      )
      .get("vid_a") as {
      status: string;
      current_step: string | null;
      deferred_until: number | null;
    };
    // Video stays in_progress so the runner resumes it once the defer expires.
    expect(video.status).toBe("in_progress");
    expect(video.current_step).toBe("defer_step");
    expect(video.deferred_until).toBe(later);

    const stepRow = db
      .prepare(
        "SELECT status FROM video_steps WHERE video_id = ? AND step_name = ?"
      )
      .get("vid_a", "defer_step") as { status: string };
    // Step row stays 'running'; re-entry will pick it back up and the step
    // body is responsible for its own idempotency.
    expect(stepRow.status).toBe("running");
  });

  it("does not set deferred_until when a step returns normally", async () => {
    const db = freshDb();
    const projectsDir = tempDir("run-step-defer-not-set");
    insertVideo(db, "vid_a");
    stepsRepo.upsertPending(db, "vid_a", "normal_step");

    await runStep(
      makeDeps(db, projectsDir),
      makePerRun(),
      fakeStep("normal_step"),
      "vid_a",
      new AbortController().signal
    );

    const video = db
      .prepare("SELECT deferred_until FROM videos WHERE id = ?")
      .get("vid_a") as { deferred_until: number | null };
    expect(video.deferred_until).toBeNull();
  });
});
