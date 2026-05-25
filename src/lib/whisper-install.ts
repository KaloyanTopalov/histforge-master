import { spawn } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join, resolve } from "node:path";

/**
 * Where auto-installed whisper.cpp artefacts live. Kept under
 * `vendor/whisper/` at the repo root so a single `.gitignore` rule
 * (`vendor/`) excludes both the binary and the model. Operators who
 * prefer manual install set `WHISPER_LOCAL_BIN` + `WHISPER_LOCAL_MODEL`
 * in `.env` and bypass this directory entirely.
 */
export const VENDOR_DIR = resolve(process.cwd(), "vendor", "whisper");

/**
 * Stable GitHub download URLs. `releases/latest/download/<asset>`
 * redirects to the asset on the most recent release — we don't have to
 * pin a version. If whisper.cpp ever drops the `whisper-bin-x64.zip`
 * asset name we'll need to update this, but it's been stable since the
 * project started shipping Windows binaries.
 */
const WHISPER_WIN_BIN_ZIP_URL =
  "https://github.com/ggerganov/whisper.cpp/releases/latest/download/whisper-bin-x64.zip";

/**
 * Hugging Face direct download for the base English model. ~150 MB,
 * the sweet spot for speed/quality on CPU. Operators can swap the
 * model URL via WHISPER_INSTALL_MODEL_URL if they want a different
 * size — the install layout stays the same.
 */
const DEFAULT_MODEL_URL =
  "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const DEFAULT_MODEL_NAME = "ggml-base.en.bin";

export interface WhisperInstallState {
  /**
   * Where the route resolves the binary + model from on this host.
   * `env` means WHISPER_LOCAL_BIN / WHISPER_LOCAL_MODEL took priority;
   * `vendor` means the auto-installed copy under vendor/whisper/ was
   * picked up; `none` means nothing is configured yet.
   */
  source: "env" | "vendor" | "none";
  installed: boolean;
  binPath: string | null;
  modelPath: string | null;
  /**
   * True when this host has a feasible auto-install path. Windows
   * x64 only for now — whisper.cpp publishes prebuilt binaries only
   * for Windows; macOS / Linux installs go via package manager or
   * source build, which we don't try to script.
   */
  autoInstallSupported: boolean;
}

/**
 * Resolves what local-Whisper assets the host has access to, in
 * priority order: explicit env vars beat the vendor/ install. Used by
 * the alignment auto-transcribe route to pick a binary + model, and
 * by the status route to feed the UI.
 */
export function resolveWhisperInstall(): WhisperInstallState {
  const autoInstallSupported = process.platform === "win32";

  const envBin = (process.env.WHISPER_LOCAL_BIN || "").trim();
  const envModel = (process.env.WHISPER_LOCAL_MODEL || "").trim();
  if (envBin && envModel && existsSync(envBin) && existsSync(envModel)) {
    return {
      source: "env",
      installed: true,
      binPath: envBin,
      modelPath: envModel,
      autoInstallSupported,
    };
  }

  // Vendor fallback: look for either of whisper.cpp's two binary names,
  // both at the root of vendor/whisper/ AND inside vendor/whisper/Release/.
  // The current Windows release zip extracts a `Release/` subfolder
  // containing the binaries + DLLs; older release shapes (or a manual
  // copy) might land them at the root. The DLLs whisper-cli needs sit
  // next to the .exe regardless, so we just resolve to wherever the
  // exe lives and let Windows' DLL search find them locally.
  // Recent releases use `whisper-cli.exe`; older ones use `main.exe`.
  const candidates: string[] = [];
  for (const dir of [VENDOR_DIR, join(VENDOR_DIR, "Release")]) {
    for (const name of ["whisper-cli.exe", "main.exe", "whisper-cli", "main"]) {
      candidates.push(join(dir, name));
    }
  }
  const venBin = candidates.find((p) => existsSync(p));
  const venModel = join(VENDOR_DIR, DEFAULT_MODEL_NAME);
  if (venBin && existsSync(venModel)) {
    return {
      source: "vendor",
      installed: true,
      binPath: venBin,
      modelPath: venModel,
      autoInstallSupported,
    };
  }

  return {
    source: "none",
    installed: false,
    binPath: null,
    modelPath: null,
    autoInstallSupported,
  };
}

export interface SetupResult {
  ok: true;
  binPath: string;
  modelPath: string;
  binBytes: number;
  modelBytes: number;
}

export class WhisperInstallError extends Error {
  constructor(message: string, public stage: string) {
    super(message);
    this.name = "WhisperInstallError";
  }
}

export interface SetupOptions {
  /**
   * Override download URLs — used by the test suite to swap in a local
   * mock server. Defaults to whisper.cpp's GitHub release + the base
   * English model on Hugging Face.
   */
  binZipUrl?: string;
  modelUrl?: string;
  /**
   * Override the vendor directory — tests point this at a tmpdir so a
   * real install isn't written into the repo root.
   */
  vendorDir?: string;
  /**
   * Replace the zip-extraction step (PowerShell's Expand-Archive on
   * Windows by default). Tests pass a noop or a synthetic extractor
   * because Expand-Archive is Windows-only.
   */
  extractZipFn?: (zipPath: string, destDir: string) => Promise<void>;
}

/**
 * Downloads whisper.cpp's Windows x64 binary archive + the base
 * English ggml model into `vendor/whisper/`. Idempotent — re-running
 * after a partial failure resumes wherever needed.
 *
 * Failure modes are explicit (WhisperInstallError with `stage` set)
 * so the route can surface a useful message instead of "fetch
 * failed".
 */
export async function setupWhisper(opts: SetupOptions = {}): Promise<SetupResult> {
  const vendorDir = opts.vendorDir ?? VENDOR_DIR;
  const binZipUrl = opts.binZipUrl ?? WHISPER_WIN_BIN_ZIP_URL;
  const modelUrl = (process.env.WHISPER_INSTALL_MODEL_URL || opts.modelUrl || DEFAULT_MODEL_URL).trim();
  const extractZipFn = opts.extractZipFn ?? extractZipWindows;

  mkdirSync(vendorDir, { recursive: true });

  // Step 1: download the Windows binary zip if no extracted exe is
  // already present. The exe names + subdir mirror what
  // resolveWhisperInstall looks for — finding any of them means
  // "binary stage is done". whisper.cpp's current Windows release zip
  // extracts into a `Release/` subfolder; older shapes land at root.
  const exeCandidates: string[] = [];
  for (const dir of [vendorDir, join(vendorDir, "Release")]) {
    for (const name of ["whisper-cli.exe", "main.exe"]) {
      exeCandidates.push(join(dir, name));
    }
  }
  const existingExe = exeCandidates.find((p) => existsSync(p));
  let binPath: string;
  if (existingExe) {
    binPath = existingExe;
  } else {
    const zipPath = join(vendorDir, "whisper-bin-x64.zip");
    try {
      await downloadToFile(binZipUrl, zipPath);
    } catch (e) {
      throw new WhisperInstallError(
        `Failed to download whisper.cpp binary from ${binZipUrl}: ${e instanceof Error ? e.message : String(e)}`,
        "download_binary",
      );
    }
    try {
      await extractZipFn(zipPath, vendorDir);
    } catch (e) {
      throw new WhisperInstallError(
        `Failed to extract ${zipPath}: ${e instanceof Error ? e.message : String(e)}`,
        "extract_binary",
      );
    }
    // Leave the zip behind on partial failure (lets a retry reuse the
    // download); only delete after a successful extract.
    try { unlinkSync(zipPath); } catch { /* best effort */ }
    const extracted = exeCandidates.find((p) => existsSync(p));
    if (!extracted) {
      throw new WhisperInstallError(
        `Extracted archive at ${vendorDir} did not contain whisper-cli.exe or main.exe (checked the root and a Release/ subfolder).`,
        "extract_binary",
      );
    }
    binPath = extracted;
  }

  // Step 2: download the model. Same idempotence trick — skip if the
  // file already exists with non-zero size. A partial download from a
  // prior crash gets wiped (zero or partial bytes; we can't tell
  // partial cleanly so we re-fetch on truncated state).
  const modelPath = join(vendorDir, DEFAULT_MODEL_NAME);
  let modelBytes = 0;
  try {
    if (existsSync(modelPath)) modelBytes = statSync(modelPath).size;
  } catch { /* fall through to redownload */ }
  // ggml-base.en.bin is ~147 MB. Anything under 1 MB is definitely
  // a partial download from an aborted attempt; re-fetch.
  if (modelBytes < 1024 * 1024) {
    try {
      if (existsSync(modelPath)) unlinkSync(modelPath);
    } catch { /* best effort */ }
    try {
      await downloadToFile(modelUrl, modelPath);
    } catch (e) {
      throw new WhisperInstallError(
        `Failed to download model from ${modelUrl}: ${e instanceof Error ? e.message : String(e)}`,
        "download_model",
      );
    }
    modelBytes = statSync(modelPath).size;
  }

  const binBytes = statSync(binPath).size;
  return {
    ok: true,
    binPath,
    modelPath,
    binBytes,
    modelBytes,
  };
}

/**
 * Stream a URL to a file using undici-backed fetch + node:stream/promises.
 * Throws on non-2xx response so the caller can wrap it into a
 * WhisperInstallError with the right `stage` tag.
 */
async function downloadToFile(url: string, dest: string): Promise<void> {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
  }
  if (!resp.body) {
    throw new Error("Response had no body");
  }
  // Ensure parent dir exists in case caller skipped mkdir.
  mkdirSync(resolve(dest, ".."), { recursive: true });
  // resp.body is a web ReadableStream; convert to a Node Readable
  // for stream.pipeline. Node 18+ supports Readable.fromWeb directly.
  const nodeReadable = Readable.fromWeb(
    resp.body as unknown as Parameters<typeof Readable.fromWeb>[0],
  );
  // Clean up a partial file if pipeline throws — leaving a half-written
  // download confuses the idempotence check on the next run.
  try {
    await pipeline(nodeReadable, createWriteStream(dest));
  } catch (e) {
    try { rmSync(dest, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Windows-only ZIP extractor — spawns PowerShell's Expand-Archive.
 * Cross-platform extraction would need a Node library; we only ship
 * Windows binaries for now, so the platform restriction is fine.
 * Tests override this via SetupOptions.extractZipFn.
 */
function extractZipWindows(zipPath: string, destDir: string): Promise<void> {
  if (process.platform !== "win32") {
    return Promise.reject(
      new Error(
        "Auto-install is Windows-only. On macOS/Linux, install whisper.cpp via your package manager and set WHISPER_LOCAL_BIN + WHISPER_LOCAL_MODEL in .env.",
      ),
    );
  }
  return new Promise((resolveP, reject) => {
    const ps = spawn(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -Path '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    ps.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    ps.on("error", (err) => {
      reject(new Error(`Expand-Archive spawn failed: ${err.message}`));
    });
    ps.on("close", (code) => {
      if (code === 0) resolveP();
      else reject(new Error(`Expand-Archive exited ${code}: ${stderr.trim() || "(no stderr)"}`));
    });
  });
}
