import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import { setSetting, getRawSetting } from '@/lib/settings';
import {
  tryAutoResumeAfterBridgeRecovery,
  __resetBridgeRecoveryThrottle,
} from '@/worker/bridge-recovery';

let db: Db;

const channelInput = {
  name: 'br-test-ch',
  displayName: 'Bridge-Recovery Test',
  description: '',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'BR Artist',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: null,
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: '',
};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  __resetBridgeRecoveryThrottle();
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
});

function setPaused(albumId: string, channelId: string, db: Db) {
  albumsRepo.patch(albumId, { status: 'awaiting_suno_relogin' }, db);
  setSetting(
    'suno_bridge_disrupted',
    JSON.stringify({
      albumId,
      channelId,
      code: 'SIDECAR_INTERNAL',
      detail: 'port 9333 unreachable',
      at: Date.now(),
    }),
    db,
  );
}

function makeFetch(mappings: Record<string, { status: number; body?: unknown }>) {
  return async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();
    const path = u.includes('/health')
      ? '/health'
      : u.includes('/credits')
        ? '/credits'
        : u.includes('/json/version')
          ? '/json/version'
          : '?';
    const m = mappings[path];
    if (!m) throw new Error(`fetch not mocked for ${u}`);
    const ok = m.status >= 200 && m.status < 300;
    return {
      ok,
      status: m.status,
      json: async () => m.body ?? {},
    } as Response;
  };
}

describe('tryAutoResumeAfterBridgeRecovery', () => {
  it('no-op when suno_bridge_disrupted flag is empty', async () => {
    const result = await tryAutoResumeAfterBridgeRecovery(db);
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('no-flag');
  });

  it('skipped when cookie-rotation flag is also set (operator must run suno:login)', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    setSetting('suno_cookie_rotated', JSON.stringify({ at: Date.now() }), db);

    const result = await tryAutoResumeAfterBridgeRecovery(db);
    expect(result.attempted).toBe(false);
    expect(result.reason).toBe('cookie-rotation-takes-precedence');
    expect(albumsRepo.get(album.id, db)?.status).toBe('awaiting_suno_relogin');
  });

  it('throttled: rapid probes within 30s window do not hit the bridge', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      throw new Error('should not be called');
    }) as unknown as typeof fetch;

    // First probe lands at t=0 and fires (bridge unreachable below — but we'll
    // throw before reaching fetch since the throttle kicks in on the 2nd).
    const a = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl, nowMs: 0 });
    expect(a.attempted).toBe(true); // first probe attempts (calls fetch)
    expect(calls).toBe(1);

    // Second probe at t=10s should be throttled.
    const b = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl, nowMs: 10_000 });
    expect(b.attempted).toBe(false);
    expect(b.reason).toBe('throttled');
    expect(calls).toBe(1);

    // Third probe at t=31s should fire again.
    const c = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl, nowMs: 31_000 });
    expect(c.attempted).toBe(true);
    expect(calls).toBe(2);
  });

  it('returns bridge-down when /health unreachable', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    const fetchImpl = (async () => {
      throw new Error('connection refused');
    }) as unknown as typeof fetch;

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.attempted).toBe(true);
    expect(result.reason).toBe('bridge-down');
    expect(result.resumed).toBe(0);
    expect(albumsRepo.get(album.id, db)?.status).toBe('awaiting_suno_relogin');
  });

  it('returns sidecar-down when bridge alive but sidecarAlive=false', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    const fetchImpl = makeFetch({
      '/health': { status: 200, body: { sidecarAlive: false } },
    });

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.reason).toBe('sidecar-down');
    expect(albumsRepo.get(album.id, db)?.status).toBe('awaiting_suno_relogin');
  });

  it('returns chrome-down when bridge alive but Chrome CDP unreachable', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    // Bridge + sidecar healthy, but Chrome CDP throws (no /json/version mapping)
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = typeof url === 'string' ? url : url.toString();
      if (u.includes('/health')) {
        return { ok: true, status: 200, json: async () => ({ sidecarAlive: true }) } as Response;
      }
      if (u.includes('/json/version')) {
        throw new Error('connection refused on port 9333');
      }
      throw new Error(`unexpected fetch: ${u}`);
    }) as unknown as typeof fetch;

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.reason).toBe('chrome-down');
    expect(albumsRepo.get(album.id, db)?.status).toBe('awaiting_suno_relogin');
  });

  it('returns auth-down when /credits returns 401 (Chrome alive)', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    const fetchImpl = makeFetch({
      '/health': { status: 200, body: { sidecarAlive: true } },
      '/json/version': { status: 200, body: { Browser: 'Chrome/138' } },
      '/credits': { status: 401, body: { code: 'SUNO_AUTH' } },
    });

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.reason).toBe('auth-down');
    expect(albumsRepo.get(album.id, db)?.status).toBe('awaiting_suno_relogin');
  });

  it('resumes the specific album when bridge + Chrome + auth all healthy', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    setPaused(album.id, ch.id, db);
    const fetchImpl = makeFetch({
      '/health': { status: 200, body: { sidecarAlive: true } },
      '/json/version': { status: 200, body: { Browser: 'Chrome/138' } },
      '/credits': { status: 200, body: { credits: 100 } },
    });

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.attempted).toBe(true);
    expect(result.reason).toBe('resumed');
    expect(result.resumed).toBe(1);
    expect(albumsRepo.get(album.id, db)?.status).toBe('queued');
    expect(getRawSetting('suno_bridge_disrupted', db)).toBe('');
  });

  it('clears stale flag when album no longer awaiting (operator already resumed)', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    // Flag is set but album was manually re-queued before this probe.
    setSetting(
      'suno_bridge_disrupted',
      JSON.stringify({ albumId: album.id, channelId: ch.id, at: Date.now() }),
      db,
    );
    const fetchImpl = makeFetch({
      '/health': { status: 200, body: { sidecarAlive: true } },
      '/json/version': { status: 200, body: { Browser: 'Chrome/138' } },
      '/credits': { status: 200, body: { credits: 100 } },
    });

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.reason).toBe('flag-stale-cleared');
    expect(getRawSetting('suno_bridge_disrupted', db)).toBe('');
  });

  it('clears malformed flag and re-queues any orphaned awaiting_suno_relogin album', async () => {
    const ch = channelsRepo.create(channelInput, db);
    const album = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.patch(album.id, { status: 'awaiting_suno_relogin' }, db);
    setSetting('suno_bridge_disrupted', '{ malformed', db);
    const fetchImpl = makeFetch({
      '/health': { status: 200, body: { sidecarAlive: true } },
      '/json/version': { status: 200, body: { Browser: 'Chrome/138' } },
      '/credits': { status: 200, body: { credits: 100 } },
    });

    const result = await tryAutoResumeAfterBridgeRecovery(db, { fetchImpl });
    expect(result.reason).toBe('malformed-flag-cleared');
    expect(getRawSetting('suno_bridge_disrupted', db)).toBe('');
    // Without the orphan sweep, the album would be stranded in
    // awaiting_suno_relogin with no flag pointing to it.
    expect(albumsRepo.get(album.id, db)?.status).toBe('queued');
    expect(result.resumed).toBe(1);
  });
});
