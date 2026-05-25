import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { performance } from 'node:perf_hooks';
import { runPipeline, PipelineError, type PipelineDeps } from '@/worker/pipeline';
import {
  openDb,
  initSchema,
  __setDbForTests,
  type Db,
} from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import type { Album } from '@/lib/repos/albums';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
});

afterEach(() => {
  __setDbForTests(null);
});

const baseChannel = {
  name: 'pipeline-test-ch',
  displayName: 'Pipeline Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Pipeline Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function fakeAlbum(): Album {
  // Persist via the real repo so orchestrator's DB writes (best-effort
  // *_status='failed' patches, retry_branch_only clears) target a real row.
  const ch = channelsRepo.create(baseChannel, db);
  const a = albumsRepo.create({ channelId: ch.id }, db);
  albumsRepo.patch(a.id, { status: 'in_progress' }, db);
  return albumsRepo.get(a.id, db)!;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeDeps(overrides: Partial<PipelineDeps>): PipelineDeps {
  return {
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
    ...overrides,
  };
}

describe('worker/pipeline', () => {
  it('runs both branches concurrently then step10 + step11 on success', async () => {
    const album = fakeAlbum();
    const startA: number[] = [];
    const startB: number[] = [];
    const branchA = vi.fn(async () => {
      startA.push(performance.now());
      await sleep(20);
    });
    const branchB = vi.fn(async () => {
      startB.push(performance.now());
      await sleep(20);
    });
    const step10 = vi.fn(async () => {});
    const step11 = vi.fn(async () => {});

    await runPipeline(album, makeDeps({ branchA, branchB, step10, step11 }));

    expect(branchA).toHaveBeenCalledTimes(1);
    expect(branchB).toHaveBeenCalledTimes(1);
    expect(step10).toHaveBeenCalledTimes(1);
    expect(step11).toHaveBeenCalledTimes(1);
    // Both branches started on the same event-loop tick (well under 5 ms).
    expect(Math.abs(startA[0] - startB[0])).toBeLessThan(5);
  });

  it('on branch A failure: still awaits branch B, skips step10, runs step11, throws PipelineError', async () => {
    const album = fakeAlbum();
    let bDoneAt: number | null = null;
    const branchA = vi.fn(async () => {
      throw new Error('boom-A');
    });
    const branchB = vi.fn(async () => {
      await sleep(30);
      bDoneAt = performance.now();
    });
    const step10 = vi.fn(async () => {});
    const step11 = vi.fn(async () => {});

    await expect(
      runPipeline(album, makeDeps({ branchA, branchB, step10, step11 })),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(branchB).toHaveBeenCalledTimes(1);
    expect(bDoneAt).not.toBeNull();
    expect(step10).not.toHaveBeenCalled();
    expect(step11).toHaveBeenCalledTimes(1);
  });

  it('on branch B failure: awaits branch A, skips step10, runs step11, throws', async () => {
    const album = fakeAlbum();
    let aDoneAt: number | null = null;
    const branchA = vi.fn(async () => {
      await sleep(30);
      aDoneAt = performance.now();
    });
    const branchB = vi.fn(async () => {
      throw new Error('boom-B');
    });
    const step10 = vi.fn(async () => {});
    const step11 = vi.fn(async () => {});

    await expect(
      runPipeline(album, makeDeps({ branchA, branchB, step10, step11 })),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(branchA).toHaveBeenCalledTimes(1);
    expect(aDoneAt).not.toBeNull();
    expect(step10).not.toHaveBeenCalled();
    expect(step11).toHaveBeenCalledTimes(1);
  });

  it('reports both branches in the failure when both throw, runs step11 anyway', async () => {
    const album = fakeAlbum();
    const branchA = vi.fn(async () => {
      throw new Error('boom-A');
    });
    const branchB = vi.fn(async () => {
      throw new Error('boom-B');
    });
    const step10 = vi.fn(async () => {});
    const step11 = vi.fn(async () => {});

    let caught: unknown;
    try {
      await runPipeline(album, makeDeps({ branchA, branchB, step10, step11 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    const e = caught as PipelineError;
    expect(e.message).toContain('branchA');
    expect(e.message).toContain('branchB');
    expect(e.causes).toHaveLength(2);
    expect(step10).not.toHaveBeenCalled();
    expect(step11).toHaveBeenCalledTimes(1);
  });

  it('a step11 throw is swallowed so it never masks a branch error', async () => {
    const album = fakeAlbum();
    const branchA = vi.fn(async () => {
      throw new Error('boom-A');
    });
    const step11 = vi.fn(async () => {
      throw new Error('step11-internal');
    });
    let caught: unknown;
    try {
      await runPipeline(album, makeDeps({ branchA, step11 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PipelineError);
    const e = caught as PipelineError;
    expect(e.message).toContain('branchA');
    expect(e.causes).toHaveLength(1);
    expect((e.causes[0] as Error).message).toBe('boom-A');
    expect(step11).toHaveBeenCalledTimes(1);
  });

  it('awaiting_captcha after fork skips step10 + step11 entirely', async () => {
    const album = fakeAlbum();
    const branchA = vi.fn(async () => {
      // Mirror step 06's clean-return captcha pause.
      albumsRepo.patch(album.id, { status: 'awaiting_captcha' }, db);
    });
    const step10 = vi.fn(async () => {});
    const step11 = vi.fn(async () => {});

    await runPipeline(album, makeDeps({ branchA, step10, step11 }));

    expect(step10).not.toHaveBeenCalled();
    expect(step11).not.toHaveBeenCalled();
    expect(albumsRepo.get(album.id, db)?.status).toBe('awaiting_captcha');
  });

  it('branchA rejection patches distrokid_status=failed before re-throwing', async () => {
    const album = fakeAlbum();
    const branchA = vi.fn(async () => {
      throw new Error('boom-A');
    });
    await expect(
      runPipeline(album, makeDeps({ branchA })),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(albumsRepo.get(album.id, db)?.distrokidStatus).toBe('failed');
  });

  it('branchB rejection patches video_status=failed before re-throwing', async () => {
    const album = fakeAlbum();
    const branchB = vi.fn(async () => {
      throw new Error('boom-B');
    });
    await expect(
      runPipeline(album, makeDeps({ branchB })),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(albumsRepo.get(album.id, db)?.videoStatus).toBe('failed');
  });

  it("retry_branch_only='A' runs only branch A and skips 01-05b", async () => {
    const album = fakeAlbum();
    albumsRepo.patch(album.id, { retryBranchOnly: 'A' }, db);
    const fresh = albumsRepo.get(album.id, db)!;
    const step01 = vi.fn(async () => {});
    const step05b = vi.fn(async () => {});
    const branchA = vi.fn(async () => {});
    const branchB = vi.fn(async () => {});
    await runPipeline(
      fresh,
      makeDeps({ step01, step05b, branchA, branchB }),
    );
    expect(step01).not.toHaveBeenCalled();
    expect(step05b).not.toHaveBeenCalled();
    expect(branchA).toHaveBeenCalledTimes(1);
    expect(branchB).not.toHaveBeenCalled();
    // Flag cleared by finally block.
    expect(albumsRepo.get(album.id, db)?.retryBranchOnly).toBeNull();
  });

  it("retry_branch_only='B' runs only branch B and skips 01-05b", async () => {
    const album = fakeAlbum();
    albumsRepo.patch(album.id, { retryBranchOnly: 'B' }, db);
    const fresh = albumsRepo.get(album.id, db)!;
    const step01 = vi.fn(async () => {});
    const branchA = vi.fn(async () => {});
    const branchB = vi.fn(async () => {});
    await runPipeline(fresh, makeDeps({ step01, branchA, branchB }));
    expect(step01).not.toHaveBeenCalled();
    expect(branchA).not.toHaveBeenCalled();
    expect(branchB).toHaveBeenCalledTimes(1);
    expect(albumsRepo.get(album.id, db)?.retryBranchOnly).toBeNull();
  });

  it('retry_branch_only is cleared even when the retried branch fails', async () => {
    const album = fakeAlbum();
    albumsRepo.patch(album.id, { retryBranchOnly: 'A' }, db);
    const fresh = albumsRepo.get(album.id, db)!;
    await expect(
      runPipeline(
        fresh,
        makeDeps({
          branchA: vi.fn(async () => {
            throw new Error('still broken');
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(PipelineError);
    expect(albumsRepo.get(album.id, db)?.retryBranchOnly).toBeNull();
  });

  it('runs step01 then step02 sequentially before the parallel fork', async () => {
    const album = fakeAlbum();
    const events: Array<{ name: string; t: number }> = [];
    const record = (name: string) => events.push({ name, t: performance.now() });
    const step01 = vi.fn(async () => {
      record('step01-start');
      await sleep(10);
      record('step01-end');
    });
    const step02 = vi.fn(async () => {
      record('step02-start');
      await sleep(10);
      record('step02-end');
    });
    const branchA = vi.fn(async () => {
      record('branchA-start');
      await sleep(5);
    });
    const branchB = vi.fn(async () => {
      record('branchB-start');
      await sleep(5);
    });
    const step10 = vi.fn(async () => {
      record('step10-start');
    });
    const step03 = vi.fn(async () => {
      record('step03-start');
      await sleep(5);
      record('step03-end');
    });
    const step04 = vi.fn(async () => {
      record('step04-start');
      await sleep(5);
      record('step04-end');
    });
    const step05a = vi.fn(async () => {
      record('step05a-start');
      await sleep(5);
      record('step05a-end');
    });
    const step05b = vi.fn(async () => {
      record('step05b-start');
      await sleep(5);
      record('step05b-end');
    });

    await runPipeline(
      album,
      makeDeps({ step01, step02, step03, step04, step05a, step05b, branchA, branchB, step10 }),
    );

    const idx = (n: string) => events.findIndex((e) => e.name === n);
    // Strict sequencing: step01 fully completes before step02 starts.
    expect(idx('step01-end')).toBeLessThan(idx('step02-start'));
    // step02 -> step03 -> step04 -> step05a -> step05b sequential.
    expect(idx('step02-end')).toBeLessThan(idx('step03-start'));
    expect(idx('step03-end')).toBeLessThan(idx('step04-start'));
    expect(idx('step04-end')).toBeLessThan(idx('step05a-start'));
    expect(idx('step05a-end')).toBeLessThan(idx('step05b-start'));
    // step05b fully completes before either branch starts.
    expect(idx('step05b-end')).toBeLessThan(idx('branchA-start'));
    expect(idx('step05b-end')).toBeLessThan(idx('branchB-start'));
    // Branches start within the same event-loop tick.
    expect(
      Math.abs(events[idx('branchA-start')].t - events[idx('branchB-start')].t),
    ).toBeLessThan(5);
    // step10 runs after both branches.
    expect(idx('step10-start')).toBeGreaterThan(idx('branchA-start'));
    expect(idx('step10-start')).toBeGreaterThan(idx('branchB-start'));
  });
});
