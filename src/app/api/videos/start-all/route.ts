import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as videosRepo from "@/lib/repos/videos";
import { applyReadyScriptArtifacts } from "@/lib/ready-script";

export async function POST(_req: Request): Promise<NextResponse> {
  const db = getDb();
  const flippedIds = videosRepo.transitionAllNewToQueued(db);
  // Each prep call is wrapped so one bad row (corrupt snapshot, FS
  // error, etc.) doesn't abort the rest of the batch. The video has
  // already flipped to `queued` — surfacing the per-id failure lets the
  // operator retry from the row.
  const errors: { id: string; message: string }[] = [];
  for (const id of flippedIds) {
    try {
      applyReadyScriptArtifacts(db, id);
    } catch (err) {
      errors.push({
        id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return NextResponse.json({
    ok: true,
    count: flippedIds.length,
    ...(errors.length > 0 ? { errors } : {}),
  });
}
