import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { concatTracks } from '@/lib/audio/concat';
import { loopToTarget } from '@/lib/audio/loop';
import { ffprobe } from '@/lib/audio/ffmpeg';

const FIXTURE_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\//, '')),
  '../../../../tests/fixtures/audio/concat-set',
);

const FIXTURE_FILES = ['01.wav', '02.wav', '03.wav', '04.wav', '05.wav'];

let workDir: string;

beforeEach(() => {
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-test-'));
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

async function buildConcat(): Promise<string> {
  const concatPath = path.join(workDir, 'concat.wav');
  await concatTracks(
    FIXTURE_FILES.map((f) => path.join(FIXTURE_ROOT, f)),
    concatPath,
  );
  return concatPath;
}

describe('loopToTarget', () => {
  it('loops a 30s concat to a 75s target (3 repeats, then trim)', async () => {
    const concatPath = await buildConcat();
    const out = path.join(workDir, 'loop.wav');
    await loopToTarget(concatPath, out, 75);
    const probe = await ffprobe(out);
    expect(probe.duration).toBeDefined();
    expect(probe.duration!).toBeGreaterThanOrEqual(74.5);
    expect(probe.duration!).toBeLessThanOrEqual(75.5);
    // Intermediate files cleaned up.
    expect(fs.existsSync(path.join(workDir, 'loop_full.wav'))).toBe(false);
    expect(fs.existsSync(path.join(workDir, 'loop-list.txt'))).toBe(false);
  }, 60_000);

  it('idempotency: rerun is a noop when out duration already matches target', async () => {
    const concatPath = await buildConcat();
    const out = path.join(workDir, 'loop.wav');
    await loopToTarget(concatPath, out, 60);
    const mtime1 = fs.statSync(out).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    await loopToTarget(concatPath, out, 60);
    const mtime2 = fs.statSync(out).mtimeMs;
    expect(mtime2).toBe(mtime1);
  }, 60_000);

  it('rejects when target_seconds <= 0', async () => {
    const concatPath = await buildConcat();
    await expect(
      loopToTarget(concatPath, path.join(workDir, 'loop.wav'), 0),
    ).rejects.toMatchObject({ code: 'LOOP_INVALID_TARGET' });
  });

  it('rejects with LOOP_INPUT_MISSING when concat input is missing', async () => {
    await expect(
      loopToTarget(path.join(workDir, 'nope.wav'), path.join(workDir, 'loop.wav'), 30),
    ).rejects.toMatchObject({ code: 'LOOP_INPUT_MISSING' });
  });

  // Regression: idempotency previously skipped re-rendering when the output
  // duration matched the target, even if the source concat had been
  // regenerated. That silently propagated stale audio into the final mux.
  it('re-renders when concat.wav is newer than the existing loop.wav (stale-content regression)', async () => {
    const concatPath = await buildConcat();
    const out = path.join(workDir, 'loop.wav');
    await loopToTarget(concatPath, out, 60);
    const loopMtimeBefore = fs.statSync(out).mtimeMs;

    // Touch concat.wav to make it newer than loop.wav (simulating a
    // regenerated concat). Use future mtime to dodge filesystem resolution.
    const newer = new Date(loopMtimeBefore + 5_000);
    fs.utimesSync(concatPath, newer, newer);

    await loopToTarget(concatPath, out, 60);
    const loopMtimeAfter = fs.statSync(out).mtimeMs;
    expect(loopMtimeAfter).toBeGreaterThan(loopMtimeBefore);
  }, 60_000);
});
