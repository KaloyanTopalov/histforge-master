import { NextResponse } from "next/server";
import { magnificRuntime } from "@/lib/magnific-runtime";

// The handler reads no request-specific input, so Next's production build
// statically prerenders it and freezes the cold-state response
// ({running:false,...}) into the bundle — the pill then polls a stale
// build-time snapshot forever. Force per-request execution so the poll
// reflects the live in-memory runtime state.
export const dynamic = "force-dynamic";

/**
 * Runtime status snapshot for the Settings pill. Returns the runtime's
 * `{running, connected, session_valid, last_error}` payload verbatim — no
 * `success` wrapper, since this is a read of in-memory state, not a
 * mutation. The pill component polls this every 5s.
 */
export async function GET(): Promise<NextResponse> {
  const status = await magnificRuntime.status();
  return NextResponse.json(status);
}
