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
 * POST /api/videos/:id/rerender-last-step — re-render the music_video's
 * `final.mp4` from the existing `loop_clip.mp4`, preserving the expensive
 * Magnific artifacts (`loop_image.png`, `loop_clip.mp4`, `songs/`).
 *
 * Music-video kind + done status are required; everything else is a
 * 409. The lifecycle method wipes `final.mp4` + `build/` on disk and
 * flips the `render_music_video` step row back to pending so the
 * orchestrator's next tick re-runs it. Operators reach for this action
 * after dialing the loop-seam mitigation knobs (`music_video_loop_*`
 * settings) on the Magnific tab.
 */
export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const result = videoLifecycle.rerenderLastStep(
    getDb(),
    ctx.params.id,
    projectsDirPath()
  );
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (result.reason === "wrong_kind") {
    return NextResponse.json(
      {
        error: "wrong_kind",
        message: "Re-render only valid on music_video videos.",
      },
      { status: 409 }
    );
  }
  return NextResponse.json(
    {
      error: "not_done",
      message: "Re-render only valid on a done video.",
    },
    { status: 409 }
  );
}
