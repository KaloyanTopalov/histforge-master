import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import {
  __resetMockFlowState,
  makeMockFlowClient,
  type FlowClient,
} from '@/lib/flow/client';
import { step05bInternal } from '@/worker/steps/05b-thumbnail';
import { ffprobe } from '@/lib/audio/ffmpeg';

let db: Db;
let workDir: string;
let originalApiKey: string | undefined;
let projectsDir: string;

const baseChannel = {
  name: 'step05b-test-ch',
  displayName: 'Step05b Test',
  description: 'noir blues channel',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step05b Artist',
  distrokidPrimaryGenre: 'Blues',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

async function setupAlbumWithCover(): Promise<{
  albumId: string;
  channelId: string;
  coverPath: string;
}> {
  const channel = channelsRepo.create({ ...baseChannel, active: true });
  const album = albumsRepo.create({ channelId: channel.id });
  albumsRepo.patch(album.id, {
    albumTitle: 'Late Hours',
    artistName: 'Step05b Artist',
    sunoStylePrompt: 'noir slow blues',
    primaryGenre: 'Blues',
  });
  // Pretend step 05a finished: create cover.png at 3000x3000 by upscaling
  // the square fixture.
  const albumDir = path.join(projectsDir, channel.id, album.id);
  fs.mkdirSync(albumDir, { recursive: true });
  const coverPath = path.join(albumDir, 'cover.png');
  await import('node:child_process').then(({ execFileSync }) => {
    execFileSync('ffmpeg', [
      '-y',
      '-i',
      path.join(process.cwd(), 'tests', 'fixtures', 'flow', 'fixture-square.png'),
      '-vf',
      'scale=3000:3000:flags=lanczos',
      '-frames:v',
      '1',
      coverPath,
    ]);
  });
  albumsRepo.patch(album.id, { coverImagePath: coverPath });
  return { albumId: album.id, channelId: channel.id, coverPath };
}

const noopLog = (_stage: string, _msg: string) => {};
function fastOpts(opts: Partial<{ fontPath: string }> = {}) {
  return {
    pollIntervalMs: 0,
    pollTimeoutMs: 5_000,
    projectsDir,
    fontPath: opts.fontPath ?? path.join(workDir, 'no-font-here.ttf'),
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetMockFlowState();
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step05b-work-'));
  projectsDir = path.join(workDir, 'projects');
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

describe('step05bThumbnail', () => {
  it('default useCover=true: thumb derived from cover, no Flow call, 1920x1080', async () => {
    const { albumId } = await setupAlbumWithCover();
    const baseClient = makeMockFlowClient();
    let submits = 0;
    const wrapped: FlowClient = {
      ...baseClient,
      submitPrompt: async (...args) => {
        submits++;
        return baseClient.submitPrompt(...args);
      },
    };
    await step05bInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());
    expect(submits).toBe(0);
    const album = albumsRepo.get(albumId)!;
    const probe = await ffprobe(album.thumbnailPath!);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
  }, 30_000);

  it('channel override useCover=false triggers a Flow call', async () => {
    const { albumId, channelId } = await setupAlbumWithCover();
    // Place a channel-template override that returns useCover:false.
    // Session 10's resolveChannelPrompt looks up channel-templates files
    // by PromptKind ("thumbnail"), not by the workflow-default basename
    // ("thumbnail-prompt"). This decouples per-channel overrides from
    // per-workflow default file naming.
    const overrideDir = path.join(
      process.cwd(),
      'prompts',
      'channel-templates',
      channelId,
    );
    fs.mkdirSync(overrideDir, { recursive: true });
    const overridePath = path.join(overrideDir, 'thumbnail.md');
    fs.writeFileSync(
      overridePath,
      '<!-- mock-response: { "useCover": false, "imagePrompt": "abstract waves and city lights, cinematic 16:9" } -->\n\nmust have a non-empty body to be a valid template.\n',
    );
    try {
      const baseClient = makeMockFlowClient();
      let submits = 0;
      const wrapped: FlowClient = {
        ...baseClient,
        submitPrompt: async (...args) => {
          submits++;
          return baseClient.submitPrompt(...args);
        },
      };
      await step05bInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());
      expect(submits).toBe(1);
      const album = albumsRepo.get(albumId)!;
      const probe = await ffprobe(album.thumbnailPath!);
      expect(probe.width).toBe(1920);
      expect(probe.height).toBe(1080);
    } finally {
      fs.rmSync(overrideDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('overlay text + missing font: warning logged, step still completes without overlay', async () => {
    const { albumId, channelId } = await setupAlbumWithCover();
    const ch = channelsRepo.list().find((c) => c.id === channelId)!;
    channelsRepo.patch(ch.id, { thumbnailOverlayText: 'TEST OVERLAY' });
    const logs: string[] = [];
    const log = (stage: string, msg: string) => logs.push(`${stage} ${msg}`);
    const client = makeMockFlowClient();
    await step05bInternal(albumsRepo.get(albumId)!, log, client, fastOpts());
    expect(logs.some((l) => l.includes('thumbnail font missing'))).toBe(true);
    const album = albumsRepo.get(albumId)!;
    const probe = await ffprobe(album.thumbnailPath!);
    expect(probe.width).toBe(1920);
    expect(probe.height).toBe(1080);
  }, 30_000);

  it('idempotent: rerun is a noop when thumbnail already exists with correct dims', async () => {
    const { albumId } = await setupAlbumWithCover();
    const baseClient = makeMockFlowClient();
    await step05bInternal(albumsRepo.get(albumId)!, noopLog, baseClient, fastOpts());
    let submits = 0;
    const wrapped: FlowClient = {
      ...baseClient,
      submitPrompt: async (...args) => {
        submits++;
        return baseClient.submitPrompt(...args);
      },
    };
    await step05bInternal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts());
    expect(submits).toBe(0);
  }, 30_000);
});
