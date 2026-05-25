import { NextResponse } from "next/server";
import { setSetting } from "@/lib/settings";

export async function POST(): Promise<NextResponse> {
  setSetting("queue_state", "paused");
  return NextResponse.json({ ok: true, queueState: "paused" });
}
