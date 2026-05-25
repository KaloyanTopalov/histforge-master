import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";
import { appendLog } from "@/lib/logger";

/**
 * Step 6 — voiceover.
 *
 * Thin glue: reads `script/full_script.md`, hands it to the snapshot's
 * TTS provider, tells it to write the mp3 to `audio/narration.mp3`. The
 * provider is resolved upstream from `snapshot.tts_provider` in
 * `resolveDeps`; this step never reads settings or opens providers
 * itself. All voice tuning params live in Settings and are read inside
 * the provider. The provider creates `audio/` if missing.
 *
 * Diagnostics: `opts.log` surfaces unusual poll events in the per-video
 * `pipeline.log`. Transcript paths (SRT, JSON) are logged when returned.
 */
export const step: Step = {
  name: "voiceover",
  module: "tts",
  label: "Voiceover",
  description: "Synthesizes the script narration via the TTS provider.",
  inputs: ["script/full_script.md"],
  outputs: [
    "audio/narration.mp3",
    "audio/narration.srt",
    "audio/narration.json",
    // AI33 resume token (sidecar). Listed here so the orchestrator's
    // failure-cleanup loop wipes it on a terminal step throw — without
    // this, a user-driven Retry would resume the now-dead task forever.
    "audio/.tts_task_id",
  ],
  // Sidecar excluded — not consumed downstream.
  produces: [
    "audio/narration.mp3",
    "audio/narration.srt",
    "audio/narration.json",
  ],
  async run(videoId, ctx) {
    const projectDir = join(ctx.projectsDir, videoId);
    const scriptPath = join(projectDir, "script", "full_script.md");
    const outPath = join(projectDir, "audio", "narration.mp3");

    const text = readFileSync(scriptPath, "utf-8");
    const result = await ctx.ttsProvider.synthesize(text, outPath, {
      log: (message) => appendLog(videoId, "voiceover", message, ctx.projectsDir),
      signal: ctx.signal,
    });

    if (result.transcripts) {
      const paths = [
        result.transcripts.srtPath,
        result.transcripts.jsonPath,
      ].filter(Boolean);
      if (paths.length > 0) {
        appendLog(
          videoId,
          "voiceover",
          `Transcripts saved: ${paths.join(", ")}`,
          ctx.projectsDir
        );
      }
    }
  },
};
