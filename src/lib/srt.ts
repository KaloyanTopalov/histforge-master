import type { AlignmentEntry } from "@/types";

/**
 * SRT/VTT cue-format parser that maps subtitle cues into the
 * `AlignmentEntry[]` shape consumed by step 7's `alignment.json`.
 *
 * Why this exists: when an operator wants to skip the WSL/aeneas
 * alignment step (Phase 5 manual-upload bypass) they typically have
 * an SRT file from a transcription tool (Whisper, Descript, etc.),
 * not aeneas-shaped JSON. This parser is the lingua franca.
 *
 * Format support:
 *   - SRT cue blocks separated by blank lines, with optional
 *     numeric index on the first line.
 *   - Timestamps `HH:MM:SS,mmm --> HH:MM:SS,mmm` (SRT) and
 *     `HH:MM:SS.mmm --> HH:MM:SS.mmm` (VTT) — both accepted.
 *   - Multi-line cue text is joined with a single space.
 *   - A leading `WEBVTT` header line (with optional metadata) is
 *     tolerated and skipped.
 *
 * Output entry shape mirrors aeneas's JSON exactly:
 *   { id: "f000001", text: "...", begin: 0.0, end: 2.5 }
 *
 * Ids are 1-indexed, zero-padded to 6 digits to match aeneas's
 * default `os_task_file_format` output. The chunker step (8)
 * doesn't read ids semantically — it just iterates in order — but
 * matching aeneas's exact shape keeps the downstream contract
 * identical to the auto-generated path.
 */
export function parseSrtToAlignment(srt: string): AlignmentEntry[] {
  if (typeof srt !== "string" || srt.trim().length === 0) {
    throw new Error("Empty or non-string SRT input.");
  }

  // Normalise line endings before splitting on blank lines.
  const normalised = srt.replace(/\r\n?/g, "\n").trim();

  // VTT files start with `WEBVTT` (optionally with metadata). Drop the
  // header block — everything up to and including the first blank
  // line. SRT files don't have such a header so this is a no-op for
  // them.
  let body = normalised;
  if (/^WEBVTT\b/i.test(body)) {
    const firstBlank = body.indexOf("\n\n");
    body = firstBlank === -1 ? "" : body.slice(firstBlank + 2);
  }

  const blocks = body
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const entries: AlignmentEntry[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    // First line may be a cue index (digits only) — if so, drop it.
    if (lines.length > 1 && /^\d+$/.test(lines[0].trim())) {
      lines.shift();
    }
    if (lines.length === 0) continue;

    const timingLine = lines[0].trim();
    const timing = parseTimingLine(timingLine);
    if (!timing) {
      // Skip non-cue blocks (e.g. VTT NOTE / STYLE / REGION sections).
      continue;
    }
    const text = lines
      .slice(1)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length === 0) continue;

    entries.push({
      id: `f${String(entries.length + 1).padStart(6, "0")}`,
      text,
      begin: timing.begin,
      end: timing.end,
    });
  }

  if (entries.length === 0) {
    throw new Error("SRT/VTT input contained no valid cue blocks.");
  }
  return entries;
}

const TIMING_RE =
  /^(\d{1,2}):([0-5]?\d):([0-5]?\d)[.,](\d{1,3})\s*-->\s*(\d{1,2}):([0-5]?\d):([0-5]?\d)[.,](\d{1,3})/;

function parseTimingLine(
  line: string,
): { begin: number; end: number } | null {
  const m = TIMING_RE.exec(line);
  if (!m) return null;
  const begin =
    Number(m[1]) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number(padRightToMs(m[4])) / 1000;
  const end =
    Number(m[5]) * 3600 +
    Number(m[6]) * 60 +
    Number(m[7]) +
    Number(padRightToMs(m[8])) / 1000;
  if (!Number.isFinite(begin) || !Number.isFinite(end) || end < begin) {
    return null;
  }
  return { begin, end };
}

/**
 * SRT/VTT allow 1-3 digit fractional seconds. Right-pad to 3 digits
 * so we always interpret as milliseconds, regardless of how the
 * source file wrote them. (".5" becomes 500 ms, ".50" becomes 500 ms,
 * ".500" stays 500 ms.)
 */
function padRightToMs(frac: string): string {
  if (frac.length >= 3) return frac.slice(0, 3);
  return frac + "0".repeat(3 - frac.length);
}

/**
 * Validate that a parsed-JSON value is a non-empty `AlignmentEntry[]`.
 * Used by both the upload route (to reject malformed JSON before
 * writing it) and step 7's bypass guard (to verify a pre-existing
 * file is actually usable before skipping aeneas).
 */
export function isValidAlignmentArray(value: unknown): value is AlignmentEntry[] {
  if (!Array.isArray(value) || value.length === 0) return false;
  for (const entry of value) {
    if (!entry || typeof entry !== "object") return false;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.length === 0) return false;
    if (typeof e.text !== "string") return false;
    if (typeof e.begin !== "number" || !Number.isFinite(e.begin)) return false;
    if (typeof e.end !== "number" || !Number.isFinite(e.end)) return false;
    if (e.end < e.begin) return false;
  }
  return true;
}
