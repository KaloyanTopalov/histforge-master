import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveMagnificToken } from "@/lib/magnific-auth";
import * as magnificRepo from "@/lib/repos/magnific";
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
  }),
  z.object({
    id: z.union([z.string(), z.number()]).optional(),
    external_task_id: z.string().min(1),
    status: z.literal("failed"),
    error: z.string().optional(),
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
