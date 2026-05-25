import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseType } from "better-sqlite3";
import { createDb, seedDefaultSettings } from "@/lib/db";
import {
  runGenerateLoopClip,
  step as generateLoopClipStep,
} from "@/worker/steps/generate-loop-clip";
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
  magnificMotionPrompt: string | null
): void {
  db.prepare(
    `INSERT INTO videos
       (id, title, topic_info, workflow_id, status, kind, magnific_image_prompt, magnific_motion_prompt, created_at)
     VALUES (?, ?, '', ?, 'in_progress', 'music_video', ?, ?, ?)`
  ).run(
    id,
    "MV",
    "music-video-magnific-suno",
    "a still image",
    magnificMotionPrompt,
    1
  );
}

describe("generate_loop_clip — Step metadata contract", () => {
  it("exposes the right name, module, inputs, and outputs", () => {
    expect(generateLoopClipStep.name).toBe("generate_loop_clip");
    expect(generateLoopClipStep.module).toBe("music_video");
    expect(generateLoopClipStep.inputs ?? []).toEqual(["loop_image.png"]);
    expect(generateLoopClipStep.outputs).toEqual(["loop_clip.mp4"]);
  });
});

describe("generate_loop_clip — entry gate", () => {
  it("throws when videos.magnific_motion_prompt is NULL", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-null");
    insertMusicVideo(db, "v_mv", null);

    await expect(
      generateLoopClipStep.run("v_mv", makeStepContext({ db, projectsDir }))
    ).rejects.toThrow(/magnific_motion_prompt/);
  });

  it("throws when videos.magnific_motion_prompt is the empty string", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-empty");
    insertMusicVideo(db, "v_mv", "");

    await expect(
      generateLoopClipStep.run("v_mv", makeStepContext({ db, projectsDir }))
    ).rejects.toThrow(/magnific_motion_prompt/);
  });
});

describe("generate_loop_clip — idempotent skip on existing artifact", () => {
  it("returns immediately if projects/<videoId>/loop_clip.mp4 already exists; no queue rows created", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-exists");
    insertMusicVideo(db, "v_mv", "a vibe");
    mkdirSync(join(projectsDir, "v_mv"), { recursive: true });
    writeFileSync(join(projectsDir, "v_mv", "loop_clip.mp4"), "stub");

    await generateLoopClipStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir })
    );

    const counts = magnificRepo.countByStatusForVideo(
      db,
      "v_mv",
      "image-to-video"
    );
    expect(counts).toEqual({ pending: 0, dispatched: 0, done: 0, failed: 0 });
    expect(existsSync(join(projectsDir, "v_mv", "loop_clip.mp4"))).toBe(true);
  });
});

describe("generate_loop_clip — enqueue + skip-enqueue on re-entry", () => {
  it("enqueues a magnific_queue row with mode=image-to-video, no_timeout=0, reference_image=loop_image.png, and the operator's magnific_motion_prompt verbatim", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-enqueue");
    insertMusicVideo(db, "v_mv", "aggressive push-in, swirling debris");

    // Pre-abort the signal so the wait returns 'deleted' on first poll;
    // we only care about the enqueue side-effect here.
    const controller = new AbortController();
    controller.abort();

    const result = await generateLoopClipStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir, signal: controller.signal })
    );
    expect(result).toMatchObject({ deferred: true });

    const open = magnificRepo.findOpenTaskForVideo(
      db,
      "v_mv",
      "image-to-video"
    );
    expect(open).toBeDefined();
    expect(open!.mode).toBe("image-to-video");
    expect(open!.no_timeout).toBe(0);
    expect(open!.output_path).toBe("loop_clip.mp4");
    expect(open!.reference_image).toBe("loop_image.png");
    expect(open!.status).toBe("pending");
    // The enqueued prompt is the operator-supplied motion prompt verbatim —
    // no MOTION_SUFFIX appended (dropped in Task 1.5 of the magnific
    // motion-prompt plan).
    expect(open!.prompt).toBe("aggressive push-in, swirling debris");
  });

  it("does NOT enqueue a second row if an open one already exists for (video, image-to-video)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-skip-enqueue");
    insertMusicVideo(db, "v_mv", "a vibe");
    magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "earlier motion prompt",
      output_path: "loop_clip.mp4",
      reference_image: "loop_image.png",
      no_timeout: 0,
      created_at: 1,
    });

    const controller = new AbortController();
    controller.abort();
    const result = await generateLoopClipStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir, signal: controller.signal })
    );
    expect(result).toMatchObject({ deferred: true });

    const counts = magnificRepo.countByStatusForVideo(
      db,
      "v_mv",
      "image-to-video"
    );
    expect(counts.pending + counts.dispatched).toBe(1);
  });
});

describe("generate_loop_clip — wait outcomes surface as DeferSignal", () => {
  it("returns DeferSignal when the wait returns 'deleted' (signal aborted mid-wait)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-deleted");
    insertMusicVideo(db, "v_mv", "a vibe");

    const controller = new AbortController();
    controller.abort();
    const result = await generateLoopClipStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir, signal: controller.signal })
    );
    expect(result).toMatchObject({
      deferred: true,
      retryAfter: expect.any(Number),
    });
  });

  it("returns DeferSignal when the wait returns 'paused' (global queue paused)", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-paused");
    insertMusicVideo(db, "v_mv", "a vibe");
    setSetting("queue_state", "paused", db);

    const result = await generateLoopClipStep.run(
      "v_mv",
      makeStepContext({ db, projectsDir })
    );
    expect(result).toMatchObject({
      deferred: true,
      retryAfter: expect.any(Number),
    });
  });
});

describe("generate_loop_clip — terminal-failure detection", () => {
  it("throws when the queue drains (ok:true) but no loop_clip.mp4 lands on disk", async () => {
    const db = freshDb();
    const projectsDir = tempDir("loopclip-failed");
    insertMusicVideo(db, "v_mv", "a vibe");
    // Pre-seed a dispatched row so findOpenTaskForVideo finds an open
    // task and the step skips enqueue, then race a transition to 'failed'
    // during the wait. Mimics what the submit-result webhook does when
    // the extension reports an error. After failTask the wait sees
    // pending+dispatched=0 and returns ok:true — the step then checks
    // for the artifact, finds it missing, and throws.
    const id = magnificRepo.enqueueTask(db, {
      video_id: "v_mv",
      mode: "image-to-video",
      prompt: "motion",
      output_path: "loop_clip.mp4",
      reference_image: "loop_image.png",
      no_timeout: 0,
      created_at: 1,
    });
    db.prepare(
      "UPDATE magnific_queue SET status = 'dispatched' WHERE id = ?"
    ).run(id);
    setTimeout(() => {
      magnificRepo.failTask(db, id, "extension reported error");
    }, 10);

    await expect(
      runGenerateLoopClip("v_mv", {
        db,
        projectsDir,
        pollIntervalMs: 5,
      })
    ).rejects.toThrow(/loop_clip\.mp4/);
  });
});
