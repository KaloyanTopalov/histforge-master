import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Repo-relative path to the Session-1 Python virtual environment on
 * Windows. The setup script (`python/draw_on/setup.ps1`) creates this
 * .venv with the draw-on CLI's pinned dependencies (numpy, opencv-python).
 */
export const DRAW_ON_VENV_WINDOWS_RELATIVE =
  "python/draw_on/.venv/Scripts/python.exe";

/**
 * Repo-relative path to the same .venv on POSIX (the layout the macOS /
 * Linux `setup.sh` script produces).
 */
export const DRAW_ON_VENV_POSIX_RELATIVE = "python/draw_on/.venv/bin/python";

export interface ResolveDrawOnPythonPathOpts {
  /**
   * The `draw_on_python_path` setting value as read from the settings
   * table (string, possibly empty). Non-empty operator overrides win
   * outright — the resolver does NOT validate them against the
   * filesystem. The render precheck (Phase 7) runs `python -m draw_on
   * --help` to verify the resolved path can actually launch the CLI.
   */
  setting: string | null;
  /** Repo root for venv probing. Defaults to `process.cwd()`. */
  repoRoot?: string;
  /** Platform string for venv shape selection. Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Filesystem existence probe — test seam. Defaults to `existsSync`. */
  existsFn?: (path: string) => boolean;
}

/**
 * Resolve the Python interpreter the draw-on step / render precheck will
 * spawn. Three-tier fallback:
 *
 *   1. The operator-set `draw_on_python_path` setting wins outright when
 *      non-empty (whitespace-only is treated as empty so a settings UI
 *      that submits `"   "` doesn't accidentally pin a broken path).
 *   2. The Session-1 .venv at `python/draw_on/.venv/...` (Windows
 *      `Scripts/python.exe` or POSIX `bin/python`) is the default for
 *      operators who ran the setup script.
 *   3. Bare `python` on PATH is the last-ditch fallback for systems where
 *      the venv isn't present. The render precheck then verifies the
 *      `python -m draw_on --help` invocation actually returns 0.
 *
 * No throws on missing files — the resolver is the cheap path; the
 * precheck is the loud-failure path.
 */
export function resolveDrawOnPythonPath(
  opts: ResolveDrawOnPythonPathOpts
): string {
  const setting = (opts.setting ?? "").trim();
  if (setting.length > 0) return setting;

  const repoRoot = opts.repoRoot ?? process.cwd();
  const platform = opts.platform ?? process.platform;
  const existsFn = opts.existsFn ?? existsSync;

  const relative =
    platform === "win32"
      ? DRAW_ON_VENV_WINDOWS_RELATIVE
      : DRAW_ON_VENV_POSIX_RELATIVE;
  const venvPath = resolve(repoRoot, relative);

  if (existsFn(venvPath)) return venvPath;
  return "python";
}
