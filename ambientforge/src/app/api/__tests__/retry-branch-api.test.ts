import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { POST as retryBranchRoute } from '@/app/api/albums/[id]/retry-branch/route';

let db: Db;

const baseChannel = {
  name: 'retry-branch-ch',
  displayName: 'Retry Branch',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
  active: true,
};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
});

function makeReq(albumId: string, body: unknown): Request {
  return new Request(`http://localhost/api/albums/${albumId}/retry-branch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/albums/[id]/retry-branch', () => {
  it("happy path branch=A: status→queued, distrokid_status→pending, retry_branch_only='A'", async () => {
    const ch = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: ch.id });
    albumsRepo.patch(album.id, {
      status: 'failed',
      distrokidStatus: 'failed',
      distrokidSubmittedAt: 1234,
      safeToUploadAfter: 5678,
      distrokidDryRunArtifact: '/some/path.png',
    });

    const res = await retryBranchRoute(makeReq(album.id, { branch: 'A' }), {
      params: { id: album.id },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.album.status).toBe('queued');
    expect(body.album.distrokidStatus).toBe('pending');
    expect(body.album.distrokidSubmittedAt).toBeNull();
    expect(body.album.safeToUploadAfter).toBeNull();
    expect(body.album.distrokidDryRunArtifact).toBeNull();
    expect(body.album.retryBranchOnly).toBe('A');
  });

  it("happy path branch=B: status→queued, video_status→pending, retry_branch_only='B', final_video_path cleared", async () => {
    const ch = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: ch.id });
    albumsRepo.patch(album.id, {
      status: 'failed',
      videoStatus: 'failed',
      finalVideoPath: '/tmp/x.mp4',
      videoProgressPct: 42,
    });

    const res = await retryBranchRoute(makeReq(album.id, { branch: 'B' }), {
      params: { id: album.id },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.album.status).toBe('queued');
    expect(body.album.videoStatus).toBe('pending');
    expect(body.album.finalVideoPath).toBeNull();
    expect(body.album.videoProgressPct).toBe(0);
    expect(body.album.retryBranchOnly).toBe('B');
  });

  it('404 when album does not exist', async () => {
    const res = await retryBranchRoute(makeReq('missing', { branch: 'A' }), {
      params: { id: 'missing' },
    });
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('ALBUM_NOT_FOUND');
  });

  it('400 INVALID_BODY when branch is not "A" or "B"', async () => {
    const ch = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: ch.id });
    const res = await retryBranchRoute(makeReq(album.id, { branch: 'C' }), {
      params: { id: album.id },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_BODY');
  });

  it('409 ALBUM_LOCKED_DURING_RUN when album is in_progress', async () => {
    const ch = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: ch.id });
    albumsRepo.patch(album.id, { status: 'in_progress', distrokidStatus: 'failed' });
    const res = await retryBranchRoute(makeReq(album.id, { branch: 'A' }), {
      params: { id: album.id },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ALBUM_LOCKED_DURING_RUN');
  });

  it('409 BRANCH_NOT_RETRIABLE when requested branch is not in failed state', async () => {
    const ch = channelsRepo.create(baseChannel);
    const album = albumsRepo.create({ channelId: ch.id });
    // distrokidStatus defaults to 'pending'
    albumsRepo.patch(album.id, { status: 'failed', videoStatus: 'failed' });
    const res = await retryBranchRoute(makeReq(album.id, { branch: 'A' }), {
      params: { id: album.id },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('BRANCH_NOT_RETRIABLE');
  });
});
