import { NextResponse } from "next/server";
import type { Database as DatabaseType } from "better-sqlite3";
import { getDb } from "@/lib/db";
import { listWorkflows } from "@/lib/workflows";
import * as workflowsRepo from "@/lib/repos/workflows";
import { WorkflowRowSchema } from "@/lib/workflows-schema";
import {
  validateInputAvailability,
  validateWorkflowConsistency,
} from "@/lib/workflows-validator";
import { buildDetail, toApiSummary } from "@/lib/workflows-api";
import type { WorkflowRow, WorkflowSnapshot } from "@/types";

function countSteps(db: DatabaseType, workflow_id: string): number {
  return workflowsRepo.findStepsByWorkflow(db, workflow_id).length;
}

export async function GET(req: Request): Promise<NextResponse> {
  const db = getDb();
  const url = new URL(req.url);
  const enabledOnly = url.searchParams.get("enabled") === "1";

  const rows = listWorkflows(db);
  const filtered = enabledOnly ? rows.filter((r) => r.enabled === 1) : rows;
  const workflows = filtered.map((row) =>
    toApiSummary(row, countSteps(db, row.id))
  );
  return NextResponse.json({ workflows });
}

export async function POST(req: Request): Promise<NextResponse> {
  const parsed = WorkflowRowSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const data = parsed.data;
  // Editor "Save New Workflow" is narrative-only — the v1 music-video
  // workflow ships pre-seeded and isn't authored via this endpoint. AI-skill
  // drafts of either kind go through POST /api/workflows/import, which
  // routes through `importWorkflowJson` and honors `data.kind` directly.
  if (data.kind !== "narrative") {
    return NextResponse.json(
      {
        error: "music_video_unsupported",
        message:
          "POST /api/workflows accepts narrative workflows only. Music-video workflows ship seeded; round-trip JSON imports go through POST /api/workflows/import.",
      },
      { status: 400 }
    );
  }
  const db = getDb();
  const now = Date.now();
  const row: WorkflowRow = {
    id: data.id,
    label: data.label,
    short_label: data.short_label,
    description: data.description ?? null,
    kind: "narrative",
    script_llm_provider: data.script_llm_provider,
    tts_provider: data.tts_provider,
    image_provider: data.image_provider,
    video_provider: data.video_provider,
    music_provider: null,
    upscaler_provider: null,
    is_builtin: 0,
    enabled: data.enabled === false ? 0 : 1,
    version: 1,
    created_at: now,
    updated_at: now,
    chunker_step: data.chunker_step,
    // Narrative-only route (music_video imports short-circuit above), so
    // `data` is narrowed to the narrative branch which carries the
    // optional image_style. Null fallback preserves the pre-Phase-5
    // cinematic default for payloads that omit the field.
    image_style: data.image_style ?? null,
  };

  try {
    db.transaction(() => {
      workflowsRepo.insert(db, row);
      workflowsRepo.replaceSteps(db, row.id, data.steps);
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

  // Validator runs post-commit on an in-memory snapshot synthesized from
  // the parsed body — no extra DB round-trip. Warnings are advisory; saves
  // are never blocked by missing-input warnings.
  const snapshot: WorkflowSnapshot = {
    workflow_id: row.id,
    version: row.version,
    kind: row.kind,
    script_llm_provider: row.script_llm_provider,
    tts_provider: row.tts_provider,
    image_provider: row.image_provider,
    video_provider: row.video_provider,
    music_provider: row.music_provider,
    upscaler_provider: row.upscaler_provider,
    chunker_step: row.chunker_step,
    image_style: row.image_style ?? null,
    steps: data.steps,
  };
  const inputs = validateInputAvailability(snapshot);
  const consistency = validateWorkflowConsistency(snapshot);
  return NextResponse.json(
    {
      workflow: buildDetail(db, row.id),
      warnings: [...inputs.warnings, ...consistency.warnings],
    },
    { status: 201 }
  );
}
