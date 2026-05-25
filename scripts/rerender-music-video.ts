/**
 * One-off: re-render the music_video final.mp4 for a single video, preserving
 * the prior render at `final.before-trim.mp4` so the operator can A/B the
 * loop-seam mitigation against the original. Usage:
 *
 *   npx tsx scripts/rerender-music-video.ts <videoId>
 *
 * Bypasses the worker queue — calls the step's pure function directly. The
 * video's row state (status, current_step) is untouched.
 */

import "dotenv/config";
import { existsSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "../src/lib/db";
import { runRenderMusicVideo } from "../src/worker/steps/render-music-video";

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error("Usage: tsx scripts/rerender-music-video.ts <videoId>");
    process.exit(1);
  }

  const db = getDb();
  const row = db
    .prepare("SELECT id, title, kind, song_count, repeat_factor FROM videos WHERE id = ?")
    .get(videoId) as
    | { id: string; title: string; kind: string; song_count: number | null; repeat_factor: number | null }
    | undefined;
  if (!row) {
    console.error(`No video with id=${videoId}`);
    process.exit(1);
  }
  if (row.kind !== "music_video") {
    console.error(`Video ${videoId} is kind=${row.kind}, not music_video — refusing.`);
    process.exit(1);
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projDir = join(projectsDir, videoId);
  const finalPath = join(projDir, "final.mp4");
  const backupPath = join(projDir, "final.before-trim.mp4");
  const loopClipPath = join(projDir, "loop_clip.mp4");

  if (!existsSync(loopClipPath)) {
    console.error(`Missing ${loopClipPath} — cannot re-render.`);
    process.exit(1);
  }

  if (existsSync(finalPath)) {
    if (existsSync(backupPath)) {
      // A backup already exists from a prior re-render — don't clobber it.
      // Just delete the current final.mp4 so the step re-runs.
      unlinkSync(finalPath);
      console.log(`Removed existing final.mp4 (backup at final.before-trim.mp4 preserved)`);
    } else {
      renameSync(finalPath, backupPath);
      console.log(`Backed up final.mp4 → final.before-trim.mp4`);
    }
  }

  console.log(
    `Re-rendering ${videoId} (${row.title}) — song_count=${row.song_count} repeat_factor=${row.repeat_factor}`
  );
  const startedAt = Date.now();
  await runRenderMusicVideo(videoId, { db, projectsDir });
  const elapsedMs = Date.now() - startedAt;

  if (!existsSync(finalPath)) {
    console.error("Step completed but final.mp4 was not produced.");
    process.exit(1);
  }
  const sizeMb = (statSync(finalPath).size / 1024 / 1024).toFixed(2);
  console.log(`Done in ${(elapsedMs / 1000).toFixed(1)}s — ${finalPath} (${sizeMb} MB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
