import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import { applyReadyScriptArtifacts } from "@/lib/ready-script";

interface RouteCtx {
  params: { id: string };
}

export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const video = videosRepo.findById(db, ctx.params.id);
  if (!video) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (video.status !== "new") {
    return NextResponse.json(
      {
        error: "not_startable",
        message: "Start is only valid on a new video.",
      },
      { status: 409 }
    );
  }
  videosRepo.transitionNewToQueued(db, ctx.params.id);
  applyReadyScriptArtifacts(db, ctx.params.id);
  return NextResponse.json({ ok: true });
}
