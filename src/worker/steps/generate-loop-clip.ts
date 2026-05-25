import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeferSignal, Step } from "@/worker/pipeline";
import * as magnificRepo from "@/lib/repos/magnific";
import { waitForMagnificQueue } from "@/lib/magnific-wait";

/**
 * Test-only injection surface — mirrors the generate-loop-image shape
 * (`*Deps` + `runX(videoId, deps)` + `Step.run` calls `runX`). Forwards
 * the cancellation primitives and poll knobs into `waitForMagnificQueue`.
 */
export interface GenerateLoopClipDeps {
  db: DatabaseType;
  projectsDir: string;
  log?: (message: string) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  nowSec?: () => number;
}

/**
 * Phase 2.4 music-video step: enqueue an `image-to-video` row on the
 * magnific_queue and wait for the Magnific Seedance executor to land the
 * result. The enqueued `prompt` is the operator-supplied
 * `videos.magnific_motion_prompt` verbatim — no derived suffix. Unlike
 * `generate_loop_image`, this row uses `no_timeout=0` so the reaper requeues
 * if the extension session hangs past the dispatch timeout — the
 * image-to-video phase isn't operator-blocking (handoff §Decision 8).
 *
 * Idempotent on re-entry: a re-pick of the video after a crash skips the
 * enqueue if the artifact is already on disk, or if an open queue row still
 * exists (worker_boot reset flips dispatched rows back to pending so the
 * extension can claim them again).
 *
 * Wait outcomes mirror generate_loop_image:
 *   - {ok:true} with the artifact on disk → success, step returns
 *   - {ok:true} without the artifact → the only-other-explanation is a
 *     failed row (countByStatusForVideo counts pending+dispatched, which
 *     drains to 0 when the row goes to either 'done' or 'failed'). Throw a
 *     deterministic error so the orchestrator's retry re-enters; the
 *     terminal failed row is excluded from findOpenTaskForVideo, so the
 *     re-entry enqueues a fresh row.
 *   - {ok:false, paused|deleted} → DeferSignal. The picker idles on
 *     queue_state='paused' until the operator unpauses (resumes the same
 *     step); the delete path is handled at the next pickNextVideo tick.
 */
export async function runGenerateLoopClip(
  videoId: string,
  deps: GenerateLoopClipDeps
): Promise<void | DeferSignal> {
  const { db, projectsDir } = deps;
  const log = deps.log ?? (() => {});
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const projDir = join(projectsDir, videoId);
  const outPath = join(projDir, "loop_clip.mp4");
  if (existsSync(outPath)) {
    log("generate_loop_clip: loop_clip.mp4 already on disk; skipping");
    return;
  }

  const row = db
    .prepare("SELECT magnific_motion_prompt FROM videos WHERE id = ?")
    .get(videoId) as { magnific_motion_prompt: string | null } | undefined;
  const motionPrompt = row?.magnific_motion_prompt;
  if (!motionPrompt) {
    throw new Error(
      `generate_loop_clip: videos.magnific_motion_prompt is missing for ${videoId}`
    );
  }

  mkdirSync(projDir, { recursive: true });

  const open = magnificRepo.findOpenTaskForVideo(
    db,
    videoId,
    "image-to-video"
  );
  if (open) {
    log(
      `generate_loop_clip: open queue row #${open.id} (status=${open.status}); awaiting`
    );
  } else {
    const id = magnificRepo.enqueueTask(db, {
      video_id: videoId,
      mode: "image-to-video",
      prompt: motionPrompt,
      output_path: "loop_clip.mp4",
      reference_image: "loop_image.png",
      no_timeout: 0,
      created_at: nowSec(),
    });
    log(`generate_loop_clip: enqueued image-to-video task #${id}; awaiting`);
  }

  const result = await waitForMagnificQueue(videoId, "image-to-video", {
    db,
    log,
    signal: deps.signal,
    pollIntervalMs: deps.pollIntervalMs,
    nowSec,
  });
  if (!result.ok) {
    return { deferred: true, retryAfter: result.retryAfter };
  }

  if (!existsSync(outPath)) {
    throw new Error(
      `generate_loop_clip: queue drained but loop_clip.mp4 was not delivered for ${videoId} (terminal failure)`
    );
  }
}

export const step: Step = {
  name: "generate_loop_clip",
  module: "music_video",
  label: "Generate loop clip",
  description:
    "Enqueues an image-to-video task on the magnific_queue and waits for the Magnific Seedance executor to deliver the looped clip.",
  inputs: ["loop_image.png"],
  outputs: ["loop_clip.mp4"],
  run(videoId, ctx) {
    return runGenerateLoopClip(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      log: ctx.log,
      signal: ctx.signal,
    });
  },
};
