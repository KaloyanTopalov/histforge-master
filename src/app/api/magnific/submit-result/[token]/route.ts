import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveMagnificToken } from "@/lib/magnific-auth";
import * as magnificRepo from "@/lib/repos/magnific";
import * as videosRepo from "@/lib/repos/videos";
import { downloadToProjectPath } from "@/lib/flow-media";
import { isAllowedMagnificHost } from "@/lib/magnific-media";

interface RouteCtx {
  params: { token: string };
}

/**
 * Body schema discriminated on `status`. The success body carries
 * `resultUrl`; the failure body carries `error`. The optional `id`
 * field is the row's database id (the extension echoes it back for
 * debugging convenience); the route doesn't read it — it looks up
 * the row by the minted `external_task_id`, which is the value
 * dispatched on the next-task wire.
 *
 * Field casing follows the existing Flow extension contract — snake
 * for column-mirror names, camel for body-only carry-overs like
 * resultUrl — so the magnific-ext SW can crib from youforge-flow's
 * wire format without translation.
 */
const SubmitSchema = z.discriminatedUnion("status", [
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    external_task_id: z.string().min(1),
    status: z.literal("done"),
    resultUrl: z.string().min(1),
    // image-batch only: the Project UUID the extension created on the first
    // row, echoed back so HistForge caches it on the videos row for reuse.
    magnific_project_id: z.string().nullable().optional(),
  }),
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    external_task_id: z.string().min(1),
    status: z.literal("failed"),
    error: z.string().optional(),
    // image-batch only: null + error="project_missing" signals the cached
    // Project was deleted in Magnific, so HistForge clears the cached id.
    magnific_project_id: z.string().nullable().optional(),
  }),
]);

function projectsDirPath(): string {
  return process.env.PROJECTS_DIR ?? "./projects";
}

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = resolveMagnificToken(ctx.params.token);
  if (!auth.ok) return auth.response;
  const { db } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const parsed = SubmitSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  const task = magnificRepo.findTaskByExternalId(
    db,
    parsed.data.external_task_id
  );
  // Stale submission — the row was requeued and reclaimed under a
  // fresh external_task_id, or never existed. Idempotent OK so the
  // extension doesn't retry-storm a misrouted submit.
  if (!task) {
    return NextResponse.json({ success: true, duplicate: true });
  }
  // Already terminal — also idempotent OK.
  if (task.status === "done" || task.status === "failed") {
    return NextResponse.json({ success: true, duplicate: true });
  }

  // image-batch Project-id caching. The extension reports the Project UUID it
  // created on the first row so later rows reuse it; {magnific_project_id:
  // null, error: "project_missing"} means the cached Project was deleted in
  // Magnific, so clear it and the next row recreates it. An absent field is a
  // no-op. Runs before the download so the UUID is cached regardless of this
  // row's outcome; the terminal early-return above prevents re-persist on
  // retry, and setMagnificProjectId is itself idempotent.
  if (parsed.data.magnific_project_id !== undefined) {
    if (parsed.data.magnific_project_id === null) {
      if (
        parsed.data.status === "failed" &&
        parsed.data.error === "project_missing"
      ) {
        videosRepo.setMagnificProjectId(db, task.video_id, null);
      }
    } else {
      videosRepo.setMagnificProjectId(
        db,
        task.video_id,
        parsed.data.magnific_project_id
      );
    }
  }

  if (parsed.data.status === "done") {
    const resultUrl = parsed.data.resultUrl;
    if (!isAllowedMagnificHost(resultUrl)) {
      magnificRepo.failTask(
        db,
        task.id,
        `invalid result host: ${resultUrl}`
      );
      return NextResponse.json({ success: true });
    }
    try {
      await downloadToProjectPath(
        task.video_id,
        task.output_path,
        resultUrl,
        projectsDirPath(),
        isAllowedMagnificHost
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      magnificRepo.failTask(db, task.id, `download_failed: ${msg}`);
      return NextResponse.json({ success: true });
    }
    magnificRepo.submitResult(
      db,
      task.id,
      resultUrl,
      Math.floor(Date.now() / 1000)
    );
    return NextResponse.json({ success: true });
  }

  // status === 'failed' — record the error; do not auto-requeue.
  // Operator recourse is retrying the step from the dashboard, which
  // re-enters the worker step → findOpenTaskForVideo misses → fresh
  // enqueue.
  magnificRepo.failTask(db, task.id, parsed.data.error ?? "unknown error");
  return NextResponse.json({ success: true });
}
