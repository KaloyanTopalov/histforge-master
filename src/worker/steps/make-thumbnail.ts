import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Step } from "@/worker/pipeline";

/**
 * Test-only injection surface — matches the render.ts / generate-loop-clip
 * shape (`*Deps` + `runX(videoId, deps)` + `Step.run` calls `runX`). `exec`
 * lets tests verify the assembled ffmpeg args without spawning a real
 * process; `signal` is wired into the default exec so a delete mid-step
 * kills the child (`project_long_running_step_cancellation`).
 */
export interface MakeThumbnailDeps {
  projectsDir?: string;
  exec?: (args: string[]) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * Signal-aware ffmpeg spawn. Mirrors the generate-loop-clip pattern: spawn
 * with `signal` so AbortController.abort kills the in-flight process;
 * stderr is buffered + tailed into the rejection message so a user reading
 * pipeline.log can see what ffmpeg complained about.
 */
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

export async function runMakeThumbnail(
  videoId: string,
  deps: MakeThumbnailDeps = {}
): Promise<void> {
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";
  const projDir = join(projectsDir, videoId);
  mkdirSync(projDir, { recursive: true });

  const inputPath = join(projDir, "loop_image.png");
  const outPath = join(projDir, "thumbnail.jpg");
  if (existsSync(outPath)) return;

  const exec = deps.exec ?? buildFfmpegExec(deps.signal);
  await exec([
    "-i", inputPath,
    "-vf",
    "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black",
    "-frames:v", "1",
    "-q:v", "2",
    outPath,
  ]);
}

export const step: Step = {
  name: "make_thumbnail",
  module: "music_video",
  label: "Make thumbnail",
  description: "Crops loop_image.png into a 1920×1080 thumbnail.jpg via ffmpeg.",
  inputs: ["loop_image.png"],
  outputs: ["thumbnail.jpg"],
  run(videoId, ctx) {
    return runMakeThumbnail(videoId, {
      projectsDir: ctx.projectsDir,
      signal: ctx.signal,
    });
  },
};
