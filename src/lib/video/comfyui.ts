import { rmSync } from "node:fs";
import { join } from "node:path";
import { generateHookVideoBatch } from "@/lib/image/comfyui";
import type { VideoProvider } from "./types";

/**
 * ComfyUI as a `VideoProvider`. Thin wrapper over the existing
 * `generateHookVideoBatch` (which lives in `lib/image/comfyui.ts` because
 * that's where the workflow-execution plumbing already is, and whose
 * "hook" name is a historic artifact — see the helper's docstring).
 * `videoId` and `projectsDir` are ignored — ComfyUI is local, with no
 * per-video queue.
 */
export const comfyuiVideoProvider: VideoProvider = {
  async generateBatch(items, targetDir, opts) {
    await generateHookVideoBatch(items, targetDir, {
      db: opts.db,
      log: opts.log,
      pollIntervalMs: opts.pollIntervalMs,
      signal: opts.signal,
    });
  },
  cleanup: async (videoId, opts) => {
    rmSync(join(opts.projectsDir, videoId, "videos/clip"), {
      recursive: true,
      force: true,
    });
  },
};
