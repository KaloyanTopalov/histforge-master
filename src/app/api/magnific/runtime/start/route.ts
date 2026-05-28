import { NextResponse } from "next/server";
import { magnificRuntime } from "@/lib/magnific-runtime";

/**
 * Operator-facing control: boot the Playwright-managed Chromium that hosts
 * magnific-ext. No token auth — Settings is operator-only and lives behind
 * the same surface area as the rest of the dashboard (mirrors
 * `src/app/api/magnific/regenerate-token/route.ts`).
 *
 * The runtime owns idempotency: a second POST while already running is a
 * no-op. Errors (Chromium missing, extension path invalid, userDataDir
 * locked) surface as HTTP 500 with the message text so the dashboard
 * banner can render a useful diagnostic.
 */
export async function POST(): Promise<NextResponse> {
  try {
    await magnificRuntime.start();
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }
}
