import type { Database as DatabaseType } from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";

/**
 * Test-only injection surface. `exec` is the seam tests use to verify
 * the per-song ffmpeg args without spawning real processes; `signal` is
 * wired into the default exec so a delete mid-stub kills the child
 * (`project_long_running_step_cancellation`).
 */
export interface DownloadMusicDeps {
  db?: DatabaseType;
  projectsDir?: string;
  exec?: (args: string[]) => void | Promise<void>;
  signal?: AbortSignal;
}

function buildFfmpegExec(
  signal?: AbortSignal
): (args: string[]) => Promise<void> {
  return (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn("ffmpeg", ["-y", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        signal,
      });
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code, sig) => {
        if (code === 0) {
          resolve();
          return;
        }
        const tail = stderr.trim().split("\n").slice(-20).join(" | ");
        reject(
          new Error(
            `ffmpeg exited with ${code === null ? `signal=${sig}` : `code=${code}`}: ${tail}`
          )
        );
      });
    });
}

/**
 * Plan 1 stub for the music-video kind's music-download step. Reads
 * `videos.song_count` and writes that many 1-second silent stereo WAVs
 * into `projects/<videoId>/songs/`. Plan 3 Phase 3.3 replaces this with
 * the real Suno download loop driven by `suno_queue` task completion.
 *
 * Throws on a missing or null `song_count` — by the time this step runs
 * the create-time validator has guaranteed the column is set on every
 * music_video row, so a null here is an invariant violation.
 */
export async function runDownloadMusic(
  videoId: string,
  deps: DownloadMusicDeps
): Promise<void> {
  if (!deps.db) {
    throw new Error("download_music requires a database connection");
  }
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";

  const row = deps.db
    .prepare("SELECT song_count FROM videos WHERE id = ?")
    .get(videoId) as { song_count: number | null } | undefined;
  if (!row) {
    throw new Error(`No video found for id ${videoId}`);
  }
  if (row.song_count === null || row.song_count === undefined) {
    throw new Error(
      `Video ${videoId} has no song_count — music_video rows must carry one`
    );
  }

  const songsDir = join(projectsDir, videoId, "songs");
  mkdirSync(songsDir, { recursive: true });

  const exec = deps.exec ?? buildFfmpegExec(deps.signal);
  for (let i = 1; i <= row.song_count; i++) {
    const filename = `song_${String(i).padStart(2, "0")}.wav`;
    await exec([
      "-f", "lavfi",
      "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
      "-t", "1",
      join(songsDir, filename),
    ]);
  }
}

export const step: Step = {
  name: "download_music",
  module: "music_video",
  label: "Download music",
  description:
    "Stub: synthesises N 1-second silent WAVs (one per song_count) under songs/.",
  inputs: [],
  // Trailing slash matches `render_music_video`'s declared input so the
  // input-availability validator's exact-anchored globMatch sees them as
  // a producer/consumer pair. The orchestrator's rmSync handles the slash
  // unchanged.
  outputs: ["songs/"],
  run(videoId, ctx) {
    return runDownloadMusic(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      signal: ctx.signal,
    });
  },
};
