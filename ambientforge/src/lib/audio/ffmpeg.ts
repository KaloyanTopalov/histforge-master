/**
 * FFmpeg wrapper. Image steps 05a + 05b run crop/scale/letterbox/drawtext via
 * shell-spawned ffmpeg (no native bindings). Audio steps 07-09 (Session 7)
 * will reuse the same wrapper for concat / loop / mux.
 *
 * NVENC detection is cached at module load — the result doesn't change for
 * the lifetime of the worker.
 */

import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

export class FfmpegError extends Error {
  readonly code: string;
  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    if (cause) (this as { cause?: unknown }).cause = cause;
  }
}

/** Shared input-existence guard for the single-image helpers. Each passes its
 * own distinct code so the failing step is unambiguous in pipeline.log. */
function assertInputExists(input: string, code: string): void {
  if (!fs.existsSync(input)) {
    throw new FfmpegError(code, `input not found: ${input}`);
  }
}

let nvencCache: boolean | null = null;
let ffmpegOnPath: boolean | null = null;

export async function ensureFfmpeg(): Promise<void> {
  if (ffmpegOnPath === true) return;
  try {
    await execFileAsync('ffmpeg', ['-version'], { maxBuffer: 1024 * 1024 });
    ffmpegOnPath = true;
  } catch (err) {
    ffmpegOnPath = false;
    throw new FfmpegError(
      'FFMPEG_NOT_FOUND',
      'ffmpeg is not on PATH. Install FFmpeg (https://ffmpeg.org/download.html) and ensure both `ffmpeg` and `ffprobe` are reachable.',
      err,
    );
  }
}

/**
 * Probe `ffmpeg -encoders` once. Returns true when h264_nvenc appears in the
 * encoder list. RTX 4070 always has NVENC; we still check at runtime so
 * non-NVIDIA dev machines fall back to libx264 cleanly.
 */
export async function detectNvenc(): Promise<boolean> {
  if (nvencCache !== null) return nvencCache;
  try {
    const { stdout } = await execFileAsync('ffmpeg', ['-encoders'], {
      maxBuffer: 8 * 1024 * 1024,
    });
    nvencCache = /\bh264_nvenc\b/.test(stdout);
  } catch {
    nvencCache = false;
  }
  return nvencCache;
}

/** Test-only: reset the NVENC detection cache between runs. */
export function __resetNvencCacheForTests(): void {
  nvencCache = null;
}

// ---------------------------------------------------------------------------
// ffprobe (image + audio)
// ---------------------------------------------------------------------------

export type ProbeResult = {
  width?: number;
  height?: number;
  duration?: number;
  codec?: string;
  audioCodec?: string;
  sampleRate?: number;
  channels?: number;
};

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
  sample_rate?: string;
  channels?: number;
};

type FfprobeFormat = {
  duration?: string;
};

type FfprobeJson = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

export async function ffprobe(filePath: string): Promise<ProbeResult> {
  if (!fs.existsSync(filePath)) {
    throw new FfmpegError('FFPROBE_FILE_MISSING', `not found: ${filePath}`);
  }
  let stdout: string;
  try {
    const result = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', filePath],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new FfmpegError('FFPROBE_FAILED', `ffprobe failed for ${filePath}`, err);
  }
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeJson;
  } catch (err) {
    throw new FfmpegError('FFPROBE_FAILED', `ffprobe returned non-JSON for ${filePath}`, err);
  }
  const streams = parsed.streams ?? [];
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const primary = videoStream ?? audioStream ?? streams[0];
  return {
    width: primary?.width,
    height: primary?.height,
    duration: primary?.duration
      ? Number(primary.duration)
      : parsed.format?.duration
        ? Number(parsed.format.duration)
        : undefined,
    codec: primary?.codec_name,
    audioCodec: audioStream?.codec_name,
    sampleRate: audioStream?.sample_rate ? Number(audioStream.sample_rate) : undefined,
    channels: audioStream?.channels,
  };
}

// ---------------------------------------------------------------------------
// Generic spawn wrapper
// ---------------------------------------------------------------------------

export async function runFfmpeg(args: string[]): Promise<void> {
  await ensureFfmpeg();
  try {
    await execFileAsync('ffmpeg', args, {
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (err) {
    const stderrTail = (err as { stderr?: string }).stderr?.slice(-400) ?? '';
    throw new FfmpegError(
      'FFMPEG_RUN_FAILED',
      `ffmpeg ${args.slice(0, 4).join(' ')}... failed: ${stderrTail}`,
      err,
    );
  }
}

/**
 * Spawn ffmpeg and forward each stderr line to a callback. Used by step 09 to
 * parse `time=HH:MM:SS.cc` progress lines without buffering the entire stderr.
 *
 * Resolves on exit code 0; rejects with FfmpegError otherwise. The last 400
 * characters of stderr are attached to the error message for diagnostics.
 */
export async function runFfmpegStreaming(
  args: string[],
  opts: { onStderrLine?: (line: string) => void } = {},
): Promise<void> {
  await ensureFfmpeg();
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderrTail: string[] = [];
    let stderrLen = 0;
    let buf = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      // ffmpeg emits progress lines separated by \r and final messages by \n.
      buf += chunk;
      const parts = buf.split(/\r\n|\r|\n/);
      buf = parts.pop() ?? '';
      for (const line of parts) {
        if (line.length === 0) continue;
        stderrTail.push(line);
        stderrLen += line.length + 1;
        // Keep the tail bounded — drop oldest lines once we exceed ~4KB.
        while (stderrLen > 4096 && stderrTail.length > 1) {
          stderrLen -= (stderrTail.shift()?.length ?? 0) + 1;
        }
        opts.onStderrLine?.(line);
      }
    });
    child.on('error', (err) => {
      reject(new FfmpegError('FFMPEG_RUN_FAILED', `spawn failed: ${String(err)}`, err));
    });
    child.on('close', (code) => {
      if (buf.length > 0) {
        opts.onStderrLine?.(buf);
        stderrTail.push(buf);
      }
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderrTail.join('\n').slice(-400);
      reject(
        new FfmpegError(
          'FFMPEG_RUN_FAILED',
          `ffmpeg ${args.slice(0, 4).join(' ')}... exited ${code}: ${tail}`,
        ),
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Image post-processing helpers
// ---------------------------------------------------------------------------

/**
 * Center-crop the input to a square, then scale to size×size, save as PNG
 * with sRGB color space. Used for cover.png (3000×3000).
 *
 * filter: crop to min(iw,ih)×min(iw,ih), scale to size, force RGB+sRGB.
 */
export async function cropAndScaleSquare(
  input: string,
  output: string,
  size: number,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const filter = `crop='min(iw,ih)':'min(iw,ih)',scale=${size}:${size}:flags=lanczos,format=rgb24`;
  await runFfmpeg([
    '-y',
    '-i',
    input,
    '-vf',
    filter,
    '-frames:v',
    '1',
    '-color_range',
    'pc',
    '-colorspace',
    'bt709',
    '-color_primaries',
    'bt709',
    '-color_trc',
    'iec61966-2-1',
    output,
  ]);
}

export type ResizeMode = 'letterbox' | 'crop';

/**
 * Resize input to exact w×h. Mode controls behavior when input aspect
 * differs from target aspect:
 *   - letterbox: scale-to-fit, pad remaining area with black (preserves
 *     full frame; produces black bars on top/bottom or left/right).
 *   - crop:      scale-to-fill, center-crop the overflow (no bars; loses
 *     content at edges).
 */
export async function resizeWithMode(
  input: string,
  output: string,
  w: number,
  h: number,
  mode: ResizeMode,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  let filter: string;
  if (mode === 'letterbox') {
    filter = `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,format=rgb24`;
  } else {
    filter = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},format=rgb24`;
  }
  await runFfmpeg(['-y', '-i', input, '-vf', filter, '-frames:v', '1', output]);
}

/**
 * Aspect-preserving downscale so the longest edge is ≤ `maxEdge`, emitted as
 * JPEG. Never upscales: the scale box is clamped to `min(source, maxEdge)` per
 * axis, so an already-small image passes through at its original size. Used to
 * produce a bounded reference image for vision LLM calls (large 4K source
 * images would waste tokens / latency).
 */
export async function scaleToMaxEdgeJpeg(
  input: string,
  output: string,
  maxEdge: number,
  opts: { qScale?: number } = {},
): Promise<void> {
  assertInputExists(input, 'SCALE_INPUT_MISSING');
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const q = opts.qScale ?? 3;
  const filter =
    `scale=w='min(iw,${maxEdge})':h='min(ih,${maxEdge})':` +
    `force_original_aspect_ratio=decrease:flags=lanczos`;
  await runFfmpeg([
    '-y',
    '-i',
    input,
    '-vf',
    filter,
    '-q:v',
    String(q),
    '-frames:v',
    '1',
    output,
  ]);
}

/**
 * Color-grade an image: vibrance + saturation only, geometry untouched
 * (resize is a separate step). Operator-facing amounts map to FFmpeg as:
 *   eq=saturation = 1 + saturation/100   (FFmpeg default 1.0; 0 = grayscale)
 *   vibrance=intensity = vibrance/100    (FFmpeg default 0; range -2..2)
 * Defaults { vibrance: 30, saturation: 10 } = the operator's "+30 / +10".
 * The exact look is a visual-tuning judgment — the mapping is intentionally
 * simple + the amounts are the API so it can be retuned without code change.
 */
export async function gradeImage(
  input: string,
  output: string,
  opts: { vibrance?: number; saturation?: number } = {},
): Promise<void> {
  assertInputExists(input, 'GRADE_INPUT_MISSING');
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const vib = (opts.vibrance ?? 30) / 100;
  const sat = 1 + (opts.saturation ?? 10) / 100;
  const filter = `vibrance=intensity=${vib},eq=saturation=${sat}`;
  await runFfmpeg(['-y', '-i', input, '-vf', filter, '-frames:v', '1', output]);
}

export type DrawTextOpts = {
  text: string;
  fontPath: string;
  fontSize?: number;
  position?: 'lower-third';
};

/**
 * Composite text on the image using the FFmpeg drawtext filter. White fill,
 * 4-px black stroke, lower-third positioning. fontPath must be an absolute
 * path to a TTF.
 */
export async function drawText(
  input: string,
  output: string,
  opts: DrawTextOpts,
): Promise<void> {
  await fs.promises.mkdir(path.dirname(output), { recursive: true });
  const probe = await ffprobe(input);
  const height = probe.height ?? 720;
  const fontSize = opts.fontSize ?? Math.round(height / 12);
  // drawtext requires forward-slashes and escaping of `:` and `\` in fontfile/text.
  const escapedFont = opts.fontPath.replace(/\\/g, '/').replace(/:/g, '\\:');
  const escapedText = opts.text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019"); // straight → curly apostrophe to dodge filter quoting
  // Lower-third: y center at ~75% of frame height, x centered.
  const y = `(h*0.75-text_h/2)`;
  const filter =
    `drawtext=fontfile='${escapedFont}':text='${escapedText}':` +
    `fontcolor=white:fontsize=${fontSize}:` +
    `borderw=4:bordercolor=black:` +
    `x=(w-text_w)/2:y=${y}`;
  await runFfmpeg(['-y', '-i', input, '-vf', filter, '-frames:v', '1', output]);
}

export type CompressJpegResult = {
  outputPath: string;
  finalSizeBytes: number;
  qScale: number;
  attempts: number;
};

/**
 * Re-encode an image (typically a high-resolution PNG) as a JPEG that fits
 * under `maxBytes`. Walks the FFmpeg `-q:v` ladder (lower number = better
 * quality / larger file) until the output meets the cap or all rungs are
 * exhausted. Used by step 05a to keep cover.jpg under DistroKid's 10 MB cover
 * limit while leaving the source cover.png untouched for downstream high-
 * quality consumers (step 05b thumbnail derivation).
 *
 * Defaults: qScales=[3,5,8] — q=3 is roughly visually-lossless ("q90"),
 * q=5 is high-quality, q=8 is comfortable backup. Cap of 3 rungs matches the
 * task spec; if all three exceed the cap the function throws so the operator
 * sees an explicit failure rather than silently shipping an oversized file.
 */
export async function compressToJpeg(
  inputPath: string,
  outputPath: string,
  maxBytes: number,
  opts: { qScales?: readonly number[] } = {},
): Promise<CompressJpegResult> {
  assertInputExists(inputPath, 'COMPRESS_INPUT_MISSING');
  if (maxBytes <= 0) {
    throw new FfmpegError(
      'COMPRESS_INVALID_MAX',
      `maxBytes must be > 0; got ${maxBytes}`,
    );
  }
  const qScales = opts.qScales ?? [3, 5, 8];
  if (qScales.length === 0) {
    throw new FfmpegError('COMPRESS_NO_Q_SCALES', 'qScales must be non-empty');
  }
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  let lastSize = -1;
  for (let i = 0; i < qScales.length; i++) {
    const q = qScales[i];
    await runFfmpeg([
      '-y',
      '-i',
      inputPath,
      '-q:v',
      String(q),
      '-frames:v',
      '1',
      outputPath,
    ]);
    lastSize = (await fs.promises.stat(outputPath)).size;
    if (lastSize <= maxBytes) {
      return {
        outputPath,
        finalSizeBytes: lastSize,
        qScale: q,
        attempts: i + 1,
      };
    }
  }
  throw new FfmpegError(
    'COVER_COMPRESS_OVER_LIMIT',
    `compressed JPEG ${(lastSize / 1024 / 1024).toFixed(2)}MB still exceeds ${(
      maxBytes /
      1024 /
      1024
    ).toFixed(2)}MB after ${qScales.length} rungs (last q=${qScales[qScales.length - 1]})`,
  );
}
