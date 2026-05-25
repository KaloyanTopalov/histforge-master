import { NextResponse } from "next/server";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensureDraftsDirs, getDraftsDir } from "@/lib/workflows-drafts-fs";
import type { DraftRow } from "@/lib/workflows-api";

const DRAFT_FILENAME_RE = /^[a-z0-9-]+\.json$/;

const SERVER_CONTROLLED_KEYS = [
  "is_builtin",
  "version",
  "created_at",
  "updated_at",
] as const;

function parseDraft(filename: string, dir: string): DraftRow {
  const path = join(dir, filename);
  const stat = statSync(path);
  const mtime = Math.floor(stat.mtimeMs / 1000);
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      filename,
      slug: null,
      label: null,
      providers: null,
      chunker_step: null,
      stepCount: null,
      mtime,
      errors: ["invalid_json"],
    };
  }

  const errors: string[] = [];
  const obj =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};

  const slug = typeof obj.id === "string" ? obj.id : null;
  if (slug === null) errors.push("missing_fields");

  for (const key of SERVER_CONTROLLED_KEYS) {
    if (key in obj) {
      errors.push("unknown_field");
      break;
    }
  }

  const label = typeof obj.label === "string" ? obj.label : null;
  const providers = {
    script:
      typeof obj.script_llm_provider === "string"
        ? obj.script_llm_provider
        : null,
    tts: typeof obj.tts_provider === "string" ? obj.tts_provider : null,
    image: typeof obj.image_provider === "string" ? obj.image_provider : null,
    video: typeof obj.video_provider === "string" ? obj.video_provider : null,
  };
  const chunker_step =
    typeof obj.chunker_step === "string" ? obj.chunker_step : null;
  const stepCount = Array.isArray(obj.steps) ? obj.steps.length : null;

  return {
    filename,
    slug,
    label,
    providers,
    chunker_step,
    stepCount,
    mtime,
    errors,
  };
}

export async function GET(_req: Request): Promise<NextResponse> {
  ensureDraftsDirs();
  const dir = getDraftsDir();
  const entries = readdirSync(dir, { withFileTypes: true });
  const filenames = entries
    .filter((e) => e.isFile() && DRAFT_FILENAME_RE.test(e.name))
    .map((e) => e.name);

  const rows: DraftRow[] = filenames.map((name) => parseDraft(name, dir));

  rows.sort((a, b) => {
    if (b.mtime !== a.mtime) return b.mtime - a.mtime;
    return a.filename.localeCompare(b.filename);
  });

  return NextResponse.json(rows);
}
