import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
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

export interface RunDrawOnCliOpts {
  /** Resolved interpreter path (from `resolveDrawOnPythonPath`). */
  pythonPath: string;
  /** Source image to draw — passed as the first positional CLI arg. */
  imagePath: string;
  /** Output clip duration in seconds — passed as the second positional CLI arg. */
  durationSec: number;
  /** Output MP4 path — passed as the third positional CLI arg. */
  outputPath: string;
  /**
   * Cancellation signal. When it aborts mid-render, the child is killed
   * and the promise rejects with an abort error. A pre-aborted signal
   * short-circuits without spawning anything.
   */
  signal?: AbortSignal;
  /**
   * Optional callback for stderr lines. Called once per `\n`-delimited
   * line as they arrive (trailing newline stripped). Used by the worker
   * step to route progress into `appendLog`.
   */
  log?: (line: string) => void;
  /** Test seam — defaults to `node:child_process`'s `spawn`. */
  spawnFn?: typeof spawn;
}

/**
 * Spawn the draw-on CLI for a single image. Resolves on exit code 0;
 * rejects on non-zero exit, spawn error, or AbortSignal trigger. The
 * spawn shape mirrors `align-whisper.ts` (stderr captured + tail in the
 * reject message), with two additions Session 2 needed:
 *
 *   1. Per-line `log` callback so the worker step can route progress
 *      into `appendLog` instead of dumping the whole 8KB tail on close.
 *   2. AbortSignal wiring — listeners on the controller kill the child
 *      and reject the promise so a deletion mid-render bails the
 *      sequential loop immediately.
 *
 * The CLI invocation is `<python> -m draw_on <image> <dur_sec> <out>`,
 * matching the Session-1 README. All flags (--fps, --split-len,
 * --dilation-px) stay at the CLI's locked defaults.
 */
export function runDrawOnCli(opts: RunDrawOnCliOpts): Promise<void> {
  const spawnFn = opts.spawnFn ?? spawn;

  // Pre-aborted: never spawn. The signal is consulted *before* the
  // child to honor the "no work after abort" contract — important when
  // a sequential loop's checkpoint fires the same tick the orchestrator
  // is shutting down.
  if (opts.signal?.aborted) {
    return Promise.reject(new Error("draw-on aborted before spawn"));
  }

  return new Promise<void>((resolveP, reject) => {
    const args = [
      "-m",
      "draw_on",
      opts.imagePath,
      String(opts.durationSec),
      opts.outputPath,
    ];

    const child: ChildProcess = spawnFn(opts.pythonPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderrTail = "";
    let lineBuffer = "";
    let settled = false;

    const onAbort = () => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        /* best effort — kill on already-dead child is fine */
      }
      reject(new Error("draw-on aborted via AbortSignal"));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail += text;
      // Cap the tail. align-whisper.ts settled on 8000 — same here.
      if (stderrTail.length > 8000) stderrTail = stderrTail.slice(-8000);

      if (opts.log) {
        lineBuffer += text;
        let nl: number;
        while ((nl = lineBuffer.indexOf("\n")) !== -1) {
          const line = lineBuffer.slice(0, nl).replace(/\r$/, "");
          lineBuffer = lineBuffer.slice(nl + 1);
          opts.log(line);
        }
      }
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);
      reject(
        new Error(
          `failed to spawn draw-on (${opts.pythonPath}): ${err.message}`
        )
      );
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      opts.signal?.removeEventListener("abort", onAbort);

      // Flush any final unterminated stderr line so `log` sees everything.
      if (opts.log && lineBuffer.length > 0) {
        opts.log(lineBuffer.replace(/\r$/, ""));
        lineBuffer = "";
      }

      if (code === 0) {
        resolveP();
        return;
      }
      const tail = stderrTail
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(-3)
        .join(" | ");
      reject(
        new Error(
          `draw-on (${opts.pythonPath}) exited with code ${code ?? "null"}${
            tail ? `: ${tail}` : ""
          }`
        )
      );
    });
  });
}
