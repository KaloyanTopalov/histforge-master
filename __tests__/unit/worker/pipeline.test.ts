import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { runPipeline, type Step, type StepContext } from "@/worker/pipeline";
import { STEP_OUTPUTS } from "@/worker/steps";
import {
  computeSnapshot,
  materializeStepList,
  resolveSnapshot,
} from "@/lib/workflows";
import { getImageProvider } from "@/lib/image";
import { noOpModerator } from "../../helpers/no-op-moderator";
import { fakeStep } from "../../helpers/step-fixtures";

const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

function tempProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-pipeline-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
  while (tmpDirs.length) {
    try {
      rmSync(tmpDirs.pop()!, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function insertVideo(
  db: DatabaseType,
  id: string,
  status = "in_progress",
  workflowId = "comfyui"
): void {
  // Seed `workflow_snapshot` so `resolveDeps` (Phase 4 Task 7) can resolve
  // the snapshot-pinned `chat` provider. Tests that pass `deps.steps`
  // override the materialization path but still need the snapshot for
  // chat resolution.
  const snapshot = computeSnapshot(db, workflowId);
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "Title", "info", workflowId, snapshot, status, 1);
}

describe("workflow registry / STEP_OUTPUTS", () => {
  it("comfyui workflow materializes to the unified 12-step list in order", () => {
    const db = freshDb();
    const slugs = materializeStepList(resolveSnapshot(db, "comfyui"));
    expect(slugs).toEqual([
      "research_outline",
      "write_hook",
      "write_chapters",
      "assemble_script",
      "voiceover",
      "align",
      "chunk_clips_then_images",
      "generate_visual_prompts",
      "generate_images",
      "generate_clips",
      "render",
      "cleanup",
    ]);
  });

  it("every comfyui-workflow slug has a STEP_OUTPUTS entry", () => {
    const db = freshDb();
    const slugs = materializeStepList(resolveSnapshot(db, "comfyui"));
    for (const name of slugs) {
      expect(STEP_OUTPUTS[name]).toBeDefined();
    }
  });
});

describe("runPipeline pre-loop", () => {
  it("seeds one pending video_steps row per step name on first run", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a");

    const steps: Step[] = [
      fakeStep("step_one"),
      fakeStep("step_two"),
      fakeStep("step_three"),
    ];

    await runPipeline("vid_a", {
      db,
      steps,
      projectsDir: tempProjectsDir(),
    });

    const rows = db
      .prepare(
        "SELECT step_name, status FROM video_steps WHERE video_id = ? ORDER BY step_name"
      )
      .all("vid_a") as Array<{ step_name: string; status: string }>;

    expect(rows).toEqual([
      { step_name: "step_one", status: "done" },
      { step_name: "step_three", status: "done" },
      { step_name: "step_two", status: "done" },
    ]);
  });
});

describe("runPipeline success path", () => {
  it("skips steps that are already marked done", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a");

    // Pre-create rows; step_one is already done from a prior run.
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, ?)"
    ).run("vid_a", "step_one", "done");
    db.prepare(
      "INSERT INTO video_steps (video_id, step_name, status) VALUES (?, ?, ?)"
    ).run("vid_a", "step_two", "pending");

    const callOrder: string[] = [];
    const steps: Step[] = [
      fakeStep("step_one", {
        run: async () => {
          callOrder.push("step_one");
        },
      }),
      fakeStep("step_two", {
        run: async () => {
          callOrder.push("step_two");
        },
      }),
    ];

    await runPipeline("vid_a", {
      db,
      steps,
      projectsDir: tempProjectsDir(),
    });

    expect(callOrder).toEqual(["step_two"]);
  });
});

describe("runPipeline failure path", () => {
  it("clears videos.current_step when a step fails", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a");

    const steps: Step[] = [
      fakeStep("bad_step", {
        run: async () => {
          throw new Error("kaboom");
        },
      }),
    ];

    await runPipeline("vid_a", {
      db,
      steps,
      projectsDir: tempProjectsDir(),
    });

    const video = db
      .prepare("SELECT status, current_step, failed_step FROM videos WHERE id = ?")
      .get("vid_a") as {
      status: string;
      current_step: string | null;
      failed_step: string | null;
    };
    expect(video.status).toBe("failed");
    expect(video.failed_step).toBe("bad_step");
    // current_step should be NULL on failed videos — consistent with
    // the success/pause/session-lost paths which all clear it. The
    // failed_step column already records which step failed.
    expect(video.current_step).toBeNull();
  });
});

// ─── imageProvider snapshot resolution (Phase 5C Task 13) ────────────
// `resolveDeps` must read `imageProvider` from `snapshot.image_provider`,
// not from the global `image_provider` setting. This closes Phase 1's
// deferred snapshot rewire and matches the videoProvider path landed in
// Phase 5B. Live setting edits after queueing must not leak into
// in-flight runs (Invariant B).

describe("runPipeline imageProvider snapshot resolution", () => {
  it("resolves ctx.imageProvider from snapshot.image_provider, ignoring the global setting", async () => {
    const db = freshDb();
    // The seeded `google-flow` workflow pins `image_provider: "google_flow"`
    // in its snapshot. The global `image_provider` setting (default
    // "comfyui") points elsewhere — it must be ignored.
    insertVideo(db, "vid_a", "in_progress", "google-flow");

    let captured: StepContext["imageProvider"] | undefined;
    const capturingStep = fakeStep("capture", {
      run: async (_videoId, ctx) => {
        captured = ctx.imageProvider;
      },
    });

    await runPipeline("vid_a", {
      db,
      steps: [capturingStep],
      projectsDir: tempProjectsDir(),
    });

    // Captured provider must be the snapshot-pinned ("google_flow") one,
    // not the global setting's default ("comfyui"). Google Flow is now
    // built per-run via makeGoogleFlowImageProvider(moderator), so identity
    // equality to a fresh getImageProvider("google_flow", ...) call no
    // longer holds — the comfyui singleton inequality still proves the
    // snapshot path was followed.
    expect(captured).not.toBe(
      getImageProvider("comfyui", { moderator: noOpModerator })
    );
  });

  it("does not throw in resolveDeps when snapshot.image_provider is null", async () => {
    const db = freshDb();
    insertVideo(db, "vid_a", "in_progress", "comfyui");
    // Rewrite the snapshot to null out the image slot — mirrors a
    // workflow that deselected its image module.
    const row = db
      .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
      .get("vid_a") as { workflow_snapshot: string };
    const snap = JSON.parse(row.workflow_snapshot);
    snap.image_provider = null;
    db.prepare("UPDATE videos SET workflow_snapshot = ? WHERE id = ?").run(
      JSON.stringify(snap),
      "vid_a"
    );

    // A step that doesn't consume ctx.imageProvider — the materializer
    // would normally skip the image slot under null, but we override
    // `steps` here to exercise resolveDeps directly.
    await expect(
      runPipeline("vid_a", {
        db,
        steps: [fakeStep("noop")],
        projectsDir: tempProjectsDir(),
      })
    ).resolves.not.toThrow();
  });
});

// ─── music_video kind resolveDeps tolerance (Plan 2 Phase 2.1 Task 1) ───
// A music_video snapshot pins script_llm_provider=null and image/video
// providers='magnific'. The eager LLM provider lookup and the
// getImageProvider/getVideoProvider calls in runPipeline would throw on
// those values; resolveDeps short-circuits for kind='music_video' so the
// orchestrator can walk the music-video step backbone.

describe("runPipeline music_video kind resolveDeps", () => {
  it("does not throw when resolving a music-video-magnific-suno snapshot", async () => {
    const db = freshDb();
    insertVideo(db, "vid_mv", "in_progress", "music-video-magnific-suno");

    await expect(
      runPipeline("vid_mv", {
        db,
        steps: [fakeStep("noop")],
        projectsDir: tempProjectsDir(),
      })
    ).resolves.not.toThrow();
  });

  it("leaves ctx.imageProvider and ctx.videoProvider as null for music_video kind", async () => {
    const db = freshDb();
    insertVideo(db, "vid_mv", "in_progress", "music-video-magnific-suno");

    let captured: StepContext | undefined;
    const capturingStep = fakeStep("capture", {
      run: async (_videoId, ctx) => {
        captured = ctx;
      },
    });

    await runPipeline("vid_mv", {
      db,
      steps: [capturingStep],
      projectsDir: tempProjectsDir(),
    });

    expect(captured).toBeDefined();
    expect(captured!.imageProvider).toBeNull();
    expect(captured!.videoProvider).toBeNull();
    expect(captured!.ttsProvider).toBeNull();
  });
});

