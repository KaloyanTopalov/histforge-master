import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { getDb } from "@/lib/db";
import { setSetting } from "@/lib/settings";

/**
 * Rotate the single Magnific extension token. Settings UI calls this
 * when the operator clicks Regenerate; the response carries the new
 * value so the page can update its display + clipboard without an extra
 * round-trip. No auth header — Settings is operator-only and lives
 * behind the same surface area as the rest of the dashboard.
 *
 * Mirrors `randomBytes(24).toString('base64url')` from Flow account
 * minting (src/app/api/flow/accounts/route.ts:30) for entropy parity.
 */
export async function POST(_req: Request): Promise<NextResponse> {
  const db = getDb();
  const token = randomBytes(24).toString("base64url");
  setSetting("magnific_token", token, db);
  return NextResponse.json({ token });
}
