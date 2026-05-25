import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import {
  runGenerateLoopImage,
  step as generateLoopImageStep,
} from "@/worker/steps/generate-loop-image";
import * as magnificRepo from "@/lib/repos/magnific";
import { setSetting } from "@/lib/settings";
import {
  cleanup,
  makeStepContext,
  tempDir,
} from "../../../helpers/step-fixtures";

const openDbs: DatabaseType[] = [];
function freshDb(): DatabaseType {
  const db = createDb(":memory:");
  seedDefaultSettings(db);
  openDbs.push(db);
  return db;
}
afterEach(() => {
  cleanup();
  while (openDbs.length) {
    try {
      openDbs.pop()!.close();
    } catch {
      // already closed
    }
  }
});

function insertMusicVideo(
  db: DatabaseType,
  id: string,
  magnificImagePrompt: string | null
): void {
  db.prepare(
    `INSERT INTO videos
       (id, title, topic_info, workflow_id, status, kind, magnific_image_prompt, created_at)
     VALUES (?, ?, '', ?, 'in_progress', 'music_video', ?, ?)`
  ).run(id, "MV", "music-video-magnific-suno", magnificImagePrompt, 1);
}

describe("generate_loop_image — Step metadata contract", () => {
  it("exposes the right name, module, inputs, and outputs", () => {
    expect(generateLoopImageStep.name).toBe("generate_loop_image");
    expect(generateLoopImageStep.module).toBe("music_video");
    expect(generateLoopImageStep.outputs).toEqual(["loop_image.png"]);
    expect(generateLoopImageStep.inputs ?? []).toEqual([]);
  });
});

describe("generate_loop_image — entry gate", () => {
  it("throws when videos.magnific_image_prompt is NULL", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-null");
    insertMusicVideo(db, "v_mv", null);

    await expect(
      generateLoopImageStep.run("v_mv", makeStepContext({ db, projectsDir }))
    ).rejects.toThrow(/magnific_image_prompt/);
  });

  it("throws when videos.magnific_image_prompt is the empty string", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-empty");
    insertMusicVideo(db, "v_mv", "");

    await expect(
      generateLoopImageStep.run("v_mv", makeStepContext({ db, projectsDir }))
    ).rejects.toThrow(/magnific_image_prompt/);
  });
});

describe("generate_loop_image — idempotent skip on existing artifact", () => {
  it("returns immediately if projects/<videoId>/loop_image.png already exists; no queue rows created", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-exists");
    insertMusicVideo(db, "v_mv", "a vibe");
    // Pre-create the output artifact.
    mkdirSync(join(projectsDir, "v_mv"), { recursive: true });
    writeFileSync(join(projectsDir, "v_mv", "loop_image.png"), "stub");

    await generateLoopImageStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir })
    );

    // No queue rows were created.
    const counts = magnificRepo.countByStatusForVideo(db, "v_mv", "image-hitl");
    expect(counts).toEqual({ pending: 0, dispatched: 0, done: 0, failed: 0 });
    // Artifact still in place.
    expect(existsSync(join(projectsDir, "v_mv", "loop_image.png"))).toBe(true);
  });
});

describe("generate_loop_image — enqueue + skip-enqueue on re-entry", () => {
  it("enqueues a magnific_queue row with mode=image-hitl, no_timeout=1, the video's prompt", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-enqueue");
    insertMusicVideo(db, "v_mv", "a vibe");

    // Pre-abort the signal so the wait returns 'deleted' on first poll;
    // we only care about the enqueue side-effect here.
    const controller = new AbortController();
    controller.abort();

    const result = await generateLoopImageStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir, signal: controller.signal })
    );
    expect(result).toMatchObject({ deferred: true });

    const open = magnificRepo.findOpenTaskForVideo(db, "v_mv", "image-hitl");
    expect(open).toBeDefined();
    expect(open!.mode).toBe("image-hitl");
    expect(open!.no_timeout).toBe(1);
    expect(open!.output_path).toBe("loop_image.png");
    expect(open!.prompt).toBe("a vibe");
    expect(open!.status).toBe("pending");
    expect(open!.reference_image).toBeNull();
  });

  it("does NOT enqueue a second row if an open one already exists for (video, image-hitl)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-skip-enqueue");
    insertMusicVideo(db, "v_mv", "a vibe");
    // Pre-create an open row.
    magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "earlier prompt",
      output_path: "loop_image.png",
      no_timeout: 1,
      created_at: 1,
    });

    const controller = new AbortController();
    controller.abort();
    const result = await generateLoopImageStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir, signal: controller.signal })
    );
    expect(result).toMatchObject({ deferred: true });

    // Only the pre-existing row is present; no second enqueue.
    const counts = magnificRepo.countByStatusForVideo(db, "v_mv", "image-hitl");
    expect(counts.pending + counts.dispatched).toBe(1);
  });
});

describe("generate_loop_image — wait outcomes surface as DeferSignal", () => {
  it("returns DeferSignal when the wait returns 'deleted' (signal aborted mid-wait)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-deleted");
    insertMusicVideo(db, "v_mv", "a vibe");

    const controller = new AbortController();
    controller.abort();
    const result = await generateLoopImageStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir, signal: controller.signal })
    );
    // Defer with retryAfter=now lets the harness call setDeferredUntil;
    // the next pickNextVideo tick hits the delete_requested short-circuit
    // and runPipeline's early-check wipes the project. A regular throw
    // here would race with the cancellation watcher and could mis-classify
    // the cancel as a step failure.
    expect(result).toMatchObject({
      deferred: true,
      retryAfter: expect.any(Number),
    });
  });

  it("returns DeferSignal when the wait returns 'paused' (global queue paused)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-paused");
    insertMusicVideo(db, "v_mv", "a vibe");
    setSetting("queue_state", "paused", db);

    const result = await generateLoopImageStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir })
    );
    // Defer is the only way the orchestrator can re-pick the video when
    // the operator unpauses without forcing a manual requeue — throwing
    // here would route through recordStepFailure and mark the video
    // 'failed', diverging from the narrative-kind pause behaviour.
    expect(result).toMatchObject({
      deferred: true,
      retryAfter: expect.any(Number),
    });
  });
});

describe("generate_loop_image — terminal-failure detection", () => {
  it("throws when the queue drains (ok:true) but no loop_image.png lands on disk", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopimg-failed");
    insertMusicVideo(db, "v_mv", "a vibe");
    // Pre-seed a dispatched row so findOpenTaskForVideo finds an open
    // task and the step skips enqueue, then race a transition to 'failed'
    // during the wait. Mimics what the submit-result webhook does when
    // the extension reports an error (image-hitl is no_timeout=1 so the
    // reaper never requeues, but submit-result can still flip the row
    // to 'failed'). After failTask the wait sees pending+dispatched=0
    // and returns ok:true — the step then checks for the artifact,
    // finds it missing, and throws.
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-hitl",
      prompt: "a vibe",
      output_path: "loop_image.png",
      no_timeout: 1,
      created_at: 1,
    });
    db.prepare(
      "UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?"
    ).run(id);
    setTimeout(() => {
      magnificRepo.failTask(db, id, "extension reported error");
    }, 10);

    await expect(
      runGenerateLoopImage("v_mv", {
        db,
        projectsDir,
        pollIntervalMs: 5,
      })
    ).rejects.toThrow(/loop_image\.png/);
  });
});
