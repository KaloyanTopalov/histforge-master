import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, initSchema, getDbVersion, DB_VERSION, DEFAULT_SETTINGS, type Db } from '@/lib/db';
import { create as createChannel } from '@/lib/repos/channels';
import { create as createAlbum } from '@/lib/repos/albums';
import { insertMany as insertTracks } from '@/lib/repos/tracks';

let db: Db;

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
});

describe('schema', () => {
  it('seeds default settings on init', () => {
    const rows = db.prepare('SELECT key, value FROM settings').all() as Array<{
      key: string;
      value: string;
    }>;
    const map = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      expect(map[k]).toBe(v);
    }
  });

  it('reports the current db version', () => {
    expect(getDbVersion(db)).toBe(DB_VERSION);
  });

  it('initSchema is idempotent', () => {
    expect(() => initSchema(db)).not.toThrow();
    expect(() => initSchema(db)).not.toThrow();
    expect(getDbVersion(db)).toBe(DB_VERSION);
  });

  it('enforces foreign keys on albums.channel_id', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO albums (id, channel_id, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run('A'.repeat(26), 'NONEXISTENT', Date.now(), Date.now()),
    ).toThrow();
  });

  it('enforces foreign keys on tracks.album_id', () => {
    expect(() =>
      db
        .prepare(
          `INSERT INTO tracks (id, album_id, track_number, title, file_name)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('T'.repeat(26), 'NOPE', 1, 'x', 'x.wav'),
    ).toThrow();
  });

  it('rejects duplicate (album_id, track_number) on tracks', () => {
    const channel = createChannel(
      {
        name: 'fk-ch',
        displayName: 'FK Channel',
        description: '',
        scheduleCron: '0 9 * * 1',
        albumBriefTemplate: null,
        trackBriefsTemplate: null,
        coverPromptTemplate: null,
        thumbnailPromptTemplate: null,
        ytMetadataTemplate: null,
        distrokidArtistName: 'A',
        distrokidPrimaryGenre: 'Ambient',
        distrokidLabelName: null,
        youtubeChannelId: null,
        youtubeChannelHandle: null,
        thumbnailOverlayText: null,
        spotifyPlaylistUrl: null,
        hashtags: '',
      },
      db,
    );
    const album = createAlbum({ channelId: channel.id }, db);
    insertTracks(
      [{ albumId: album.id, trackNumber: 1, title: 'T1', fileName: '01 - T1.wav' }],
      db,
    );
    expect(() =>
      insertTracks(
        [{ albumId: album.id, trackNumber: 1, title: 'T1 dup', fileName: '01 - T1 dup.wav' }],
        db,
      ),
    ).toThrow();
  });

  it('inserts ULID-shaped IDs (length 26)', () => {
    const ch = createChannel(
      {
        name: 'ulid-ch',
        displayName: 'X',
        description: '',
        scheduleCron: '0 9 * * 1',
        albumBriefTemplate: null,
        trackBriefsTemplate: null,
        coverPromptTemplate: null,
        thumbnailPromptTemplate: null,
        ytMetadataTemplate: null,
        distrokidArtistName: 'A',
        distrokidPrimaryGenre: 'Ambient',
        distrokidLabelName: null,
        youtubeChannelId: null,
        youtubeChannelHandle: null,
        thumbnailOverlayText: null,
        spotifyPlaylistUrl: null,
        hashtags: '',
      },
      db,
    );
    expect(ch.id).toHaveLength(26);
  });

  it('channels.distrokid_artist_verified_at column exists and defaults null', () => {
    const ch = createChannel(
      {
        name: 'verify-col-ch',
        displayName: 'X',
        description: '',
        scheduleCron: '0 9 * * 1',
        albumBriefTemplate: null,
        trackBriefsTemplate: null,
        coverPromptTemplate: null,
        thumbnailPromptTemplate: null,
        ytMetadataTemplate: null,
        distrokidArtistName: 'A',
        distrokidPrimaryGenre: 'Ambient',
        distrokidLabelName: null,
        youtubeChannelId: null,
        youtubeChannelHandle: null,
        thumbnailOverlayText: null,
        spotifyPlaylistUrl: null,
        hashtags: '',
      },
      db,
    );
    expect(ch.distrokidArtistVerifiedAt).toBeNull();
    const cols = db.prepare("PRAGMA table_info(channels)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('distrokid_artist_verified_at');
  });

  it('albums default distrokid_status=pending and video_status=pending', () => {
    const ch = createChannel(
      {
        name: 'defaults-ch',
        displayName: 'X',
        description: '',
        scheduleCron: '0 9 * * 1',
        albumBriefTemplate: null,
        trackBriefsTemplate: null,
        coverPromptTemplate: null,
        thumbnailPromptTemplate: null,
        ytMetadataTemplate: null,
        distrokidArtistName: 'A',
        distrokidPrimaryGenre: 'Ambient',
        distrokidLabelName: null,
        youtubeChannelId: null,
        youtubeChannelHandle: null,
        thumbnailOverlayText: null,
        spotifyPlaylistUrl: null,
        hashtags: '',
      },
      db,
    );
    const album = createAlbum({ channelId: ch.id }, db);
    expect(album.distrokidStatus).toBe('pending');
    expect(album.videoStatus).toBe('pending');
    expect(album.distrokidSubmittedAt).toBeNull();
    expect(album.safeToUploadAfter).toBeNull();
    expect(album.status).toBe('queued');
  });
});
