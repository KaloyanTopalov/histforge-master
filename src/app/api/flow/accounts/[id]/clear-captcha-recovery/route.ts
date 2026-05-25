import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";

interface RouteCtx {
  params: { id: string };
}

// Dashboard-internal: the operator clicks Mark recovered after
// re-engaging the Flow session in the right Chrome profile. No probe
// task — the next real dispatch validates by design (if recovery
// wasn't successful, handleCaptcha re-fires automatically). No token
// gate (same posture as siblings) — this is operator-driven from the
// dashboard's own browser session, not the extension.
export async function POST(
  _req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const db = getDb();
  const account = gfRepo.findAccountById(db, ctx.params.id);
  if (!account) {
    return NextResponse.json(
      { error: "unknown_account" },
      { status: 404 }
    );
  }
  gfRepo.clearAccountRecovery(db, ctx.params.id);
  return NextResponse.json({ ok: true });
}
