import { existsSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import { enqueueTask, listActiveOutputPaths } from "@/lib/repos/magnific";
import { waitForMagnificQueue } from "@/lib/magnific-wait";
import type { ImageProvider } from "./types";

/**
 * Magnific as an `ImageProvider` for narrative videos. Each image chunk
 * becomes an `image-batch` row on the magnific_queue (no_timeout=0, so the
 * reaper applies its normal dispatch-age timeout); the magnific-ext extension
 * generates each image inside the video's Magnific Project and posts it back,
 * and `waitForMagnificQueue` blocks until the slice drains.
 *
 * Resume-idempotent: a re-entry after a partial failure skips any chunk whose
 * output already exists on disk OR whose output_path already carries a
 * non-failed image-batch row, and enqueues only the rest. The queue has no
 * chunk_id column, so output_path (`images/<chunkId>.png`, relative to the
 * project dir — `submit-result` resolves it against projectsDir/<videoId>) is
 * the per-chunk identity. This mirrors the google_flow producer, which skips
 * chunks whose file is on disk and guards in-flight rows.
 *
 * Music-video snapshots also pin image_provider='magnific' but never reach
 * this code — `resolveDeps` short-circuits provider resolution for the
 * music_video kind, whose steps dispatch through the queue directly.
 */
export const magnificImageProvider: ImageProvider = {
  async generateBatch(items, targetDir, opts) {
    if (items.length === 0) return;

    const db = opts.db ?? getDb();
    const nowSec = opts.nowSec ?? (() => Math.floor(Date.now() / 1000));
    const covered = new Set(
      listActiveOutputPaths(db, opts.videoId, "image-batch")
    );

    for (const item of items) {
      const outputPath = `images/${item.id}.png`;
      if (
        existsSync(join(targetDir, `${item.id}.png`)) ||
        covered.has(outputPath)
      ) {
        continue;
      }
      enqueueTask(db, {
        video_id: opts.videoId,
        mode: "image-batch",
        prompt: item.prompt,
        output_path: outputPath,
        no_timeout: 0,
        created_at: nowSec(),
      });
    }

    const result = await waitForMagnificQueue(opts.videoId, "image-batch", {
      db,
      log: opts.log,
      signal: opts.signal,
      pollIntervalMs: opts.pollIntervalMs,
      nowSec,
    });
    if (!result.ok) {
      return { deferred: true, retryAfter: result.retryAfter };
    }
  },
};
