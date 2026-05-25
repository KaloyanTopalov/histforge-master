import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videoLifecycle from "@/lib/lifecycle/video";

interface RouteCtx {
  params: { id: string };
}

export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const result = videoLifecycle.resumeIfResumable(getDb(), ctx.params.id);
  if (result.ok) {
    return NextResponse.json({ ok: true });
  }
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json(
    {
      error: "not_resumable",
      message:
        "Resume is only valid on a paused video that is not pending deletion.",
    },
    { status: 409 }
  );
}
