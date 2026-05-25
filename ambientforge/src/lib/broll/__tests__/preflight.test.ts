import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertBrollPathAllowed, preflightBrollFolder } from '@/lib/broll/preflight';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-broll-preflight-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function makeColorClip(out: string, color: string, durationSec: number) {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=${color}:s=320x240:r=30:d=${durationSec}`,
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-tune',
      'stillimage',
      '-preset',
      'ultrafast',
      '-crf',
      '32',
      out,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

describe('preflightBrollFolder', () => {
  it('returns ok=false when folder does not exist', async () => {
    const r = await preflightBrollFolder(path.join(tmpRoot, 'missing'));
    expect(r.exists).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.includes('does not exist'))).toBe(true);
  });

  it('returns ok=false when folder has no video files', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'readme.txt'), 'hi');
    const r = await preflightBrollFolder(tmpRoot);
    expect(r.exists).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.videoCount).toBe(0);
  });

  it('returns ok=false when fewer than minimum clips are present', async () => {
    // Generate just 3 clips (default min is 10).
    for (let i = 1; i <= 3; i++) {
      await makeColorClip(path.join(tmpRoot, `clip-${i}.mp4`), 'blue', 1);
    }
    const r = await preflightBrollFolder(tmpRoot);
    expect(r.exists).toBe(true);
    expect(r.videoCount).toBe(3);
    expect(r.ok).toBe(false);
    expect(r.reasons.some((s) => s.includes('only 3'))).toBe(true);
  }, 60_000);

  it('returns ok=true when ≥10 video clips probe correctly', async () => {
    for (let i = 1; i <= 10; i++) {
      await makeColorClip(path.join(tmpRoot, `clip-${String(i).padStart(2, '0')}.mp4`), 'blue', 1);
    }
    const r = await preflightBrollFolder(tmpRoot);
    expect(r.exists).toBe(true);
    expect(r.videoCount).toBe(10);
    expect(r.ok).toBe(true);
    expect(r.codecsDetected).toContain('h264');
    expect(r.clips).toHaveLength(10);
  }, 120_000);

  it('respects custom minClips override', async () => {
    for (let i = 1; i <= 3; i++) {
      await makeColorClip(path.join(tmpRoot, `clip-${i}.mp4`), 'blue', 1);
    }
    const r = await preflightBrollFolder(tmpRoot, { minClips: 3 });
    expect(r.ok).toBe(true);
  }, 60_000);
});

describe('assertBrollPathAllowed (C5)', () => {
  it('accepts a path under an allowed root', () => {
    fs.mkdirSync(path.join(tmpRoot, 'rap'));
    const target = path.join(tmpRoot, 'rap');
    const r = assertBrollPathAllowed(target, [tmpRoot]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.resolvedPath).toBe(path.normalize(fs.realpathSync(target)));
    }
  });

  it('rejects a path outside any allowed root', () => {
    fs.mkdirSync(path.join(tmpRoot, 'rap'));
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-other-'));
    try {
      const r = assertBrollPathAllowed(path.join(tmpRoot, 'rap'), [otherRoot]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('PATH_NOT_ALLOWED');
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
    }
  });

  it('rejects paths containing .. segments', () => {
    fs.mkdirSync(path.join(tmpRoot, 'rap'));
    // Construct the literal traversal string manually — path.join would
    // collapse the .. during construction, defeating the test.
    const traversal = `${tmpRoot}${path.sep}rap${path.sep}..${path.sep}sensitive`;
    const r = assertBrollPathAllowed(traversal, [tmpRoot]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_TRAVERSAL');
  });

  it('rejects relative paths', () => {
    const r = assertBrollPathAllowed('relative/path', [tmpRoot]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_NOT_ABSOLUTE');
  });

  it('rejects paths that do not exist', () => {
    const ghost = path.join(tmpRoot, 'never-created-folder');
    const r = assertBrollPathAllowed(ghost, [tmpRoot]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_NOT_FOUND');
  });

  it('rejects symlinks that resolve outside the allowlist', function () {
    if (process.platform === 'win32') {
      // symlink creation on Windows requires admin or developer mode.
      // Skip rather than fail in CI without elevation.
      return;
    }
    const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-external-'));
    try {
      const link = path.join(tmpRoot, 'sneaky-link');
      fs.symlinkSync(externalDir, link, 'dir');
      const r = assertBrollPathAllowed(link, [tmpRoot]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('PATH_NOT_ALLOWED');
    } finally {
      fs.rmSync(externalDir, { recursive: true, force: true });
    }
  });

  it('rejects siblings that share a string prefix with an allowed root', () => {
    // E:\B-roll vs E:\B-roll-other: must not allow the second when only the
    // first is allowed. The path.sep boundary check guards this.
    const allowed = path.join(tmpRoot, 'B-roll');
    const sibling = path.join(tmpRoot, 'B-roll-other');
    fs.mkdirSync(allowed);
    fs.mkdirSync(sibling);
    const r = assertBrollPathAllowed(sibling, [allowed]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('PATH_NOT_ALLOWED');
  });
});
