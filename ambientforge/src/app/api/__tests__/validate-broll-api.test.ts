import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import { setSetting } from '@/lib/settings';
import { GET as validateBroll } from '@/app/api/channels/validate-broll/route';

const execFileAsync = promisify(execFile);

let db: Db;
let tmpRoot: string;

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

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'af-validate-broll-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  __setDbForTests(null);
  db.close();
});

function getReq(p: string): Request {
  return new Request(
    `http://localhost/api/channels/validate-broll?path=${encodeURIComponent(p)}`,
    { method: 'GET' },
  );
}

describe('GET /api/channels/validate-broll (C5)', () => {
  it('returns 200 for a path under the allowlist with ≥10 clips', async () => {
    const allowed = path.join(tmpRoot, 'rap');
    fs.mkdirSync(allowed);
    for (let i = 1; i <= 10; i++) {
      await makeColorClip(
        path.join(allowed, `clip-${String(i).padStart(2, '0')}.mp4`),
        'blue',
        1,
      );
    }
    setSetting('broll_allowed_root_paths', JSON.stringify([tmpRoot]), db);
    const res = await validateBroll(getReq(allowed));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.videoCount).toBe(10);
  }, 120_000);

  it('returns 403 PATH_NOT_ALLOWED for a path outside the allowlist', async () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'af-outside-'));
    try {
      setSetting('broll_allowed_root_paths', JSON.stringify([tmpRoot]), db);
      const res = await validateBroll(getReq(outside));
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe('PATH_NOT_ALLOWED');
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it('returns 403 PATH_TRAVERSAL for paths containing ..', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'rap'));
    setSetting('broll_allowed_root_paths', JSON.stringify([tmpRoot]), db);
    // Literal .. — path.join would collapse it during construction.
    const traversal = `${tmpRoot}${path.sep}rap${path.sep}..${path.sep}sensitive`;
    const res = await validateBroll(getReq(traversal));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('PATH_TRAVERSAL');
  });

  it('returns 404 PATH_NOT_FOUND when the path does not exist', async () => {
    setSetting('broll_allowed_root_paths', JSON.stringify([tmpRoot]), db);
    const res = await validateBroll(getReq(path.join(tmpRoot, 'never-created')));
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('PATH_NOT_FOUND');
  });

  it('returns 403 PATH_NOT_ALLOWED when the allowlist is empty (deny-all default)', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'rap'));
    // No setting written → defaults to '[]' → deny-all.
    const res = await validateBroll(getReq(path.join(tmpRoot, 'rap')));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe('PATH_NOT_ALLOWED');
  });

  it('returns 400 PATH_REQUIRED when ?path is missing', async () => {
    const res = await validateBroll(
      new Request('http://localhost/api/channels/validate-broll', { method: 'GET' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('PATH_REQUIRED');
  });
});
