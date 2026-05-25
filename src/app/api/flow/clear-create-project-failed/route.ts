import { NextResponse } from "next/server";
import { setSetting } from "@/lib/settings";
import { FlowBannerKeys } from "@/lib/lifecycle/flow-banner-keys";

// Dashboard-internal: the operator clicks Dismiss after acknowledging
// the trpc-envelope-drift banner on /videos. No token gate (same posture
// as /api/flow/accounts) — this is operator-driven from the dashboard's
// own browser session, not the extension.
export async function POST(): Promise<NextResponse> {
  setSetting(FlowBannerKeys.createProjectFailed, "");
  return NextResponse.json({ ok: true });
}
