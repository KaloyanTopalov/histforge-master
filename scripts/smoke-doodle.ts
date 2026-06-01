/**
 * Phase 8 doodle smoke. Bypasses upstream pipeline (LLM / TTS / Magnific
 * HITL) and exercises the Phase 6+7 code path directly with real
 * subprocesses: the production `render()` function from `@/lib/render`,
 * the real `python -m draw_on` CLI, and real ffmpeg.
 *
 * Produces `smoke-output/doodle/<videoId>/render/final.mp4`. Watch the
 * crossfade between image N and N+1 — that's the tpad assumption's moment
 * of truth.
 *
 * Run: `npx tsx scripts/smoke-doodle.ts`
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { render } from "@/lib/render";
import type { Chunk } from "@/types";
import {
  resolveDrawOnPythonPath,
  runDrawOnCli,
  verifyDrawOnPython,
} from "@/lib/draw-on-python";

const REPO_ROOT = resolve(__dirname, "..");
const SMOKE_ROOT = join(REPO_ROOT, "smoke-output", "doodle");
const VIDEO_ID = "doodle-smoke";
const PROJECTS_DIR = SMOKE_ROOT;
const PROJ_DIR = join(PROJECTS_DIR, VIDEO_ID);

// Real-content source: three consecutive doodle images from the earlier
// run, straddling the Session-1 baseline (image_005). Using real content
// doubles the smoke as a content-quality check AND a crossfade check.
const REAL_DOODLE_DIR = join(
  REPO_ROOT,
  "projects",
  "01KSX7F0ZYYQN9G0ZHHHAT2ZXH",
  "images"
);
const SOURCE_IMAGE_IDS = ["image_004", "image_005", "image_006"];

const CHUNK_DURATION_SEC = 5;
const FRAMERATE = 30;

// Reasonable ffmpeg exec — captures stderr tail so failures are diagnosable.
function ffmpegExec(args: string[]): Promise<void> {
  return new Promise<void>((resolveP, rejectP) => {
    const child = spawn("ffmpeg", ["-y", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
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
        rejectP(new Error(`ffprobe non-numeric duration: ${stdout}`));
        return;
      }
      resolveP(d);
    });
  });
}

async function main(): Promise<void> {
  const overallStart = Date.now();

  // 1. Clean + setup project dir.
  rmSync(PROJ_DIR, { recursive: true, force: true });
  mkdirSync(join(PROJ_DIR, "chunks"), { recursive: true });
  mkdirSync(join(PROJ_DIR, "images"), { recursive: true });
  mkdirSync(join(PROJ_DIR, "audio"), { recursive: true });

  // 2. Copy real doodle images into the smoke project. The IDs we keep
  // are image_001/002/003 (sequential) so chunks.json / clips_drawn lookups
  // stay tidy.
  for (let i = 0; i < SOURCE_IMAGE_IDS.length; i++) {
    const srcId = SOURCE_IMAGE_IDS[i];
    const dstId = `image_${String(i + 1).padStart(3, "0")}`;
    const srcPath = join(REAL_DOODLE_DIR, `${srcId}.png`);
    const dstPath = join(PROJ_DIR, "images", `${dstId}.png`);
    if (!existsSync(srcPath)) {
      throw new Error(
        `Real source image missing: ${srcPath}. Cannot run real-content smoke.`
      );
    }
    copyFileSync(srcPath, dstPath);
    console.log(`[setup] image ${srcId} -> ${dstId}.png`);
  }

  // 3. Write chunks.json — 3 image chunks, 5s each.
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

  // 4. Synthesize silent narration matching the total chunk span.
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

  // 5. Run draw-on per image (real Python subprocess). Time each one.
  const pythonPath = resolveDrawOnPythonPath({ setting: "" });
  console.log(`[draw-on] python: ${pythonPath}`);
  await verifyDrawOnPython({ pythonPath });
  console.log(`[draw-on] health check OK`);

  mkdirSync(join(PROJ_DIR, "clips_drawn"), { recursive: true });
  const drawTimes: Array<{ id: string; sec: number }> = [];
  const drawStart = Date.now();
  for (const chunk of chunks) {
    const imagePath = join(PROJ_DIR, "images", `${chunk.id}.png`);
    const outputPath = join(PROJ_DIR, "clips_drawn", `${chunk.id}.mp4`);
    const t0 = Date.now();
    process.stdout.write(`[draw-on] ${chunk.id}: `);
    await runDrawOnCli({
      pythonPath,
      imagePath,
      durationSec: chunk.end - chunk.start,
      outputPath,
      log: () => {
        /* swallow chatter — we just want the wall time */
      },
    });
    const sec = (Date.now() - t0) / 1000;
    drawTimes.push({ id: chunk.id, sec });
    process.stdout.write(`${sec.toFixed(2)}s\n`);
  }
  const drawTotalSec = (Date.now() - drawStart) / 1000;
  console.log(`[draw-on] total: ${drawTotalSec.toFixed(2)}s`);

  // 6. Real render via production render() function.
  const renderStart = Date.now();
  console.log(`[render] starting…`);
  await render(VIDEO_ID, {
    projectsDir: PROJECTS_DIR,
    aspectRatio: "16:9",
    longEdgePx: 1920,
    framerate: FRAMERATE,
    videoEncoder: "libx264",
    motion: "static",
    revealEffect: "draw_on",
    drawOnHealthCheck: () => verifyDrawOnPython({ pythonPath }),
    exec: ffmpegExec,
    probe: ffprobe,
    log: (msg) => console.log(`[render] ${msg}`),
  });
  const renderSec = (Date.now() - renderStart) / 1000;

  // 7. Verify the expected outputs.
  const finalPath = join(PROJ_DIR, "final.mp4");
  if (!existsSync(finalPath)) {
    throw new Error(`Expected final.mp4 at ${finalPath} — render produced nothing.`);
  }
  const finalDuration = await ffprobe(finalPath);

  const clipsDir = join(PROJ_DIR, "clips_drawn");
  const drawnFiles = readdirSync(clipsDir).filter((f) => f.endsWith(".mp4"));
  if (drawnFiles.length !== chunks.length) {
    throw new Error(
      `clips_drawn/ has ${drawnFiles.length} files; expected ${chunks.length}`
    );
  }

  const overallSec = (Date.now() - overallStart) / 1000;
  console.log(`\n=== Doodle smoke complete ===`);
  console.log(`  Real-content source: projects/01KSX7F0ZYYQN9G0ZHHHAT2ZXH/images/{${SOURCE_IMAGE_IDS.join(", ")}}.png`);
  console.log(`  clips_drawn/: ${drawnFiles.length} files (${drawnFiles.join(", ")})`);
  console.log(`  final.mp4   : ${finalPath}`);
  console.log(`  duration    : ${finalDuration.toFixed(2)}s (expected ~${totalSec}s)`);
  console.log(`  per-image draw-on times:`);
  for (const { id, sec } of drawTimes) {
    console.log(`    ${id}: ${sec.toFixed(2)}s`);
  }
  console.log(`  draw-on total: ${drawTotalSec.toFixed(2)}s`);
  console.log(`  render only  : ${renderSec.toFixed(2)}s`);
  console.log(`  overall      : ${overallSec.toFixed(2)}s`);
}

main().catch((err) => {
  console.error("[smoke-doodle] failed:", err);
  process.exit(1);
});
