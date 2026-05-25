import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videoLifecycle from "@/lib/lifecycle/video";
import { applyReadyScriptArtifacts } from "@/lib/ready-script";

interface RouteCtx {
  params: { id: string };
}

/**
 * POST /api/videos/:id/restart — wipe all artifacts and re-queue from step 1.
 *
 * Valid when videos.status is 'failed' or 'done' (not 'queued' or
 * 'in_progress', which would be either redundant or a concurrency hazard).
 * The orchestrator's pre-loop upsert will create fresh pending step rows
 * on the next iteration.
 */
export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const result = videoLifecycle.restart(db, ctx.params.id, projectsDir);

  if (!result.ok) {
    if (result.reason === "not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json(
      {
        error: "not_restartable",
        message:
          "Restart is only valid on a failed or done video; active videos cannot be restarted.",
      },
      { status: 409 }
    );
  }

  // Re-prep on-disk script artifacts for ready-script videos: the
  // restart wiped both the project dir and the step rows, so without
  // this the orchestrator would re-run script generation against a
  // sentinel `topic_info`. No-op when `provided_script` is null.
  // Outside the lifecycle method because ready-script is its own concept.
  applyReadyScriptArtifacts(db, ctx.params.id);

  return NextResponse.json({ ok: true });
}
