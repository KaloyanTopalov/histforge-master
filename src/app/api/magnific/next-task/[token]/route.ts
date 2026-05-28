import { NextResponse } from "next/server";
import type { Database as DatabaseType } from "better-sqlite3";
import { getSetting } from "@/lib/settings";
import { resolveMagnificToken } from "@/lib/magnific-auth";
import * as magnificRepo from "@/lib/repos/magnific";
import * as videosRepo from "@/lib/repos/videos";
import type { MagnificQueueItem } from "@/types";

interface RouteCtx {
  params: { token: string };
}

/**
 * Project the dispatched row into the wire shape the magnific-ext
 * service worker consumes. Field casing follows the same mixed
 * convention as the Flow extension contract (mostly snake_case with
 * a few camelCase carry-overs); kept verbatim here so the magnific-ext
 * popup+SW can crib from the youforge-flow shape without translation.
 *
 * `model` is resolved per-row at dispatch time from settings (not from
 * a queue column) so a model setting change takes effect on the next
 * claim. Same pattern as Flow's per-dispatch `imageModel` / `videoModel`
 * resolution.
 *
 * `reference_image_url` is emitted only for image-to-video mode, where
 * the extension needs to upload the loop image as the first/last frame.
 * The URL points back at the artifact route (Phase 2.1 Task 7); the
 * token in the path is the same per-instance secret the extension already
 * holds, so no additional auth needs piping through.
 */
function shapeMagnificTaskForExtension(
  row: MagnificQueueItem,
  db: DatabaseType,
  origin: string,
  token: string
): Record<string, unknown> {
  const model =
    row.mode === "image-hitl" || row.mode === "image-batch"
      ? getSetting("magnific_image_model", db)
      : getSetting("magnific_video_model", db);
  const out: Record<string, unknown> = {
    id: row.external_task_id,
    mode: row.mode,
    prompt: row.prompt,
    model,
    output_path: row.output_path,
  };
  if (row.mode === "image-to-video" && row.reference_image) {
    const params = new URLSearchParams({
      videoId: row.video_id,
      path: row.reference_image,
    });
    out.reference_image_url = `${origin}/api/magnific/artifact/${token}?${params.toString()}`;
  }
  // image-batch (narrative Magnific) carries two video-level facts the
  // extension needs to scope generation to a per-video Project: the title
  // (to name a new Project) and the cached Project UUID (null until the
  // first row creates it). Joined here, not stored per queue row.
  if (row.mode === "image-batch") {
    const video = videosRepo.findById(db, row.video_id);
    out.video_title = video?.title ?? null;
    out.magnific_project_id = video?.magnific_project_id ?? null;
  }
  return out;
}

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = resolveMagnificToken(ctx.params.token);
  if (!auth.ok) return auth.response;
  const { db } = auth;

  // Global queue pause: hand out no new work. Doesn't surface a
  // Retry-After (queue pause is operator-toggled, not time-bounded).
  if (getSetting("queue_state", db) === "paused") {
    return NextResponse.json({});
  }

  const claimed = magnificRepo.takeNextTask(db, Math.floor(Date.now() / 1000));
  if (!claimed) return NextResponse.json({});

  const origin = new URL(req.url).origin;
  return NextResponse.json(
    shapeMagnificTaskForExtension(claimed, db, origin, ctx.params.token)
  );
}
