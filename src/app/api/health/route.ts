import { NextResponse } from "next/server";

/**
 * Liveness endpoint used to verify the Next.js process is up.
 */
export async function GET() {
  return NextResponse.json({ ok: true });
}
