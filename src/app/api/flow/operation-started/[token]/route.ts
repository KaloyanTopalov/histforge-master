import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveFlowAccount } from "@/lib/flow-auth";
import * as gfRepo from "@/lib/repos/google-flow";

interface RouteCtx {
  params: { token: string };
}

/**
 * Persists the Google operation name the SW received from a successful
 * submit, so a later requeue can resume polling instead of re-submitting
 * (which would create a duplicate gallery entry).
 *
 * Does NOT require `account.enabled` — a disabled account may still
 * have in-flight dispatched rows mid-submit, and recording their
 * operation pair recovers compute we've already paid for. Mirrors
 * `submit-result`'s gate posture for the same reason.
 *
 * State-tolerant: an unknown taskId or a row no longer in `dispatched`
 * is silently no-op'd (still 200 + success). The SW post is fire-and-
 * forget; the operation pair is only meaningful while the row is mid-
 * dispatch, so we ignore late arrivals rather than encourage SW retry
 * storms.
 */
const OperationStartedSchema = z.object({
  type: z.literal("OperationStarted"),
  accountToken: z.string().min(1),
  taskId: z.string().min(1),
  operationName: z.string().min(1),
  projectId: z.string().min(1),
});

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = await resolveFlowAccount(req, ctx, OperationStartedSchema);
  if (!auth.ok) return auth.response;
  const { parsed, db } = auth;

  const task = gfRepo.findTaskByExternalId(db, parsed.taskId);
  if (task && task.status === "dispatched") {
    gfRepo.setOperationStarted(
      db,
      task.id,
      parsed.operationName,
      parsed.projectId
    );
  }

  return NextResponse.json({ success: true });
}
