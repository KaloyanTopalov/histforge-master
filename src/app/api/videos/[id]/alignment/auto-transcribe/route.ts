import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import { parseSrtToAlignment } from "@/lib/srt";

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
 * Reads audio/narration.mp3 from the video's project directory, ffmpeg
 * re-encodes it down to a Whisper-friendly low-bitrate mono mix, POSTs
 * it to the configured OpenAI-compatible Whisper endpoint with
 * `response_format=srt`, parses the returned SRT via the existing
 * `parseSrtToAlignment` helper, and writes the result to
 * `alignment/alignment.json`. Step 07 then detects the file at entry
 * and skips the WSL/aeneas path.
 *
 * Endpoint shape is the de-facto OpenAI `/v1/audio/transcriptions`
 * contract, so this works against OpenAI, Groq, fast-whisper-server,
 * llama.cpp's whisper-server, etc. Configure via three env vars:
 *
 *   WHISPER_API_KEY    bearer token  (required)
 *   WHISPER_BASE_URL   API root      (default: https://api.openai.com/v1)
 *   WHISPER_MODEL      model id      (default: whisper-1)
 *
 * Why SRT not verbose_json: SRT chunks Whisper's segments into
 * ~5-10-second cues, which is close enough to sentence-level for the
 * chunker (step 08). verbose_json's raw segments cluster at ~30-second
 * granularity, which produces too-coarse chunks downstream.
 */
export async function POST(_req: Request, ctx: RouteCtx): Promise<NextResponse> {
  const db = getDb();
  if (!videosRepo.existsById(db, ctx.params.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const apiKey = process.env.WHISPER_API_KEY ?? "";
  if (!apiKey) {
    return NextResponse.json(
      {
        error: "whisper_not_configured",
        message:
          "WHISPER_API_KEY is not set in .env. Add it (and optionally WHISPER_BASE_URL / WHISPER_MODEL) and restart the dev server.",
      },
      { status: 503 },
    );
  }
  const baseUrl = (process.env.WHISPER_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = process.env.WHISPER_MODEL || "whisper-1";

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

  // Downsample to a Whisper-friendly mono 16 kHz 24 kbps MP3 in a
  // sibling temp file. Speech transcription is robust at this bitrate
  // and the size reduction is the whole point — many production
  // narrations weigh in around 100 MB at the source, well over Whisper's
  // 25 MB upload cap.
  mkdirSync(alignmentDir, { recursive: true });
  const downsampledPath = join(projectRoot, "audio", "narration_whisper.mp3");
  try {
    await transcodeForWhisper(audioPath, downsampledPath);
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
        message: `Downsampled audio is ${Math.round(downsampledBytes / 1024 / 1024)} MB which exceeds the Whisper 25 MB cap. Split the narration or upload an SRT manually.`,
      },
      { status: 413 },
    );
  }

  // Build multipart body for the Whisper endpoint. Using global File
  // + Blob (undici-backed in Node 20+) lets us hand FormData straight
  // to fetch() without any third-party multipart library.
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
  // Clean up the downsampled copy regardless of outcome — it's purely
  // a transient artifact of the transcription path.
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
    model,
    baseUrl,
    durationSec: entries[entries.length - 1]?.end ?? null,
  });
}

/**
 * Mono, 16 kHz, 24 kbps MP3 — Whisper's documented preference for
 * voice content. The ~24 kbps bitrate makes a 90-min narration weigh
 * about 16 MB, comfortably under the 25 MB cap. Quality remains
 * transcription-grade because Whisper trained on similar low-bitrate
 * recordings.
 */
function transcodeForWhisper(src: string, dest: string): Promise<void> {
  return new Promise((resolveP, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y",
        "-i", src,
        "-vn",
        "-ac", "1",
        "-ar", "16000",
        "-b:a", "24k",
        "-acodec", "libmp3lame",
        dest,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
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
