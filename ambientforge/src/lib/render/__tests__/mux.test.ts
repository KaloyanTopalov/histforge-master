import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildMuxArgs, buildVideoBedMuxArgs, muxVideo, pickEncoder } from '@/lib/render/mux';
import { __resetNvencCacheForTests } from '@/lib/audio/ffmpeg';

const FIXTURE_AUDIO = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../../../tests/fixtures/audio/concat-set/01.wav',
);

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mux-test-'));
  __resetNvencCacheForTests();
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('buildMuxArgs', () => {
  it('NVENC: emits h264_nvenc with p4 + cq 23', () => {
    const args = buildMuxArgs({
      useNvenc: true,
      image: '/tmp/img.png',
      audio: '/tmp/a.wav',
      out: '/tmp/o.mp4',
    });
    const joined = args.join(' ');
    expect(joined).toContain('-c:v h264_nvenc');
    expect(joined).toContain('-preset p4');
    expect(joined).toContain('-tune hq');
    expect(joined).toContain('-rc vbr');
    expect(joined).toContain('-cq 23');
    // Common flags
    expect(joined).toContain('-c:a aac');
    expect(joined).toContain('-b:a 192k');
    expect(joined).toContain('-pix_fmt yuv420p');
    expect(joined).toContain('-movflags +faststart');
    expect(joined).toContain('-r 30');
    expect(joined).toContain('-shortest');
  });

  it('libx264 fallback: emits libx264 -preset medium -crf 20', () => {
    const args = buildMuxArgs({
      useNvenc: false,
      image: '/tmp/img.png',
      audio: '/tmp/a.wav',
      out: '/tmp/o.mp4',
    });
    const joined = args.join(' ');
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-preset medium');
    expect(joined).toContain('-crf 20');
    // Common flags still present
    expect(joined).toContain('-c:a aac');
    expect(joined).toContain('-pix_fmt yuv420p');
    expect(joined).toContain('-movflags +faststart');
  });
});

describe('buildVideoBedMuxArgs (ambient-video)', () => {
  it('streams-loop the clip, picks audio from input 1, scales to 1920x1080 with letterbox/pad', () => {
    const args = buildVideoBedMuxArgs({
      useNvenc: false,
      clip: '/tmp/clip.mp4',
      audio: '/tmp/loop.wav',
      out: '/tmp/final.mp4',
      targetSeconds: 7200,
    });
    const joined = args.join(' ');
    expect(joined).toContain('-stream_loop -1');
    expect(joined).toContain('-i /tmp/clip.mp4');
    expect(joined).toContain('-i /tmp/loop.wav');
    expect(joined).toContain('-map 0:v:0');
    expect(joined).toContain('-map 1:a:0');
    expect(joined).toContain(
      'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1',
    );
    expect(joined).toContain('-c:a aac');
    expect(joined).toContain('-b:a 192k');
    expect(joined).toContain('-pix_fmt yuv420p');
    expect(joined).toContain('-movflags +faststart');
    expect(joined).toContain('-r 30');
    // Output duration locked to exact targetSeconds.
    expect(joined).toContain('-t 7200');
    expect(args.at(-1)).toBe('/tmp/final.mp4');
  });

  it('NVENC mode uses h264_nvenc with the same preset family as the still-image mux', () => {
    const args = buildVideoBedMuxArgs({
      useNvenc: true,
      clip: 'c.mp4',
      audio: 'a.wav',
      out: 'o.mp4',
      targetSeconds: 120,
    });
    const joined = args.join(' ');
    expect(joined).toContain('-c:v h264_nvenc');
    expect(joined).toContain('-preset p4');
    expect(joined).toContain('-tune hq');
    expect(joined).toContain('-rc vbr');
    expect(joined).toContain('-cq 23');
  });

  it('libx264 fallback uses the same medium / crf 20 settings as the still-image mux', () => {
    const args = buildVideoBedMuxArgs({
      useNvenc: false,
      clip: 'c.mp4',
      audio: 'a.wav',
      out: 'o.mp4',
      targetSeconds: 60,
    });
    const joined = args.join(' ');
    expect(joined).toContain('-c:v libx264');
    expect(joined).toContain('-preset medium');
    expect(joined).toContain('-crf 20');
  });
});

describe('pickEncoder', () => {
  it("nvenc_enabled='off' always picks libx264", async () => {
    const r = await pickEncoder('off');
    expect(r.useNvenc).toBe(false);
    expect(r.reason).toContain('off');
  });

  it("nvenc_enabled='force' picks NVENC regardless of detection", async () => {
    const r = await pickEncoder('force');
    expect(r.useNvenc).toBe(true);
    expect(r.reason).toContain('force');
  });
});

describe('muxVideo (real ffmpeg)', () => {
  it('produces a 1920x1080 h264/aac mp4 from a still image + 6s audio', async () => {
    // Generate a simple blue 1920x1080 png on the fly.
    const imgPath = path.join(workDir, 'img.png');
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=color=blue:size=1920x1080:duration=1:rate=1',
      '-frames:v',
      '1',
      imgPath,
    ]);

    const outPath = path.join(workDir, 'out.mp4');
    const progressCalls: number[] = [];
    await muxVideo(imgPath, FIXTURE_AUDIO, outPath, {
      nvencMode: 'off', // force libx264 for determinism in CI
      onProgress: (pct) => progressCalls.push(pct),
    });
    expect(fs.existsSync(outPath)).toBe(true);
    expect(progressCalls.at(-1)).toBe(100);
    expect(progressCalls.length).toBeGreaterThan(0);

    // ffprobe the output.
    const probeJson = execFileSync('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_streams',
      '-show_format',
      outPath,
    ]).toString();
    const probe = JSON.parse(probeJson);
    const v = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'video');
    const a = probe.streams.find((s: { codec_type: string }) => s.codec_type === 'audio');
    expect(v.codec_name).toBe('h264');
    expect(v.width).toBe(1920);
    expect(v.height).toBe(1080);
    expect(a.codec_name).toBe('aac');
  }, 120_000);

  it('idempotency: rerun on a valid output is a noop and still calls onProgress(100)', async () => {
    const imgPath = path.join(workDir, 'img.png');
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=color=red:size=1280x720:duration=1:rate=1',
      '-frames:v',
      '1',
      imgPath,
    ]);
    const outPath = path.join(workDir, 'out.mp4');
    await muxVideo(imgPath, FIXTURE_AUDIO, outPath, { nvencMode: 'off' });
    const mtime1 = fs.statSync(outPath).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    const calls: number[] = [];
    await muxVideo(imgPath, FIXTURE_AUDIO, outPath, {
      nvencMode: 'off',
      onProgress: (pct) => calls.push(pct),
    });
    expect(fs.statSync(outPath).mtimeMs).toBe(mtime1);
    expect(calls).toEqual([100]);
  }, 120_000);
});
