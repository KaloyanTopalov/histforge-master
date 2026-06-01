/**
 * Phase 8 cinematic smoke — visual backstop for Phase 6's byte-identity
 * guarantee. Uses the SAME three real doodle images as the doodle smoke
 * (visually inappropriate for cinematic, but the smoke is about the
 * RENDER PATH not the content) so the comparison is cleanly attributable
 * to the gate, not to differing inputs.
 *
 * Confirms:
 *   - No `clips_drawn/` dir is created
 *   - render() produces final.mp4 via the cinematic path (ken_burns motion
 *     here for visual signature)
 *
 * The byte-identity of the ken_burns / static -vf strings is pinned by
 * render.test.ts:160-179 / :280-294. This smoke is just the visual
 * backstop the user asked for.
 *
 * Run: `npx tsx scripts/smoke-cinematic.ts`
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve } from "node:path";
import { render } from "@/lib/render";
import type { Chunk } from "@/types";

const REPO_ROOT = resolve(__dirname, "..");
const SMOKE_ROOT = join(REPO_ROOT, "smoke-output", "cinematic");
const VIDEO_ID = "cinematic-smoke";
const PROJECTS_DIR = SMOKE_ROOT;
const PROJ_DIR = join(PROJECTS_DIR, VIDEO_ID);

const REAL_IMAGE_DIR = join(
  REPO_ROOT,
  "projects",
  "01KSX7F0ZYYQN9G0ZHHHAT2ZXH",
  "images"
);
const SOURCE_IMAGE_IDS = ["image_004", "image_005", "image_006"];

const CHUNK_DURATION_SEC = 5;
const FRAMERATE = 30;

function ffmpegExec(args: string[]): Promise<void> {
  return new Promise<void>((resolveP, rejectP) => {
    const child = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += c.toString("utf-8");
    });
    child.on("error", rejectP);
    child.on("exit", (code, sig) => {
      if (code === 0) {
        resolveP();
        return;
      }
      const tail = stderr.trim().split("\n").slice(-15).join(" | ");
      rejectP(
        new Error(
          `ffmpeg exited with ${code === null ? `signal=${sig}` : `code=${code}`}: ${tail}`
        )
      );
    });
  });
}

function ffprobe(path: string): Promise<number> {
  return new Promise<number>((resolveP, rejectP) => {
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
    );
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf-8")));
    child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf-8")));
    child.on("error", rejectP);
    child.on("exit", (code) => {
      if (code !== 0) {
        rejectP(new Error(`ffprobe failed: ${stderr.trim()}`));
        return;
      }
      const d = parseFloat(stdout);
      if (Number.isNaN(d)) {
        rejectP(new Error(`ffprobe non-numeric: ${stdout}`));
        return;
      }
      resolveP(d);
    });
  });
}

async function main(): Promise<void> {
  const overallStart = Date.now();

  rmSync(PROJ_DIR, { recursive: true, force: true });
  mkdirSync(join(PROJ_DIR, "chunks"), { recursive: true });
  mkdirSync(join(PROJ_DIR, "images"), { recursive: true });
  mkdirSync(join(PROJ_DIR, "audio"), { recursive: true });

  for (let i = 0; i < SOURCE_IMAGE_IDS.length; i++) {
    const srcId = SOURCE_IMAGE_IDS[i];
    const dstId = `image_${String(i + 1).padStart(3, "0")}`;
    copyFileSync(
      join(REAL_IMAGE_DIR, `${srcId}.png`),
      join(PROJ_DIR, "images", `${dstId}.png`)
    );
    console.log(`[setup] image ${srcId} -> ${dstId}.png`);
  }

  const chunks: Chunk[] = SOURCE_IMAGE_IDS.map((_, i) => ({
    id: `image_${String(i + 1).padStart(3, "0")}`,
    kind: "image",
    start: i * CHUNK_DURATION_SEC,
    end: (i + 1) * CHUNK_DURATION_SEC,
    text: "smoke",
    prompt: "smoke",
  }));
  writeFileSync(
    join(PROJ_DIR, "chunks", "chunks.json"),
    JSON.stringify(chunks, null, 2)
  );

  const totalSec = chunks.length * CHUNK_DURATION_SEC;
  const narrationPath = join(PROJ_DIR, "audio", "narration.mp3");
  await ffmpegExec([
    "-f",
    "lavfi",
    "-i",
    `anullsrc=r=22050:cl=mono`,
    "-t",
    String(totalSec),
    "-c:a",
    "libmp3lame",
    narrationPath,
  ]);
  console.log(`[setup] silent narration written: ${narrationPath}`);

  // Render — cinematic path. ken_burns motion picked for visual signature
  // (the zoompan is what most operators recognize as "the old behavior").
  // No clips_drawn directory should be created; no health check is wired.
  const renderStart = Date.now();
  console.log(`[render] starting cinematic (revealEffect=none, motion=ken_burns)…`);
  await render(VIDEO_ID, {
    projectsDir: PROJECTS_DIR,
    aspectRatio: "16:9",
    longEdgePx: 1920,
    framerate: FRAMERATE,
    videoEncoder: "libx264",
    motion: "ken_burns",
    revealEffect: "none",
    exec: ffmpegExec,
    probe: ffprobe,
    log: (msg) => console.log(`[render] ${msg}`),
  });
  const renderSec = (Date.now() - renderStart) / 1000;

  const finalPath = join(PROJ_DIR, "final.mp4");
  if (!existsSync(finalPath)) {
    throw new Error(`Expected final.mp4 at ${finalPath}`);
  }
  const finalDuration = await ffprobe(finalPath);

  // Negative pin: NO clips_drawn directory should exist on the cinematic path.
  const clipsDrawnDir = join(PROJ_DIR, "clips_drawn");
  if (existsSync(clipsDrawnDir)) {
    throw new Error(
      `clips_drawn/ exists at ${clipsDrawnDir} — cinematic path should never create it.`
    );
  }

  const overallSec = (Date.now() - overallStart) / 1000;
  console.log(`\n=== Cinematic smoke complete ===`);
  console.log(`  Source images: projects/01KSX7F0ZYYQN9G0ZHHHAT2ZXH/images/{${SOURCE_IMAGE_IDS.join(", ")}}.png`);
  console.log(`  clips_drawn/ : (absent — confirmed cinematic path)`);
  console.log(`  final.mp4    : ${finalPath}`);
  console.log(`  duration     : ${finalDuration.toFixed(2)}s (expected ~${totalSec}s)`);
  console.log(`  render only  : ${renderSec.toFixed(2)}s`);
  console.log(`  overall      : ${overallSec.toFixed(2)}s`);
}

main().catch((err) => {
  console.error("[smoke-cinematic] failed:", err);
  process.exit(1);
});
