import type { Step } from "@/worker/pipeline";

/**
 * Plan 1 stub for the music-video kind's music-generation step. No-op:
 * resolves immediately so the orchestrator marks the step `done`. Plan 3
 * Phase 3.2 replaces this with the suno_queue enqueue + await loop.
 *
 * This is the only step in the six-step backbone that writes no marker
 * artifact in Plan 1 — `download_music` is what eventually produces the
 * songs/ directory; this step exists to model the dispatch boundary.
 */
export const step: Step = {
  name: "generate_music",
  module: "music_video",
  label: "Generate music",
  description: "Stub: no-op until Plan 3 wires the Suno queue.",
  inputs: [],
  outputs: [],
  async run() {
    // intentional no-op
  },
};
