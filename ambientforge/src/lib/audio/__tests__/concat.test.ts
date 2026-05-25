import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { concatTracks } from '@/lib/audio/concat';
import { ffprobe, FfmpegError } from '@/lib/audio/ffmpeg';

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../../../tests/fixtures/audio/concat-set',
);

const FIXTURE_FILES = ['01.wav', '02.wav', '03.wav', '04.wav', '05.wav'];

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'concat-test-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('concatTracks', () => {
  it('concatenates 5 uniform-format wavs via stream-copy with summed duration', async () => {
    const inputs = FIXTURE_FILES.map((f) => path.join(FIXTURE_ROOT, f));
    const out = path.join(workDir, 'concat.wav');
    await concatTracks(inputs, out);
    expect(fs.existsSync(out)).toBe(true);
    const probe = await ffprobe(out);
    expect(probe.duration).toBeDefined();
    // 5 × 6s = 30s ±0.2s
    expect(probe.duration!).toBeGreaterThanOrEqual(29.8);
    expect(probe.duration!).toBeLessThanOrEqual(30.2);
    // Concat list temp file is cleaned up.
    expect(fs.existsSync(path.join(workDir, 'concat-list.txt'))).toBe(false);
  }, 30_000);

  it('rejects with INCONSISTENT_AUDIO_FORMAT when an input differs in sample rate', async () => {
    // Build a divergent input (mono / 22.05kHz) in workDir.
    const oddballPath = path.join(workDir, 'oddball.wav');
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=300:duration=3',
      '-ac',
      '1',
      '-ar',
      '22050',
      '-c:a',
      'pcm_s16le',
      oddballPath,
    ]);
    const inputs = [
      path.join(FIXTURE_ROOT, '01.wav'),
      oddballPath,
      path.join(FIXTURE_ROOT, '02.wav'),
    ];
    const out = path.join(workDir, 'concat.wav');
    await expect(concatTracks(inputs, out)).rejects.toMatchObject({
      code: 'INCONSISTENT_AUDIO_FORMAT',
    });
    expect(fs.existsSync(out)).toBe(false);
  }, 30_000);

  it('idempotency: rerun is a noop when out duration already matches sum', async () => {
    const inputs = FIXTURE_FILES.map((f) => path.join(FIXTURE_ROOT, f));
    const out = path.join(workDir, 'concat.wav');
    await concatTracks(inputs, out);
    const mtime1 = fs.statSync(out).mtimeMs;
    // Wait long enough for any rewrite to be observable.
    await new Promise((r) => setTimeout(r, 50));
    await concatTracks(inputs, out);
    const mtime2 = fs.statSync(out).mtimeMs;
    expect(mtime2).toBe(mtime1);
  }, 30_000);

  it('throws CONCAT_INPUT_MISSING when an input file is missing', async () => {
    await expect(concatTracks([path.join(workDir, 'missing.wav')], path.join(workDir, 'out.wav'))).rejects.toMatchObject({
      code: 'CONCAT_INPUT_MISSING',
    });
  });

  it('throws CONCAT_NO_INPUTS on empty input list', async () => {
    await expect(concatTracks([], path.join(workDir, 'out.wav'))).rejects.toBeInstanceOf(FfmpegError);
  });

  // Regression: paths containing apostrophes (e.g. "you're") were silently
  // truncating the FFmpeg concat demuxer's input list because `file '...'`
  // closed the string at the first inner quote. The escape `'\''` keeps
  // such files in the list — verify the output duration matches the sum.
  it('handles apostrophes in input filenames (regression for concat truncation)', async () => {
    // Stage two fixture copies with apostrophes in their basenames.
    const stage = (src: string, dstName: string) => {
      const dst = path.join(workDir, dstName);
      fs.copyFileSync(src, dst);
      return dst;
    };
    const inputs = [
      stage(path.join(FIXTURE_ROOT, '01.wav'), "you're not alone.wav"),
      stage(path.join(FIXTURE_ROOT, '02.wav'), "it's okay.wav"),
      stage(path.join(FIXTURE_ROOT, '03.wav'), "she's gone.wav"),
    ];
    const out = path.join(workDir, 'concat.wav');
    await concatTracks(inputs, out);
    expect(fs.existsSync(out)).toBe(true);
    const probe = await ffprobe(out);
    // 3 × 6s = 18s ±0.2s. If the apostrophe broke parsing, FFmpeg would have
    // emitted only the first track (~6s) or errored.
    expect(probe.duration!).toBeGreaterThanOrEqual(17.8);
    expect(probe.duration!).toBeLessThanOrEqual(18.2);
  }, 30_000);
});
