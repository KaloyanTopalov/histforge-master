import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting } from '@/lib/settings';
import { runOnce, recoverInProgress } from '@/worker/runner';
import type { PipelineDeps } from '@/worker/pipeline';
import { step11Finalize } from '@/worker/steps/11-finalize';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  // The pipeline orchestrator's best-effort catch/finally patches go through
  // getDb() (no explicit db arg), so we must wire the singleton too.
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
});

const channelInput = {
  name: 'runner-ch',
  displayName: 'Runner Channel',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Runner Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

const noopDeps = (): PipelineDeps => ({
  step01: vi.fn(async () => {}),
  step02: vi.fn(async () => {}),
  step03: vi.fn(async () => {}),
  step04: vi.fn(async () => {}),
  step05a: vi.fn(async () => {}),
  step05b: vi.fn(async () => {}),
  branchA: vi.fn(async () => {}),
  branchB: vi.fn(async () => {}),
  step10: vi.fn(async () => {}),
  step11: vi.fn(async () => {}),
});

describe('worker/runner', () => {
  it('returns picked=null when queue_state=paused', async () => {
    const ch = channelsRepo.create(channelInput, db);
    albumsRepo.create({ channelId: ch.id }, db);
    const result = await runOnce({ db, pipelineDeps: noopDeps() });
    expect(result.picked).toBeNull();
  });

  it('processes albums strictly serially in FIFO order', async () => {
    setSetting('queue_state', 'running', db);
    const ch = channelsRepo.create(channelInput, db);
    const a1 = albumsRepo.create({ channelId: ch.id }, db);
    const a2 = albumsRepo.create({ channelId: ch.id }, db);

    const deps = noopDeps();
    const r1 = await runOnce({ db, pipelineDeps: deps });
    expect(r1.picked).toBe(a1.id);
    expect(r1.finalStatus).toBe('done');
    expect(albumsRepo.get(a1.id, db)?.status).toBe('done');
    expect(albumsRepo.get(a2.id, db)?.status).toBe('queued');

    const r2 = await runOnce({ db, pipelineDeps: deps });
    expect(r2.picked).toBe(a2.id);
    expect(r2.finalStatus).toBe('done');
    expect(albumsRepo.get(a2.id, db)?.status).toBe('done');
  });

  it('marks album failed when pipeline throws', async () => {
    setSetting('queue_state', 'running', db);
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    const deps: PipelineDeps = {
      step01: vi.fn(async () => {}),
      step02: vi.fn(async () => {}),
      step03: vi.fn(async () => {}),
      step04: vi.fn(async () => {}),
      step05a: vi.fn(async () => {}),
      step05b: vi.fn(async () => {}),
      branchA: vi.fn(async () => {
        throw new Error('branchA-fails');
      }),
      branchB: vi.fn(async () => {}),
      step10: vi.fn(async () => {}),
  step11: vi.fn(async () => {}),
    };
    const result = await runOnce({ db, pipelineDeps: deps });
    expect(result.picked).toBe(a.id);
    expect(result.finalStatus).toBe('failed');
    expect(albumsRepo.get(a.id, db)?.status).toBe('failed');
  });

  it('returns picked=null when an album is already in_progress (serial guard)', async () => {
    setSetting('queue_state', 'running', db);
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(a.id, { status: 'in_progress' }, db);
    albumsRepo.create({ channelId: ch.id }, db); // a second queued album
    const result = await runOnce({ db, pipelineDeps: noopDeps() });
    expect(result.picked).toBeNull();
  });

  it('returns finalStatus=null when branchA pauses album to awaiting_captcha', async () => {
    setSetting('queue_state', 'running', db);
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    const deps: PipelineDeps = {
      step01: vi.fn(async () => {}),
      step02: vi.fn(async () => {}),
      step03: vi.fn(async () => {}),
      step04: vi.fn(async () => {}),
      step05a: vi.fn(async () => {}),
      step05b: vi.fn(async () => {}),
      branchA: vi.fn(async (album) => {
        // Step 06 captcha branch: patches status and returns cleanly.
        albumsRepo.patch(album.id, { status: 'awaiting_captcha' }, db);
      }),
      branchB: vi.fn(async () => {}),
      step10: vi.fn(async () => {}),
  step11: vi.fn(async () => {}),
    };

    const result = await runOnce({ db, pipelineDeps: deps });
    expect(result.picked).toBe(a.id);
    expect(result.finalStatus).toBeNull();
    // Album stays in awaiting_captcha — runner did NOT overwrite to 'done'.
    expect(albumsRepo.get(a.id, db)?.status).toBe('awaiting_captcha');
  });

  it('respects step 11 terminal status on retry-branch=B with prior failed distrokidStatus (Album E)', async () => {
    setSetting('queue_state', 'running', db);
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    // Album previously failed: distrokid + video both failed.
    albumsRepo.patch(
      a.id,
      {
        status: 'queued',
        distrokidStatus: 'failed',
        videoStatus: 'failed',
        retryBranchOnly: 'B',
      },
      db,
    );
    const deps: PipelineDeps = {
      step01: vi.fn(async () => {}),
      step02: vi.fn(async () => {}),
      step03: vi.fn(async () => {}),
      step04: vi.fn(async () => {}),
      step05a: vi.fn(async () => {}),
      step05b: vi.fn(async () => {}),
      branchA: vi.fn(async () => {}), // skipped due to retry-branch=B
      branchB: vi.fn(async (album) => {
        // simulate successful video render
        albumsRepo.patch(album.id, { videoStatus: 'rendered' }, db);
      }),
      step10: vi.fn(async () => {}),
      step11: step11Finalize, // real step 11 to compute terminal status
    };
    const result = await runOnce({ db, pipelineDeps: deps });
    expect(result.picked).toBe(a.id);
    // Branch A is still failed, so step 11 sets status='failed'. Runner must
    // respect that — NOT overwrite with 'done'.
    expect(result.finalStatus).toBe('failed');
    const after = albumsRepo.get(a.id, db);
    expect(after?.status).toBe('failed');
    expect(after?.distrokidStatus).toBe('failed');
    expect(after?.videoStatus).toBe('rendered');
  });

  it('returns done after retry-branch=A succeeds against a previously failed album', async () => {
    setSetting('queue_state', 'running', db);
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    // Album previously failed branch A; branch B already rendered (e.g., from
    // a prior retry-B run).
    albumsRepo.patch(
      a.id,
      {
        status: 'queued',
        distrokidStatus: 'failed',
        videoStatus: 'rendered',
        retryBranchOnly: 'A',
      },
      db,
    );
    const deps: PipelineDeps = {
      step01: vi.fn(async () => {}),
      step02: vi.fn(async () => {}),
      step03: vi.fn(async () => {}),
      step04: vi.fn(async () => {}),
      step05a: vi.fn(async () => {}),
      step05b: vi.fn(async () => {}),
      branchA: vi.fn(async (album) => {
        albumsRepo.patch(album.id, { distrokidStatus: 'dryrun' }, db);
      }),
      branchB: vi.fn(async () => {}), // skipped due to retry-branch=A
      step10: vi.fn(async () => {}),
      step11: step11Finalize,
    };
    const result = await runOnce({ db, pipelineDeps: deps });
    expect(result.picked).toBe(a.id);
    expect(result.finalStatus).toBe('done');
    const after = albumsRepo.get(a.id, db);
    expect(after?.status).toBe('done');
    expect(after?.distrokidStatus).toBe('dryrun');
    expect(after?.videoStatus).toBe('rendered');
  });

  it('recoverInProgress flips in_progress albums back to queued', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a1 = albumsRepo.create({ channelId: ch.id }, db);
    const a2 = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(a1.id, { status: 'in_progress' }, db);
    albumsRepo.patch(a2.id, { status: 'in_progress' }, db);
    const reset = recoverInProgress(db);
    expect(reset).toBe(2);
    expect(albumsRepo.get(a1.id, db)?.status).toBe('queued');
    expect(albumsRepo.get(a2.id, db)?.status).toBe('queued');
  });
});
