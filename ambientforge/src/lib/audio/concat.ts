/**
 * Stream-copy concat of WAV inputs via the FFmpeg concat demuxer. No
 * re-encoding — the audio fed to DistroKid must be bit-identical to the audio
 * inside the YouTube video. If inputs differ in codec/sample-rate/channels we
 * fail with INCONSISTENT_AUDIO_FORMAT rather than silently re-encoding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ffprobe, FfmpegError, runFfmpeg } from './ffmpeg';

export type ConcatInputProbe = {
  path: string;
  codec?: string;
  sampleRate?: number;
  channels?: number;
  duration?: number;
};

const DURATION_TOLERANCE_S = 0.1;

function toForwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Concatenate `wavPaths` (in order) into `outPath` via stream-copy. The inputs
 * must share codec, sample rate, and channel count; otherwise the concat
 * demuxer would silently produce a corrupted file.
 *
 * Idempotent: if `outPath` already exists and its duration is within
 * ±0.1s of the sum of the inputs' durations, the call returns without
 * touching disk.
 */
export async function concatTracks(wavPaths: string[], outPath: string): Promise<void> {
  if (wavPaths.length === 0) {
    throw new FfmpegError('CONCAT_NO_INPUTS', 'concatTracks called with empty input list');
  }

  const probes: ConcatInputProbe[] = [];
  for (const p of wavPaths) {
    if (!fs.existsSync(p)) {
      throw new FfmpegError('CONCAT_INPUT_MISSING', `input wav not found: ${p}`);
    }
    const probe = await ffprobe(p);
    probes.push({
      path: p,
      codec: probe.audioCodec ?? probe.codec,
      sampleRate: probe.sampleRate,
      channels: probe.channels,
      duration: probe.duration,
    });
  }

  // Uniform-format check: every input must match the first.
  const ref = probes[0];
  for (let i = 1; i < probes.length; i += 1) {
    const cur = probes[i];
    if (
      cur.codec !== ref.codec ||
      cur.sampleRate !== ref.sampleRate ||
      cur.channels !== ref.channels
    ) {
      throw new FfmpegError(
        'INCONSISTENT_AUDIO_FORMAT',
        `input ${cur.path} differs from reference ${ref.path}: ` +
          `codec=${cur.codec}/${ref.codec} sampleRate=${cur.sampleRate}/${ref.sampleRate} ` +
          `channels=${cur.channels}/${ref.channels}`,
      );
    }
  }

  const totalDuration = probes.reduce((sum, p) => sum + (p.duration ?? 0), 0);

  // Idempotency: skip if outPath already matches expected duration.
  if (fs.existsSync(outPath)) {
    try {
      const existing = await ffprobe(outPath);
      if (
        existing.duration !== undefined &&
        Math.abs(existing.duration - totalDuration) <= DURATION_TOLERANCE_S
      ) {
        return;
      }
    } catch {
      // Fall through to re-render if probe fails.
    }
  }

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });
  const listPath = path.join(path.dirname(outPath), 'concat-list.txt');
  // FFmpeg concat demuxer requires single quotes inside the path to be escaped
  // as '\'' (close-quote, literal-quote, open-quote). Track titles like "you're"
  // produce paths with apostrophes; without escaping the demuxer parses
  // `file 'C:/.../you're.wav'` as terminating the string at `you`, silently
  // truncating the concatenation at that file. See FFmpeg concat demuxer docs.
  const escapeForConcat = (raw: string): string => raw.replace(/'/g, "'\\''");
  const listBody = wavPaths
    .map((p) => `file '${escapeForConcat(toForwardSlash(path.resolve(p)))}'`)
    .join('\n');
  await fs.promises.writeFile(listPath, listBody + '\n', 'utf8');

  try {
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
      outPath,
    ]);
  } finally {
    await fs.promises.unlink(listPath).catch(() => {});
  }
}
