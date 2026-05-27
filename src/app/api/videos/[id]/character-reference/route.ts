import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import {
  CHARACTER_REFERENCE_ACCEPTED_MIMES,
  CHARACTER_REFERENCE_BASENAME,
} from "@/lib/character-reference";

interface RouteCtx {
  params: { id: string };
}

/**
 * Hard upper bound on uploaded payload size. A reference image is
 * typically well under 5 MB; 32 MB leaves headroom for higher-
 * resolution uploads (the Flow extension's `uploadImage` doesn't care
 * about source dimensions) while still rejecting accidental video-file
 * PUTs.
 */
const MAX_BYTES = 32 * 1024 * 1024;

/**
 * POST /api/videos/:id/character-reference — upload a per-video
 * character reference image. The worker's image-enqueue path picks it
 * up via `findCharacterReference` and the Flow dispatch route emits an
 * artifact URL on every `createImage` task; the youforge-flow extension
 * uploads it as the `imageInputs` reference for the Flow API call,
 * which is the path Flow uses to lock character identity across shots.
 *
 * Wire: multipart/form-data with a single `file` field. Accepts PNG,
 * JPEG, and WebP — but always normalizes to a single PNG file at
 * `projects/<id>/character_reference.png`. Non-PNG inputs are
 * transcoded via ffmpeg before writing.
 *
 * Stable-basename design (set on 2026-05-26 after a Codex review):
 *   Pending Flow queue rows store the relative path captured at
 *   enqueue time. If the upload route used the source extension (jpg,
 *   webp, etc.) those rows would dangle when an operator re-uploaded
 *   with a different format. Forcing one canonical basename means a
 *   re-upload can never invalidate in-flight reference URLs.
 *
 * Idempotent: re-uploading replaces the prior file. The operator owns
 * the consequence of re-uploading after Flow has already generated
 * images using the previous reference — those images stay as-is until
 * the operator re-runs the image step.
 *
 * Security: id must exist in the videos table. We write only to the
 * fixed basename inside the per-video project root; no path-traversal
 * surface exposed to the request.
 */
export async function POST(
  req: Request,
  ctx: RouteCtx
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
      {
        error: "invalid_body",
        message: "Expected multipart/form-data with a `file` field.",
      },
      { status: 400 }
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        error: "missing_file",
        message: "Provide an image file under the `file` field.",
      },
      { status: 400 }
    );
  }
  if (file.size === 0) {
    return NextResponse.json(
      { error: "empty_file", message: "Uploaded file is empty." },
      { status: 400 }
    );
  }
  if (file.size > MAX_BYTES) {
    return NextResponse.json(
      {
        error: "too_large",
        message: `Upload exceeds the ${Math.floor(MAX_BYTES / 1024 / 1024)} MB limit.`,
      },
      { status: 413 }
    );
  }

  const mime = (file.type || "").toLowerCase();
  if (!CHARACTER_REFERENCE_ACCEPTED_MIMES.has(mime)) {
    return NextResponse.json(
      {
        error: "unsupported_format",
        message:
          "Upload must be a PNG, JPEG, or WebP image. " +
          `Browser reported mime: ${mime || "(none)"}.`,
      },
      { status: 415 }
    );
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, ctx.params.id);
  const finalPath = resolve(projectRoot, CHARACTER_REFERENCE_BASENAME);

  // Belt for the fixed-basename design: confirm the resolved final path
  // is strictly under the per-video project root.
  if (finalPath !== resolve(projectRoot, CHARACTER_REFERENCE_BASENAME)) {
    return NextResponse.json({ error: "invalid_path" }, { status: 500 });
  }
  if (
    finalPath !== projectRoot &&
    !finalPath.startsWith(projectRoot + sep)
  ) {
    return NextResponse.json({ error: "invalid_path" }, { status: 500 });
  }

  mkdirSync(projectRoot, { recursive: true });
  const bytes = Buffer.from(await file.arrayBuffer());

  if (mime === "image/png") {
    writeFileSync(finalPath, bytes);
    return NextResponse.json({
      ok: true,
      path: CHARACTER_REFERENCE_BASENAME,
      bytes: bytes.byteLength,
      transcoded: false,
    });
  }

  // Transcode JPEG / WebP → PNG so the on-disk basename is always
  // canonical. Mirrors the voiceover route's MP3 normalization.
  const sourceExt = guessExtension(mime);
  const sourcePath = join(projectRoot, `character_reference_upload${sourceExt}`);
  writeFileSync(sourcePath, bytes);
  try {
    await transcodeToPng(sourcePath, finalPath);
  } catch (e) {
    try { unlinkSync(sourcePath); } catch { /* best effort */ }
    return NextResponse.json(
      {
        error: "transcode_failed",
        message:
          (e instanceof Error ? e.message : String(e)) ||
          "ffmpeg could not convert the upload to PNG.",
      },
      { status: 500 }
    );
  }
  try { unlinkSync(sourcePath); } catch { /* best effort */ }

  let outputBytes = 0;
  try { outputBytes = statSync(finalPath).size; } catch { /* best effort */ }
  return NextResponse.json({
    ok: true,
    path: CHARACTER_REFERENCE_BASENAME,
    bytes: outputBytes,
    transcoded: true,
    sourceMime: mime,
  });
}

function guessExtension(mime: string): string {
  if (mime === "image/jpeg" || mime === "image/jpg") return ".jpg";
  if (mime === "image/webp") return ".webp";
  return ".bin";
}

/**
 * Spawn ffmpeg to transcode an arbitrary image to PNG. Captures stderr
 * so the route can surface the real ffmpeg error message to the
 * operator (e.g. "Unknown encoder" → install a fuller ffmpeg build).
 * Resolves on exit code 0; rejects with the captured stderr otherwise.
 */
function transcodeToPng(src: string, dest: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(
      "ffmpeg",
      [
        "-y", // overwrite dest
        "-i", src,
        "-frames:v", "1", // single frame, in case input is animated
        dest,
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
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
      if (code === 0) {
        resolvePromise();
      } else {
        const tail = stderr.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" | ");
        reject(new Error(`ffmpeg exited ${code}: ${tail || "no stderr output"}`));
      }
    });
  });
}
