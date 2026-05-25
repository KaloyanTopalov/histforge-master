import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { promisify } from 'node:util';
import { SunoError } from './client';

const execFileAsync = promisify(execFile);

export type AudioMeta = {
  sampleRate: number;
  bitDepth: number;
  channels: number;
  duration: number;
};

type FfprobeStream = {
  codec_type?: string;
  sample_rate?: string;
  bits_per_sample?: number;
  bits_per_raw_sample?: string;
  channels?: number;
  duration?: string;
};

type FfprobeFormat = {
  duration?: string;
};

type FfprobeJson = {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
};

export async function ffprobeAudio(filePath: string): Promise<AudioMeta> {
  let stdout: string;
  try {
    const result = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-print_format',
        'json',
        '-show_streams',
        '-show_format',
        filePath,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch (err) {
    throw new SunoError('FFPROBE_FAILED', `ffprobe failed for ${filePath}`, false, undefined, err);
  }
  let parsed: FfprobeJson;
  try {
    parsed = JSON.parse(stdout) as FfprobeJson;
  } catch (err) {
    throw new SunoError('FFPROBE_FAILED', `ffprobe returned non-JSON for ${filePath}`, false, undefined, err);
  }
  const audio = (parsed.streams ?? []).find((s) => s.codec_type === 'audio');
  if (!audio) {
    throw new SunoError('INVALID_AUDIO_FORMAT', `no audio stream in ${filePath}`, true);
  }
  const sampleRate = audio.sample_rate ? Number(audio.sample_rate) : 0;
  const bitDepth = audio.bits_per_sample ?? (audio.bits_per_raw_sample ? Number(audio.bits_per_raw_sample) : 0);
  const channels = audio.channels ?? 0;
  const duration = audio.duration
    ? Number(audio.duration)
    : parsed.format?.duration
      ? Number(parsed.format.duration)
      : 0;
  return { sampleRate, bitDepth, channels, duration };
}

export function validateAudio(meta: AudioMeta): void {
  if (!Number.isFinite(meta.sampleRate) || meta.sampleRate < 44100) {
    throw new SunoError(
      'INVALID_AUDIO_FORMAT',
      `sample rate ${meta.sampleRate} < 44100`,
      true,
    );
  }
  if (!(meta.bitDepth === 16 || meta.bitDepth === 24)) {
    throw new SunoError(
      'INVALID_AUDIO_FORMAT',
      `bit depth ${meta.bitDepth} not in {16, 24}`,
      true,
    );
  }
  if (meta.channels !== 2) {
    throw new SunoError(
      'INVALID_AUDIO_FORMAT',
      `channels ${meta.channels} != 2`,
      true,
    );
  }
  if (!Number.isFinite(meta.duration) || meta.duration < 30) {
    throw new SunoError(
      'INVALID_AUDIO_FORMAT',
      `duration ${meta.duration}s < 30s`,
      true,
    );
  }
}

export async function audioFileValid(filePath: string): Promise<boolean> {
  if (!fs.existsSync(filePath)) return false;
  try {
    const meta = await ffprobeAudio(filePath);
    validateAudio(meta);
    return true;
  } catch {
    return false;
  }
}
