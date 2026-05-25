import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import { parseSrtToAlignment } from "@/lib/srt";
import { resolveWhisperInstall } from "@/lib/whisper-install";

interface RouteCtx {
  params: { id: string };
}

/**
 * Cap on the file we send to Whisper. OpenAI's hosted Whisper rejects
 * payloads above 25 MB; Groq's free tier is the same. We downsample to
 * mono 16 kHz at 24 kbps MP3 before sending, which fits ~2.5 hours of
 * narration into the cap. Longer audio still throws — the operator can
 * upload an SRT manually or split the audio into shorter videos.
 */
const WHISPER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;

/**
 * POST /api/videos/:id/alignment/auto-transcribe
 *
 * Two execution paths, selected by env:
 *
 *   1. LOCAL (preferred when configured): WHISPER_LOCAL_BIN +
 *      WHISPER_LOCAL_MODEL point at a whisper.cpp `main` binary and
 *      a ggml model file. The route ffmpeg-converts narration.mp3 to
 *      mono 16 kHz PCM WAV (whisper.cpp's required input shape),
 *      spawns the binary with `-osrt`, reads the resulting `.srt`,
 *      parses it via `parseSrtToAlignment`, writes `alignment.json`.
 *      No network call, no upload size cap.
 *
 *   2. HTTP API (fallback when no local config): POSTs the audio to
 *      an OpenAI-compatible `/v1/audio/transcriptions` endpoint
 *      (OpenAI, Groq, self-hosted whisper-server, etc.) with
 *      `response_format=srt`. Subject to the endpoint's upload cap
 *      (25 MB on OpenAI/Groq free).
 *
 * Both paths converge on the same `alignment/alignment.json` shape, so
 * step 07's bypass guard treats them identically. SRT output (vs
 * verbose_json) is chosen so the chunker step (08) gets ~5-10-second
 * cue boundaries instead of Whisper's coarser ~30-second segments.
 *
 * Configure via env (see `.env.example`):
 *
 *   LOCAL mode:
 *     WHISPER_LOCAL_BIN     path to whisper.cpp `main`/`whisper-cli` binary
 *     WHISPER_LOCAL_MODEL   path to ggml .bin model file
 *     WHISPER_LOCAL_LANG    optional ISO 639-1 code (default: en)
 *     WHISPER_LOCAL_THREADS optional thread count (default: cpu count)
 *
 *   HTTP API mode:
 *     WHISPER_API_KEY       bearer token (required)
 *     WHISPER_BASE_URL      API root (default: https://api.openai.com/v1)
 *     WHISPER_MODEL         model id (default: whisper-1)
 */
export async function POST(_req: Request, ctx: RouteCtx): Promise<NextResponse> {
  const db = getDb();
  if (!videosRepo.existsById(db, ctx.params.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, ctx.params.id);
  const audioPath = join(projectRoot, "audio", "narration.mp3");
  const alignmentDir = join(projectRoot, "alignment");
  const finalPath = resolve(alignmentDir, "alignment.json");

  if (
    finalPath !== resolve(projectRoot, "alignment", "alignment.json") ||
    !finalPath.startsWith(projectRoot + sep)
  ) {
    return NextResponse.json({ error: "invalid_path" }, { status: 500 });
  }

  if (!existsSync(audioPath) || statSync(audioPath).size === 0) {
    return NextResponse.json(
      {
        error: "no_audio",
        message:
          "audio/narration.mp3 is missing or empty. Upload a voiceover (or run the voiceover step) before transcribing.",
      },
      { status: 400 },
    );
  }

  mkdirSync(alignmentDir, { recursive: true });

  // Local whisper.cpp mode wins when configured. Explicit env vars
  // take priority and get granular error reporting (so a typo in
  // WHISPER_LOCAL_BIN surfaces as local_bin_missing instead of being
  // silently demoted to "not configured"). If env vars are blank, fall
  // back to the auto-installed copy under vendor/whisper/.
  const envBin = (process.env.WHISPER_LOCAL_BIN || "").trim();
  const envModel = (process.env.WHISPER_LOCAL_MODEL || "").trim();
  if (envBin && envModel) {
    return runLocalWhisper({
      projectRoot,
      audioPath,
      finalPath,
      localBin: envBin,
      localModel: envModel,
    });
  }
  const installed = resolveWhisperInstall();
  if (installed.source === "vendor" && installed.binPath && installed.modelPath) {
    return runLocalWhisper({
      projectRoot,
      audioPath,
      finalPath,
      localBin: installed.binPath,
      localModel: installed.modelPath,
    });
  }

  const apiKey = process.env.WHISPER_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "whisper_not_configured",
        message:
          "Whisper isn't configured. Easiest: click \"Install local Whisper\" on the alignment card to auto-download whisper.cpp + a base model. Or set WHISPER_LOCAL_BIN + WHISPER_LOCAL_MODEL (offline) / WHISPER_API_KEY (hosted) in .env and restart the dev server.",
      },
      { status: 503 },
    );
  }
  return runHttpWhisper({
    apiKey,
    projectRoot,
    audioPath,
    finalPath,
  });
}

interface RunCtx {
  projectRoot: string;
  audioPath: string;
  finalPath: string;
}

async function runHttpWhisper(
  args: RunCtx & { apiKey: string },
): Promise<NextResponse> {
  const { apiKey, projectRoot, audioPath, finalPath } = args;
  const baseUrl = (process.env.WHISPER_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.WHISPER_MODEL || "whisper-1";

  const downsampledPath = join(projectRoot, "audio", "narration_whisper.mp3");
  try {
    await transcodeForWhisperMp3(audioPath, downsampledPath);
  } catch (e) {
    return NextResponse.json(
      {
        error: "downsample_failed",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  let downsampledBytes = 0;
  try { downsampledBytes = statSync(downsampledPath).size; } catch { /* checked below */ }
  if (downsampledBytes === 0) {
    try { unlinkSync(downsampledPath); } catch { /* best effort */ }
    return NextResponse.json(
      { error: "downsample_failed", message: "ffmpeg produced an empty file." },
      { status: 500 },
    );
  }
  if (downsampledBytes > WHISPER_UPLOAD_MAX_BYTES) {
    try { unlinkSync(downsampledPath); } catch { /* best effort */ }
    return NextResponse.json(
      {
        error: "audio_too_long",
        message: `Downsampled audio is ${Math.round(downsampledBytes / 1024 / 1024)} MB which exceeds the Whisper 25 MB cap. Use local Whisper (no upload limit) or upload an SRT manually.`,
      },
      { status: 413 },
    );
  }

  const audioBytes = readFileSync(downsampledPath);
  const blob = new Blob([audioBytes], { type: "audio/mpeg" });
  const fileForWhisper = new File([blob], "narration_whisper.mp3", { type: "audio/mpeg" });
  const form = new FormData();
  form.append("file", fileForWhisper);
  form.append("model", model);
  form.append("response_format", "srt");

  let whisperResp: Response;
  try {
    whisperResp = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (e) {
    try { unlinkSync(downsampledPath); } catch { /* best effort */ }
    return NextResponse.json(
      {
        error: "whisper_unreachable",
        message: `Could not reach ${baseUrl}/audio/transcriptions: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 502 },
    );
  }

  const responseText = await whisperResp.text();
  try { unlinkSync(downsampledPath); } catch { /* best effort */ }

  if (!whisperResp.ok) {
    return NextResponse.json(
      {
        error: "whisper_error",
        status: whisperResp.status,
        message: `Whisper endpoint returned HTTP ${whisperResp.status}: ${responseText.slice(0, 500)}`,
      },
      { status: 502 },
    );
  }

  let entries;
  try {
    entries = parseSrtToAlignment(responseText);
  } catch (e) {
    return NextResponse.json(
      {
        error: "parse_failed",
        message: `Whisper returned a response we couldn't parse as SRT: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }

  writeFileSync(finalPath, JSON.stringify(entries) + "\n", "utf-8");

  return NextResponse.json({
    ok: true,
    path: "alignment/alignment.json",
    entries: entries.length,
    mode: "http",
    model,
    baseUrl,
    durationSec: entries[entries.length - 1]?.end ?? null,
  });
}

async function runLocalWhisper(
  args: RunCtx & { localBin: string; localModel: string },
): Promise<NextResponse> {
  const { projectRoot, audioPath, finalPath, localBin, localModel } = args;

  if (!existsSync(localBin)) {
    return NextResponse.json(
      {
        error: "local_bin_missing",
        message: `WHISPER_LOCAL_BIN points at ${localBin} which does not exist on disk.`,
      },
      { status: 503 },
    );
  }
  if (!existsSync(localModel)) {
    return NextResponse.json(
      {
        error: "local_model_missing",
        message: `WHISPER_LOCAL_MODEL points at ${localModel} which does not exist on disk.`,
      },
      { status: 503 },
    );
  }

  // whisper.cpp requires 16 kHz mono PCM WAV. Convert the MP3 first.
  const wavPath = join(projectRoot, "audio", "narration_whisper.wav");
  try {
    await transcodeForWhisperWav(audioPath, wavPath);
  } catch (e) {
    return NextResponse.json(
      {
        error: "downsample_failed",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }

  // whisper.cpp's -of takes a basename (no extension); the binary
  // appends .srt automatically when -osrt is set. Sibling location
  // keeps everything inside the project root for easy cleanup.
  const srtBasename = join(projectRoot, "alignment", "narration_whisper");
  const srtFullPath = srtBasename + ".srt";

  const lang = (process.env.WHISPER_LOCAL_LANG || "en").trim();
  const threadsRaw = (process.env.WHISPER_LOCAL_THREADS || "").trim();
  const threads = /^\d+$/.test(threadsRaw) ? threadsRaw : "";

  const cliArgs = [
    "-m", localModel,
    "-f", wavPath,
    "-l", lang,
    "-osrt",
    "-of", srtBasename,
    "--no-prints",
  ];
  if (threads) cliArgs.push("-t", threads);

  try {
    await spawnWhisperCli(localBin, cliArgs);
  } catch (e) {
    try { unlinkSync(wavPath); } catch { /* best effort */ }
    try { unlinkSync(srtFullPath); } catch { /* best effort */ }
    return NextResponse.json(
      {
        error: "local_whisper_failed",
        message: `${basename(localBin)} failed: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }

  if (!existsSync(srtFullPath)) {
    try { unlinkSync(wavPath); } catch { /* best effort */ }
    return NextResponse.json(
      {
        error: "local_whisper_no_output",
        message: `${basename(localBin)} exited cleanly but produced no SRT at ${srtFullPath}.`,
      },
      { status: 500 },
    );
  }

  const srt = readFileSync(srtFullPath, "utf-8");
  try { unlinkSync(wavPath); } catch { /* best effort */ }
  try { unlinkSync(srtFullPath); } catch { /* best effort */ }

  let entries;
  try {
    entries = parseSrtToAlignment(srt);
  } catch (e) {
    return NextResponse.json(
      {
        error: "parse_failed",
        message: `Local Whisper produced output we couldn't parse as SRT: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }

  writeFileSync(finalPath, JSON.stringify(entries) + "\n", "utf-8");

  return NextResponse.json({
    ok: true,
    path: "alignment/alignment.json",
    entries: entries.length,
    mode: "local",
    model: basename(localModel),
    durationSec: entries[entries.length - 1]?.end ?? null,
  });
}

/**
 * Mono, 16 kHz, 24 kbps MP3 — for the HTTP API path. The ~24 kbps
 * bitrate makes a 90-min narration weigh about 16 MB, comfortably
 * under OpenAI/Groq's 25 MB cap. Quality remains transcription-grade
 * because Whisper trained on similar low-bitrate recordings.
 */
function transcodeForWhisperMp3(src: string, dest: string): Promise<void> {
  return runFfmpeg([
    "-y", "-i", src,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "24k",
    "-acodec", "libmp3lame",
    dest,
  ]);
}

/**
 * Mono, 16 kHz, signed-16 PCM WAV — whisper.cpp's required input
 * shape. No bitrate cap matters here because the WAV stays local
 * and is consumed in the same process tree.
 */
function transcodeForWhisperWav(src: string, dest: string): Promise<void> {
  return runFfmpeg([
    "-y", "-i", src,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-c:a", "pcm_s16le",
    dest,
  ]);
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    proc.on("error", (err) => {
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) resolveP();
      else {
        const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" | ");
        reject(new Error(`ffmpeg exited ${code}: ${tail || "no stderr output"}`));
      }
    });
  });
}

/**
 * Spawn whisper.cpp's `main` (or `whisper-cli`) binary with the given
 * arguments. Captures stderr for diagnostics on non-zero exit. Whisper
 * can take a long time on CPU — caller controls the surrounding
 * request timeout.
 */
function spawnWhisperCli(bin: string, args: string[]): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(bin, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 16000) stderr = stderr.slice(-16000);
    });
    proc.on("error", (err) => {
      reject(new Error(`${basename(bin)} spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) resolveP();
      else {
        const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-5).join(" | ");
        reject(new Error(`exited ${code}: ${tail || "no stderr output"}`));
      }
    });
  });
}
