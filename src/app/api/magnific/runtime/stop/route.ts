import { NextResponse } from "next/server";
import { magnificRuntime } from "@/lib/magnific-runtime";

/**
 * Operator-facing control: tear down the Playwright-managed Chromium.
 * Awaits `context.close()` so cookies / IndexedDB flush cleanly before the
 * response returns. No-op when already stopped (the runtime guards). Same
 * no-auth rationale as `/start`.
 */
export async function POST(): Promise<NextResponse> {
  try {
    await magnificRuntime.stop();
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
