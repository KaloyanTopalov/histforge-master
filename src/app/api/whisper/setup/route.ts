import { NextResponse } from "next/server";
import {
  resolveWhisperInstall,
  setupWhisper,
  WhisperInstallError,
} from "@/lib/whisper-install";

/**
 * POST /api/whisper/setup — auto-installs whisper.cpp binary + ggml
 * model into `vendor/whisper/` so the alignment auto-transcribe route
 * can call them.
 *
 * Blocking: download is ~10 MB binary + ~150 MB model. On broadband
 * this takes 1-3 minutes; the route blocks until done. The UI shows
 * a busy state while the request is outstanding.
 *
 * Pre-flight checks:
 *   - 409 already_installed when status.installed is true (any source).
 *     Operator can re-run by deleting `vendor/whisper/` first.
 *   - 503 unsupported_platform on non-Windows hosts. Auto-install
 *     depends on whisper.cpp's prebuilt Windows release; macOS/Linux
 *     install via package manager or source build, which we don't
 *     try to automate.
 */
export async function POST(): Promise<NextResponse> {
  const before = resolveWhisperInstall();
  if (before.installed) {
    return NextResponse.json(
      {
        error: "already_installed",
        message:
          before.source === "env"
            ? "Local Whisper is already configured via env vars; nothing to install."
            : "Local Whisper is already installed under vendor/whisper/. Delete that directory to reinstall.",
        state: before,
      },
      { status: 409 },
    );
  }
  if (!before.autoInstallSupported) {
    return NextResponse.json(
      {
        error: "unsupported_platform",
        message:
          "Auto-install only supports Windows x64. On macOS/Linux, install whisper.cpp via your package manager (brew install whisper-cpp / apt build) and set WHISPER_LOCAL_BIN + WHISPER_LOCAL_MODEL in .env.",
      },
      { status: 503 },
    );
  }

  try {
    const result = await setupWhisper();
    const after = resolveWhisperInstall();
    return NextResponse.json({
      ok: true,
      binPath: result.binPath,
      modelPath: result.modelPath,
      binBytes: result.binBytes,
      modelBytes: result.modelBytes,
      state: after,
    });
  } catch (e) {
    if (e instanceof WhisperInstallError) {
      return NextResponse.json(
        { error: "install_failed", stage: e.stage, message: e.message },
        { status: 500 },
      );
    }
    return NextResponse.json(
      {
        error: "install_failed",
        message: e instanceof Error ? e.message : String(e),
      },
      { status: 500 },
    );
  }
}
