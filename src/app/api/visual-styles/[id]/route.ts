import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db";
import * as visualStylesRepo from "@/lib/repos/visual-styles";

interface RouteCtx {
  params: { id: string };
}

export async function GET(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const visual_style = visualStylesRepo.findById(getDb(), ctx.params.id);
  if (!visual_style) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ visual_style });
}

const PatchVisualStyleSchema = z
  .object({
    title: z.string().min(1).optional(),
    prompt: z.string().optional(),
  })
  .refine((v) => v.title !== undefined || v.prompt !== undefined, {
    message: "at least one field required",
  });

export async function PATCH(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  if (!visualStylesRepo.findById(db, ctx.params.id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  const parsed = PatchVisualStyleSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  visualStylesRepo.update(db, ctx.params.id, parsed.data);
  const updated = visualStylesRepo.findById(db, ctx.params.id);
  return NextResponse.json({ visual_style: updated });
}

/**
 * Unconditional 204 — missing-row is a silent success (decision 3 in the
 * plan / handoff). Referencing `videos.visual_style_id` FKs are nulled by
 * the `ON DELETE SET NULL` constraint set up in Phase 3; no in-use gating.
 */
export async function DELETE(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  visualStylesRepo.deleteById(getDb(), ctx.params.id);
  return new NextResponse(null, { status: 204 });
}
