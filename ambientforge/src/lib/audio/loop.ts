/**
 * Loop a stream-copyable WAV until its duration meets a target, then
 * stream-copy trim to the exact target. Used by step 08 to extend the
 * 30-track concat to a 2-hour (or test-target) duration. The trim lands at
 * the end of the final repeat — never mid-concat.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ffprobe, FfmpegError, runFfmpeg } from './ffmpeg';

const TRIM_TOLERANCE_S = 0.5;

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

export async function loopToTarget(
  concatPath: string,
  outPath: string,
  targetSeconds: number,
): Promise<void> {
  if (!fs.existsSync(concatPath)) {
    throw new FfmpegError('LOOP_INPUT_MISSING', `concat input not found: ${concatPath}`);
  }
  if (targetSeconds <= 0) {
    throw new FfmpegError('LOOP_INVALID_TARGET', `targetSeconds must be > 0; got ${targetSeconds}`);
  }

  // Idempotency: skip only if the output matches the target duration AND is
  // newer than the source concat. Without the mtime check, a stale loop.wav
  // built from a previous (e.g., truncated) concat would be reused even after
  // concat.wav was correctly regenerated — silently propagating wrong content
  // into the final mux.
  if (fs.existsSync(outPath)) {
    try {
      const existing = await ffprobe(outPath);
      const outStat = fs.statSync(outPath);
      const concatStat = fs.statSync(concatPath);
      if (
        existing.duration !== undefined &&
        Math.abs(existing.duration - targetSeconds) <= TRIM_TOLERANCE_S &&
        outStat.mtimeMs >= concatStat.mtimeMs
      ) {
        return;
      }
    } catch {
      // Fall through to re-render.
    }
  }

  const concatProbe = await ffprobe(concatPath);
  const concatDur = concatProbe.duration;
  if (!concatDur || concatDur <= 0) {
    throw new FfmpegError('LOOP_INPUT_NO_DURATION', `cannot read concat duration for ${concatPath}`);
  }

  const repeats = Math.ceil(targetSeconds / concatDur);
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const outDir = path.dirname(outPath);
  const listPath = path.join(outDir, 'loop-list.txt');
  const loopFullPath = path.join(outDir, 'loop_full.wav');
  // Escape single quotes inside the path for FFmpeg's concat demuxer (same
  // gotcha as src/lib/audio/concat.ts — a path containing a literal apostrophe
  // would terminate the file '...' string early and silently truncate looping).
  const escapeForConcat = (raw: string): string => raw.replace(/'/g, "'\\''");
  const concatLine = `file '${escapeForConcat(toForwardSlash(path.resolve(concatPath)))}'`;
  const listBody = Array.from({ length: repeats }, () => concatLine).join('\n');
  await fs.promises.writeFile(listPath, listBody + '\n', 'utf8');

  try {
    // Stage 1: stream-copy concat into loop_full.wav (still over-target).
    await runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      loopFullPath,
    ]);
    // Stage 2: trim to exactly targetSeconds. Stream-copy trim works because
    // the loop is uniform — the cut happens inside the final repeat.
    await runFfmpeg([
      '-y',
      '-i',
      loopFullPath,
      '-c',
      'copy',
      '-t',
      String(targetSeconds),
      outPath,
    ]);
  } finally {
    await fs.promises.unlink(listPath).catch(() => {});
    await fs.promises.unlink(loopFullPath).catch(() => {});
  }
}
