import { NextResponse } from "next/server";
import { magnificRuntime } from "@/lib/magnific-runtime";

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
