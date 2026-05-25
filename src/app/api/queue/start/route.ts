import { NextResponse } from "next/server";
import { setSetting } from "@/lib/settings";

export async function POST(): Promise<NextResponse> {
  setSetting("queue_state", "running");
  return NextResponse.json({ ok: true, queueState: "running" });
}
