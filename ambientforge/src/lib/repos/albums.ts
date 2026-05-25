import { ulid } from 'ulid';
import { getDb, type Db } from '../db';
import {
  SUNO_MODES,
  WORKFLOWS,
  type SunoMode,
  type Workflow,
  get as getChannel,
} from './channels';

export type AlbumStatus =
  | 'new'
  | 'queued'
  | 'in_progress'
  | 'awaiting_captcha'
  | 'awaiting_suno_relogin'
  | 'done'
  | 'failed';
export type DistrokidStatus = 'pending' | 'submitted' | 'failed' | 'dryrun';
export type VideoStatus = 'pending' | 'rendering' | 'rendered' | 'failed';
export type RetryBranch = 'A' | 'B' | null;

export type Album = {
  id: string;
  channelId: string;
  status: AlbumStatus;
  themePrompt: string | null;
  albumTitle: string;
  artistName: string;
  primaryGenre: string;
  sunoStylePrompt: string;
  coverImagePath: string | null;
  thumbnailPath: string | null;
  ytImagePath: string | null;
  tracklistText: string | null;
  ytTitle: string | null;
  ytDescription: string | null;
  ytTags: string | null;
  distrokidReleaseId: string | null;
  distrokidDryRunArtifact: string | null;
  distrokidSubmittedAt: number | null;
  safeToUploadAfter: number | null;
  distrokidStatus: DistrokidStatus;
  videoStatus: VideoStatus;
  videoProgressPct: number;
  retryBranchOnly: RetryBranch;
  finalVideoPath: string | null;
  uploadedAt: number | null;
  youtubeVideoId: string | null;
  sunoModel: string | null;
  sunoMode: SunoMode | null;
  sunoInstrumental: boolean | null;
  sunoPersonaId: string | null;
  workflow: Workflow;
  lastError: string | null;
  sunoPromptId: string | null;
  sunoPromptResolvedText: string | null;
  sceneImagePrompt: string | null;
  sceneSeedancePrompt: string | null;
  sceneTitle: string | null;
  createdAt: number;
  updatedAt: number;
};

export type AlbumCreateInput = {
  channelId: string;
  themePrompt?: string | null;
  artistName?: string;
  status?: AlbumStatus;
  /**
   * Optional override. When omitted, create() reads channel.workflow at insert
   * time and snapshots it on the album row. The snapshot protects historical
   * accuracy when the channel later switches workflow.
   */
  workflow?: Workflow;
};

type Row = {
  id: string;
  channel_id: string;
  status: AlbumStatus;
  theme_prompt: string | null;
  album_title: string;
  artist_name: string;
  primary_genre: string;
  suno_style_prompt: string;
  cover_image_path: string | null;
  thumbnail_path: string | null;
  yt_image_path: string | null;
  tracklist_text: string | null;
  yt_title: string | null;
  yt_description: string | null;
  yt_tags: string | null;
  distrokid_release_id: string | null;
  distrokid_dry_run_artifact: string | null;
  distrokid_submitted_at: number | null;
  safe_to_upload_after: number | null;
  distrokid_status: DistrokidStatus;
  video_status: VideoStatus;
  video_progress_pct: number;
  retry_branch_only: RetryBranch;
  final_video_path: string | null;
  uploaded_at: number | null;
  youtube_video_id: string | null;
  suno_model: string | null;
  suno_mode: string | null;
  suno_instrumental: number | null;
  suno_persona_id: string | null;
  workflow: string;
  last_error: string | null;
  suno_prompt_id: string | null;
  suno_prompt_resolved_text: string | null;
  scene_image_prompt: string | null;
  scene_seedance_prompt: string | null;
  scene_title: string | null;
  created_at: number;
  updated_at: number;
};

function fromRow(r: Row): Album {
  return {
    id: r.id,
    channelId: r.channel_id,
    status: r.status,
    themePrompt: r.theme_prompt,
    albumTitle: r.album_title,
    artistName: r.artist_name,
    primaryGenre: r.primary_genre,
    sunoStylePrompt: r.suno_style_prompt,
    coverImagePath: r.cover_image_path,
    thumbnailPath: r.thumbnail_path,
    ytImagePath: r.yt_image_path,
    tracklistText: r.tracklist_text,
    ytTitle: r.yt_title,
    ytDescription: r.yt_description,
    ytTags: r.yt_tags,
    distrokidReleaseId: r.distrokid_release_id,
    distrokidDryRunArtifact: r.distrokid_dry_run_artifact,
    distrokidSubmittedAt: r.distrokid_submitted_at,
    safeToUploadAfter: r.safe_to_upload_after,
    distrokidStatus: r.distrokid_status,
    videoStatus: r.video_status,
    videoProgressPct: r.video_progress_pct,
    retryBranchOnly: r.retry_branch_only,
    finalVideoPath: r.final_video_path,
    uploadedAt: r.uploaded_at,
    youtubeVideoId: r.youtube_video_id,
    sunoModel: r.suno_model,
    sunoMode:
      r.suno_mode != null && (SUNO_MODES as readonly string[]).includes(r.suno_mode)
        ? (r.suno_mode as SunoMode)
        : null,
    sunoInstrumental: r.suno_instrumental == null ? null : r.suno_instrumental === 1,
    sunoPersonaId: r.suno_persona_id,
    workflow:
      (WORKFLOWS as readonly string[]).includes(r.workflow)
        ? (r.workflow as Workflow)
        : 'ambient',
    lastError: r.last_error,
    sunoPromptId: r.suno_prompt_id,
    sunoPromptResolvedText: r.suno_prompt_resolved_text,
    sceneImagePrompt: r.scene_image_prompt,
    sceneSeedancePrompt: r.scene_seedance_prompt,
    sceneTitle: r.scene_title,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = `id, channel_id, status, theme_prompt, album_title, artist_name,
  primary_genre, suno_style_prompt, cover_image_path, thumbnail_path,
  yt_image_path, tracklist_text, yt_title, yt_description, yt_tags,
  distrokid_release_id, distrokid_dry_run_artifact, distrokid_submitted_at,
  safe_to_upload_after, distrokid_status, video_status, video_progress_pct,
  retry_branch_only, final_video_path, uploaded_at, youtube_video_id,
  suno_model, suno_mode, suno_instrumental, suno_persona_id, workflow,
  last_error, suno_prompt_id, suno_prompt_resolved_text,
  scene_image_prompt, scene_seedance_prompt, scene_title,
  created_at, updated_at`;

export function create(input: AlbumCreateInput, db: Db = getDb()): Album {
  const id = ulid();
  const now = Date.now();
  // Workflow snapshot: take the channel's current workflow at album-creation
  // time so the album row records what the pipeline ACTUALLY ran. If the
  // channel later switches workflows, past albums still report the original.
  const workflow =
    input.workflow ?? getChannel(input.channelId, db)?.workflow ?? 'ambient';
  if (!(WORKFLOWS as readonly string[]).includes(workflow)) {
    throw new Error(`invalid workflow: ${workflow}`);
  }
  db.prepare(
    `INSERT INTO albums (id, channel_id, status, theme_prompt, artist_name, workflow, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.channelId,
    input.status ?? 'queued',
    input.themePrompt ?? null,
    input.artistName ?? '',
    workflow,
    now,
    now,
  );
  return get(id, db)!;
}

export function get(id: string, db: Db = getDb()): Album | null {
  const row = db.prepare(`SELECT ${COLS} FROM albums WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listByChannel(channelId: string, limit = 50, db: Db = getDb()): Album[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM albums WHERE channel_id = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(channelId, limit) as Row[];
  return rows.map(fromRow);
}

export function getMostRecentByChannel(channelId: string, db: Db = getDb()): Album | null {
  const row = db
    .prepare(
      `SELECT ${COLS} FROM albums WHERE channel_id = ? ORDER BY created_at DESC LIMIT 1`,
    )
    .get(channelId) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listByStatus(status: AlbumStatus, db: Db = getDb()): Album[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM albums WHERE status = ? ORDER BY created_at ASC`)
    .all(status) as Row[];
  return rows.map(fromRow);
}

export function nextQueued(db: Db = getDb()): Album | null {
  const row = db
    .prepare(`SELECT ${COLS} FROM albums WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
    .get() as Row | undefined;
  return row ? fromRow(row) : null;
}

export function hasInProgress(db: Db = getDb()): boolean {
  const row = db.prepare("SELECT 1 FROM albums WHERE status = 'in_progress' LIMIT 1").get();
  return !!row;
}

export function listReadyToUpload(now: number = Date.now(), db: Db = getDb()): Album[] {
  const rows = db
    .prepare(
      `SELECT ${COLS} FROM albums
       WHERE status = 'done'
         AND youtube_video_id IS NULL
         AND safe_to_upload_after IS NOT NULL
         AND safe_to_upload_after <= ?
       ORDER BY safe_to_upload_after ASC`,
    )
    .all(now) as Row[];
  return rows.map(fromRow);
}

export function hasOpenForChannel(channelId: string, db: Db = getDb()): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM albums WHERE channel_id = ? AND status IN ('new','queued','in_progress','awaiting_captcha','awaiting_suno_relogin') LIMIT 1",
    )
    .get(channelId);
  return !!row;
}

const PATCHABLE: Record<string, string> = {
  status: 'status',
  themePrompt: 'theme_prompt',
  albumTitle: 'album_title',
  artistName: 'artist_name',
  primaryGenre: 'primary_genre',
  sunoStylePrompt: 'suno_style_prompt',
  coverImagePath: 'cover_image_path',
  thumbnailPath: 'thumbnail_path',
  ytImagePath: 'yt_image_path',
  tracklistText: 'tracklist_text',
  ytTitle: 'yt_title',
  ytDescription: 'yt_description',
  ytTags: 'yt_tags',
  distrokidReleaseId: 'distrokid_release_id',
  distrokidDryRunArtifact: 'distrokid_dry_run_artifact',
  distrokidSubmittedAt: 'distrokid_submitted_at',
  safeToUploadAfter: 'safe_to_upload_after',
  distrokidStatus: 'distrokid_status',
  videoStatus: 'video_status',
  videoProgressPct: 'video_progress_pct',
  retryBranchOnly: 'retry_branch_only',
  finalVideoPath: 'final_video_path',
  uploadedAt: 'uploaded_at',
  youtubeVideoId: 'youtube_video_id',
  sunoModel: 'suno_model',
  sunoMode: 'suno_mode',
  sunoInstrumental: 'suno_instrumental',
  sunoPersonaId: 'suno_persona_id',
  lastError: 'last_error',
  sunoPromptId: 'suno_prompt_id',
  sunoPromptResolvedText: 'suno_prompt_resolved_text',
  sceneImagePrompt: 'scene_image_prompt',
  sceneSeedancePrompt: 'scene_seedance_prompt',
  sceneTitle: 'scene_title',
};

const BOOL_KEYS = new Set(['sunoInstrumental']);

export function patch(
  id: string,
  fields: Partial<Omit<Album, 'id' | 'channelId' | 'createdAt' | 'updatedAt'>>,
  db: Db = getDb(),
): Album | null {
  if (
    fields.sunoMode != null &&
    !(SUNO_MODES as readonly string[]).includes(fields.sunoMode)
  ) {
    throw new Error(`invalid suno_mode: ${fields.sunoMode}`);
  }
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: Date.now() };
  for (const [key, value] of Object.entries(fields)) {
    const col = PATCHABLE[key];
    if (!col) continue;
    sets.push(`${col} = @${key}`);
    if (BOOL_KEYS.has(key)) {
      params[key] = value == null ? null : value ? 1 : 0;
    } else {
      params[key] = value ?? null;
    }
  }
  if (sets.length === 0) return get(id, db);
  sets.push('updated_at = @updatedAt');
  db.prepare(`UPDATE albums SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id, db);
}
