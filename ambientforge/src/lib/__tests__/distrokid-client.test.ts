import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DistrokidError,
  __resetMockDistrokidState,
  makeMockDistrokidClient,
} from '@/lib/distrokid/client';

let tmpDir: string;

function makeFakePng(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

beforeEach(() => {
  __resetMockDistrokidState();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ambientforge-dk-client-'));
});

afterEach(() => {
  __resetMockDistrokidState();
  if (tmpDir && fs.existsSync(tmpDir)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

describe('DistrokidError', () => {
  it('preserves code, retriable, status, cause', () => {
    const cause = new Error('underlying');
    const err = new DistrokidError('TEST_CODE', 'msg', true, 503, cause);
    expect(err.code).toBe('TEST_CODE');
    expect(err.retriable).toBe(true);
    expect(err.status).toBe(503);
    expect(err.cause).toBe(cause);
    expect(err.message).toBe('msg');
    expect(err.name).toBe('DistrokidError');
  });
});

describe('makeMockDistrokidClient', () => {
  it('verifyArtist returns found:true for normal artist name', async () => {
    const client = makeMockDistrokidClient();
    const result = await client.verifyArtist('Some Artist');
    expect(result.found).toBe(true);
  });

  it('verifyArtist throws DISTROKID_ARTIST_NOT_FOUND when name contains "Nonexistent"', async () => {
    const client = makeMockDistrokidClient();
    await expect(client.verifyArtist('Nonexistent Artist')).rejects.toMatchObject({
      code: 'DISTROKID_ARTIST_NOT_FOUND',
      retriable: false,
    });
  });

  it('verifyArtist throws DISTROKID_ARTIST_NOT_FOUND for "Definitely Not A Real Artist"', async () => {
    const client = makeMockDistrokidClient();
    await expect(client.verifyArtist('Definitely Not A Real Artist')).rejects.toMatchObject({
      code: 'DISTROKID_ARTIST_NOT_FOUND',
    });
  });

  it('startRelease returns a unique releaseToken per call', async () => {
    const client = makeMockDistrokidClient();
    const a = await client.startRelease();
    const b = await client.startRelease();
    expect(a.releaseToken).not.toBe(b.releaseToken);
    expect(a.releaseToken).toMatch(/^mock-release-\d{4}$/);
  });

  it('uploadCover throws DISTROKID_COVER_MISSING when file does not exist', async () => {
    const client = makeMockDistrokidClient();
    const { releaseToken } = await client.startRelease();
    await expect(
      client.uploadCover(releaseToken, path.join(tmpDir, 'missing.png')),
    ).rejects.toMatchObject({ code: 'DISTROKID_COVER_MISSING' });
  });

  it('uploadTrack throws DISTROKID_UNKNOWN_RELEASE for unknown token', async () => {
    const client = makeMockDistrokidClient();
    const audioPath = path.join(tmpDir, 'track.wav');
    fs.writeFileSync(audioPath, 'fake');
    await expect(
      client.uploadTrack('bogus-token', audioPath, 1, 'Track 1'),
    ).rejects.toMatchObject({ code: 'DISTROKID_UNKNOWN_RELEASE' });
  });

  it('verifyTrackCount returns count + matches based on uploaded tracks', async () => {
    const client = makeMockDistrokidClient();
    const { releaseToken } = await client.startRelease();
    const audioPath = path.join(tmpDir, 'track.wav');
    fs.writeFileSync(audioPath, 'fake');
    await client.uploadTrack(releaseToken, audioPath, 1, 'A');
    await client.uploadTrack(releaseToken, audioPath, 2, 'B');
    const v = await client.verifyTrackCount(releaseToken, 2);
    expect(v.count).toBe(2);
    expect(v.matches).toBe(true);
    const v3 = await client.verifyTrackCount(releaseToken, 3);
    expect(v3.matches).toBe(false);
  });

  it('submitOrScreenshot copies fixture to dest path and returns screenshot_saved', async () => {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'distrokid', 'dryrun-fixture.png');
    if (!fs.existsSync(fixturePath)) makeFakePng(fixturePath);
    const client = makeMockDistrokidClient();
    const { releaseToken } = await client.startRelease();
    const dest = path.join(tmpDir, 'dryrun.png');
    const r = await client.submitOrScreenshot(releaseToken, dest, true);
    expect(r.status).toBe('screenshot_saved');
    expect(fs.existsSync(dest)).toBe(true);
    expect(fs.statSync(dest).size).toBeGreaterThan(0);
  });

  it('submitOrScreenshot returns captcha_required when channelName hint contains "captcha-test"', async () => {
    const client = makeMockDistrokidClient();
    const { releaseToken } = await client.startRelease();
    const dest = path.join(tmpDir, 'dryrun.png');
    const r = await client.submitOrScreenshot(releaseToken, dest, true, {
      channelName: 'my-captcha-test-channel',
    });
    expect(r.status).toBe('captcha_required');
    // No file should be written when captcha is triggered.
    expect(fs.existsSync(dest)).toBe(false);
  });

  it('focusWindow returns ok:true', async () => {
    const client = makeMockDistrokidClient();
    const r = await client.focusWindow();
    expect(r.ok).toBe(true);
  });

  it('__resetMockDistrokidState clears state between calls', async () => {
    const client = makeMockDistrokidClient();
    const a = await client.startRelease();
    __resetMockDistrokidState();
    const b = await client.startRelease();
    // Counter resets to 0001 after reset.
    expect(b.releaseToken).toBe('mock-release-0001');
    expect(a.releaseToken).toBe('mock-release-0001'); // same first-id pre-reset
  });
});
