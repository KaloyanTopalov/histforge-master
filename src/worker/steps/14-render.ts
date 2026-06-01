import type { Database as DatabaseType } from "better-sqlite3";
import { spawn } from "node:child_process";
import type { Step } from "@/worker/pipeline";
import { getDb } from "@/lib/db";
import { getSetting } from "@/lib/settings";
import { appendLog } from "@/lib/logger";
import { render } from "@/lib/render";
import {
  IMAGE_STYLE_DEFINITIONS,
  type ImageStyleDefinition,
} from "@/lib/image/styles";
import {
  resolveDrawOnPythonPath,
  verifyDrawOnPython,
} from "@/lib/draw-on-python";
import type { WorkflowSnapshot } from "@/types";

/**
 * Deliberate exception to the {@link makeStepContext} convention used by
 * the other doer-steps. This module keeps a `*Deps` shape + named `runRender`
 * function because its test-only injection points (`exec` / `probe` — the
 * ffmpeg and ffprobe wrappers) are non-cross-cutting and have no home on
 * `StepContext`. Promoting them would expand the cross-cutting surface for
 * one step's benefit. See docs/handoffs/2026-05-16-step-deps-collapse-plan.md
 * for the design call.
 */
export interface RenderStepDeps {
  db?: DatabaseType;
  projectsDir?: string;
  /**
   * Optional exec override for tests. Production builds a signal-aware
   * exec from `signal` so AbortController.abort kills the in-flight
   * ffmpeg process; tests typically pass `vi.fn()`.
   */
  exec?: (args: string[]) => void | Promise<void>;
  /**
   * Optional probe override for tests. Production builds a signal-aware
   * ffprobe wrapper from `signal`; tests typically pass
   * `vi.fn().mockResolvedValue(<seconds>)`.
   */
  probe?: (path: string) => Promise<number>;
  /**
   * Cancellation signal — wired by the orchestrator. When aborted,
   * spawned ffmpeg processes receive SIGTERM (Linux/macOS) or are killed
   * (Windows) via Node's built-in signal-aware spawn.
   */
  signal?: AbortSignal;
  /**
   * Snapshot override for tests that need to drive a specific
   * `image_style` without seeding a workflow row. Production loads it
   * from `ctx.snapshot` via the orchestrator. When omitted (no snapshot
   * available at all), revealEffect defaults to "none" — preserving the
   * pre-Phase-7 cinematic-only behavior.
   */
  snapshot?: WorkflowSnapshot;
  /**
   * Optional health-check override for tests. Production builds a
   * `verifyDrawOnPython(...)` closure over the resolved python path.
   * Tests can pass `vi.fn().mockResolvedValue(undefined)` to skip the
   * real spawn.
   */
  drawOnHealthCheck?: () => Promise<void>;
}

/**
 * Resolve the reveal-effect carried by the snapshot's image_style. Forgiving
 * — null / undefined / unknown / cinematic all collapse to "none" so a
 * pinned snapshot with a removed style name doesn't crash render. Mirrors
 * the materializer's lookup in `lib/workflows.ts`.
 */
function resolveRevealEffect(
  imageStyle: string | null | undefined
): "none" | "draw_on" {
  if (imageStyle == null) return "none";
  const def = (
    IMAGE_STYLE_DEFINITIONS as Record<string, ImageStyleDefinition | undefined>
  )[imageStyle];
  return def?.reveal_effect === "draw_on" ? "draw_on" : "none";
}

/**
 * Build a `spawn`-based ffmpeg exec. Async + signal-aware so a delete
 * mid-render kills the child process instead of waiting for it to
 * complete (the original `execFileSync` was structurally uninterruptible).
 *
 * Stderr is buffered and surfaced in the rejection message so a user
 * looking at pipeline.log can see what ffmpeg complained about.
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
        // Cap to avoid runaway memory; ffmpeg can be chatty on long renders.
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code, sig) => {
        if (code === 0) {
          resolve();
          return;
        }
        // Tail enough to capture encoder-init complaints (NVENC / AMF
        // / libx264 print their reasons in the last ~10-20 lines before
        // the muxer's downstream "Nothing was written" closer).
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
 * Build a `spawn`-based ffprobe wrapper. Returns the media file's duration
 * in seconds. Mirrors `buildFfmpegExec`'s signal handling and stderr-tail
 * rejection shape. ffprobe ships alongside ffmpeg (see README install
 * notes) — no separate dependency.
 *
 * NaN stdout means the input file is corrupted/zero-length; we reject
 * loudly so the renderer fails on the broken file instead of feeding
 * `offset=NaN` into the xfade filter.
 */
function buildFfprobeExec(
  signal?: AbortSignal
): (path: string) => Promise<number> {
  return (path: string) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(
        "ffprobe",
        [
          "-v", "error",
          "-show_entries", "format=duration",
          "-of", "default=noprint_wrappers=1:nokey=1",
          path,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          signal,
        }
      );
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
      });
      child.on("error", (err) => reject(err));
      child.on("exit", (code, sig) => {
        if (code !== 0) {
          const tail = stderr.trim().split("\n").slice(-3).join(" | ");
          reject(
            new Error(
              `ffprobe exited with ${code === null ? `signal=${sig}` : `code=${code}`}: ${tail}`
            )
          );
          return;
        }
        const duration = parseFloat(stdout);
        if (Number.isNaN(duration)) {
          reject(
            new Error(
              `ffprobe returned non-numeric duration for ${path}: ${stdout.trim() || "(empty)"}`
            )
          );
          return;
        }
        resolve(duration);
      });
    });
}

/**
 * Step 14 — render. Reads settings from the DB, then delegates to
 * `lib/render.ts` which builds and spawns ffmpeg commands.
 */
export async function runRender(
  videoId: string,
  deps: RenderStepDeps = {}
): Promise<void> {
  const db = deps.db ?? getDb();
  const projectsDir =
    deps.projectsDir ?? process.env.PROJECTS_DIR ?? "./projects";

  const aspectRatio = getSetting("aspect_ratio", db) as string;
  const longEdgePx = getSetting("long_edge_px", db) as number;
  const framerate = getSetting("framerate", db) as number;
  const videoEncoder = getSetting("video_encoder", db);
  const motion = getSetting("render_image_motion", db);

  const exec = deps.exec ?? buildFfmpegExec(deps.signal);
  const probe = deps.probe ?? buildFfprobeExec(deps.signal);

  // Reveal-effect resolution: snapshot.image_style → styles registry →
  // reveal_effect. Defaults to "none" when the snapshot is absent (tests
  // that don't pass one) or carries an unknown / null style name — same
  // forgiving spirit as the materializer's lookup.
  const revealEffect = resolveRevealEffect(deps.snapshot?.image_style);
  let drawOnHealthCheck: (() => Promise<void>) | undefined;
  if (revealEffect === "draw_on") {
    drawOnHealthCheck =
      deps.drawOnHealthCheck ??
      (() => {
        const pythonPath = resolveDrawOnPythonPath({
          setting: getSetting("draw_on_python_path", db),
        });
        return verifyDrawOnPython({ pythonPath });
      });
  }

  await render(videoId, {
    projectsDir,
    aspectRatio,
    longEdgePx,
    framerate,
    videoEncoder,
    motion,
    revealEffect,
    drawOnHealthCheck,
    exec,
    probe,
    log: (message) => appendLog(videoId, "render", message, projectsDir),
  });
}

export const step: Step = {
  name: "render",
  module: "glue",
  label: "Render",
  description: "Renders the final video with ffmpeg from chunks, audio, images, and clips.",
  inputs: [
    "chunks/chunks.json",
    "audio/narration.mp3",
    "images/*.png",
    "videos/clip/*.mp4",
  ],
  // render also rm -rf's render/ at start — belt-and-suspenders.
  outputs: ["render", "final.mp4"],
  // render/ is transient, not produced for downstream.
  produces: ["final.mp4"],
  run(videoId, ctx) {
    return runRender(videoId, {
      db: ctx.db,
      projectsDir: ctx.projectsDir,
      signal: ctx.signal,
      snapshot: ctx.snapshot,
    });
  },
};
