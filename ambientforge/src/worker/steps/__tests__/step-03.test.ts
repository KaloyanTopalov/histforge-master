import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import * as sunoPromptsRepo from '@/lib/repos/channel-suno-prompts';
import { setSetting, getRawSetting } from '@/lib/settings';
import {
  __resetMockSunoState,
  makeMockSunoClient,
  SunoError,
  type SunoClient,
} from '@/lib/suno/client';
import { step03Internal } from '@/worker/steps/03-suno-generate';

let db: Db;

const baseChannel = {
  name: 'step03-test-ch',
  displayName: 'Step03 Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Step03 Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

function seed30Tracks(albumId: string) {
  const inputs = Array.from({ length: 30 }, (_, i) => ({
    albumId,
    trackNumber: i + 1,
    title: `Track ${i + 1}`,
    fileName: `${String(i + 1).padStart(2, '0')} - Track ${i + 1}.wav`,
    sunoLyrics: `lyrics ${i + 1}`,
  }));
  return tracksRepo.insertMany(inputs);
}

function setupAlbum(): { albumId: string } {
  const channel = channelsRepo.create({ ...baseChannel, active: true });
  const album = albumsRepo.create({ channelId: channel.id });
  albumsRepo.patch(album.id, {
    albumTitle: 'Test Album',
    artistName: 'Step03 Artist',
    sunoStylePrompt: 'ambient drift',
    primaryGenre: 'Ambient',
  });
  seed30Tracks(album.id);
  return { albumId: album.id };
}

/**
 * Setup variant for tests that exercise the v8 per-track rotation: creates a
 * channel with N active prompts in the collection and an album that has NO
 * legacy sunoStylePrompt set (so selectSunoPromptRotation hits the fresh
 * round-robin branch instead of the v7-compat in-flight path).
 */
function setupAlbumWithRotation(promptCount = 3): { albumId: string; channelId: string } {
  const channel = channelsRepo.create({ ...baseChannel, active: true });
  for (let i = 0; i < promptCount; i++) {
    sunoPromptsRepo.create(
      {
        channelId: channel.id,
        label: `style-${i + 1}`,
        content: `style ${i + 1} content for rotation testing`,
        active: true,
      },
      db,
    );
  }
  const album = albumsRepo.create({ channelId: channel.id });
  albumsRepo.patch(album.id, {
    albumTitle: 'Test Album',
    artistName: 'Step03 Artist',
    primaryGenre: 'Ambient',
  });
  seed30Tracks(album.id);
  return { albumId: album.id, channelId: channel.id };
}

const noopLog = (_stage: string, _msg: string) => {};
const fastOpts = { submitDelayMs: 0, retryDelayMs: 0 };

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetMockSunoState();
});

afterEach(() => {
  __setDbForTests(null);
  __resetMockSunoState();
});

describe('step03SunoGenerate', () => {
  it('happy path: 30 tracks all submitted, sunoTaskId populated, status=submitted', async () => {
    const { albumId } = setupAlbum();
    setSetting('suno_mock_credits', '100', db);
    const client = makeMockSunoClient();

    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);

    const tracks = tracksRepo.listByAlbum(albumId);
    expect(tracks).toHaveLength(30);
    for (const t of tracks) {
      expect(t.sunoTaskId).toMatch(/^mock-task-\d{4}$/);
      expect(t.status).toBe('submitted');
    }
    // Pre-flight cleared the insufficient flag.
    expect(getRawSetting('suno_insufficient_credits', db) ?? '').toBe('');
  });

  it('insufficient credits: throws INSUFFICIENT_SUNO_CREDITS, no submits, sets settings flag', async () => {
    const { albumId } = setupAlbum();
    setSetting('suno_mock_credits', '10', db);
    const client = makeMockSunoClient();

    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SUNO_CREDITS' });

    const tracks = tracksRepo.listByAlbum(albumId);
    expect(tracks.every((t) => t.sunoTaskId === null)).toBe(true);
    expect(tracks.every((t) => t.status === 'pending')).toBe(true);
    const flag = JSON.parse(getRawSetting('suno_insufficient_credits', db) || '{}');
    expect(flag.credits).toBe(10);
    expect(flag.required).toBe(30);
    expect(flag.albumId).toBe(albumId);
  });

  it('resume: skips tracks with existing sunoTaskId, submits the rest', async () => {
    const { albumId } = setupAlbum();
    setSetting('suno_mock_credits', '100', db);
    // Pre-populate first 5 tracks with sunoTaskIds (simulating crash mid-step-03).
    const tracks = tracksRepo.listByAlbum(albumId);
    for (let i = 0; i < 5; i++) {
      tracksRepo.patch(tracks[i].id, {
        sunoTaskId: `pre-existing-${i + 1}`,
        status: 'submitted',
      });
    }
    const client = makeMockSunoClient();

    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);

    const after = tracksRepo.listByAlbum(albumId);
    // First 5 unchanged.
    for (let i = 0; i < 5; i++) {
      expect(after[i].sunoTaskId).toBe(`pre-existing-${i + 1}`);
    }
    // Remaining 25 submitted (mock counter started at 0).
    for (let i = 5; i < 30; i++) {
      expect(after[i].sunoTaskId).toMatch(/^mock-task-\d{4}$/);
      expect(after[i].status).toBe('submitted');
    }
  });

  it('per-track retriable failure: retries once, fails track, continues with the rest', async () => {
    const { albumId } = setupAlbum();
    setSetting('suno_mock_credits', '100', db);
    const inner = makeMockSunoClient();
    let track7Attempts = 0;
    // Fail track 7 (the 7th submission) twice, succeed on all others.
    const client: SunoClient = {
      ...inner,
      submit: async (opts) => {
        // Mock submits in order; we count by which call index this is by lyrics suffix.
        const isTrack7 = opts.lyrics === 'lyrics 7';
        if (isTrack7) {
          track7Attempts++;
          throw new SunoError('SUNO_RATE_LIMITED', 'simulated 429', true, 429);
        }
        return inner.submit(opts);
      },
    };

    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);

    const after = tracksRepo.listByAlbum(albumId);
    expect(track7Attempts).toBe(2); // initial + 1 retry
    const t7 = after.find((t) => t.trackNumber === 7)!;
    expect(t7.status).toBe('failed');
    expect(t7.sunoTaskId).toBeNull();
    // Tracks 1-6 and 8-30 all submitted.
    for (const t of after) {
      if (t.trackNumber === 7) continue;
      expect(t.status).toBe('submitted');
      expect(t.sunoTaskId).toMatch(/^mock-task-\d{4}$/);
    }
  });

  it('non-retriable per-track error fails the track immediately (no retry)', async () => {
    const { albumId } = setupAlbum();
    setSetting('suno_mock_credits', '100', db);
    const inner = makeMockSunoClient();
    let track3Attempts = 0;
    const client: SunoClient = {
      ...inner,
      submit: async (opts) => {
        if (opts.lyrics === 'lyrics 3') {
          track3Attempts++;
          throw new SunoError('SUNO_AUTH', 'simulated 401', false, 401);
        }
        return inner.submit(opts);
      },
    };

    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);

    expect(track3Attempts).toBe(1); // no retry on non-retriable
    const after = tracksRepo.listByAlbum(albumId);
    const t3 = after.find((t) => t.trackNumber === 3)!;
    expect(t3.status).toBe('failed');
  });

  it('noop when all tracks already have sunoTaskId', async () => {
    const { albumId } = setupAlbum();
    setSetting('suno_mock_credits', '100', db);
    const tracks = tracksRepo.listByAlbum(albumId);
    for (const t of tracks) {
      tracksRepo.patch(t.id, { sunoTaskId: `pre-${t.trackNumber}`, status: 'submitted' });
    }
    const client = makeMockSunoClient();
    let credCalls = 0;
    const wrapped: SunoClient = {
      ...client,
      getCredits: async () => {
        credCalls++;
        return 999;
      },
    };

    await step03Internal(albumsRepo.get(albumId)!, noopLog, wrapped, fastOpts);

    expect(credCalls).toBe(0); // noop short-circuits before pre-flight
    const after = tracksRepo.listByAlbum(albumId);
    expect(after.every((t) => t.sunoTaskId?.startsWith('pre-'))).toBe(true);
  });

  it('bridge disrupted mid-album: pauses album, leaves remaining tracks pending, sets settings flag', async () => {
    const { albumId } = setupAlbumWithRotation();
    setSetting('suno_mock_credits', '100', db);
    const inner = makeMockSunoClient();
    // Succeed for the first 5, then start failing with SIDECAR_INTERNAL.
    let submitCount = 0;
    const client: SunoClient = {
      ...inner,
      submit: async (opts) => {
        submitCount++;
        if (submitCount > 5) {
          throw new SunoError(
            'SIDECAR_INTERNAL',
            "bridge responded 502: ConnectionError: HTTPConnectionPool(host='127.0.0.1', port=9333)",
            true,
            502,
          );
        }
        return inner.submit(opts);
      },
    };

    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).rejects.toMatchObject({ code: 'SIDECAR_INTERNAL' });

    // Album was paused, not failed.
    const album = albumsRepo.get(albumId)!;
    expect(album.status).toBe('awaiting_suno_relogin');

    // Settings flag set with diagnostic info.
    const flag = JSON.parse(getRawSetting('suno_bridge_disrupted', db) || '{}');
    expect(flag.albumId).toBe(albumId);
    expect(flag.code).toBe('SIDECAR_INTERNAL');
    expect(flag.detail).toContain('port=9333');

    // First 5 tracks submitted, remaining 25 stayed pending — NOT marked failed.
    const after = tracksRepo.listByAlbum(albumId);
    const submitted = after.filter((t) => t.sunoTaskId !== null);
    const pending = after.filter((t) => t.sunoTaskId === null);
    expect(submitted).toHaveLength(5);
    expect(pending).toHaveLength(25);
    for (const t of pending) {
      expect(t.status).toBe('pending');
      expect(t.sunoPromptId).not.toBeNull(); // rotation locked in for all tracks
    }
  });

  it('bridge disrupted on FIRST track: still pauses cleanly, no submissions', async () => {
    const { albumId } = setupAlbumWithRotation();
    setSetting('suno_mock_credits', '100', db);
    const inner = makeMockSunoClient();
    const client: SunoClient = {
      ...inner,
      submit: async () => {
        throw new SunoError('SUNO_BRIDGE_UNREACHABLE', 'fetch failed', true);
      },
    };

    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).rejects.toMatchObject({ code: 'SUNO_BRIDGE_UNREACHABLE' });

    expect(albumsRepo.get(albumId)!.status).toBe('awaiting_suno_relogin');
    const after = tracksRepo.listByAlbum(albumId);
    expect(after.every((t) => t.sunoTaskId === null && t.status === 'pending')).toBe(true);
  });

  it('resume after bridge disruption: re-running step 03 picks up exactly the unsubmitted tracks', async () => {
    const { albumId } = setupAlbumWithRotation();
    setSetting('suno_mock_credits', '100', db);
    const inner = makeMockSunoClient();
    let submitCount = 0;
    let bridgeUp = false;
    const client: SunoClient = {
      ...inner,
      submit: async (opts) => {
        submitCount++;
        if (!bridgeUp && submitCount > 5) {
          throw new SunoError('SIDECAR_INTERNAL', 'bridge down', true, 502);
        }
        return inner.submit(opts);
      },
    };

    // First run: fails after 5 submissions
    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).rejects.toMatchObject({ code: 'SIDECAR_INTERNAL' });
    expect(tracksRepo.listByAlbum(albumId).filter((t) => t.sunoTaskId).length).toBe(5);

    // Operator resumes: clear flag + bring bridge up + re-queue
    setSetting('suno_bridge_disrupted', '', db);
    albumsRepo.patch(albumId, { status: 'queued' }, db);
    bridgeUp = true;
    submitCount = 0;

    // Second run: picks up the remaining 25
    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);
    const after = tracksRepo.listByAlbum(albumId);
    expect(after.filter((t) => t.sunoTaskId).length).toBe(30);
    expect(after.every((t) => t.status === 'submitted')).toBe(true);
  });

  it('resume with partial submissions still respects credit threshold (required = pending only)', async () => {
    const { albumId } = setupAlbum();
    // 25 already submitted, 5 pending, only 4 credits available -> should fail (4 < 5).
    const tracks = tracksRepo.listByAlbum(albumId);
    for (let i = 0; i < 25; i++) {
      tracksRepo.patch(tracks[i].id, { sunoTaskId: `pre-${i}`, status: 'submitted' });
    }
    setSetting('suno_mock_credits', '4', db);
    const client = makeMockSunoClient();

    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SUNO_CREDITS' });

    // 5 credits would have sufficed.
    setSetting('suno_mock_credits', '5', db);
    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).resolves.not.toThrow();
  });
});

describe('step03 suno-dual-variant (per-channel)', () => {
  function setupDualAlbum(promptCount: number): { albumId: string } {
    const channel = channelsRepo.create({ ...baseChannel, active: true });
    channelsRepo.patch(channel.id, { sunoDualVariant: true }, db);
    for (let i = 0; i < promptCount; i++) {
      sunoPromptsRepo.create(
        {
          channelId: channel.id,
          label: `dual-${i + 1}`,
          content: `dual style ${i + 1}`,
          active: true,
        },
        db,
      );
    }
    const album = albumsRepo.create({ channelId: channel.id });
    albumsRepo.patch(album.id, {
      albumTitle: 'Dual',
      artistName: 'A',
      primaryGenre: 'Ambient',
    });
    seed30Tracks(album.id);
    setSetting('suno_mock_credits', '100', db);
    return { albumId: album.id };
  }

  it('30 tracks → 15 generations: pairs share taskId+style, clip indices 0/1', async () => {
    const { albumId } = setupDualAlbum(3);
    const client = makeMockSunoClient();

    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);

    const tracks = tracksRepo.listByAlbum(albumId); // ORDER BY track_number ASC
    expect(tracks).toHaveLength(30);
    for (const t of tracks) expect(t.status).toBe('submitted');
    // The whole point: 30 tracks but only 15 distinct Suno generations.
    expect(new Set(tracks.map((t) => t.sunoTaskId)).size).toBe(15);
    for (let i = 0; i < 30; i += 2) {
      const a = tracks[i];
      const b = tracks[i + 1];
      expect(a.sunoTaskId).toBe(b.sunoTaskId);
      expect(a.sunoTaskId).toMatch(/^mock-task-\d{4}$/);
      expect(a.sunoClipIndex).toBe(0);
      expect(b.sunoClipIndex).toBe(1);
      expect(a.sunoPromptId).toBeTruthy();
      expect(a.sunoPromptId).toBe(b.sunoPromptId);
      expect(a.sunoPromptResolvedText).toBe(b.sunoPromptResolvedText);
    }
    // 3 active prompts round-robin across 15 pairs → 3 distinct styles.
    expect(new Set(tracks.map((t) => t.sunoPromptId)).size).toBe(3);
    expect(getRawSetting('suno_insufficient_credits', db) ?? '').toBe('');
  });

  it('idempotent resume: a fully-submitted dual album re-runs as noop', async () => {
    const { albumId } = setupDualAlbum(2);
    const client = makeMockSunoClient();

    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);
    const first = tracksRepo.listByAlbum(albumId).map((t) => t.sunoTaskId);
    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);
    const second = tracksRepo.listByAlbum(albumId).map((t) => t.sunoTaskId);

    expect(second).toEqual(first); // no re-submission, taskIds stable
    expect(new Set(second).size).toBe(15);
  });

  it('credit gate counts generations (pairs), not tracks: 15 needed for 30', async () => {
    const { albumId } = setupDualAlbum(1);
    setSetting('suno_mock_credits', '14', db); // 14 < 15 pairs → fail
    const client = makeMockSunoClient();
    await expect(
      step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_SUNO_CREDITS' });

    setSetting('suno_mock_credits', '15', db); // exactly 15 → succeeds
    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);
    expect(new Set(tracksRepo.listByAlbum(albumId).map((t) => t.sunoTaskId)).size).toBe(15);
  });

  it('half-submitted pair: WARNs, skips the orphan, never double-bills', async () => {
    const { albumId } = setupDualAlbum(2);
    const client = makeMockSunoClient();
    await step03Internal(albumsRepo.get(albumId)!, noopLog, client, fastOpts);
    expect(
      new Set(tracksRepo.listByAlbum(albumId).map((t) => t.sunoTaskId)).size,
    ).toBe(15);

    // Force a half-pair: clear the 2nd track of pair 0 (simulates a hard-kill
    // / manual edit — the atomic commit never produces this on its own).
    const tracks = tracksRepo.listByAlbum(albumId); // trackNumber ASC
    const orphan = tracks[1]; // pair 0 = tracks[0] + tracks[1]
    const partnerTaskId = tracks[0].sunoTaskId;
    tracksRepo.patch(orphan.id, { sunoTaskId: null, status: 'pending' });

    const logs: string[] = [];
    const capLog = (stage: string, msg: string) => {
      logs.push(`${stage} ${msg}`);
    };
    await step03Internal(albumsRepo.get(albumId)!, capLog, client, fastOpts);

    const warn = logs.find((l) => l.includes('WARN') && l.includes('half-submitted'));
    expect(warn).toBeTruthy();
    expect(warn).toContain('pair=0');
    expect(warn).toContain(`orphan=track${orphan.trackNumber}`);

    // Conservative: orphan NOT re-submitted, partner intact, no new task.
    const afterTracks = tracksRepo.listByAlbum(albumId);
    expect(afterTracks.find((t) => t.id === orphan.id)!.sunoTaskId).toBeNull();
    expect(afterTracks.find((t) => t.id === tracks[0].id)!.sunoTaskId).toBe(
      partnerTaskId,
    );
    expect(
      new Set(afterTracks.map((t) => t.sunoTaskId).filter(Boolean)).size,
    ).toBe(15);
  });
});
