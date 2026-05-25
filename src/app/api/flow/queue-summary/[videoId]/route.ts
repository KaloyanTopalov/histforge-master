import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { buildFlowSummary } from "@/lib/flow-summary";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { videoId: string };
}

/**
 * Flow queue summary for a video — powers the video-detail "Flow
 * progress" panel. Returns counts by kind (image / clip) and
 * the per-chunk failed list (chunk_id, error_reason, retry_count) so
 * operators can triage without SQL access.
 *
 * Kept separate from /api/videos/[id] so the detail poll isn't forced
 * to pay for this query when the workflow isn't google-flow.
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
  return NextResponse.json(buildFlowSummary(db, ctx.params.videoId));
}
