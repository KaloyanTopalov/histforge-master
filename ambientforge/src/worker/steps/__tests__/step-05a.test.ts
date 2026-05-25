import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import {
  __resetMockFlowState,
  __setMockNextFixture,
  makeMockFlowClient,
  type FlowClient,
} from '@/lib/flow/client';
import { step05aInternal } from '@/worker/steps/05a-cover-image';
import { ffprobe } from '@/lib/audio/ffmpeg';

let db: Db;
let workDir: string;
let originalApiKey: string | undefined;

const baseChannel = {
  name: 'step05a-test-ch',
  displayName: 'Step05a Test',
  description: 'late-night ambient drift channel',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step05a Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function setupAlbum(): { albumId: string; channelId: string } {
  const channel = channelsRepo.create({ ...baseChannel, active: true });
  const album = albumsRepo.create({ channelId: channel.id });
  albumsRepo.patch(album.id, {
    albumTitle: 'Test Album',
    artistName: 'Step05a Artist',
    sunoStylePrompt: 'ambient drift, slow tempo, warm pads',
    primaryGenre: 'Ambient',
  });
  return { albumId: album.id, channelId: channel.id };
}

const noopLog = (_stage: string, _msg: string) => {};
function fastOpts(): { pollIntervalMs: number; pollTimeoutMs: number; projectsDir: string } {
  return {
    pollIntervalMs: 0,
    pollTimeoutMs: 5_000,
    projectsDir: path.join(workDir, 'projects'),
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetMockFlowState();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step05a-work-'));
  // The image-prompt LLM call uses chatCompletionJSON; mock-mode lets us serve
  // fixed JSON via the template's <!-- mock-response: ... --> directive.
  originalApiKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'mock';
  setSetting('openrouter_api_key', 'mock', db);
});

afterEach(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  __setDbForTests(null);
  __resetMockFlowState();
  if (originalApiKey === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = originalApiKey;
});

describe('step05aCoverImage', () => {
  it('happy path: 3000x3000 cover.png and 1920x1080 ytImage.png produced', async () => {
    const { albumId, channelId } = setupAlbum();
    const client = makeMockFlowClient();
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    const album = albumsRepo.get(albumId)!;
    expect(album.coverImagePath).toBeTruthy();
    expect(album.ytImagePath).toBeTruthy();

    const coverPath = path.join(workDir, 'projects', channelId, albumId, 'cover.png');
    const ytPath = path.join(workDir, 'projects', channelId, albumId, 'ytImage.png');
    expect(fs.existsSync(coverPath)).toBe(true);
    expect(fs.existsSync(ytPath)).toBe(true);

    const cover = await ffprobe(coverPath);
    expect(cover.width).toBe(3000);
    expect(cover.height).toBe(3000);

    const yt = await ffprobe(ytPath);
    expect(yt.width).toBe(1920);
    expect(yt.height).toBe(1080);

    // Raw scratch should be cleaned up.
    expect(
      fs.existsSync(path.join(workDir, 'projects', channelId, albumId, '_raw-cover.png')),
    ).toBe(false);
  }, 30_000);

  it('idempotent: rerun is a noop when both paths exist with valid dimensions', async () => {
    const { albumId, channelId } = setupAlbum();
    const client = makeMockFlowClient();
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    // Pretend the operator triggers another run by monkey-patching the client
    // to track calls; idempotency check should short-circuit.
    let submitCalls = 0;
    const wrapped: FlowClient = {
      ...client,
      submitPrompt: async (...args) => {
        submitCalls++;
        return client.submitPrompt(...args);
      },
    };
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());
    expect(submitCalls).toBe(0);
    void channelId;
  }, 30_000);

  it('aspect-retry: wide first call -> square retry -> step succeeds with 3000x3000 cover', async () => {
    const { albumId } = setupAlbum();
    const client = makeMockFlowClient();
    let submitCalls = 0;
    // First call -> wide fixture, second call -> square (default for 1:1).
    __setMockNextFixture('fixture-wide.png');
    const wrapped: FlowClient = {
      ...client,
      submitPrompt: async (...args) => {
        submitCalls++;
        return client.submitPrompt(...args);
      },
    };
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());
    expect(submitCalls).toBe(2);
    const album = albumsRepo.get(albumId)!;
    const cover = await ffprobe(album.coverImagePath!);
    expect(cover.width).toBe(3000);
    expect(cover.height).toBe(3000);
  }, 30_000);

  it('force-crop fallback: wide both calls -> step still succeeds, no infinite loop', async () => {
    const { albumId } = setupAlbum();
    const baseClient = makeMockFlowClient();
    // Always serve wide regardless of requested aspect.
    const wrapped: FlowClient = {
      ...baseClient,
      submitPrompt: async (prompt, _aspect) => {
        __setMockNextFixture('fixture-wide.png');
        return baseClient.submitPrompt(prompt, '1:1');
      },
    };
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());
    const album = albumsRepo.get(albumId)!;
    const cover = await ffprobe(album.coverImagePath!);
    expect(cover.width).toBe(3000);
    expect(cover.height).toBe(3000);
    const yt = await ffprobe(album.ytImagePath!);
    expect(yt.width).toBe(1920);
    expect(yt.height).toBe(1080);
  }, 30_000);

  it('youtube_image_aspect=crop produces 1920x1080 (matching letterbox dims)', async () => {
    const { albumId } = setupAlbum();
    setSetting('youtube_image_aspect', 'crop', db);
    const client = makeMockFlowClient();
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());
    const album = albumsRepo.get(albumId)!;
    const yt = await ffprobe(album.ytImagePath!);
    expect(yt.width).toBe(1920);
    expect(yt.height).toBe(1080);
  }, 30_000);

  // Auto-resample-for-DK regression group. The default fixture is small
  // (~5 KB), so the standard happy-path test covers the under-threshold
  // branch implicitly. These tests pin the contract:
  //   1) source > 10 MB -> cover.jpg appears, ≤ 10 MB, valid JPEG.
  //   2) source < 10 MB -> cover.jpg absent (no leftover).
  it('auto-resamples to cover.jpg when source PNG > 10 MB DK cap', async () => {
    const { albumId, channelId } = setupAlbum();

    // Synthesize a high-entropy 3000x3000 PNG that survives lanczos rescale
    // and lands well over 10 MB after step 05a's cropAndScaleSquare pass.
    const largePng = path.join(workDir, 'noisy-3000.png');
    const rawBin = path.join(workDir, '_raw-3000.bin');
    fs.writeFileSync(rawBin, randomBytes(3000 * 3000 * 3));
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
      '3000x3000',
      '-i',
      rawBin,
      '-frames:v',
      '1',
      '-c:v',
      'png',
      largePng,
    ]);
    fs.unlinkSync(rawBin);
    expect(fs.statSync(largePng).size).toBeGreaterThan(10 * 1024 * 1024);

    const baseClient = makeMockFlowClient();
    const wrapped: FlowClient = {
      ...baseClient,
      download: async (_taskId, destPath) => {
        await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
        await fs.promises.copyFile(largePng, destPath);
      },
    };
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());

    const albumDir = path.join(workDir, 'projects', channelId, albumId);
    const coverPng = path.join(albumDir, 'cover.png');
    const coverJpg = path.join(albumDir, 'cover.jpg');

    expect(fs.existsSync(coverPng)).toBe(true);
    // The PNG itself stays untouched (high-quality source for thumbnail
    // derivation). Confirm it's actually over the 9.5 MB resample threshold.
    const pngSize = fs.statSync(coverPng).size;
    expect(pngSize).toBeGreaterThan(Math.floor(9.5 * 1024 * 1024));

    expect(fs.existsSync(coverJpg)).toBe(true);
    const jpgSize = fs.statSync(coverJpg).size;
    expect(jpgSize).toBeLessThanOrEqual(10 * 1024 * 1024);

    // JPEG header sanity (FF D8 SOI marker).
    const head = fs.readFileSync(coverJpg).subarray(0, 2);
    expect(head[0]).toBe(0xff);
    expect(head[1]).toBe(0xd8);

    // Dimensions preserved.
    const probe = await ffprobe(coverJpg);
    expect(probe.width).toBe(3000);
    expect(probe.height).toBe(3000);
  }, 120_000);

  it('skips cover.jpg when source PNG is small (default fixture path)', async () => {
    const { albumId, channelId } = setupAlbum();
    const client = makeMockFlowClient();
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    const albumDir = path.join(workDir, 'projects', channelId, albumId);
    const coverPng = path.join(albumDir, 'cover.png');
    const coverJpg = path.join(albumDir, 'cover.jpg');

    expect(fs.existsSync(coverPng)).toBe(true);
    expect(fs.statSync(coverPng).size).toBeLessThan(Math.floor(9.5 * 1024 * 1024));
    expect(fs.existsSync(coverJpg)).toBe(false);
  }, 30_000);

  it('removes a stale cover.jpg from a prior over-threshold run when the new source is small', async () => {
    const { albumId, channelId } = setupAlbum();
    const albumDir = path.join(workDir, 'projects', channelId, albumId);
    fs.mkdirSync(albumDir, { recursive: true });
    const staleJpgPath = path.join(albumDir, 'cover.jpg');
    fs.writeFileSync(staleJpgPath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]));
    expect(fs.existsSync(staleJpgPath)).toBe(true);

    const client = makeMockFlowClient();
    await step05aInternal(albumsRepo.get(albumId)!, noopLog, client, fastOpts());

    expect(fs.existsSync(staleJpgPath)).toBe(false);
  }, 30_000);
});
