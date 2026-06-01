import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import * as workflowsRepo from "@/lib/repos/workflows";
import { buildDetail } from "@/lib/workflows-api";
import type { WorkflowRow } from "@/types";

interface RouteCtx {
  params: { id: string };
}

const CloneBodySchema = z.object({
  new_id: z.string().regex(/^[a-z0-9-]+$/, "kebab-case slug"),
  new_label: z.string().min(1).max(120).optional(),
  new_short_label: z.string().min(1).max(40).optional(),
});

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const parsed = CloneBodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const { new_id, new_label, new_short_label } = parsed.data;
  const sourceId = ctx.params.id;
  const db = getDb();

  let notFound = false;
  let response: NextResponse | null = null;

  try {
    db.transaction(() => {
      const source = workflowsRepo.findById(db, sourceId);
      if (!source) {
        notFound = true;
        return;
      }
      // Self-clone is treated identically to a normal id collision so
      // the client gets one error code to handle.
      if (new_id === sourceId) {
        response = NextResponse.json(
          { error: "workflow_id_exists" },
          { status: 409 }
        );
        return;
      }

      const sourceSteps = workflowsRepo.findStepsByWorkflow(db, sourceId);
      const now = Date.now();
      const newRow: WorkflowRow = {
        id: new_id,
        label: new_label ?? `${source.label} (copy)`,
        short_label: new_short_label ?? source.short_label,
        description: source.description,
        kind: source.kind,
        script_llm_provider: source.script_llm_provider,
        tts_provider: source.tts_provider,
        image_provider: source.image_provider,
        video_provider: source.video_provider,
        music_provider: source.music_provider,
        upscaler_provider: source.upscaler_provider,
        is_builtin: 0,
        enabled: 1,
        version: 1,
        created_at: now,
        updated_at: now,
        chunker_step: source.chunker_step,
        image_style: source.image_style,
      };
      workflowsRepo.insert(db, newRow);
      workflowsRepo.replaceSteps(
        db,
        new_id,
        sourceSteps.map((s) => ({ step_name: s.step_name }))
      );

      response = NextResponse.json(
        { workflow: buildDetail(db, new_id) },
        { status: 201 }
      );
    })();
  } catch (err) {
    if (workflowsRepo.isPrimaryKeyCollision(err)) {
      return NextResponse.json(
        { error: "workflow_id_exists" },
        { status: 409 }
      );
    }
    throw err;
  }

  if (notFound) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return response!;
}
