import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, initSchema, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import * as statsRepo from '@/lib/repos/channelStats';
import * as settingsRepo from '@/lib/repos/settings';
import * as sessionsRepo from '@/lib/repos/sessions';

let db: Db;

const channelInput = {
  name: 'sad-ambient',
  displayName: "i'm crying",
  description: 'Niche test',
  scheduleCron: '0 9 * * 1',
  albumBriefTemplate: null,
  trackBriefsTemplate: null,
  coverPromptTemplate: null,
  thumbnailPromptTemplate: null,
  ytMetadataTemplate: null,
  distrokidArtistName: 'Songs For Cry',
  distrokidPrimaryGenre: 'Ambient',
  distrokidLabelName: null,
  youtubeChannelId: null,
  youtubeChannelHandle: '@songsforcry',
  thumbnailOverlayText: null,
  spotifyPlaylistUrl: null,
  hashtags: 'ambient,sleep',
};

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
});

describe('repos/channels', () => {
  it('creates and reads back a channel', () => {
    const created = channelsRepo.create(channelInput, db);
    const fetched = channelsRepo.get(created.id, db);
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('sad-ambient');
    expect(fetched!.displayName).toBe("i'm crying");
    expect(fetched!.active).toBe(true);
    expect(fetched!.youtubeChannelHandle).toBe('@songsforcry');
  });

  it('lookup by name', () => {
    channelsRepo.create(channelInput, db);
    const fetched = channelsRepo.getByName('sad-ambient', db);
    expect(fetched?.distrokidArtistName).toBe('Songs For Cry');
  });

  it('list filters by active', () => {
    const a = channelsRepo.create(channelInput, db);
    channelsRepo.create({ ...channelInput, name: 'lofi-study' }, db);
    channelsRepo.softDelete(a.id, db);
    expect(channelsRepo.list({}, db)).toHaveLength(2);
    expect(channelsRepo.list({ activeOnly: true }, db)).toHaveLength(1);
  });

  it('patch updates fields and bumps updated_at', async () => {
    const c = channelsRepo.create(channelInput, db);
    await new Promise((r) => setTimeout(r, 5));
    const patched = channelsRepo.patch(c.id, { displayName: 'sobbing' }, db);
    expect(patched!.displayName).toBe('sobbing');
    expect(patched!.updatedAt).toBeGreaterThanOrEqual(c.updatedAt);
  });

  it('softDelete sets active=false but preserves the row', () => {
    const c = channelsRepo.create(channelInput, db);
    channelsRepo.softDelete(c.id, db);
    const after = channelsRepo.get(c.id, db);
    expect(after).not.toBeNull();
    expect(after!.active).toBe(false);
  });

  it('rejects duplicate channel names', () => {
    channelsRepo.create(channelInput, db);
    expect(() => channelsRepo.create(channelInput, db)).toThrow();
  });

  it('defaults v9 sceneThemes and seedanceMotionPrompt to null on create', () => {
    const c = channelsRepo.create(channelInput, db);
    expect(c.sceneThemes).toBeNull();
    expect(c.seedanceMotionPrompt).toBeNull();
  });

  it('creates with v9 scene fields when provided in ChannelInput', () => {
    const themes = JSON.stringify([
      'knight by campfire at night',
      'knight resting by river at dusk',
    ]);
    const c = channelsRepo.create(
      {
        ...channelInput,
        name: 'medieval-ambient',
        sceneThemes: themes,
        seedanceMotionPrompt: 'static camera, embers float, knight still',
      },
      db,
    );
    expect(c.sceneThemes).toBe(themes);
    expect(c.seedanceMotionPrompt).toBe('static camera, embers float, knight still');

    const fetched = channelsRepo.get(c.id, db);
    expect(fetched!.sceneThemes).toBe(themes);
    expect(fetched!.seedanceMotionPrompt).toBe('static camera, embers float, knight still');
  });

  it('round-trips v9 scene fields via patch (non-null + back to null)', () => {
    const c = channelsRepo.create(channelInput, db);
    const filled = channelsRepo.patch(
      c.id,
      {
        sceneThemes: '["knight in ancient ruins at twilight"]',
        seedanceMotionPrompt: 'fireflies drift, leaves sway',
      },
      db,
    );
    expect(filled!.sceneThemes).toBe('["knight in ancient ruins at twilight"]');
    expect(filled!.seedanceMotionPrompt).toBe('fireflies drift, leaves sway');

    const cleared = channelsRepo.patch(
      c.id,
      { sceneThemes: null, seedanceMotionPrompt: null },
      db,
    );
    expect(cleared!.sceneThemes).toBeNull();
    expect(cleared!.seedanceMotionPrompt).toBeNull();
  });
});

describe('repos/albums', () => {
  it('creates with sane defaults and copies the artist name', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create(
      { channelId: ch.id, artistName: ch.distrokidArtistName },
      db,
    );
    expect(a.status).toBe('queued');
    expect(a.distrokidStatus).toBe('pending');
    expect(a.videoStatus).toBe('pending');
    expect(a.artistName).toBe('Songs For Cry');
    expect(a.distrokidSubmittedAt).toBeNull();
    expect(a.safeToUploadAfter).toBeNull();
  });

  it('hasInProgress detects globally', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    expect(albumsRepo.hasInProgress(db)).toBe(false);
    albumsRepo.patch(a.id, { status: 'in_progress' }, db);
    expect(albumsRepo.hasInProgress(db)).toBe(true);
  });

  it('hasOpenForChannel returns true while album is queued/in_progress/awaiting_captcha', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    expect(albumsRepo.hasOpenForChannel(ch.id, db)).toBe(true);
    albumsRepo.patch(a.id, { status: 'done' }, db);
    expect(albumsRepo.hasOpenForChannel(ch.id, db)).toBe(false);
  });

  it('nextQueued returns oldest queued album', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    albumsRepo.create({ channelId: ch.id }, db);
    const next = albumsRepo.nextQueued(db);
    expect(next?.id).toBe(a.id);
  });

  it('defaults v9 scene_* fields to null on create', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    expect(a.sceneImagePrompt).toBeNull();
    expect(a.sceneSeedancePrompt).toBeNull();
    expect(a.sceneTitle).toBeNull();
  });

  it('round-trips v9 scene_* fields via patch (non-null + back to null)', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);

    const filled = albumsRepo.patch(
      a.id,
      {
        sceneImagePrompt: 'knight by campfire, ghibli illustration --ar 16:9 --niji 6',
        sceneSeedancePrompt: 'static camera, embers float, knight still',
        sceneTitle: "The Knight's Quiet Fire | Medieval Music for Sleep & Calm",
      },
      db,
    );
    expect(filled!.sceneImagePrompt).toBe(
      'knight by campfire, ghibli illustration --ar 16:9 --niji 6',
    );
    expect(filled!.sceneSeedancePrompt).toBe('static camera, embers float, knight still');
    expect(filled!.sceneTitle).toBe(
      "The Knight's Quiet Fire | Medieval Music for Sleep & Calm",
    );

    const cleared = albumsRepo.patch(
      a.id,
      { sceneImagePrompt: null, sceneSeedancePrompt: null, sceneTitle: null },
      db,
    );
    expect(cleared!.sceneImagePrompt).toBeNull();
    expect(cleared!.sceneSeedancePrompt).toBeNull();
    expect(cleared!.sceneTitle).toBeNull();
  });

  it('records Content-ID hold timestamps via patch', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    const submittedAt = Date.now();
    const safeAfter = submittedAt + 14 * 86_400_000;
    const updated = albumsRepo.patch(
      a.id,
      {
        distrokidStatus: 'dryrun',
        distrokidSubmittedAt: submittedAt,
        safeToUploadAfter: safeAfter,
      },
      db,
    );
    expect(updated!.distrokidStatus).toBe('dryrun');
    expect(updated!.distrokidSubmittedAt).toBe(submittedAt);
    expect(updated!.safeToUploadAfter).toBe(safeAfter);
  });
});

describe('repos/tracks', () => {
  it('inserts 30 tracks atomically', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    const inputs = Array.from({ length: 30 }, (_, i) => ({
      albumId: a.id,
      trackNumber: i + 1,
      title: `Track ${i + 1}`,
      fileName: `${String(i + 1).padStart(2, '0')} - Track ${i + 1}.wav`,
    }));
    tracksRepo.insertMany(inputs, db);
    const list = tracksRepo.listByAlbum(a.id, db);
    expect(list).toHaveLength(30);
    expect(list[0].trackNumber).toBe(1);
    expect(list[29].trackNumber).toBe(30);
  });

  it('patch updates suno fields', () => {
    const ch = channelsRepo.create(channelInput, db);
    const a = albumsRepo.create({ channelId: ch.id }, db);
    tracksRepo.insertMany(
      [{ albumId: a.id, trackNumber: 1, title: 'X', fileName: '01 - X.wav' }],
      db,
    );
    const t = tracksRepo.listByAlbum(a.id, db)[0];
    const updated = tracksRepo.patch(t.id, { sunoTaskId: 'sno_abc', status: 'submitted' }, db);
    expect(updated!.sunoTaskId).toBe('sno_abc');
    expect(updated!.status).toBe('submitted');
  });
});

describe('repos/channelStats', () => {
  it('insertSnapshot + listByChannel returns snapshots in time order', () => {
    const ch = channelsRepo.create(channelInput, db);
    const t = Date.now();
    statsRepo.insertSnapshot(
      { channelId: ch.id, fetchedAt: t, subscriberCount: 100, totalViews: 1000, videoCount: 5 },
      db,
    );
    statsRepo.insertSnapshot(
      {
        channelId: ch.id,
        fetchedAt: t + 86_400_000,
        subscriberCount: 110,
        totalViews: 1100,
        videoCount: 6,
      },
      db,
    );
    const rows = statsRepo.listByChannel(ch.id, {}, db);
    expect(rows).toHaveLength(2);
    expect(rows[0].fetchedAt).toBeLessThan(rows[1].fetchedAt);
    expect(statsRepo.latestForChannel(ch.id, db)?.subscriberCount).toBe(110);
  });
});

describe('repos/settings', () => {
  it('getRaw / setRaw round-trip', () => {
    settingsRepo.setRaw('queue_state', 'running', db);
    expect(settingsRepo.getRaw('queue_state', db)).toBe('running');
  });

  it('getAllRaw includes seeded defaults', () => {
    const all = settingsRepo.getAllRaw(db);
    expect(all.content_id_hold_days).toBe('14');
    expect(all.distrokid_dry_run).toBe('true');
  });
});

describe('repos/sessions', () => {
  it('upsert + get + listAll', () => {
    sessionsRepo.upsert('suno', 'valid', 12345, db);
    sessionsRepo.upsert('distrokid', 'expired', 67890, db);
    expect(sessionsRepo.get('suno', db)?.status).toBe('valid');
    expect(sessionsRepo.listAll(db)).toHaveLength(2);
  });

  it('upsert overwrites status', () => {
    sessionsRepo.upsert('suno', 'valid', 1, db);
    sessionsRepo.upsert('suno', 'expired', 2, db);
    expect(sessionsRepo.get('suno', db)?.status).toBe('expired');
  });
});
