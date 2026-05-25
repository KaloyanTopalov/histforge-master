import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import { setSetting } from '@/lib/settings';
import { POST as createChannel } from '@/app/api/channels/route';
import { GET as validateBroll } from '@/app/api/channels/validate-broll/route';

const execFileAsync = promisify(execFile);

let db: Db;
let tmpDir: string;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rap-validation-'));
  // C5: every rap-validation test uses tmpDir as the B-roll root, so allow it.
  setSetting('broll_allowed_root_paths', JSON.stringify([tmpDir]), db);
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const baseValidBody = {
  name: 'rap-test',
  displayName: 'Rap Test',
  description: 'Rap channel',
  scheduleCron: '0 9 * * 1',
  distrokidArtistName: 'Rap Artist',
  distrokidPrimaryGenre: 'Hip-Hop',
};

function jsonReq(body: unknown): Request {
  return new Request('http://localhost/api/channels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function makeColorClip(out: string) {
  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      `color=c=blue:s=320x240:r=30:d=1`,
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

describe('POST /api/channels — rap workflow validation', () => {
  it('rejects rap-compilation without brollFolderPath', async () => {
    const res = await createChannel(
      jsonReq({ ...baseValidBody, workflow: 'rap-compilation' }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('BROLL_FOLDER_REQUIRED');
  });

  it('rejects rap-compilation when brollFolderPath has too few clips', async () => {
    // Generate 3 clips (default min is 10).
    for (let i = 1; i <= 3; i++) {
      await makeColorClip(path.join(tmpDir, `clip-${i}.mp4`));
    }
    const res = await createChannel(
      jsonReq({
        ...baseValidBody,
        workflow: 'rap-compilation',
        brollFolderPath: tmpDir,
      }),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('BROLL_FOLDER_INVALID');
  }, 60_000);

  it('accepts ambient workflow without brollFolderPath', async () => {
    const res = await createChannel(
      jsonReq({ ...baseValidBody, workflow: 'ambient' }),
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.channel.workflow).toBe('ambient');
  });
});

describe('GET /api/channels/validate-broll', () => {
  it('returns 400 when path query param missing', async () => {
    const res = await validateBroll(
      new Request('http://localhost/api/channels/validate-broll'),
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe('PATH_REQUIRED');
  });

  it('returns 404 PATH_NOT_FOUND for missing folder (C5: rejected before preflight)', async () => {
    const res = await validateBroll(
      new Request(
        `http://localhost/api/channels/validate-broll?path=${encodeURIComponent(path.join(tmpDir, 'missing'))}`,
      ),
    );
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error.code).toBe('PATH_NOT_FOUND');
  });
});
