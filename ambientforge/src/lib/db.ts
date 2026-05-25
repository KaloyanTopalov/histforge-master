import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { ulid } from 'ulid';

export const DB_VERSION = 11;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  schedule_cron TEXT NOT NULL,
  album_brief_template TEXT,
  track_briefs_template TEXT,
  cover_prompt_template TEXT,
  thumbnail_prompt_template TEXT,
  yt_metadata_template TEXT,
  distrokid_artist_name TEXT NOT NULL,
  distrokid_primary_genre TEXT NOT NULL,
  distrokid_label_name TEXT,
  youtube_channel_id TEXT,
  youtube_channel_handle TEXT,
  thumbnail_overlay_text TEXT,
  spotify_playlist_url TEXT,
  hashtags TEXT NOT NULL DEFAULT '',
  distrokid_artist_verified_at INTEGER,
  suno_model TEXT NOT NULL DEFAULT 'chirp-fenix',
  suno_mode TEXT NOT NULL DEFAULT 'custom',
  suno_instrumental INTEGER NOT NULL DEFAULT 0,
  suno_persona_id TEXT,
  workflow TEXT NOT NULL DEFAULT 'ambient',
  tracks_per_album INTEGER,
  target_video_seconds INTEGER,
  broll_folder_path TEXT,
  suno_style_prompt TEXT,
  prompt_album_brief TEXT,
  prompt_track_briefs TEXT,
  prompt_cover_image TEXT,
  prompt_thumbnail TEXT,
  prompt_yt_metadata TEXT,
  youtube_image_aspect TEXT,
  distrokid_songwriter_name TEXT,
  distrokid_performer_name TEXT,
  distrokid_performer_role TEXT,
  distrokid_producer_name TEXT,
  distrokid_producer_role TEXT,
  rap_clip_strategy TEXT,
  scene_themes TEXT,
  seedance_motion_prompt TEXT,
  image_style_name TEXT,
  suno_dual_variant INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  status TEXT NOT NULL DEFAULT 'new',
  theme_prompt TEXT,
  album_title TEXT NOT NULL DEFAULT '',
  artist_name TEXT NOT NULL DEFAULT '',
  primary_genre TEXT NOT NULL DEFAULT '',
  suno_style_prompt TEXT NOT NULL DEFAULT '',
  cover_image_path TEXT,
  thumbnail_path TEXT,
  yt_image_path TEXT,
  tracklist_text TEXT,
  yt_title TEXT,
  yt_description TEXT,
  yt_tags TEXT,
  distrokid_release_id TEXT,
  distrokid_dry_run_artifact TEXT,
  distrokid_submitted_at INTEGER,
  safe_to_upload_after INTEGER,
  distrokid_status TEXT NOT NULL DEFAULT 'pending',
  video_status TEXT NOT NULL DEFAULT 'pending',
  video_progress_pct INTEGER NOT NULL DEFAULT 0,
  retry_branch_only TEXT,
  final_video_path TEXT,
  uploaded_at INTEGER,
  youtube_video_id TEXT,
  suno_model TEXT,
  suno_mode TEXT,
  suno_instrumental INTEGER,
  suno_persona_id TEXT,
  workflow TEXT NOT NULL DEFAULT 'ambient',
  last_error TEXT,
  suno_prompt_id TEXT,
  suno_prompt_resolved_text TEXT,
  scene_image_prompt TEXT,
  scene_seedance_prompt TEXT,
  scene_title TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_albums_channel ON albums(channel_id);
CREATE INDEX IF NOT EXISTS idx_albums_status ON albums(status);

CREATE TABLE IF NOT EXISTS tracks (
  id TEXT PRIMARY KEY,
  album_id TEXT NOT NULL REFERENCES albums(id),
  track_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  duration REAL NOT NULL DEFAULT 0,
  suno_task_id TEXT,
  suno_lyrics TEXT,
  audio_path TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  suno_prompt_id TEXT,
  suno_prompt_resolved_text TEXT,
  suno_clip_index INTEGER,
  UNIQUE (album_id, track_number)
);
CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album_id);

CREATE TABLE IF NOT EXISTS channel_stats (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  fetched_at INTEGER NOT NULL,
  subscriber_count INTEGER NOT NULL,
  total_views INTEGER NOT NULL,
  video_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_stats_channel_fetched ON channel_stats(channel_id, fetched_at);

CREATE TABLE IF NOT EXISTS channel_suno_prompts (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id),
  label TEXT NOT NULL,
  content TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_channel_suno_prompts_channel ON channel_suno_prompts(channel_id, active);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  service TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  last_checked INTEGER NOT NULL
);
`;

export const DEFAULT_SETTINGS: Record<string, string> = {
  db_version: String(DB_VERSION),
  queue_state: 'paused',
  scheduler_enabled: 'false',
  openrouter_api_key: '',
  model_name: 'anthropic/claude-haiku-4.5',
  distrokid_dry_run: 'true',
  target_video_seconds: '7200',
  cover_resample_threshold_mb: '9.5',
  youtube_image_aspect: 'letterbox',
  suno_max_concurrent: '1',
  suno_poll_interval_ms: '15000',
  suno_poll_timeout_ms: '600000',
  suno_mock_credits: '100',
  suno_insufficient_credits: '',
  nvenc_enabled: 'auto',
  stats_fetch_hour_utc: '3',
  content_id_hold_days: '14',
  keep_raw_audio_after_done: 'false',
  distrokid_artist_missing: '',
  distrokid_captcha_pending: '',
  distrokid_live_mode_blocked_at: '',
  force_branch_b_failure_for_album: '',
  tracks_per_album_override: '0',
};

export type Db = Database.Database;

let cached: Db | null = null;

export function defaultDbPath(): string {
  return process.env.AMBIENTFORGE_DB_PATH ?? path.join(process.cwd(), 'data', 'ambientforge.db');
}

export function openDb(dbPath?: string): Db {
  const target = dbPath ?? defaultDbPath();
  if (target !== ':memory:') {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  }
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

function runMigrations(db: Db): void {
  // Older dev DBs (DB_VERSION=1) lack channels.distrokid_artist_verified_at — fresh
  // SCHEMA_SQL already declares it, so the ALTER is only relevant on existing DBs.
  // SQLite has no ADD COLUMN IF NOT EXISTS — swallow the duplicate-column error.
  const addColumn = (sql: string) => {
    try {
      db.exec(sql);
    } catch (err) {
      if (!String(err).includes('duplicate column name')) throw err;
    }
  };
  addColumn('ALTER TABLE channels ADD COLUMN distrokid_artist_verified_at INTEGER');
  // v3: Branch-B render progress + per-branch retry flag.
  addColumn('ALTER TABLE albums ADD COLUMN video_progress_pct INTEGER NOT NULL DEFAULT 0');
  addColumn('ALTER TABLE albums ADD COLUMN retry_branch_only TEXT');
  // v4: per-channel + per-album Suno config (model, mode, instrumental, persona).
  addColumn("ALTER TABLE channels ADD COLUMN suno_model TEXT NOT NULL DEFAULT 'chirp-fenix'");
  addColumn("ALTER TABLE channels ADD COLUMN suno_mode TEXT NOT NULL DEFAULT 'custom'");
  addColumn('ALTER TABLE channels ADD COLUMN suno_instrumental INTEGER NOT NULL DEFAULT 0');
  addColumn('ALTER TABLE channels ADD COLUMN suno_persona_id TEXT');
  addColumn('ALTER TABLE albums ADD COLUMN suno_model TEXT');
  addColumn('ALTER TABLE albums ADD COLUMN suno_mode TEXT');
  addColumn('ALTER TABLE albums ADD COLUMN suno_instrumental INTEGER');
  addColumn('ALTER TABLE albums ADD COLUMN suno_persona_id TEXT');
  // v5: multi-workflow (ambient default + rap-compilation) + per-channel
  // configurability (prompts, video target, B-roll, DK credit overrides).
  // Existing rows default to workflow='ambient' so behavior is unchanged.
  addColumn("ALTER TABLE channels ADD COLUMN workflow TEXT NOT NULL DEFAULT 'ambient'");
  addColumn('ALTER TABLE channels ADD COLUMN tracks_per_album INTEGER');
  addColumn('ALTER TABLE channels ADD COLUMN target_video_seconds INTEGER');
  addColumn('ALTER TABLE channels ADD COLUMN broll_folder_path TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN suno_style_prompt TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN prompt_album_brief TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN prompt_track_briefs TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN prompt_cover_image TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN prompt_thumbnail TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN prompt_yt_metadata TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN youtube_image_aspect TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN distrokid_songwriter_name TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN distrokid_performer_name TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN distrokid_performer_role TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN distrokid_producer_name TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN distrokid_producer_role TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN rap_clip_strategy TEXT');
  addColumn("ALTER TABLE albums ADD COLUMN workflow TEXT NOT NULL DEFAULT 'ambient'");
  // v6: per-album error message captured on terminal failure for triage.
  addColumn('ALTER TABLE albums ADD COLUMN last_error TEXT');
  // v7: multi-prompt Suno style. New channel_suno_prompts collection (created
  // by SCHEMA_SQL above), albums get a FK to the picked prompt + a snapshot
  // of the prompt content so audit/idempotency survive a later prompt edit
  // or delete.
  addColumn('ALTER TABLE albums ADD COLUMN suno_prompt_id TEXT');
  addColumn('ALTER TABLE albums ADD COLUMN suno_prompt_resolved_text TEXT');
  // Backfill: each existing channel with a non-empty legacy suno_style_prompt
  // gets one 'migrated-default' row in the new collection. Idempotent — skips
  // channels that already have any prompt rows. Old column stays as a read-
  // fallback for new channels created via the legacy API field.
  const channelsToMigrate = db
    .prepare(
      `SELECT c.id AS channelId, c.suno_style_prompt AS content
       FROM channels c
       WHERE c.suno_style_prompt IS NOT NULL
         AND length(c.suno_style_prompt) > 0
         AND NOT EXISTS (
           SELECT 1 FROM channel_suno_prompts p WHERE p.channel_id = c.id
         )`,
    )
    .all() as Array<{ channelId: string; content: string }>;
  if (channelsToMigrate.length > 0) {
    const insertPrompt = db.prepare(
      `INSERT INTO channel_suno_prompts
         (id, channel_id, label, content, weight, active, created_at, updated_at)
       VALUES (?, ?, 'migrated-default', ?, 1.0, 1, ?, ?)`,
    );
    const now = Date.now();
    const tx = db.transaction(() => {
      for (const c of channelsToMigrate) {
        insertPrompt.run(ulid(), c.channelId, c.content, now, now);
      }
    });
    tx();
  }
  // v8: per-track suno style support. tracks now record which prompt produced
  // them so a single album can rotate styles across its tracks (mixtape-style
  // compilations, etc.). suno_prompt_id is the FK; suno_prompt_resolved_text
  // is the snapshot so audit survives a later prompt deletion (mirrors the
  // album-level pattern from v7).
  addColumn('ALTER TABLE tracks ADD COLUMN suno_prompt_id TEXT');
  addColumn('ALTER TABLE tracks ADD COLUMN suno_prompt_resolved_text TEXT');
  // v9: ambient-video workflow — per-album scene generation (Midjourney image
  // prompt + Seedance motion prompt + YouTube title generated as a coherent
  // set by OpenRouter) + per-channel scene themes pool + channel-level
  // seedance fallback prompt. All nullable: existing ambient + rap-compilation
  // channels migrate as NULL and behave unchanged.
  addColumn('ALTER TABLE albums ADD COLUMN scene_image_prompt TEXT');
  addColumn('ALTER TABLE albums ADD COLUMN scene_seedance_prompt TEXT');
  addColumn('ALTER TABLE albums ADD COLUMN scene_title TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN scene_themes TEXT');
  addColumn('ALTER TABLE channels ADD COLUMN seedance_motion_prompt TEXT');
  // v10: per-channel Magnific saved-style name (e.g. "medievel"). Optional;
  // drives the freepik-runner content script's style picker when set.
  addColumn('ALTER TABLE channels ADD COLUMN image_style_name TEXT');
  // v11: per-channel "Suno dual variant" mode. When set, ambient-video does
  // 15 generations × 2 clips = 30 tracks (≈half the Suno cost) instead of 30
  // generations. Default 0 → every existing channel behaves EXACTLY as before.
  // tracks.suno_clip_index records which of a generation's 2 clips a track
  // maps to; NULL = legacy single-clip download (clip 0), byte-identical to
  // pre-v11 so non-flagged channels are unaffected.
  addColumn('ALTER TABLE channels ADD COLUMN suno_dual_variant INTEGER NOT NULL DEFAULT 0');
  addColumn('ALTER TABLE tracks ADD COLUMN suno_clip_index INTEGER');
}

export function initSchema(db: Db): void {
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  const seed = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING',
  );
  const tx = db.transaction(() => {
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
      seed.run(k, v);
    }
  });
  tx();
  // After migrations + seed, ensure the db_version setting reflects current code.
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run('db_version', String(DB_VERSION));
}

/**
 * Process-wide singleton DB. Use this from API routes / worker code.
 * Tests should call openDb(':memory:') + initSchema directly instead.
 */
export function getDb(): Db {
  if (cached) return cached;
  cached = openDb();
  initSchema(cached);
  return cached;
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/** Test-only seam: lets a test swap the singleton so route handlers hit an in-memory DB. */
export function __setDbForTests(db: Db | null): void {
  cached = db;
}

export function getDbVersion(db: Db): number {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('db_version') as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}
