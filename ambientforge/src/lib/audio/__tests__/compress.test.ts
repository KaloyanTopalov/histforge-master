import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compressToJpeg, ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'compress-test-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

/** Build a high-entropy PNG of `size`×`size`. Random RGB bytes don't deflate
 * well, so the resulting PNG is roughly 3·size² bytes — exceeds 10 MB at
 * size=2200, comfortably exceeds at 3000. */
function buildNoisyPng(outPath: string, size: number): void {
  const rawPath = path.join(path.dirname(outPath), `_raw-${size}.bin`);
  fs.writeFileSync(rawPath, randomBytes(size * size * 3));
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'rawvideo',
    '-pixel_format',
    'rgb24',
    '-video_size',
    `${size}x${size}`,
    '-i',
    rawPath,
    '-frames:v',
    '1',
    '-c:v',
    'png',
    outPath,
  ]);
  fs.unlinkSync(rawPath);
}

describe('compressToJpeg', () => {
  it('shrinks a 12+ MB noisy PNG to a JPEG below the 10 MB cap with valid header', async () => {
    const inputPng = path.join(workDir, 'huge.png');
    // 2400×2400 RGB random → ~17 MB PNG (well over 10 MB cap).
    buildNoisyPng(inputPng, 2400);
    const inputSize = fs.statSync(inputPng).size;
    expect(inputSize).toBeGreaterThan(12 * 1024 * 1024);

    const outputJpg = path.join(workDir, 'cover.jpg');
    const cap = 10 * 1024 * 1024;
    const result = await compressToJpeg(inputPng, outputJpg, cap);

    expect(result.outputPath).toBe(outputJpg);
    expect(result.finalSizeBytes).toBeLessThanOrEqual(cap);
    expect(fs.statSync(outputJpg).size).toBe(result.finalSizeBytes);

    // Valid JFIF/JPEG: starts with SOI marker (FF D8) and has codec_name=mjpeg
    // when probed.
    const head = fs.readFileSync(outputJpg).subarray(0, 2);
    expect(head[0]).toBe(0xff);
    expect(head[1]).toBe(0xd8);

    const probe = await ffprobe(outputJpg);
    expect(probe.width).toBe(2400);
    expect(probe.height).toBe(2400);
  }, 90_000);

  it('walks the q ladder when q=3 is over and lands on a higher q', async () => {
    const inputPng = path.join(workDir, 'huge.png');
    buildNoisyPng(inputPng, 2400);

    const outputJpg = path.join(workDir, 'cover.jpg');
    // Force a tight cap that q=3 cannot satisfy on noisy input. Use a custom
    // ladder ending at q=31 (MJPEG's worst-quality rung) so the loop is
    // guaranteed to land on a small file regardless of source entropy. We
    // assert the helper escalated past the first rung and produced a file
    // under the cap — both invariants of the "walks the ladder" contract.
    const result = await compressToJpeg(inputPng, outputJpg, 5 * 1024 * 1024, {
      qScales: [3, 10, 31],
    });
    expect(result.qScale).toBeGreaterThan(3);
    expect(result.attempts).toBeGreaterThanOrEqual(2);
    expect(result.finalSizeBytes).toBeLessThanOrEqual(5 * 1024 * 1024);
  }, 90_000);

  it('throws COVER_COMPRESS_OVER_LIMIT when no q rung produces a small enough file', async () => {
    const inputPng = path.join(workDir, 'huge.png');
    buildNoisyPng(inputPng, 2400);

    // 1 KB cap: nothing in [3, 5, 8] will fit. Should throw after 3 attempts.
    const outputJpg = path.join(workDir, 'cover.jpg');
    await expect(
      compressToJpeg(inputPng, outputJpg, 1024),
    ).rejects.toMatchObject({ code: 'COVER_COMPRESS_OVER_LIMIT' });
  }, 90_000);

  it('rejects missing input', async () => {
    await expect(
      compressToJpeg(
        path.join(workDir, 'nope.png'),
        path.join(workDir, 'out.jpg'),
        10 * 1024 * 1024,
      ),
    ).rejects.toMatchObject({ code: 'COMPRESS_INPUT_MISSING' });
  });

  it('rejects invalid maxBytes', async () => {
    const inputPng = path.join(workDir, 'small.png');
    // Trivial 16x16 solid color is fine for input-validation tests.
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=size=16x16:c=red:d=1',
      '-frames:v',
      '1',
      inputPng,
    ]);
    await expect(
      compressToJpeg(inputPng, path.join(workDir, 'out.jpg'), 0),
    ).rejects.toBeInstanceOf(FfmpegError);
  });

  it('rejects empty qScales', async () => {
    const inputPng = path.join(workDir, 'small.png');
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=size=16x16:c=red:d=1',
      '-frames:v',
      '1',
      inputPng,
    ]);
    await expect(
      compressToJpeg(inputPng, path.join(workDir, 'out.jpg'), 1024 * 1024, { qScales: [] }),
    ).rejects.toMatchObject({ code: 'COMPRESS_NO_Q_SCALES' });
  });
});
