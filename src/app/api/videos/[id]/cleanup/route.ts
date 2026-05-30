import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videoLifecycle from "@/lib/lifecycle/video";

interface RouteCtx {
  params: { id: string };
}

function projectsDirPath(): string {
  return process.env.PROJECTS_DIR ?? "./projects";
}

/**
 * POST /api/videos/:id/cleanup — operator-triggered wipe of a done
 * video's intermediates (images, audio, alignment, chunks). The KEEP
 * set (final.mp4, pipeline.log, script/full_script.md) is preserved.
 *
 * Bypasses the `auto_cleanup_after_render` setting by design: that
 * setting gates the post-render step; this is the explicit operator
 * trigger. Idempotent — repeat invocation on an already-clean done
 * video returns 200 with `already_clean: true` instead of erroring.
 */
export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const result = videoLifecycle.cleanupIntermediates(
    getDb(),
    ctx.params.id,
    projectsDirPath()
  );
  if (result.ok) {
    return NextResponse.json({
      ok: true,
      already_clean: result.already_clean,
    });
  }
  if (result.reason === "not_found") {
    return NextResponse.json(
      { ok: false, reason: "not_found" },
      { status: 404 }
    );
  }
  return NextResponse.json(
    { ok: false, reason: "not_done" },
    { status: 409 }
  );
}
