import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { BUILTIN_WORKFLOWS } from "@/lib/workflows";
import * as workflowsRepo from "@/lib/repos/workflows";
import { buildDetail } from "@/lib/workflows-api";

interface RouteCtx {
  params: { id: string };
}

export async function POST(
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
    if (current.is_builtin === 0) {
      response = NextResponse.json(
        { error: "not_a_builtin" },
        { status: 400 }
      );
      return;
    }
    const seed = BUILTIN_WORKFLOWS.find((w) => w.id === id);
    if (!seed) {
      response = NextResponse.json(
        { error: "no_seed_for_builtin" },
        { status: 500 }
      );
      return;
    }
    workflowsRepo.update(db, id, {
      label: seed.label,
      short_label: seed.short_label,
      description: seed.description,
      kind: seed.kind,
      script_llm_provider: seed.script_llm_provider,
      tts_provider: seed.tts_provider,
      image_provider: seed.image_provider,
      video_provider: seed.video_provider,
      music_provider: seed.music_provider,
      upscaler_provider: seed.upscaler_provider,
      chunker_step: seed.chunker_step,
      enabled: 1,
    });
    workflowsRepo.replaceSteps(db, id, seed.steps);
    workflowsRepo.bumpVersion(db, id);

    response = NextResponse.json({ workflow: buildDetail(db, id) });
  })();

  if (notFound) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return response!;
}
