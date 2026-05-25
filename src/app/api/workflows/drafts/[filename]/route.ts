import { NextResponse } from "next/server";
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ImportError } from "@/lib/workflows-import";
import {
  ensureDraftsDirs,
  getDraftsDir,
  validateDraftFilename,
} from "@/lib/workflows-drafts-fs";

interface RouteCtx {
  params: { filename: string };
}

export async function DELETE(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  ensureDraftsDirs();

  try {
    validateDraftFilename(ctx.params.filename);
  } catch (err) {
    if (err instanceof ImportError && err.code === "invalid_filename") {
      return NextResponse.json(
        { error: "invalid_filename" },
        { status: 400 }
      );
    }
    throw err;
  }

  const path = join(getDraftsDir(), ctx.params.filename);
  if (!existsSync(path)) {
    return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  }
  unlinkSync(path);
  return NextResponse.json({ deleted: true });
}
