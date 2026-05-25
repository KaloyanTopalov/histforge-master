import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { id: string };
}

function projectsDirPath(): string {
  return process.env.PROJECTS_DIR ?? "./projects";
}

/**
 * POST /api/videos/:id/open-folder — reveal the per-video folder in Windows
 * Explorer with final.mp4 pre-selected.
 *
 * Windows-only by design (non-Windows hosts get 400). Fire-and-forget:
 * detached + stdio:"ignore" + unref(), because explorer.exe exits with
 * code 1 even on success and would otherwise pin the event loop. The 410
 * `folder_missing` check is on the project folder, not on final.mp4 —
 * Explorer's `/select,` falls back to opening the parent when the target
 * is missing, so an absent final.mp4 inside a present folder is still a
 * useful action.
 */
export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.id);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  if (process.platform !== "win32") {
    return NextResponse.json(
      {
        error: "unsupported_platform",
        message: "Open folder is only supported on Windows.",
      },
      { status: 400 }
    );
  }

  const projectDir = join(resolve(projectsDirPath()), ctx.params.id);
  if (!existsSync(projectDir)) {
    return NextResponse.json(
      {
        error: "folder_missing",
        message: "The project folder for this video no longer exists on disk.",
      },
      { status: 410 }
    );
  }

  const finalPath = join(projectDir, "final.mp4");
  try {
    const child = spawn("explorer.exe", [`/select,${finalPath}`], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch (err) {
    return NextResponse.json(
      {
        error: "spawn_failed",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}
