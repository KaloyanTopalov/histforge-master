import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import * as gfRepo from "@/lib/repos/google-flow";

/**
 * Narrow projection of Flow accounts currently in operator-gated
 * recovery. Surfaces the same query as `BannerFlags.flowRecoveryAccounts`
 * on the videos-list poll, but on a dedicated endpoint so the
 * `/videos/[id]` page can poll just this slice without pulling the full
 * videos-list payload.
 */
export async function GET(): Promise<NextResponse> {
  const db = getDb();
  return NextResponse.json({ accounts: gfRepo.listRecoveryAccounts(db) });
}
