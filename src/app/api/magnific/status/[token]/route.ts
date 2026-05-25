import { NextResponse } from "next/server";
import { z } from "zod";
import { resolveMagnificToken } from "@/lib/magnific-auth";
import { setSetting } from "@/lib/settings";

interface RouteCtx {
  params: { token: string };
}

/**
 * Session-health channel for the magnific-ext SW. On `session_expired`
 * the route flips the `magnific_relogin_needed` settings flag so the
 * dashboard banner can prompt the operator to re-login the magnific.ai
 * Chrome tab. Every other event kind is accepted and no-op'd:
 *
 *   • The extension may emit advisory events HistForge doesn't track
 *     yet (rate_limited, bridge_reload, …); rejecting unknown events
 *     just clutters the SW console without blocking any real work.
 *   • The contract intentionally matches Flow's /status/[token] shape
 *     (`type: "StatusEvent"`, free-form `event` string) so future events
 *     plug in without a route version bump — the relogin-needed clear
 *     is the operator's job from the Settings tab in v1.
 *
 * Schema is intentionally permissive: any string event is accepted, only
 * the `event` field is required, and unknown fields pass through.
 */
const StatusEventSchema = z
  .object({
    event: z.string().min(1),
  })
  .passthrough();

export async function POST(
  req: Request,
  ctx: RouteCtx
): Promise<NextResponse> {
  const auth = resolveMagnificToken(ctx.params.token);
  if (!auth.ok) return auth.response;
  const { db } = auth;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  const parsed = StatusEventSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_input", issues: parsed.error.issues },
      { status: 400 }
    );
  }

  if (parsed.data.event === "session_expired") {
    setSetting("magnific_relogin_needed", true, db);
  }
  // Other event kinds (rate_limited, bridge_reload, …) are advisory —
  // accept and no-op.

  return NextResponse.json({ success: true });
}
