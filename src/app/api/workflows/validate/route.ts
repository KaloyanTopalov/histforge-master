import { NextResponse } from "next/server";
import type { WorkflowSnapshot } from "@/types";
import { NarrativeRowSchema } from "@/lib/workflows-schema";
import {
  validateInputAvailability,
  validateWorkflowConsistency,
} from "@/lib/workflows-validator";

/**
 * Stateless validator endpoint for the editor's "Validate now" button.
 * Body shape is the four provider columns + `steps` — the subset the
 * validator consumes. No DB read, no DB write; the synthetic snapshot's
 * `workflow_id` / `version` are unused by `validateInputAvailability`.
 *
 * The route is flat (no `[id]` segment) because the body is self-
 * contained — a URL parameter would be functionally unused.
 *
 * The editor surface is narrative-only — the v1 music-video workflow
 * ships seeded, not editor-authored — so the body picks from
 * `NarrativeRowSchema` directly rather than the kind-discriminated
 * `WorkflowRowSchema`. The synthesized snapshot is therefore always
 * `kind: 'narrative'`; `validateWorkflowConsistency` delegates to the
 * chunker ↔ provider rule on that branch.
 */
const ValidateBodySchema = NarrativeRowSchema.pick({
  script_llm_provider: true,
  tts_provider: true,
  image_provider: true,
  image_style: true,
  video_provider: true,
  chunker_step: true,
  steps: true,
});

export async function POST(req: Request): Promise<NextResponse> {
  const parsed = ValidateBodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const data = parsed.data;
  const snapshot: WorkflowSnapshot = {
    workflow_id: "__validate__",
    version: 0,
    kind: "narrative",
    script_llm_provider: data.script_llm_provider,
    tts_provider: data.tts_provider,
    image_provider: data.image_provider,
    video_provider: data.video_provider,
    music_provider: null,
    upscaler_provider: null,
    chunker_step: data.chunker_step,
    image_style: data.image_style ?? null,
    steps: data.steps,
  };
  const inputs = validateInputAvailability(snapshot);
  const consistency = validateWorkflowConsistency(snapshot);
  return NextResponse.json({
    warnings: [...inputs.warnings, ...consistency.warnings],
  });
}
