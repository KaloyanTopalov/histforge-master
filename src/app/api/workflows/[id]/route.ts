import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getWorkflowFromDb } from "@/lib/workflows";
import * as workflowsRepo from "@/lib/repos/workflows";
import { WorkflowPatchSchema } from "@/lib/workflows-schema";
import {
  validateInputAvailability,
  validateWorkflowConsistency,
} from "@/lib/workflows-validator";
import type { WorkflowRow, WorkflowSnapshot } from "@/types";
import { buildDetail } from "@/lib/workflows-api";

interface RouteCtx {
  params: { id: string };
}

export async function GET(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const row = getWorkflowFromDb(db, ctx.params.id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ workflow: buildDetail(db, row.id) });
}

export async function PATCH(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const parsed = WorkflowPatchSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { id } = ctx.params;
  const db = getDb();
  const data = parsed.data;
  // Strip the URL-derived/non-column fields. `expected_version` is the
  // optimistic-concurrency token; `steps` is handled by `replaceSteps`;
  // any sneaky `id` from the body is dropped (slug is immutable).
  const { steps, expected_version, ...rowFields } = data;

  let conflictResponse: NextResponse | null = null;
  let notFound = false;
  // Captured inside the transaction so post-commit snapshot construction
  // is in-memory. `preStepNames` is only populated when the body omits
  // `steps` — in that case the post-PATCH steps equal the pre-PATCH steps.
  let preRow: WorkflowRow | null = null;
  let preStepNames: { step_name: string }[] | null = null;

  db.transaction(() => {
    const current = workflowsRepo.findById(db, id);
    if (!current) {
      notFound = true;
      return;
    }
    if (current.version !== expected_version) {
      conflictResponse = NextResponse.json(
        {
          error: "version_conflict",
          current_version: current.version,
        },
        { status: 409 }
      );
      return;
    }
    preRow = current;
    if (steps === undefined) {
      preStepNames = workflowsRepo
        .findStepsByWorkflow(db, id)
        .map((s) => ({ step_name: s.step_name }));
    }

    if (Object.keys(rowFields).length > 0) {
      workflowsRepo.update(db, id, rowFields);
    }
    if (steps !== undefined) {
      workflowsRepo.replaceSteps(db, id, steps);
    }
    workflowsRepo.bumpVersion(db, id);
  })();

  if (notFound) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (conflictResponse) return conflictResponse;

  // Validator runs post-commit on an in-memory snapshot synthesized from
  // values we just wrote — no extra DB round-trip back to `workflows` +
  // `workflow_steps`. Warnings are advisory; saves are never blocked.
  // `warnings` is additive — pre-Phase-3 callers ignoring it stay correct.
  const before = preRow!;
  const merged = { ...before, ...rowFields };
  const snapshot: WorkflowSnapshot = {
    workflow_id: id,
    version: before.version + 1,
    kind: merged.kind,
    script_llm_provider: merged.script_llm_provider,
    tts_provider: merged.tts_provider,
    image_provider: merged.image_provider,
    video_provider: merged.video_provider,
    music_provider: merged.music_provider,
    upscaler_provider: merged.upscaler_provider,
    chunker_step: merged.chunker_step,
    steps: steps ?? preStepNames!,
  };
  const inputs = validateInputAvailability(snapshot);
  const consistency = validateWorkflowConsistency(snapshot);
  return NextResponse.json({
    workflow: buildDetail(db, id),
    warnings: [...inputs.warnings, ...consistency.warnings],
  });
}

export async function DELETE(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const { id } = ctx.params;
  const db = getDb();

  let notFound = false;
  let response: NextResponse | null = null;

  db.transaction(() => {
    const current = workflowsRepo.findById(db, id);
    if (!current) {
      notFound = true;
      return;
    }
    if (current.is_builtin === 1) {
      response = NextResponse.json(
        { error: "cannot_delete_builtin" },
        { status: 400 }
      );
      return;
    }
    const inUse = workflowsRepo.countVideosUsingWorkflow(db, id);
    if (inUse > 0) {
      response = NextResponse.json(
        { error: "workflow_in_use", videos_count: inUse },
        { status: 409 }
      );
      return;
    }
    workflowsRepo.deleteById(db, id);
    response = NextResponse.json({ deleted: true });
  })();

  if (notFound) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return response!;
}
