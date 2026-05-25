import { NextResponse } from "next/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { getDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";
import * as videosRepo from "@/lib/repos/videos";
import * as flowLifecycle from "@/lib/lifecycle/flow";
import type { Chunk } from "@/types";

interface RouteCtx {
  params: { rowId: string };
}

const BodySchema = z
  .object({
    /**
     * Optional new prompt. When present the row's prompt + chunks.json
     * are rewritten and the moderation budget is reset (the "edit and
     * retry" path). When absent the row is requeued in place with its
     * current prompt (the "retry" path) — useful when the operator
     * wants to give a still-in-progress automatic rewrite another shot
     * without overriding what the moderator produced.
     */
    prompt: z.string().trim().min(1, "prompt is required").optional(),
  })
  .strict();

/**
 * Operator override for a single Flow queue row. Two modes, keyed off
 * whether the body carries a `prompt`:
 *
 *   - **Edit + retry** (prompt present): replace the row's prompt, sync
 *     the matching chunk in `chunks.json`, reset moderation_round to 0
 *     so the override gets a fresh moderation budget, write a
 *     `moderation_events` row tagged `manual_edit`, and flip the row
 *     back to `pending`.
 *
 *   - **Plain retry** (prompt absent): requeue the row in place via
 *     `requeueTask` — same prompt, moderation_round preserved, no
 *     audit row written. This is the "give the current prompt another
 *     attempt" affordance the operator needs while an automatic
 *     moderation rewrite is mid-flight (status = `pending` or
 *     `dispatched`) and they don't want to override what the moderator
 *     produced.
 *
 * If the parent video is in `failed` status, both paths also reset the
 * failed step and clear failure metadata — mirroring the bulk
 * `requeue-failed` route — so the runner re-enters the step.
 *
 * Targets a `failed`, `dispatched`, or `pending` row. Accepting
 * `pending` matters when the moderation loop has just requeued the
 * row: the operator needs to be able to intervene at that exact moment,
 * not only after the requeued attempt also fails. For `dispatched` rows
 * the extension may submit a result for the old prompt before
 * re-dispatch lands — the submit-result handler treats those as
 * duplicates via the `external_task_id` reset, so the worst case is a
 * wasted dispatch, not a corrupted output.
 *
 * The `chunks.json` write happens *after* the SQLite transaction
 * commits, matching the moderation-loop convention — filesystem writes
 * have no business inside a SQLite transaction.
 */
export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const rowId = Number(ctx.params.rowId);
  if (!Number.isInteger(rowId) || rowId <= 0) {
    return NextResponse.json({ error: "bad_row_id" }, { status: 400 });
  }

  let parsed: z.infer<typeof BodySchema>;
  try {
    const json: unknown = await req.json();
    parsed = BodySchema.parse(json);
  } catch (err) {
    const issues = err instanceof z.ZodError ? err.issues : undefined;
    return NextResponse.json(
      { error: "bad_body", issues },
      { status: 400 }
    );
  }

  const db = getDb();
  const row = gfRepo.findTaskById(db, rowId);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (
    row.status !== "failed" &&
    row.status !== "dispatched" &&
    row.status !== "pending"
  ) {
    return NextResponse.json(
      { error: "bad_status", status: row.status },
      { status: 409 }
    );
  }
  const newPrompt = parsed.prompt;
  // The edit path writes a moderation_events row, which requires a
  // chunk_id. The plain retry path doesn't write events, so a missing
  // chunk_id is fine.
  if (newPrompt !== undefined && row.chunk_id == null) {
    return NextResponse.json({ error: "missing_chunk_id" }, { status: 409 });
  }

  const video = videosRepo.findById(db, row.video_id);
  if (!video) {
    return NextResponse.json({ error: "video_not_found" }, { status: 404 });
  }

  const originalPrompt = row.prompt;
  const now = Math.floor(Date.now() / 1000);

  const { videoUnfailed: resumedFailedStep } = flowLifecycle.requeueFailedTask(
    db,
    row,
    {
      newPrompt,
      chunkId: row.chunk_id,
      originalPrompt,
      reasonTag: "manual_edit",
      nowSec: now,
    }
  );

  const chunksJsonUpdated =
    newPrompt !== undefined && row.chunk_id !== null
      ? syncChunksJsonPrompt(row.video_id, row.chunk_id, newPrompt)
      : false;

  return NextResponse.json({
    ok: true,
    rowId: row.id,
    mode: newPrompt !== undefined ? "edit" : "retry",
    chunksJsonUpdated,
    resumedFailedStep,
  });
}

/**
 * Find the chunk by id in `chunks.json`, append the previous (non-null)
 * prompt to `prompt_history`, install the new prompt, and write the
 * file back. Returns true when the file was successfully read+written,
 * false when the file is missing, the chunk isn't there, or the
 * filesystem reports an error — all non-fatal: the queue row already
 * carries the new prompt (canonical) and `moderation_events` is the
 * audit record.
 */
function syncChunksJsonPrompt(
  videoId: string,
  chunkId: string,
  newPrompt: string
): boolean {
  const projectsDir = process.env.PROJECTS_DIR ?? "./projects";
  const chunksPath = join(projectsDir, videoId, "chunks", "chunks.json");
  if (!existsSync(chunksPath)) return false;
  try {
    const chunks: Chunk[] = JSON.parse(readFileSync(chunksPath, "utf-8"));
    const chunk = chunks.find((c) => c.id === chunkId);
    if (!chunk) return false;
    if (chunk.prompt === newPrompt) {
      // No-op write: prompt is already in sync (operator edited
      // chunks.json by hand before calling the endpoint). Skip writing.
      return true;
    }
    const history = chunk.prompt_history ?? [];
    if (chunk.prompt != null) history.push(chunk.prompt);
    chunk.prompt_history = history;
    chunk.prompt = newPrompt;
    writeFileSync(chunksPath, JSON.stringify(chunks, null, 2), "utf-8");
    return true;
  } catch {
    return false;
  }
}
