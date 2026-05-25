import { NextResponse } from "next/server";
import { setSetting } from "@/lib/settings";
import { FlowBannerKeys } from "@/lib/lifecycle/flow-banner-keys";

// Dashboard-internal: the operator clicks Dismiss to snooze the
// session-expired banner on /videos. The flag also auto-clears on the
// first successful next-task claim, so manual dismissal is a UX escape
// hatch — re-emission on the next session_expired event is the design.
// No token gate (same posture as /api/flow/clear-create-project-failed).
export async function POST(): Promise<NextResponse> {
  setSetting(FlowBannerKeys.reloginNeeded, false);
  return NextResponse.json({ ok: true });
}
