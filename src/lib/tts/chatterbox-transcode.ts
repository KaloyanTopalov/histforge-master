import {
  spawn as nodeSpawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { throwIfAborted } from "@/worker/cancellation";

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions
) => ChildProcess;

export interface WavBytesToMp3Opts {
  /** Cancellation signal — passed straight to `spawn` so Node's signal-aware
   * kill handles SIGTERM (POSIX) / process kill (Windows). */
  signal?: AbortSignal;
  /**
   * Spawn injection point — defaults to `node:child_process` `spawn`.
   * Tests pass a fake that returns an EventEmitter-shaped stub. Mirrors
   * the `exec` injection pattern in `worker/steps/14-render.ts`.
   */
  spawn?: SpawnFn;
  /**
   * Pitch-preserving tempo factor applied via ffmpeg's `atempo` audio
   * filter. Omitted (or `1.0`) means no filter is added. Used by the
   * Chatterbox-fast provider to apply `chatterbox_speed_factor` after
   * the sidecar emits unmodified-tempo WAV — the fast fork's
   * `model.generate()` exposes no speed parameter. `atempo` natively
   * accepts 0.5..2.0; values outside that range are realised by chaining
   * two filters (e.g. 4× → `atempo=2,atempo=2`).
   */
  speed?: number;
}

/**
 * Build the ffmpeg `-filter:a` arg pair for a tempo factor. Returns an
 * empty list at speed=1.0 (the default — keeps the existing chatterbox
 * path's args identical to before this feature). atempo's native range
 * is 0.5..2.0; outside that we chain two filters whose product is the
 * requested speed. Validates an upper/lower bound consistent with the
 * `chatterbox_speed_factor` Zod range (0.25..4) so an out-of-band
 * caller fails loudly rather than silently dropping the filter.
 */
function atempoArgs(speed: number): string[] {
  if (speed === 1.0) return [];
  if (speed < 0.25 || speed > 4) {
    throw new Error(
      `wavBytesToMp3 speed must be in [0.25, 4]; got ${speed}`
    );
  }
  if (speed >= 0.5 && speed <= 2.0) {
    return ["-filter:a", `atempo=${speed}`];
  }
  if (speed > 2.0) {
    return ["-filter:a", `atempo=2,atempo=${speed / 2}`];
  }
  // speed < 0.5 — chain on the slow side
  return ["-filter:a", `atempo=0.5,atempo=${speed / 0.5}`];
}

/**
 * Pipe `wavBytes` through `ffmpeg -i pipe:0` and write a libmp3lame MP3
 * to `outMp3Path`. Mirrors the spawn pattern in `worker/steps/14-render.ts`
 * — only the args and the stdin pipe differ. Used by the Chatterbox TTS
 * provider to convert the wrapper's WAV output into the MP3 the rest of
 * the pipeline expects.
 *
 * Stays in `lib/tts/` rather than folding into `lib/render.ts` because
 * this is a TTS concern (provider-side wire-format adapter), not a
 * rendering concern.
 */
export async function wavBytesToMp3(
  wavBytes: Buffer,
  outMp3Path: string,
  opts: WavBytesToMp3Opts = {}
): Promise<void> {
  // `async` so the pre-Promise sync throws (throwIfAborted, mkdirSync
  // EACCES) surface as rejections — callers handle every failure mode
  // through a single try/await instead of guarding the sync prelude
  // separately.
  throwIfAborted(opts.signal);
  mkdirSync(dirname(outMp3Path), { recursive: true });

  const spawnFn = opts.spawn ?? nodeSpawn;

  return new Promise<void>((resolve, reject) => {
    const child = spawnFn(
      "ffmpeg",
      [
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        ...atempoArgs(opts.speed ?? 1.0),
        "-codec:a",
        "libmp3lame",
        "-q:a",
        "2",
        outMp3Path,
      ],
      {
        stdio: ["pipe", "ignore", "pipe"],
        windowsHide: true,
        signal: opts.signal,
      }
    );

    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      // Cap to avoid runaway memory; ffmpeg can be chatty even on
      // narration-length inputs if something is off.
      if (stderr.length < 64 * 1024) stderr += chunk.toString("utf-8");
    });

    // AbortError from Node's signal-aware spawn lands here too — surfaces
    // to the caller verbatim so `isAbortError` can distinguish it from a
    // real ffmpeg failure.
    child.on("error", reject);

    child.on("exit", (code, sig) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split("\n").slice(-3).join(" | ");
      reject(
        new Error(
          `ffmpeg WAV→MP3 exited with ${
            code === null ? `signal=${sig}` : `code=${code}`
          }: ${tail}`
        )
      );
    });

    child.stdin?.write(wavBytes);
    child.stdin?.end();
  });
}
