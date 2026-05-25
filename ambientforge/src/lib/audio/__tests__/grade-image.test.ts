import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gradeImage, ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'grade-image-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Colorful test image (ffmpeg testsrc has saturated color bars). */
function buildColorImage(outPath: string, w: number, h: number): void {
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc=size=${w}x${h}:duration=1`,
    '-frames:v',
    '1',
    outPath,
  ]);
}

/** Average per-pixel saturation (0 ≈ grayscale) via ffmpeg signalstats. */
function satAvg(img: string): number {
  const out = execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      img,
      '-vf',
      'signalstats,metadata=print:file=-',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8' },
  );
  const m = out.match(/lavfi\.signalstats\.SATAVG=([\d.]+)/);
  if (!m) throw new Error(`SATAVG not found in ffmpeg output:\n${out.slice(0, 300)}`);
  return parseFloat(m[1]);
}

describe('gradeImage', () => {
  it('keeps the input dimensions and writes a valid image (color-only, no resize)', async () => {
    const input = path.join(workDir, 'in.png');
    buildColorImage(input, 640, 360);
    const output = path.join(workDir, 'graded.png');

    await gradeImage(input, output);

    const probe = await ffprobe(output);
    expect(probe.width).toBe(640);
    expect(probe.height).toBe(360);
    // Valid PNG signature 89 50 4E 47
    const head = fs.readFileSync(output).subarray(0, 4);
    expect([...head]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  }, 60_000);

  it('saturation:-100 produces a grayscale image (SATAVG ≈ 0) — the knob is wired', async () => {
    const input = path.join(workDir, 'in.png');
    buildColorImage(input, 480, 270);

    const gray = path.join(workDir, 'gray.png');
    await gradeImage(input, gray, { saturation: -100, vibrance: 0 });

    const normal = path.join(workDir, 'normal.png');
    await gradeImage(input, normal); // defaults — stays colorful

    const graySat = satAvg(gray);
    const normalSat = satAvg(normal);
    expect(graySat).toBeLessThan(3); // grayscale ≈ 0 on the 0–255 scale
    expect(normalSat).toBeGreaterThan(graySat + 10); // default keeps real color
  }, 60_000);

  it('rejects a missing input with a clear FfmpegError code', async () => {
    await expect(
      gradeImage(path.join(workDir, 'nope.png'), path.join(workDir, 'out.png')),
    ).rejects.toMatchObject({ code: 'GRADE_INPUT_MISSING' });
  });
});
