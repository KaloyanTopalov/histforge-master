import { NextResponse } from "next/server";
import { resolveWhisperInstall } from "@/lib/whisper-install";

/**
 * GET /api/whisper/status — describes how the local-Whisper path will
 * resolve on this host:
 *
 *   - source: "env"    → WHISPER_LOCAL_BIN + WHISPER_LOCAL_MODEL set
 *   - source: "vendor" → auto-installed copy under vendor/whisper/
 *   - source: "none"   → nothing configured yet
 *
 * The alignment-card UI polls this on mount + after a setup call so the
 * status badge tracks reality without a hard page reload.
 */
export async function GET(): Promise<NextResponse> {
  const state = resolveWhisperInstall();
  return NextResponse.json(state);
}
