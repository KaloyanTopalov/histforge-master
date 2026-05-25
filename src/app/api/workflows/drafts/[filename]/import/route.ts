import { NextResponse } from "next/server";
import {
  existsSync,
  readFileSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { getDb } from "@/lib/db";
import {
  IMPORT_ERROR_STATUS,
  ImportError,
  importWorkflowJson,
} from "@/lib/workflows-import";
import {
  ensureDraftsDirs,
  getDraftsDir,
  getImportedDir,
  validateDraftFilename,
} from "@/lib/workflows-drafts-fs";
import { buildDetail } from "@/lib/workflows-api";

interface RouteCtx {
  params: { filename: string };
}

export async function POST(
  req: Request,
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

  const sourcePath = join(getDraftsDir(), ctx.params.filename);
  if (!existsSync(sourcePath)) {
    return NextResponse.json({ error: "draft_not_found" }, { status: 404 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(sourcePath, "utf-8"));
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const overwrite = new URL(req.url).searchParams.get("overwrite") === "1";
  const db = getDb();
  let result;
  try {
    result = importWorkflowJson(db, payload, { overwrite });
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json(
        { error: err.code, ...err.details },
        { status: IMPORT_ERROR_STATUS[err.code] }
      );
    }
    throw err;
  }

  // Successful commit → archive the source file. Same-volume sibling
  // rename, so EXDEV is not a concern under normal operation. If the
  // rename fails (disk full, EPERM), the DB row is the source of truth;
  // surface the failure as a top-level archiveError field so the UI can
  // prompt the operator to discard manually.
  const archivedName = `${result.row.id}-${Math.floor(Date.now() / 1000)}.json`;
  const archivedPath = join(getImportedDir(), archivedName);
  let archiveError: string | undefined;
  try {
    renameSync(sourcePath, archivedPath);
  } catch (err) {
    archiveError =
      err instanceof Error ? err.message : String(err);
    console.error(
      `Draft import committed but archive rename failed: ${sourcePath} -> ${archivedPath}`,
      err
    );
  }

  const responseBody: Record<string, unknown> = {
    workflow: buildDetail(db, result.row.id),
    warnings: result.warnings,
  };
  if (archiveError !== undefined) {
    responseBody.archiveError = archiveError;
  }
  return NextResponse.json(responseBody, {
    status: result.status === "created" ? 201 : 200,
  });
}
