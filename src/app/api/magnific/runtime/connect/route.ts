import { NextResponse } from "next/server";
import { magnificRuntime } from "@/lib/magnific-runtime";

/**
 * Operator-triggered connect flow: open a visible browser window, wait
 * for the operator to complete the Magnific login, then slide the window
 * back off-screen. The runtime owns the 5-minute timeout and the
 * re-entrancy guard — a second concurrent POST returns
 * `{success:false, reason:"connect_in_progress"}` synchronously without
 * touching the browser context.
 *
 * The response body is the runtime's `ConnectResult` verbatim. All
 * outcomes (success, timeout, connect_in_progress) return HTTP 200; the
 * route does not reclassify connect outcomes as HTTP errors so the
 * dashboard can render the reason string without forking on status code.
 */
export async function POST(): Promise<NextResponse> {
  const result = await magnificRuntime.connect();
  return NextResponse.json(result);
}
