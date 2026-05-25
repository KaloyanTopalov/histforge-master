import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  IMPORT_ERROR_STATUS,
  ImportError,
  importWorkflowJson,
} from "@/lib/workflows-import";
import { buildDetail } from "@/lib/workflows-api";

export async function POST(req: Request): Promise<NextResponse> {
  const overwrite = new URL(req.url).searchParams.get("overwrite") === "1";
  const payload = await req.json();
  const db = getDb();
  try {
    const result = importWorkflowJson(db, payload, { overwrite });
    return NextResponse.json(
      { workflow: buildDetail(db, result.row.id), warnings: result.warnings },
      { status: result.status === "created" ? 201 : 200 }
    );
  } catch (err) {
    if (err instanceof ImportError) {
      return NextResponse.json(
        { error: err.code, ...err.details },
        { status: IMPORT_ERROR_STATUS[err.code] }
      );
    }
    throw err;
  }
}
