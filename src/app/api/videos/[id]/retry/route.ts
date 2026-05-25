import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videoLifecycle from "@/lib/lifecycle/video";

interface RouteCtx {
  params: { id: string };
}

/**
 * POST /api/videos/:id/retry — re-queue a failed video from its failed step.
 *
 * Only valid when videos.status='failed'. The lifecycle method resets the
 * failed step row to pending and clears failure metadata, but deliberately
 * preserves `started_at` (original pickup time) and leaves `current_step`
 * untouched — the orchestrator will set it on the next iteration. Retry
 * only resets the failed step row — `done` rows for the script-generation
 * steps stay intact, so ready-script videos need no re-prep here (unlike
 * restart, which wipes everything).
 */
export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const result = videoLifecycle.retry(getDb(), ctx.params.id);
  if (result.ok) return NextResponse.json({ ok: true });
  if (result.reason === "not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (result.reason === "not_failed") {
    return NextResponse.json(
      {
        error: "not_failed",
        message: "Retry is only valid on a failed video.",
      },
      { status: 409 }
    );
  }
  // Defensive: a 'failed' video without a failed_step is a bug elsewhere,
  // but don't silently no-op.
  return NextResponse.json({ error: "missing_failed_step" }, { status: 500 });
}
