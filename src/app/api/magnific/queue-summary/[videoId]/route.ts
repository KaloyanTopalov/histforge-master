import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as magnificRepo from "@/lib/repos/magnific";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { videoId: string };
}

/**
 * Magnific queue summary for a video — powers the magnific HITL banner
 * on the video detail page (Plan 2 Phase 2.3 Task 4).
 *
 * Public — no token. The shape is intentionally narrower than Flow's
 * queue-summary: a single combined histogram across both modes (the
 * banner doesn't need a per-mode split), plus a single `hitl_pending`
 * field that the banner consumes directly. Returns 404 for unknown
 * videos so callers don't paper over an FK typo with zeroed counts.
 */
export async function GET(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.videoId);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const hitl = magnificRepo.findDispatchedHitlForVideo(db, ctx.params.videoId);
  return NextResponse.json({
    counts: magnificRepo.countByStatusForVideoAllModes(db, ctx.params.videoId),
    hitl_pending: hitl
      ? { row_id: hitl.id, mode: hitl.mode, prompt: hitl.prompt }
      : null,
  });
}
