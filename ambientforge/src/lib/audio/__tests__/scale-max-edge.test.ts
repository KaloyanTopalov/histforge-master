import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scaleToMaxEdgeJpeg, ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scale-max-edge-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

function buildSolid(outPath: string, w: number, h: number): void {
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `color=size=${w}x${h}:c=blue:d=1`,
    '-frames:v',
    '1',
    outPath,
  ]);
}

describe('scaleToMaxEdgeJpeg', () => {
  it('downscales a large image so the longest edge <= maxEdge, aspect preserved, JPEG out', async () => {
    const input = path.join(workDir, 'big.png');
    buildSolid(input, 2000, 1000); // 2:1 aspect
    const output = path.join(workDir, 'bounded.jpg');

    await scaleToMaxEdgeJpeg(input, output, 800);

    const probe = await ffprobe(output);
    expect(Math.max(probe.width ?? 0, probe.height ?? 0)).toBeLessThanOrEqual(800);
    // 2:1 aspect must be preserved → 800×400
    expect(probe.width).toBe(800);
    expect(probe.height).toBe(400);

    // Valid JPEG: SOI marker FF D8
    const head = fs.readFileSync(output).subarray(0, 2);
    expect(head[0]).toBe(0xff);
    expect(head[1]).toBe(0xd8);
  }, 60_000);

  it('does not upscale an image already within maxEdge', async () => {
    const input = path.join(workDir, 'small.png');
    buildSolid(input, 300, 150);
    const output = path.join(workDir, 'passthrough.jpg');

    await scaleToMaxEdgeJpeg(input, output, 800);

    const probe = await ffprobe(output);
    expect(probe.width).toBe(300);
    expect(probe.height).toBe(150);
  }, 60_000);

  it('rejects a missing input with a clear FfmpegError code', async () => {
    await expect(
      scaleToMaxEdgeJpeg(
        path.join(workDir, 'does-not-exist.png'),
        path.join(workDir, 'out.jpg'),
        800,
      ),
    ).rejects.toMatchObject({ code: 'SCALE_INPUT_MISSING' });
  });
});
