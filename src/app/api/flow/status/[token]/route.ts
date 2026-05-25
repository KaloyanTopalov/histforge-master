import { NextResponse } from "next/server";
import { z } from "zod";
import { setSetting } from "@/lib/settings";
import { resolveFlowAccount } from "@/lib/flow-auth";
import * as gfRepo from "@/lib/repos/google-flow";
import { FlowBannerKeys } from "@/lib/lifecycle/flow-banner-keys";

interface RouteCtx {
  params: { token: string };
}

/**
 * Session-expiry flips the global relogin flag but deliberately does
 * NOT pause the account — the extension self-halts in Chrome (Task 1.8),
 * and a DB pause would outlast a quick re-login with no mechanism to
 * clear early. Stale last_seen_at is the liveness signal instead.
 *
 * This route does NOT gate on account.enabled: status is observability
 * (operators want to know a disabled account is still reporting
 * session issues), and accepting submissions from disabled accounts
 * never moves work forward.
 *
 * Schema is intentionally permissive on `event`: the extension emits
 * advisory events (`progress`, `rate_limited`, `bridge_reload`,
 * `circuit_breaker_tripped`, …) that HistForge currently ignores.
 * Rejecting them with 400 just clutters the SW console without
 * blocking real work — accept and no-op instead.
 */
const StatusEventSchema = z.object({
  type: z.literal("StatusEvent"),
  accountToken: z.string().min(1),
  event: z.string().min(1),
  credits: z.number().optional(),
  tier: z.string().optional(),
  serviceTier: z.string().optional(),
  sku: z.string().optional(),
  at: z.string().optional(),
}).passthrough();

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = await resolveFlowAccount(req, ctx, StatusEventSchema);
  if (!auth.ok) return auth.response;
  const { account, parsed, db, now } = auth;

  if (parsed.event === "session_expired") {
    setSetting(FlowBannerKeys.reloginNeeded, true, db);
  } else if (parsed.event === "credits" && typeof parsed.credits === "number") {
    gfRepo.updateAccountCredits(db, account.id, parsed.credits, now);
  }
  // Other event kinds (progress, rate_limited, bridge_reload,
  // circuit_breaker_tripped, …) are advisory — accept and no-op.

  return NextResponse.json({ success: true });
}
