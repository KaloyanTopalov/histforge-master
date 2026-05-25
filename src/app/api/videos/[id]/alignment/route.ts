import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import {
  isValidAlignmentArray,
  parseSrtToAlignment,
} from "@/lib/srt";

interface RouteCtx {
  params: { id: string };
}

/**
 * Hard upper bound on uploaded payload size. Alignment files are tiny
 * (a few KB per minute of audio); 16 MB is generous and rejects any
 * accidental misuploads.
 */
const MAX_BYTES = 16 * 1024 * 1024;

/**
 * POST /api/videos/:id/alignment — upload a pre-computed alignment to
 * bypass the WSL/aeneas step (07).
 *
 * Accepts two formats:
 *   - `.json` / `application/json` — must be a non-empty
 *     `AlignmentEntry[]` (shape validated). Written verbatim.
 *   - `.srt` / `.vtt` / `text/srt` / `text/vtt` — parsed via
 *     `parseSrtToAlignment` and serialised to AlignmentEntry[] JSON.
 *
 * Destination is always `<projectsDir>/<id>/alignment/alignment.json`
 * so step 07 + downstream chunker need no awareness of the upload
 * path — they just see the file.
 *
 * Idempotent: overwrites any prior file. If you upload after step 07
 * already ran, click Retry on the alignment row so the pipeline
 * re-enters and picks up the new file.
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
      {
        error: "invalid_body",
        message: "Expected multipart/form-data with a `file` field.",
      },
      { status: 400 },
    );
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json(
      {
        error: "missing_file",
        message: "Provide an alignment file under the `file` field.",
      },
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

  const text = await file.text();
  const format = detectFormat(file);
  let entries: unknown;
  let entryCount: number;
  try {
    if (format === "json") {
      entries = JSON.parse(text);
      if (!isValidAlignmentArray(entries)) {
        return NextResponse.json(
          {
            error: "invalid_shape",
            message:
              "JSON must be a non-empty array of " +
              "{id: string, text: string, begin: number, end: number}.",
          },
          { status: 400 },
        );
      }
      entryCount = entries.length;
    } else if (format === "srt") {
      entries = parseSrtToAlignment(text);
      entryCount = (entries as unknown[]).length;
    } else {
      return NextResponse.json(
        {
          error: "unsupported_format",
          message:
            "Upload must be a .json alignment file or a .srt/.vtt subtitle file. " +
            `Browser reported mime: ${file.type || "(none)"}, name: ${file.name || "(none)"}.`,
        },
        { status: 415 },
      );
    }
  } catch (e) {
    return NextResponse.json(
      {
        error: "parse_failed",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 400 },
    );
  }

  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const projectRoot = resolve(projectsDir, ctx.params.id);
  const alignmentDir = join(projectRoot, "alignment");
  const finalPath = resolve(alignmentDir, "alignment.json");

  // Defense in depth: confirm the resolved final path is strictly
  // under the per-video project root.
  if (
    finalPath !== resolve(projectRoot, "alignment", "alignment.json") ||
    !finalPath.startsWith(projectRoot + sep)
  ) {
    return NextResponse.json({ error: "invalid_path" }, { status: 500 });
  }

  mkdirSync(alignmentDir, { recursive: true });
  writeFileSync(finalPath, JSON.stringify(entries) + "\n", "utf-8");

  return NextResponse.json({
    ok: true,
    path: "alignment/alignment.json",
    entries: entryCount,
    sourceFormat: format,
  });
}

function detectFormat(file: File): "json" | "srt" | "unknown" {
  const mime = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (
    mime === "application/json" ||
    mime === "text/json" ||
    name.endsWith(".json")
  ) {
    return "json";
  }
  if (
    mime === "application/x-subrip" ||
    mime === "text/srt" ||
    mime === "text/vtt" ||
    mime === "text/plain" || // most file pickers report plaintext for .srt
    name.endsWith(".srt") ||
    name.endsWith(".vtt")
  ) {
    return "srt";
  }
  return "unknown";
}
