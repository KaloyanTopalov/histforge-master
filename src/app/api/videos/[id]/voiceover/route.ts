import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { id: string };
}

/**
 * Hard upper bound on uploaded payload size. TTS narrations for a
 * 90-min HistForge script weigh in around 60-80 MB at typical bitrates;
 * 256 MB leaves plenty of headroom for higher-quality uploads while
 * still rejecting accidental movie-file PUTs.
 */
const MAX_BYTES = 256 * 1024 * 1024;

/**
 * Audio mime types we accept verbatim (the file is already an MP3, so
 * it can land at `audio/narration.mp3` as-is). The browser's reported
 * mime can be one of several aliases depending on platform.
 */
const MP3_MIMES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mpeg3",
  "audio/x-mpeg-3",
]);

/**
 * Non-MP3 audio mimes we'll accept and transcode to MP3 via ffmpeg.
 * Operator-uploaded audio commonly comes out of a DAW as WAV or M4A;
 * normalising to MP3 keeps step 06's downstream contract intact (the
 * pipeline + aeneas only know about `audio/narration.mp3`).
 */
const TRANSCODABLE_MIMES = new Set([
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/mp4",
  "audio/m4a",
  "audio/x-m4a",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/x-flac",
]);

/**
 * POST /api/videos/:id/voiceover — upload a pre-rendered voiceover for
 * a video, bypassing the TTS step.
 *
 * Wire: multipart/form-data with a single `file` field. Accepts
 * common audio mimes; MP3s land directly at
 * `<projectsDir>/<id>/audio/narration.mp3`, other formats are
 * transcoded via ffmpeg. Step 06 (`worker/steps/06-voiceover.ts`)
 * checks for that file at entry and skips the TTS call when present.
 *
 * Idempotent: overwrites any prior `narration.mp3`. The operator owns
 * the consequence of overwriting after step 06 has already run — the
 * existing Retry-step UI handles re-running from there.
 *
 * Security: id must exist in the videos table. We write only to the
 * fixed filename inside the per-video project root; no path-traversal
 * surface exposed to the request.
 */
export async function POST(
  req: Request,
  ctx: RouteCtx,
): Promise<NextResponse> {
  const db = getDb();
  if (!videosRepo.existsById(db, ctx.params.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "invalid_body", message: "Expected multipart/form-data with a `file` field." },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing_file", message: "Provide an audio file under the `file` field." },
      { status: 400 },
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "empty_file", message: "Uploaded file is empty." },
      { status: 400 },
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: "too_large",
        message: `Upload exceeds the ${Math.floor(MAX_BYTES / 1024 / 1024)} MB limit.`,
      },
      { status: 413 },
    );
  }

  const mime = (file.type || "").toLowerCase();
  const isMp3 = MP3_MIMES.has(mime);
  const needsTranscode = !isMp3 && TRANSCODABLE_MIMES.has(mime);
  if (!isMp3 && !needsTranscode) {
    return NextResponse.json(
      {
        error: "unsupported_format",
        message:
          "Upload must be an audio file (mp3, wav, m4a, aac, ogg, flac). " +
          `Browser reported mime: ${mime || "(none)"}.`,
      },
      { status: 415 },
    );
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, ctx.params.id);
  const audioDir = join(projectRoot, "audio");
  const finalPath = resolve(audioDir, "narration.mp3");

  // Belt for the fixed-filename design: confirm the resolved final
  // path is strictly under the per-video project root. Cheap, and
  // guards against PROJECTS_DIR pointing at something exotic.
  if (finalPath !== resolve(projectRoot, "audio", "narration.mp3")) {
    return NextResponse.json({ error: "invalid_path" }, { status: 500 });
  }
  if (
    finalPath !== projectRoot &&
    !finalPath.startsWith(projectRoot + sep)
  ) {
    return NextResponse.json({ error: "invalid_path" }, { status: 500 });
  }

  mkdirSync(audioDir, { recursive: true });
  const bytes = Buffer.from(await file.arrayBuffer());

  if (isMp3) {
    writeFileSync(finalPath, bytes);
    return NextResponse.json({
      ok: true,
      path: "audio/narration.mp3",
      bytes: bytes.byteLength,
      transcoded: false,
    });
  }

  // Transcode path: write the source to a sibling temp file, run
  // ffmpeg → final mp3, then delete the source. Using a sibling
  // (not /tmp) keeps the file system local to PROJECTS_DIR so no
  // cross-volume copy is required, and it survives a transcode crash
  // without leaving stray bytes in the OS temp dir.
  const sourceExt = guessExtension(mime);
  const sourcePath = join(audioDir, `narration_upload${sourceExt}`);
  writeFileSync(sourcePath, bytes);
  try {
    await transcodeToMp3(sourcePath, finalPath);
  } catch (e) {
    try { unlinkSync(sourcePath); } catch { /* best effort */ }
    return NextResponse.json(
      {
        error: "transcode_failed",
        message:
          (e instanceof Error ? e.message : String(e)) ||
          "ffmpeg could not convert the upload to MP3.",
      },
      { status: 500 },
    );
  }
  try { unlinkSync(sourcePath); } catch { /* best effort */ }

  let outputBytes = 0;
  try { outputBytes = statSync(finalPath).size; } catch { /* best effort */ }
  return NextResponse.json({
    ok: true,
    path: "audio/narration.mp3",
    bytes: outputBytes,
    transcoded: true,
    sourceMime: mime,
  });
}

function guessExtension(mime: string): string {
  if (mime === "audio/wav" || mime === "audio/x-wav" || mime === "audio/wave") return ".wav";
  if (mime === "audio/mp4" || mime === "audio/m4a" || mime === "audio/x-m4a") return ".m4a";
  if (mime === "audio/aac") return ".aac";
  if (mime === "audio/ogg") return ".ogg";
  if (mime === "audio/flac" || mime === "audio/x-flac") return ".flac";
  return ".audio";
}

/**
 * Spawn ffmpeg to transcode an arbitrary audio file to MP3. Captures
 * stderr so the route can surface the real ffmpeg error message to the
 * operator (e.g. "Unknown encoder" → install a fuller ffmpeg build).
 * Resolves on exit code 0; rejects with the captured stderr otherwise.
 */
function transcodeToMp3(src: string, dest: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y", // overwrite dest
        "-i", src,
        "-vn", // ignore any embedded artwork
        "-acodec", "libmp3lame",
        "-q:a", "2", // VBR high quality (~190 kbps)
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
      // Spawn-time failure — most likely ffmpeg not on PATH.
      reject(new Error(`ffmpeg spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolvePromise();
      } else {
        const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" | ");
        reject(new Error(`ffmpeg exited ${code}: ${tail || "no stderr output"}`));
      }
    });
  });
}
