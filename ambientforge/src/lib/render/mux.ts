/**
 * Mux a still image and a WAV into a 1920×1080 H.264/AAC MP4. NVENC when
 * available; libx264 fallback. Stream-copy is not an option here — H.264
 * needs to be encoded from a static image and AAC from PCM. Progress is
 * reported via stderr `time=` parsing.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  detectNvenc,
  ffprobe,
  FfmpegError,
  runFfmpegStreaming,
} from '@/lib/audio/ffmpeg';

export type NvencMode = 'auto' | 'force' | 'off';

export type BuildMuxArgsInput = {
  useNvenc: boolean;
  image: string;
  audio: string;
  out: string;
};

export type BuildVideoBedMuxArgsInput = {
  useNvenc: boolean;
  /** Short looped clip (e.g. 10s) used as the video bed. */
  clip: string;
  /** Audio track (typically already extended to `targetSeconds`). */
  audio: string;
  out: string;
  /** Output target duration. Caller is responsible for ensuring audio matches. */
  targetSeconds: number;
};

// libx264 + `-shortest` can pad the output by up to ~2s vs the audio duration
// (last-GOP / PTS alignment). The idempotency check is "this looks like a
// successful prior render," not a strict equality.
const DURATION_TOLERANCE_S = 3;

/**
 * Pure helper — build the FFmpeg argument vector for the mux command. Kept
 * separate so unit tests can assert command construction without invoking
 * ffmpeg.
 *
 * NVENC: h264_nvenc -preset p4 -tune hq -rc vbr -cq 23
 * libx264: libx264 -preset medium -crf 20
 * Common: -loop 1 -i image -i audio -c:a aac -b:a 192k -shortest
 *         -pix_fmt yuv420p -movflags +faststart -r 30
 */
export function buildMuxArgs({ useNvenc, image, audio, out }: BuildMuxArgsInput): string[] {
  const codec = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
  return [
    '-y',
    '-loop',
    '1',
    '-i',
    image,
    '-i',
    audio,
    ...codec,
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-r',
    '30',
    out,
  ];
}

/** ambient-video letterbox/pillarbox normalization to 1920×1080 — same chain
 * as the rap final mux. Preserves source aspect (no distortion); pads black. */
const VIDEO_BED_SCALE_PAD =
  'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';

/**
 * Pure helper — build the FFmpeg argument vector for the ambient-video final
 * mux (looped clip + already-extended audio → 1920×1080 H.264/AAC MP4).
 *
 * `-stream_loop -1` on the clip input plus `-t targetSeconds` produces a
 * deterministic-duration output without re-encoding the loop concatenation.
 * `-map 0:v:0 -map 1:a:0` is mandatory: without it ffmpeg auto-selects the
 * AAC stream from the clip input (if present) over the audio input and the
 * song would never reach the viewer (same gotcha as the rap final mux).
 */
export function buildVideoBedMuxArgs({
  useNvenc,
  clip,
  audio,
  out,
  targetSeconds,
}: BuildVideoBedMuxArgsInput): string[] {
  const codec = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
  return [
    '-y',
    '-stream_loop',
    '-1',
    '-i',
    clip,
    '-i',
    audio,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-vf',
    VIDEO_BED_SCALE_PAD,
    ...codec,
    '-pix_fmt',
    'yuv420p',
    '-r',
    '30',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-movflags',
    '+faststart',
    '-t',
    String(targetSeconds),
    out,
  ];
}

export async function pickEncoder(mode: NvencMode): Promise<{ useNvenc: boolean; reason: string }> {
  if (mode === 'force') return { useNvenc: true, reason: 'nvenc_enabled=force' };
  if (mode === 'off') return { useNvenc: false, reason: 'nvenc_enabled=off' };
  const detected = await detectNvenc();
  return {
    useNvenc: detected,
    reason: detected ? 'nvenc_enabled=auto detected=true' : 'nvenc_enabled=auto detected=false',
  };
}

const TIME_RE = /time=(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

function parseTimeSeconds(line: string): number | null {
  const m = TIME_RE.exec(line);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const cs = m[4] ? Number(m[4].padEnd(2, '0').slice(0, 2)) / 100 : 0;
  return h * 3600 + min * 60 + s + cs;
}

export type MuxOptions = {
  nvencMode?: NvencMode;
  onProgress?: (pct: number) => void;
};

/**
 * Mux image+audio→MP4. Writes nothing on idempotent skip; calls
 * `onProgress(100)` once on completion (including idempotent skip) so the
 * caller can patch persistent state uniformly.
 */
export async function muxVideo(
  imagePath: string,
  audioPath: string,
  outPath: string,
  opts: MuxOptions = {},
): Promise<void> {
  if (!fs.existsSync(imagePath)) {
    throw new FfmpegError('MUX_IMAGE_MISSING', `image not found: ${imagePath}`);
  }
  if (!fs.existsSync(audioPath)) {
    throw new FfmpegError('MUX_AUDIO_MISSING', `audio not found: ${audioPath}`);
  }

  const audioProbe = await ffprobe(audioPath);
  const targetDur = audioProbe.duration;
  if (!targetDur || targetDur <= 0) {
    throw new FfmpegError('MUX_AUDIO_NO_DURATION', `cannot read audio duration for ${audioPath}`);
  }

  // Idempotency: if outPath looks correct, skip the encode but still emit 100%.
  if (fs.existsSync(outPath)) {
    try {
      const existing = await ffprobe(outPath);
      if (
        existing.codec === 'h264' &&
        existing.audioCodec === 'aac' &&
        existing.duration !== undefined &&
        Math.abs(existing.duration - targetDur) <= DURATION_TOLERANCE_S
      ) {
        opts.onProgress?.(100);
        return;
      }
    } catch {
      // Fall through to re-render.
    }
  }

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const { useNvenc } = await pickEncoder(opts.nvencMode ?? 'auto');
  const args = buildMuxArgs({ useNvenc, image: imagePath, audio: audioPath, out: outPath });

  let lastPct = -1;
  await runFfmpegStreaming(args, {
    onStderrLine: (line) => {
      if (!opts.onProgress) return;
      const elapsed = parseTimeSeconds(line);
      if (elapsed === null) return;
      // Cap at 99 until exit-0 — final 100 fires below.
      const pct = Math.max(0, Math.min(99, Math.round((elapsed / targetDur) * 100)));
      if (pct > lastPct) {
        lastPct = pct;
        opts.onProgress(pct);
      }
    },
  });
  opts.onProgress?.(100);
}

export type MuxVideoBedOptions = {
  nvencMode?: NvencMode;
  onProgress?: (pct: number) => void;
};

/**
 * ambient-video final mux: short looped clip (video bed) + audio →
 * 1920×1080 H.264/AAC MP4 of exact `targetSeconds` duration. Idempotency
 * skips re-encoding when an existing output looks like a successful prior
 * render. Calls `onProgress(100)` exactly once on completion (including
 * idempotent skip).
 */
export async function muxVideoBedAndAudio(
  clipPath: string,
  audioPath: string,
  outPath: string,
  targetSeconds: number,
  opts: MuxVideoBedOptions = {},
): Promise<void> {
  if (!fs.existsSync(clipPath)) {
    throw new FfmpegError('MUX_CLIP_MISSING', `clip not found: ${clipPath}`);
  }
  if (!fs.existsSync(audioPath)) {
    throw new FfmpegError('MUX_AUDIO_MISSING', `audio not found: ${audioPath}`);
  }
  if (targetSeconds <= 0) {
    throw new FfmpegError(
      'MUX_INVALID_TARGET',
      `targetSeconds must be > 0; got ${targetSeconds}`,
    );
  }

  if (fs.existsSync(outPath)) {
    try {
      const existing = await ffprobe(outPath);
      if (
        existing.codec === 'h264' &&
        existing.audioCodec === 'aac' &&
        existing.width === 1920 &&
        existing.height === 1080 &&
        existing.duration !== undefined &&
        Math.abs(existing.duration - targetSeconds) <= DURATION_TOLERANCE_S
      ) {
        opts.onProgress?.(100);
        return;
      }
    } catch {
      // Fall through to re-render.
    }
  }

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const { useNvenc } = await pickEncoder(opts.nvencMode ?? 'auto');
  const args = buildVideoBedMuxArgs({
    useNvenc,
    clip: clipPath,
    audio: audioPath,
    out: outPath,
    targetSeconds,
  });

  let lastPct = -1;
  await runFfmpegStreaming(args, {
    onStderrLine: (line) => {
      if (!opts.onProgress) return;
      const elapsed = parseTimeSeconds(line);
      if (elapsed === null) return;
      const pct = Math.max(0, Math.min(99, Math.round((elapsed / targetSeconds) * 100)));
      if (pct > lastPct) {
        lastPct = pct;
        opts.onProgress(pct);
      }
    },
  });
  opts.onProgress?.(100);
}
