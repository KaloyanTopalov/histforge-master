import { NextResponse } from "next/server";
import { z } from "zod";
import { ulid } from "ulid";
import { getDb } from "@/lib/db";
import * as visualStylesRepo from "@/lib/repos/visual-styles";
import type { VisualStyle } from "@/types";

export async function GET(): Promise<NextResponse> {
  const visual_styles = visualStylesRepo.list(getDb());
  return NextResponse.json({ visual_styles });
}

const CreateVisualStyleSchema = z.object({
  title: z.string().min(1),
  prompt: z.string(),
});

export async function POST(req: Request): Promise<NextResponse> {
  const parsed = CreateVisualStyleSchema.safeParse(await req.json());
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }
  const db = getDb();
  const now = Date.now();
  const row: VisualStyle = {
    id: ulid(),
    title: parsed.data.title,
    prompt: parsed.data.prompt,
    created_at: now,
    updated_at: now,
  };
  visualStylesRepo.insert(db, row);
  return NextResponse.json({ visual_style: row }, { status: 201 });
}
