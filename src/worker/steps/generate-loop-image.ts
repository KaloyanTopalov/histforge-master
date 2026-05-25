import type { Database as DatabaseType } from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DeferSignal, Step } from "@/worker/pipeline";
import * as magnificRepo from "@/lib/repos/magnific";
import { waitForMagnificQueue } from "@/lib/magnific-wait";

/**
 * Test-only injection surface — matches the render.ts shape (`*Deps` +
 * `runX(videoId, deps)` + `Step.run` calls `runX`). Forwards the
 * cancellation primitives and poll knobs into `waitForMagnificQueue`.
 */
export interface GenerateLoopImageDeps {
  db: DatabaseType;
  projectsDir: string;
  log?: (message: string) => void;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  nowSec?: () => number;
}

/**
 * Phase 2.3 music-video step: enqueue an `image-hitl` row on the
 * magnific_queue and block until the operator picks a variation in the
 * Magnific tab. The submit-result webhook streams the chosen image to
 * `projects/<videoId>/loop_image.png`; the wait helper flips to
 * `{ok:true}` on the next poll and we return.
 *
 * Idempotent on re-entry: a re-pick of the video after a crash skips
 * straight to the wait when the artifact already lives on disk, or when
 * a queue row is still open (worker_boot reset flips dispatched rows
 * back to pending so the extension can claim them again).
 *
 * "HITL absorbs latency" — while the queue is just waiting on the
 * operator the wait helper keeps polling, no defer is emitted. Pause
 * and delete are the two ways the wait can exit non-ok; both yield via
 * DeferSignal so the orchestrator handles them the same way it does for
 * narrative-kind steps:
 *   - paused → setDeferredUntil(now); picker idles on queue_state=paused
 *     and resumes the in_progress video once the operator unpauses.
 *     Mirrors `waitForFlowQueue`'s paused branch in
 *     google-flow-common.ts.
 *   - deleted → setDeferredUntil(now); the next pickNextVideo tick hits
 *     the delete_requested short-circuit and runPipeline's early-check
 *     wipes the project. Throwing AbortError here would route to
 *     deleteFully one tick sooner but introduces a race on the
 *     non-signal delete-poll path (the wait helper can read
 *     delete_requested=1 before the 2s cancellation watcher has aborted
 *     the signal — a normal-Error throw in that window would
 *     mis-classify the cancellation as a step failure).
 *
 * Terminal-failure detection mirrors generate_loop_clip: countByStatusForVideo
 * counts pending+dispatched, which drains to 0 when the row goes to either
 * 'done' or 'failed' (image-hitl is no_timeout=1 so the reaper never
 * requeues, but submit-result can still flip the row to 'failed' on an
 * extension-reported error, a Magnific CDN download failure, or a
 * disallowed result host). Throw a deterministic error so the
 * orchestrator's retry re-enters; the terminal failed row is excluded
 * from findOpenTaskForVideo, so the re-entry enqueues a fresh row and
 * the banner reappears.
 */
export async function runGenerateLoopImage(
  videoId: string,
  deps: GenerateLoopImageDeps
): Promise<void | DeferSignal> {
  const { db, projectsDir } = deps;
  const log = deps.log ?? (() => {});
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  const projDir = join(projectsDir, videoId);
  const outPath = join(projDir, "loop_image.png");
  if (existsSync(outPath)) {
    log("generate_loop_image: loop_image.png already on disk; skipping");
    return;
  }

  const row = db
    .prepare("SELECT magnific_image_prompt FROM videos WHERE id = ?")
    .get(videoId) as { magnific_image_prompt: string | null } | undefined;
  const prompt = row?.magnific_image_prompt;
  if (!prompt) {
    throw new Error(
      `generate_loop_image: videos.magnific_image_prompt is missing for ${videoId}`
    );
  }

  mkdirSync(projDir, { recursive: true });

  const open = magnificRepo.findOpenTaskForVideo(db, videoId, "image-hitl");
  if (open) {
    log(
      `generate_loop_image: open queue row #${open.id} (status=${open.status}); awaiting`
    );
  } else {
    const id = magnificRepo.enqueueTask(db, {
      video_id: videoId,
      mode: "image-hitl",
      prompt,
      output_path: "loop_image.png",
      no_timeout: 1,
      created_at: nowSec(),
    });
    log(`generate_loop_image: enqueued image-hitl task #${id}; awaiting`);
  }

  const result = await waitForMagnificQueue(videoId, "image-hitl", {
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
      `generate_loop_image: queue drained but loop_image.png was not delivered for ${videoId} (terminal failure)`
    );
  }
}

export const step: Step = {
  name: "generate_loop_image",
  module: "music_video",
  label: "Generate loop image",
  description:
    "Enqueues an image-hitl task on the magnific_queue and waits for the operator to pick a Magnific variation.",
  inputs: [],
  outputs: ["loop_image.png"],
  run(videoId, ctx) {
    return runGenerateLoopImage(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      log: ctx.log,
      signal: ctx.signal,
    });
  },
};
