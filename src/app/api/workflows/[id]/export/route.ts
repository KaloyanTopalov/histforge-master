import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as workflowsRepo from "@/lib/repos/workflows";

interface RouteCtx {
  params: { id: string };
}

/**
 * The export shape is intentionally **snake_case** — it matches the
 * JSON-on-disk format consumed by the AI skill in Phase 6 and the
 * import endpoint (`WorkflowImportSchema`). This is a deliberate
 * divergence from the camelCase API response boundary used elsewhere
 * (toApiSummary in `@/lib/workflows-api`); a user editing a downloaded JSON
 * and re-importing should see the same shape going in and out.
 *
 * Lifecycle fields (`version`, `created_at`, `updated_at`,
 * `is_builtin`) are excluded — re-importing produces a clean v1 row.
 * Nullable fields emit literal `null` (not omitted) so the schema
 * round-trips without ambiguity.
 */
export async function GET(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const { id } = ctx.params;
  const db = getDb();
  const row = workflowsRepo.findById(db, id);
  if (!row) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const stepRows = workflowsRepo.findStepsByWorkflow(db, id);

  const payload = {
    id: row.id,
    label: row.label,
    short_label: row.short_label,
    description: row.description,
    kind: row.kind,
    script_llm_provider: row.script_llm_provider,
    tts_provider: row.tts_provider,
    image_provider: row.image_provider,
    video_provider: row.video_provider,
    music_provider: row.music_provider,
    upscaler_provider: row.upscaler_provider,
    enabled: row.enabled === 1,
    chunker_step: row.chunker_step,
    steps: stepRows.map((s) => ({ step_name: s.step_name })),
  };

  return new NextResponse(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "content-disposition": `attachment; filename="${row.id}.json"`,
    },
  });
}
