import { describe, it, expect, afterEach } from "vitest";
import type { Database as DatabaseType } from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, seedDefaultSettings } from "@/lib/db";
import { imageProviders } from "@/lib/image";
import { videoProviders } from "@/lib/video";
import { ttsProviders } from "@/lib/tts";
import * as videosRepo from "@/lib/repos/videos";
import { setSetting } from "@/lib/settings";
import { runPipeline, type Step, type StepContext } from "@/worker/pipeline";
import { computeSnapshot, materializeStepList } from "@/lib/workflows";
import type { WorkflowSnapshot } from "@/types";

const openDbs: DatabaseType[] = [];
const tmpDirs: string[] = [];

function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}

function tempProjectsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "histforge-wf-pipe-"));
  tmpDirs.push(dir);
  return dir;
}

// Fill the structural Step fields (module, label, description) that tests
// don't care about so each test literal can focus on `name`/`outputs`/`run`.
function step(s: Partial<Step> & { name: string }): Step {
  return {
    module: "glue",
    label: s.name,
    description: `Test step ${s.name}`,
    outputs: [],
    run: async () => {},
    ...s,
  };
}

afterEach(() => {
  while (openDbs.length) {
    try { openDbs.pop()!.close(); } catch { /* ignore */ }
  }
  while (tmpDirs.length) {
    try { rmSync(tmpDirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function insertVideo(
  db: DatabaseType,
  id: string,
  workflowId: string,
  status = "in_progress"
): void {
  // Seed `workflow_snapshot` so `resolveDeps` (Phase 4 Task 7) can resolve
  // the snapshot-pinned `chat` provider. The null-snapshot invariant
  // violation test inlines its own SQL and skips this helper.
  const snapshot = computeSnapshot(db, workflowId);
  db.prepare(
    "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(id, "Title", "info", workflowId, snapshot, status, 1);
}

describe("runPipeline — snapshot-driven resolution", () => {
  it("throws when videos.workflow_snapshot is null (invariant violation)", async () => {
    const db = freshDb();
    // Inline SQL skips the snapshot-seeding `insertVideo` helper — we want
    // to simulate a corrupt row whose snapshot was never written.
    // Greenfield FK would block this when workflow_id is bogus, but
    // `comfyui` is a seeded id, so the FK is happy. The snapshot column
    // is nullable; leaving it null is exactly the invariant violation
    // `resolveDeps` must catch.
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run("v_no_snap", "Title", "info", "comfyui", "in_progress", 1);

    await expect(
      runPipeline("v_no_snap", { db, projectsDir: tempProjectsDir() })
    ).rejects.toThrow(/snapshot/i);
  });

  it("throws with the bogus slug name when the snapshot references an unknown step", async () => {
    const db = freshDb();
    const badSnapshot = JSON.stringify({
      workflow_id: "comfyui",
      version: 1,
      script_llm_provider: "openrouter",
      tts_provider: null,
      image_provider: null,
      video_provider: null,
      steps: [{ step_name: "totally_made_up_step" }],
    });
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_bad_slug", "T", "i", "comfyui", badSnapshot, "in_progress", 1);

    await expect(
      runPipeline("v_bad_slug", { db, projectsDir: tempProjectsDir() })
    ).rejects.toThrow(/totally_made_up_step/);
  });

  it("passes caller-supplied `steps` through as an override (for tests)", async () => {
    const db = freshDb();
    insertVideo(db, "v_ok", "comfyui");

    const order: string[] = [];
    const steps: Step[] = [
      step({ name: "a", outputs: [], run: async () => { order.push("a"); } }),
      step({ name: "b", outputs: [], run: async () => { order.push("b"); } }),
    ];

    await runPipeline("v_ok", {
      db,
      steps,
      projectsDir: tempProjectsDir(),
    });

    expect(order).toEqual(["a", "b"]);
  });
});

describe("runPipeline — delete_requested interrupt", () => {
  it("stops at the next step boundary, removes project dir, and deletes video + step rows", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const db = freshDb();
    insertVideo(db, "v_del", "comfyui");
    const projectsDir = tempProjectsDir();
    const projectDir = join(projectsDir, "v_del");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "artifact.txt"), "data");

    const calls: string[] = [];
    const steps: Step[] = [
      step({
        name: "first",
        outputs: [],
        run: async () => {
          calls.push("first");
          // User requests deletion while "first" is running.
          db.prepare(
            "UPDATE videos SET delete_requested = 1 WHERE id = ?"
          ).run("v_del");
        },
      }),
      step({
        name: "second",
        outputs: [],
        run: async () => {
          calls.push("second");
        },
      }),
    ];

    await runPipeline("v_del", { db, steps, projectsDir });

    // "second" must never have run — the orchestrator aborts between steps.
    expect(calls).toEqual(["first"]);

    // Project dir is gone.
    expect(existsSync(projectDir)).toBe(false);

    // Video row and its step rows are gone.
    const vRow = db
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v_del");
    expect(vRow).toBeUndefined();
    const stepRows = db
      .prepare("SELECT step_name FROM video_steps WHERE video_id = ?")
      .all("v_del");
    expect(stepRows).toEqual([]);
  });

  it("honors delete_requested even when the snapshot pins a provider resolveDeps would crash on", async () => {
    const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
    const db = freshDb();

    // The music_video snapshot pins `script_llm_provider=null` (known
    // gap, see runPipeline JSDoc), and `resolveDeps` would crash on
    // `getLlmProvider(null)`. Without the early-exit at the top of
    // runPipeline this throw is swallowed by tickOnce, and a deletion
    // requested from the details page (which sets delete_requested=1
    // on an in_progress video) stays stuck forever.
    insertVideo(db, "v_mv_del", "music-video-magnific-suno");
    db.prepare(
      "UPDATE videos SET delete_requested = 1 WHERE id = ?"
    ).run("v_mv_del");

    const projectsDir = tempProjectsDir();
    const projectDir = join(projectsDir, "v_mv_del");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "artifact.txt"), "data");

    await runPipeline("v_mv_del", { db, projectsDir });

    expect(existsSync(projectDir)).toBe(false);
    const vRow = db
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v_mv_del");
    expect(vRow).toBeUndefined();
    const stepRows = db
      .prepare("SELECT step_name FROM video_steps WHERE video_id = ?")
      .all("v_mv_del");
    expect(stepRows).toEqual([]);
  });

  it("runs all steps normally when delete_requested stays 0", async () => {
    const db = freshDb();
    insertVideo(db, "v_keep", "comfyui");

    const calls: string[] = [];
    const steps: Step[] = [
      step({ name: "a", outputs: [], run: async () => { calls.push("a"); } }),
      step({ name: "b", outputs: [], run: async () => { calls.push("b"); } }),
    ];

    await runPipeline("v_keep", {
      db,
      steps,
      projectsDir: tempProjectsDir(),
    });

    expect(calls).toEqual(["a", "b"]);
    // Video row survives and ends up done.
    const row = db
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get("v_keep") as { status: string } | undefined;
    expect(row?.status).toBe("done");
  });
});

describe("runPipeline — pause interrupt", () => {
  it("stops at the next step boundary when video.paused=1 and leaves status=in_progress", async () => {
    const db = freshDb();
    insertVideo(db, "v_pause", "comfyui");

    const calls: string[] = [];
    const steps: Step[] = [
      step({
        name: "first",
        outputs: [],
        run: async () => {
          calls.push("first");
          // User pauses the video mid-step.
          db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run(
            "v_pause"
          );
        },
      }),
      step({
        name: "second",
        outputs: [],
        run: async () => {
          calls.push("second");
        },
      }),
    ];

    await runPipeline("v_pause", { db, steps, projectsDir: tempProjectsDir() });

    // "second" never runs — the orchestrator honored the pause between steps.
    expect(calls).toEqual(["first"]);

    const row = db
      .prepare("SELECT status, current_step FROM videos WHERE id = ?")
      .get("v_pause") as { status: string; current_step: string | null };
    // Status stays in_progress so the video resumes cleanly when unpaused.
    expect(row.status).toBe("in_progress");
    // current_step is left as the last step that ran — the plan explicitly
    // accepts this (the row is genuinely mid-pipeline).
    expect(row.current_step).toBe("first");

    // Step rows are in a consistent resumable state: first is done,
    // second is pending. Leaving "first" as running would trip
    // resetStaleRunningSteps on the next worker start; leaving "second"
    // as running would be a lie about in-flight state.
    const stepRows = db
      .prepare(
        "SELECT step_name, status FROM video_steps WHERE video_id = ? ORDER BY step_name"
      )
      .all("v_pause") as Array<{ step_name: string; status: string }>;
    expect(stepRows).toEqual([
      { step_name: "first", status: "done" },
      { step_name: "second", status: "pending" },
    ]);
  });

  it("stops at the next step boundary when queue_state='paused' globally", async () => {
    const db = freshDb();
    insertVideo(db, "v_gpause", "comfyui");

    const calls: string[] = [];
    const steps: Step[] = [
      step({
        name: "first",
        outputs: [],
        run: async () => {
          calls.push("first");
          // Global pause is toggled while "first" is running.
          setSetting("queue_state", "paused", db);
        },
      }),
      step({
        name: "second",
        outputs: [],
        run: async () => {
          calls.push("second");
        },
      }),
    ];

    await runPipeline("v_gpause", { db, steps, projectsDir: tempProjectsDir() });

    expect(calls).toEqual(["first"]);

    const row = db
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get("v_gpause") as { status: string };
    expect(row.status).toBe("in_progress");
  });

  it("delete still wins when both delete_requested and paused are set", async () => {
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const db = freshDb();
    insertVideo(db, "v_both", "comfyui");
    const projectsDir = tempProjectsDir();
    const projectDir = join(projectsDir, "v_both");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "artifact.txt"), "data");

    const steps: Step[] = [
      step({
        name: "first",
        outputs: [],
        run: async () => {
          // User pauses AND requests delete during the same step.
          db.prepare(
            "UPDATE videos SET paused = 1, delete_requested = 1 WHERE id = ?"
          ).run("v_both");
        },
      }),
      step({
        name: "second",
        outputs: [],
        run: async () => {},
      }),
    ];

    await runPipeline("v_both", { db, steps, projectsDir });

    // Delete wins: project dir removed, video row gone.
    expect(existsSync(projectDir)).toBe(false);
    const row = db
      .prepare("SELECT id FROM videos WHERE id = ?")
      .get("v_both");
    expect(row).toBeUndefined();
  });

  it("does not mark the video done when pause is set after the last step", async () => {
    const db = freshDb();
    insertVideo(db, "v_post", "comfyui");

    const steps: Step[] = [
      step({
        name: "only",
        outputs: [],
        run: async () => {
          // Pause set right before the post-loop completes.
          db.prepare("UPDATE videos SET paused = 1 WHERE id = ?").run("v_post");
        },
      }),
    ];

    await runPipeline("v_post", { db, steps, projectsDir: tempProjectsDir() });

    const row = db
      .prepare("SELECT status, output_path FROM videos WHERE id = ?")
      .get("v_post") as { status: string; output_path: string | null };
    // Stays in_progress; markDone would have flipped it to "done" and set
    // output_path — neither should happen while paused.
    expect(row.status).toBe("in_progress");
    expect(row.output_path).toBeNull();
  });

  it("delete still wins over pause at the post-loop boundary", async () => {
    // Covers the post-last-step check: both flags set during the final
    // step's run, so the for-loop exits normally and the race lands in
    // the post-loop guards. Delete must still win and wipe the row.
    const { existsSync, mkdirSync, writeFileSync } = await import("node:fs");
    const db = freshDb();
    insertVideo(db, "v_post_both", "comfyui");
    const projectsDir = tempProjectsDir();
    const projectDir = join(projectsDir, "v_post_both");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, "artifact.txt"), "data");

    const steps: Step[] = [
      step({
        name: "only",
        outputs: [],
        run: async () => {
          db.prepare(
            "UPDATE videos SET paused = 1, delete_requested = 1 WHERE id = ?"
          ).run("v_post_both");
        },
      }),
    ];

    await runPipeline("v_post_both", { db, steps, projectsDir });

    expect(existsSync(projectDir)).toBe(false);
    expect(
      db.prepare("SELECT id FROM videos WHERE id = ?").get("v_post_both")
    ).toBeUndefined();
  });

  it("resumes cleanly when the per-video paused flag is cleared between invocations", async () => {
    const db = freshDb();
    insertVideo(db, "v_resume", "comfyui");
    // Hoisted so the same project dir is shared across invocations — if
    // step two ever starts reading step one's output, this prevents a
    // silent pass.
    const projectsDir = tempProjectsDir();

    const calls: string[] = [];
    const steps: Step[] = [
      step({
        name: "first",
        outputs: [],
        run: async () => {
          calls.push("first");
          videosRepo.setPaused(db, "v_resume");
        },
      }),
      step({
        name: "second",
        outputs: [],
        run: async () => {
          calls.push("second");
        },
      }),
    ];

    await runPipeline("v_resume", { db, steps, projectsDir });

    // First invocation paused after step one.
    expect(calls).toEqual(["first"]);

    // User resumes — flag cleared, runner invokes runPipeline again.
    videosRepo.clearPaused(db, "v_resume");

    await runPipeline("v_resume", { db, steps, projectsDir });

    // Step two now runs and the video finishes.
    expect(calls).toEqual(["first", "second"]);
    const row = db
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get("v_resume") as { status: string };
    expect(row.status).toBe("done");
  });

  it("resumes cleanly when queue_state is flipped back to running between invocations", async () => {
    const db = freshDb();
    insertVideo(db, "v_gresume", "comfyui");
    const projectsDir = tempProjectsDir();

    const calls: string[] = [];
    const steps: Step[] = [
      step({
        name: "first",
        outputs: [],
        run: async () => {
          calls.push("first");
          setSetting("queue_state", "paused", db);
        },
      }),
      step({
        name: "second",
        outputs: [],
        run: async () => {
          calls.push("second");
        },
      }),
    ];

    await runPipeline("v_gresume", { db, steps, projectsDir });

    // First invocation halted at the between-step boundary because the
    // global queue was paused mid-run.
    expect(calls).toEqual(["first"]);

    // Operator flips the global queue back on — next runPipeline must
    // proceed through the remaining steps.
    setSetting("queue_state", "running", db);

    await runPipeline("v_gresume", { db, steps, projectsDir });

    expect(calls).toEqual(["first", "second"]);
    const row = db
      .prepare("SELECT status FROM videos WHERE id = ?")
      .get("v_gresume") as { status: string };
    expect(row.status).toBe("done");
  });
});

// ─── Snapshot end-to-end (Invariant B) ───────────────────────────────
// `createNewVideo` writes the snapshot that the orchestrator later reads
// to materialize the step list. These tests close the loop:
// createNewVideo → JSON-stored snapshot → materializeStepList must equal
// the legacy 13-step list for both seeded workflows. If `resolveDeps`
// later regresses the parse/materialize wiring, snapshot end-to-end is
// the path that catches it (the lib-level `materializeStepList` test in
// __tests__/unit/lib/workflows.test.ts only proves the function works on
// hand-built snapshots).

// Both built-in workflows materialize to the same unified slug list after
// Phase 5 — provider dispatch is by ctx.imageProvider / ctx.videoProvider,
// not by slug. The snapshot's *_provider columns still differ (and drive
// runtime dispatch), but the materialized step list is identical.
const BUILTIN_STEPS = [
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
];

function readSnapshot(db: DatabaseType, videoId: string): WorkflowSnapshot {
  const row = db
    .prepare("SELECT workflow_snapshot FROM videos WHERE id = ?")
    .get(videoId) as { workflow_snapshot: string };
  return JSON.parse(row.workflow_snapshot) as WorkflowSnapshot;
}

describe("snapshot end-to-end via createNewVideo", () => {
  it("comfyui video's pinned snapshot materializes to the unified 13-step list", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_cf",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });

    expect(materializeStepList(readSnapshot(db, "v_cf"))).toEqual(
      BUILTIN_STEPS
    );
  });

  it("google-flow video's pinned snapshot materializes to the unified 13-step list", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_gf",
      title: "T",
      topic_info: "info",
      workflow_id: "google-flow",
      created_at: 1,
    });

    expect(materializeStepList(readSnapshot(db, "v_gf"))).toEqual(
      BUILTIN_STEPS
    );
  });
});

describe("snapshot immutability after queueing", () => {
  it("edits to the live workflow_steps table do not change a queued video's pinned step list", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_pin",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_pin");

    // Operator edits the live workflow's step list AFTER queueing — this
    // is exactly the scenario Invariant B protects against.
    db.prepare(
      "INSERT INTO workflow_steps (workflow_id, position, step_name) VALUES (?, ?, ?)"
    ).run("comfyui", 99, "rogue_extra_step");

    const slugs = materializeStepList(readSnapshot(db, "v_pin"));
    expect(slugs).toEqual(BUILTIN_STEPS);
    expect(slugs).not.toContain("rogue_extra_step");
  });

  it("edits to the live workflow row's provider columns do not change a queued video's pinned providers", () => {
    const db = freshDb();
    videosRepo.createNewVideo(db, {
      id: "v_prov",
      title: "T",
      topic_info: "info",
      workflow_id: "comfyui",
      created_at: 1,
    });
    videosRepo.transitionNewToQueued(db, "v_prov");

    // Flip the live workflow's image provider — pinned snapshot must
    // ignore this. After Phase 5 the slug is provider-agnostic (unified),
    // but the snapshot's image_provider column must still pin "comfyui".
    db.prepare(
      "UPDATE workflows SET image_provider = 'google_flow' WHERE id = ?"
    ).run("comfyui");

    const snap = readSnapshot(db, "v_prov");
    expect(snap.image_provider).toBe("comfyui");
    expect(materializeStepList(snap)).toContain("generate_images");
  });
});

// ─── Phase 5 snapshot-driven provider resolution (integration) ───────
// `resolveDeps` reads `snapshot.image_provider` / `snapshot.video_provider`
// and looks them up in `imageProviders` / `videoProviders`. These tests
// don't override providers via `deps`; instead a capture step records
// `ctx.imageProvider` / `ctx.videoProvider` and asserts identity against
// the real registry exports — proving snapshot → registry → ctx wiring
// works for both built-in workflows and a cross-provider mix.
//
// Combined with `__tests__/unit/worker/steps/generate-{images,clips}.test.ts`
// (which proves the unified step modules dispatch via ctx.{image,video}Provider)
// and the snapshot-end-to-end block above (which proves materializeStepList
// emits the unified slugs), this closes the integration loop without
// running the 13-step real pipeline.

function makeCaptureStep(
  name: string,
  module: "image" | "video" | "tts",
  capture: { ctx?: StepContext }
): Step {
  return {
    name,
    module,
    label: name,
    description: "capture-only test step",
    outputs: [],
    run: async (_videoId, ctx) => {
      capture.ctx = ctx;
    },
  };
}

describe("runPipeline — Phase 5 snapshot-driven provider resolution (integration)", () => {
  it("resolves snapshot.image_provider against imageProviders and snapshot.video_provider against videoProviders for the comfyui workflow", async () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_int_cf", "comfyui");

    // Sanity-check the snapshot pins both providers to comfyui — guards
    // against an upstream regression in createNewVideo's snapshot wiring.
    const snap = readSnapshot(db, "v_int_cf");
    expect(snap.image_provider).toBe("comfyui");
    expect(snap.video_provider).toBe("comfyui");
    // And that materialization emits the unified slugs.
    expect(materializeStepList(snap)).toEqual(
      expect.arrayContaining(["generate_images", "generate_clips"])
    );

    const captured: { ctx?: StepContext } = {};
    await runPipeline("v_int_cf", {
      db,
      projectsDir,
      // Stand-in for the unified module steps — captures the StepContext
      // resolveDeps built. Real provider dispatch is exercised in the
      // per-step unit tests; here we only verify the ctx wiring.
      steps: [makeCaptureStep("capture_image", "image", captured)],
    });

    expect(captured.ctx).toBeDefined();
    expect(captured.ctx!.imageProvider).toBe(imageProviders.comfyui);
    expect(captured.ctx!.videoProvider).toBe(videoProviders.comfyui);
  });

  it("resolves both snapshot providers against the google_flow registry entries for the google-flow workflow", async () => {
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_int_gf", "google-flow");

    const snap = readSnapshot(db, "v_int_gf");
    expect(snap.image_provider).toBe("google_flow");
    expect(snap.video_provider).toBe("google_flow");

    const captured: { ctx?: StepContext } = {};
    await runPipeline("v_int_gf", {
      db,
      projectsDir,
      steps: [makeCaptureStep("capture_clips", "video", captured)],
    });

    // google_flow registers a factory (closes over the per-run moderator),
    // so identity-vs-factory-output won't hold. The comfyui registry entry
    // is the only stateless singleton — proving the captured providers
    // are NOT it proves the snapshot's google_flow lookup ran.
    expect(captured.ctx!.imageProvider).not.toBe(imageProviders.comfyui);
    expect(captured.ctx!.videoProvider).not.toBe(videoProviders.comfyui);
  });

  it("resolves image and video providers from independent registries when the snapshot mixes image=comfyui + video=google_flow (cross-provider)", async () => {
    // Phase 5's claim: provider dispatch is per-module, not per-workflow.
    // resolveDeps must hit imageProviders["comfyui"] for the image slot
    // and videoProviders["google_flow"] for the video slot — two
    // independent registry lookups. Identity comparison against the real
    // exports rules out accidental coupling (e.g., both slots reading the
    // same field) without mocking the registries.
    const db = freshDb();
    const projectsDir = tempProjectsDir();

    const snapshot = JSON.stringify({
      workflow_id: "comfyui",
      version: 1,
      script_llm_provider: "openrouter",
      tts_provider: null,
      image_provider: "comfyui",
      video_provider: "google_flow",
      steps: [],
    });
    db.prepare(
      "INSERT INTO videos (id, title, topic_info, workflow_id, workflow_snapshot, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("v_mix", "T", "info", "comfyui", snapshot, "in_progress", 1);

    const captured: { ctx?: StepContext } = {};
    await runPipeline("v_mix", {
      db,
      projectsDir,
      steps: [makeCaptureStep("capture_mix", "image", captured)],
    });

    // The two slots resolved to DIFFERENT registry entries — proves the
    // snapshot's per-slot column drives lookup independently. The video
    // slot's google_flow registry entry is a factory; identity holds only
    // for the comfyui singleton. Cross-checking with the inequality below
    // is what proves the cross-provider mix.
    expect(captured.ctx!.imageProvider).toBe(imageProviders.comfyui);
    expect(captured.ctx!.videoProvider).not.toBe(videoProviders.comfyui);
    expect(captured.ctx!.imageProvider).not.toBe(captured.ctx!.videoProvider);
  });

  it("resolves ctx.ttsProvider from snapshot.tts_provider", async () => {
    // Snapshot-pinning invariant (Invariant B): the voiceover slot
    // looks up its provider from the per-video snapshot, mirroring how
    // image/video are resolved above. The seeded comfyui workflow
    // snapshots `tts_provider: "ai33"`, so ctx.ttsProvider must end up
    // on the ai33 registry entry — not on a different one or undefined.
    // (The global `tts_provider` setting was removed in Phase 2 of the
    // snapshot-pinning plan; the snapshot is now the only source.)
    const db = freshDb();
    const projectsDir = tempProjectsDir();
    insertVideo(db, "v_tts_pin", "comfyui");

    const snap = readSnapshot(db, "v_tts_pin");
    expect(snap.tts_provider).toBe("ai33");

    const captured: { ctx?: StepContext } = {};
    await runPipeline("v_tts_pin", {
      db,
      projectsDir,
      steps: [makeCaptureStep("capture_voiceover", "tts", captured)],
    });

    expect(captured.ctx!.ttsProvider).toBe(ttsProviders.ai33);
    expect(captured.ctx!.ttsProvider).not.toBe(ttsProviders.genaipro);
  });
});

