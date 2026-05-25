import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveFlowAccount } from "@/lib/flow-auth";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";

interface RouteCtx {
  params: { token: string };
}

/**
 * Per-(video, account) Flow project mapping. The SW posts here on a
 * fresh `project.createProject` so HistForge can feed `flowProjectId`
 * back on the next dispatch. Mirrors the status route's gate posture
 * (does NOT require `account.enabled` — a disabled account can still
 * report something it just created).
 *
 * The SW posts at most once per create, no retry. First-writer-wins
 * is enforced by the table's composite PK + ON CONFLICT DO NOTHING:
 * a different `projectId` for an already-recorded pair logs a warning
 * and returns 200 — never 4xx, since the SW can't recover from one.
 */
const ProjectCreatedSchema = z.object({
  type: z.literal("ProjectCreated"),
  accountToken: z.string().min(1),
  videoId: z.string().min(1),
  projectId: z.string().min(1),
  projectTitle: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = await resolveFlowAccount(req, ctx, ProjectCreatedSchema);
  if (!auth.ok) return auth.response;
  const { account, parsed, db, now } = auth;

  const video = videosRepo.findById(db, parsed.videoId);
  if (!video) {
    return NextResponse.json({ error: "video_not_found" }, { status: 404 });
  }

  const result = gfRepo.upsertFlowProjectForAccount(
    db,
    parsed.videoId,
    account.id,
    parsed.projectId,
    now
  );
  if (
    !result.inserted &&
    result.existingProjectId !== null &&
    result.existingProjectId !== parsed.projectId
  ) {
    console.warn(
      `[flow] project_id conflict for (${parsed.videoId}, ${account.id}): ` +
        `existing=${result.existingProjectId}, reported=${parsed.projectId} — keeping existing`
    );
  }

  return NextResponse.json({ success: true });
}
