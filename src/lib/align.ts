import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { splitSentences } from "./sentences";

/**
 * Convert a Windows absolute path to a WSL mount path.
 * `C:\Users\x\foo` → `/mnt/c/Users/x/foo`
 *
 * Handles both backslash and forward-slash inputs (path.resolve on Windows
 * may return either depending on context).
 */
export function wslPath(winPath: string): string {
  // Normalise to forward slashes first
  const fwd = winPath.replace(/\\/g, "/");
  // Match drive letter at start: C:/ or c:/
  const match = fwd.match(/^([A-Za-z]):\//);
  if (!match) {
    // Already a posix path or relative — return as-is
    return fwd;
  }
  const drive = match[1].toLowerCase();
  const rest = fwd.slice(3); // skip "X:/"
  return `/mnt/${drive}/${rest}`;
}

export interface AlignOpts {
  /** Override spawn for testing — avoids real WSL calls. */
  spawnFn?: typeof spawn;
  /** Override repo root for testing — lets tests force a Windows-shaped path. */
  repoRoot?: string;
}

/**
 * Forced alignment via WSL + aeneas. Spec section 9
 * (`docs/histforge-spec.md:398-432`), interface per `:791`:
 *
 *   align(audioPath, scriptPath, outPath): Promise<void>
 *
 * 1. Reads the script from `scriptPath`.
 * 2. Splits into sentences (one per line) → writes `sentences.txt` next to
 *    `outPath` (i.e. in the same directory — `alignment/`).
 * 3. Spawns `wsl -d $WSL_DISTRO <venv-python> <align.py> --audio ... --text
 *    ... --out ...` and waits for exit. Uses the venv at
 *    `python/.venv/bin/python3.11` (must be explicit — on NTFS-mounted WSL
 *    paths, the `python3` symlink resolves to system 3.12 which can't see
 *    the venv's site-packages).
 * 4. On non-zero exit, throws with stderr so the orchestrator marks the step
 *    failed.
 *
 * The output `alignment.json` is written by align.py, not by this module.
 *
 * The interface is generic (audio/text/output paths) so a future WhisperX or
 * hosted aligner can drop in without touching step code.
 */
export async function align(
  audioPath: string,
  scriptPath: string,
  outPath: string,
  opts: AlignOpts = {}
): Promise<void> {
  const spawnFn = opts.spawnFn ?? spawn;

  // Pre-processing: sentence-split the full script
  const script = readFileSync(scriptPath, "utf-8");
  const sentences = splitSentences(script);

  // Write sentences.txt next to the output file (same alignment/ dir)
  const outDir = resolve(outPath, "..");
  const sentencesPath = resolve(outDir, "sentences.txt");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(sentencesPath, sentences.join("\n") + "\n", "utf-8");

  // Resolve paths for WSL invocation. repoRoot is joined by string template so
  // injected Windows-shaped paths (e.g. from tests running on Linux) survive
  // without being mangled by POSIX `resolve()`.
  const repoRoot = opts.repoRoot ?? resolve(process.cwd());
  const distro = process.env.WSL_DISTRO ?? "Ubuntu";
  const pythonBin = wslPath(`${repoRoot}/python/.venv/bin/python3.11`);
  const alignPy = wslPath(`${repoRoot}/python/align.py`);
  const wslAudio = wslPath(resolve(audioPath));
  const wslText = wslPath(resolve(sentencesPath));
  const wslOut = wslPath(resolve(outPath));

  const args = [
    "-d",
    distro,
    pythonBin,
    alignPy,
    "--audio",
    wslAudio,
    "--text",
    wslText,
    "--out",
    wslOut,
  ];

  return new Promise<void>((resolveP, reject) => {
    const child: ChildProcess = spawnFn("wsl", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err) => {
      reject(new Error(`Failed to spawn wsl: ${err.message}`));
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `align.py exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`
          )
        );
      } else {
        resolveP();
      }
    });
  });
}
