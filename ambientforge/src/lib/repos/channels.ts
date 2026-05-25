import { ulid } from 'ulid';
import { getDb, type Db } from '../db';
import { SUNO_MODES, type SunoMode } from '../suno/modes';
import {
  RAP_CLIP_STRATEGIES,
  WORKFLOWS,
  YOUTUBE_IMAGE_ASPECTS,
  type RapClipStrategy,
  type Workflow,
  type YoutubeImageAspect,
} from '../channels/constants';

export { SUNO_MODES, type SunoMode };
export {
  RAP_CLIP_STRATEGIES,
  WORKFLOWS,
  YOUTUBE_IMAGE_ASPECTS,
  type RapClipStrategy,
  type Workflow,
  type YoutubeImageAspect,
};

export type Channel = {
  id: string;
  name: string;
  displayName: string;
  description: string;
  active: boolean;
  scheduleCron: string;
  albumBriefTemplate: string | null;
  trackBriefsTemplate: string | null;
  coverPromptTemplate: string | null;
  thumbnailPromptTemplate: string | null;
  ytMetadataTemplate: string | null;
  distrokidArtistName: string;
  distrokidPrimaryGenre: string;
  distrokidLabelName: string | null;
  youtubeChannelId: string | null;
  youtubeChannelHandle: string | null;
  thumbnailOverlayText: string | null;
  spotifyPlaylistUrl: string | null;
  hashtags: string;
  distrokidArtistVerifiedAt: number | null;
  sunoModel: string;
  sunoMode: SunoMode;
  sunoInstrumental: boolean;
  sunoPersonaId: string | null;
  workflow: Workflow;
  tracksPerAlbum: number | null;
  targetVideoSeconds: number | null;
  brollFolderPath: string | null;
  sunoStylePrompt: string | null;
  promptAlbumBrief: string | null;
  promptTrackBriefs: string | null;
  promptCoverImage: string | null;
  promptThumbnail: string | null;
  promptYtMetadata: string | null;
  youtubeImageAspect: YoutubeImageAspect | null;
  distrokidSongwriterName: string | null;
  distrokidPerformerName: string | null;
  distrokidPerformerRole: string | null;
  distrokidProducerName: string | null;
  distrokidProducerRole: string | null;
  rapClipStrategy: RapClipStrategy | null;
  sceneThemes: string | null;
  seedanceMotionPrompt: string | null;
  imageStyleName: string | null;
  /** When true, this channel's ambient-video albums submit 15 Suno
   * generations and keep BOTH clips each (= 30 tracks) instead of 30
   * single-clip generations. Default false → identical legacy behavior. */
  sunoDualVariant: boolean;
  createdAt: number;
  updatedAt: number;
};

export type ChannelInput = Omit<
  Channel,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'active'
  | 'distrokidArtistVerifiedAt'
  | 'sunoModel'
  | 'sunoMode'
  | 'sunoInstrumental'
  | 'sunoPersonaId'
  | 'workflow'
  | 'tracksPerAlbum'
  | 'targetVideoSeconds'
  | 'brollFolderPath'
  | 'sunoStylePrompt'
  | 'promptAlbumBrief'
  | 'promptTrackBriefs'
  | 'promptCoverImage'
  | 'promptThumbnail'
  | 'promptYtMetadata'
  | 'youtubeImageAspect'
  | 'distrokidSongwriterName'
  | 'distrokidPerformerName'
  | 'distrokidPerformerRole'
  | 'distrokidProducerName'
  | 'distrokidProducerRole'
  | 'rapClipStrategy'
  | 'sceneThemes'
  | 'seedanceMotionPrompt'
  | 'imageStyleName'
  | 'sunoDualVariant'
> &
  Partial<
    Pick<
      Channel,
      | 'active'
      | 'sunoModel'
      | 'sunoMode'
      | 'sunoInstrumental'
      | 'sunoPersonaId'
      | 'workflow'
      | 'tracksPerAlbum'
      | 'targetVideoSeconds'
      | 'brollFolderPath'
      | 'sunoStylePrompt'
      | 'promptAlbumBrief'
      | 'promptTrackBriefs'
      | 'promptCoverImage'
      | 'promptThumbnail'
      | 'promptYtMetadata'
      | 'youtubeImageAspect'
      | 'distrokidSongwriterName'
      | 'distrokidPerformerName'
      | 'distrokidPerformerRole'
      | 'distrokidProducerName'
      | 'distrokidProducerRole'
      | 'rapClipStrategy'
      | 'sceneThemes'
      | 'seedanceMotionPrompt'
      | 'imageStyleName'
    >
  >;

type Row = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  active: number;
  schedule_cron: string;
  album_brief_template: string | null;
  track_briefs_template: string | null;
  cover_prompt_template: string | null;
  thumbnail_prompt_template: string | null;
  yt_metadata_template: string | null;
  distrokid_artist_name: string;
  distrokid_primary_genre: string;
  distrokid_label_name: string | null;
  youtube_channel_id: string | null;
  youtube_channel_handle: string | null;
  thumbnail_overlay_text: string | null;
  spotify_playlist_url: string | null;
  hashtags: string;
  distrokid_artist_verified_at: number | null;
  suno_model: string;
  suno_mode: string;
  suno_instrumental: number;
  suno_persona_id: string | null;
  workflow: string;
  tracks_per_album: number | null;
  target_video_seconds: number | null;
  broll_folder_path: string | null;
  suno_style_prompt: string | null;
  prompt_album_brief: string | null;
  prompt_track_briefs: string | null;
  prompt_cover_image: string | null;
  prompt_thumbnail: string | null;
  prompt_yt_metadata: string | null;
  youtube_image_aspect: string | null;
  distrokid_songwriter_name: string | null;
  distrokid_performer_name: string | null;
  distrokid_performer_role: string | null;
  distrokid_producer_name: string | null;
  distrokid_producer_role: string | null;
  rap_clip_strategy: string | null;
  scene_themes: string | null;
  seedance_motion_prompt: string | null;
  image_style_name: string | null;
  suno_dual_variant: number;
  created_at: number;
  updated_at: number;
};

function coerceSunoMode(raw: string): SunoMode {
  if ((SUNO_MODES as readonly string[]).includes(raw)) return raw as SunoMode;
  throw new Error(`invalid suno_mode: ${raw}`);
}

function coerceWorkflow(raw: string): Workflow {
  if ((WORKFLOWS as readonly string[]).includes(raw)) return raw as Workflow;
  throw new Error(`invalid workflow: ${raw}`);
}

function coerceYoutubeImageAspect(raw: string | null): YoutubeImageAspect | null {
  if (raw == null) return null;
  if ((YOUTUBE_IMAGE_ASPECTS as readonly string[]).includes(raw)) return raw as YoutubeImageAspect;
  throw new Error(`invalid youtube_image_aspect: ${raw}`);
}

function coerceRapClipStrategy(raw: string | null): RapClipStrategy | null {
  if (raw == null) return null;
  if ((RAP_CLIP_STRATEGIES as readonly string[]).includes(raw)) return raw as RapClipStrategy;
  throw new Error(`invalid rap_clip_strategy: ${raw}`);
}

function fromRow(r: Row): Channel {
  return {
    id: r.id,
    name: r.name,
    displayName: r.display_name,
    description: r.description,
    active: r.active === 1,
    scheduleCron: r.schedule_cron,
    albumBriefTemplate: r.album_brief_template,
    trackBriefsTemplate: r.track_briefs_template,
    coverPromptTemplate: r.cover_prompt_template,
    thumbnailPromptTemplate: r.thumbnail_prompt_template,
    ytMetadataTemplate: r.yt_metadata_template,
    distrokidArtistName: r.distrokid_artist_name,
    distrokidPrimaryGenre: r.distrokid_primary_genre,
    distrokidLabelName: r.distrokid_label_name,
    youtubeChannelId: r.youtube_channel_id,
    youtubeChannelHandle: r.youtube_channel_handle,
    thumbnailOverlayText: r.thumbnail_overlay_text,
    spotifyPlaylistUrl: r.spotify_playlist_url,
    hashtags: r.hashtags,
    distrokidArtistVerifiedAt: r.distrokid_artist_verified_at,
    sunoModel: r.suno_model,
    sunoMode: coerceSunoMode(r.suno_mode),
    sunoInstrumental: r.suno_instrumental === 1,
    sunoPersonaId: r.suno_persona_id,
    workflow: coerceWorkflow(r.workflow),
    tracksPerAlbum: r.tracks_per_album,
    targetVideoSeconds: r.target_video_seconds,
    brollFolderPath: r.broll_folder_path,
    sunoStylePrompt: r.suno_style_prompt,
    promptAlbumBrief: r.prompt_album_brief,
    promptTrackBriefs: r.prompt_track_briefs,
    promptCoverImage: r.prompt_cover_image,
    promptThumbnail: r.prompt_thumbnail,
    promptYtMetadata: r.prompt_yt_metadata,
    youtubeImageAspect: coerceYoutubeImageAspect(r.youtube_image_aspect),
    distrokidSongwriterName: r.distrokid_songwriter_name,
    distrokidPerformerName: r.distrokid_performer_name,
    distrokidPerformerRole: r.distrokid_performer_role,
    distrokidProducerName: r.distrokid_producer_name,
    distrokidProducerRole: r.distrokid_producer_role,
    rapClipStrategy: coerceRapClipStrategy(r.rap_clip_strategy),
    sceneThemes: r.scene_themes,
    seedanceMotionPrompt: r.seedance_motion_prompt,
    imageStyleName: r.image_style_name,
    sunoDualVariant: r.suno_dual_variant === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const COLS = `id, name, display_name, description, active, schedule_cron,
  album_brief_template, track_briefs_template, cover_prompt_template,
  thumbnail_prompt_template, yt_metadata_template, distrokid_artist_name,
  distrokid_primary_genre, distrokid_label_name, youtube_channel_id,
  youtube_channel_handle, thumbnail_overlay_text, spotify_playlist_url,
  hashtags, distrokid_artist_verified_at, suno_model, suno_mode,
  suno_instrumental, suno_persona_id, workflow, tracks_per_album,
  target_video_seconds, broll_folder_path, suno_style_prompt,
  prompt_album_brief, prompt_track_briefs, prompt_cover_image,
  prompt_thumbnail, prompt_yt_metadata, youtube_image_aspect,
  distrokid_songwriter_name, distrokid_performer_name,
  distrokid_performer_role, distrokid_producer_name,
  distrokid_producer_role, rap_clip_strategy, scene_themes,
  seedance_motion_prompt, image_style_name, suno_dual_variant,
  created_at, updated_at`;

export function create(input: ChannelInput, db: Db = getDb()): Channel {
  const id = ulid();
  const now = Date.now();
  const sunoMode = input.sunoMode ?? 'custom';
  if (!(SUNO_MODES as readonly string[]).includes(sunoMode)) {
    throw new Error(`invalid suno_mode: ${sunoMode}`);
  }
  const workflow = input.workflow ?? 'ambient';
  if (!(WORKFLOWS as readonly string[]).includes(workflow)) {
    throw new Error(`invalid workflow: ${workflow}`);
  }
  if (
    input.youtubeImageAspect != null &&
    !(YOUTUBE_IMAGE_ASPECTS as readonly string[]).includes(input.youtubeImageAspect)
  ) {
    throw new Error(`invalid youtube_image_aspect: ${input.youtubeImageAspect}`);
  }
  if (
    input.rapClipStrategy != null &&
    !(RAP_CLIP_STRATEGIES as readonly string[]).includes(input.rapClipStrategy)
  ) {
    throw new Error(`invalid rap_clip_strategy: ${input.rapClipStrategy}`);
  }
  db.prepare(
    `INSERT INTO channels (${COLS}) VALUES (
      @id, @name, @displayName, @description, @active, @scheduleCron,
      @albumBriefTemplate, @trackBriefsTemplate, @coverPromptTemplate,
      @thumbnailPromptTemplate, @ytMetadataTemplate, @distrokidArtistName,
      @distrokidPrimaryGenre, @distrokidLabelName, @youtubeChannelId,
      @youtubeChannelHandle, @thumbnailOverlayText, @spotifyPlaylistUrl,
      @hashtags, @distrokidArtistVerifiedAt, @sunoModel, @sunoMode,
      @sunoInstrumental, @sunoPersonaId, @workflow, @tracksPerAlbum,
      @targetVideoSeconds, @brollFolderPath, @sunoStylePrompt,
      @promptAlbumBrief, @promptTrackBriefs, @promptCoverImage,
      @promptThumbnail, @promptYtMetadata, @youtubeImageAspect,
      @distrokidSongwriterName, @distrokidPerformerName,
      @distrokidPerformerRole, @distrokidProducerName,
      @distrokidProducerRole, @rapClipStrategy, @sceneThemes,
      @seedanceMotionPrompt, @imageStyleName, @sunoDualVariant,
      @createdAt, @updatedAt
    )`,
  ).run({
    id,
    name: input.name,
    displayName: input.displayName,
    description: input.description ?? '',
    active: input.active === false ? 0 : 1,
    scheduleCron: input.scheduleCron,
    albumBriefTemplate: input.albumBriefTemplate ?? null,
    trackBriefsTemplate: input.trackBriefsTemplate ?? null,
    coverPromptTemplate: input.coverPromptTemplate ?? null,
    thumbnailPromptTemplate: input.thumbnailPromptTemplate ?? null,
    ytMetadataTemplate: input.ytMetadataTemplate ?? null,
    distrokidArtistName: input.distrokidArtistName,
    distrokidPrimaryGenre: input.distrokidPrimaryGenre,
    distrokidLabelName: input.distrokidLabelName ?? null,
    youtubeChannelId: input.youtubeChannelId ?? null,
    youtubeChannelHandle: input.youtubeChannelHandle ?? null,
    thumbnailOverlayText: input.thumbnailOverlayText ?? null,
    spotifyPlaylistUrl: input.spotifyPlaylistUrl ?? null,
    hashtags: input.hashtags ?? '',
    distrokidArtistVerifiedAt: null,
    sunoModel: input.sunoModel ?? 'chirp-fenix',
    sunoMode,
    sunoInstrumental: input.sunoInstrumental ? 1 : 0,
    sunoPersonaId: input.sunoPersonaId ?? null,
    workflow,
    tracksPerAlbum: input.tracksPerAlbum ?? null,
    targetVideoSeconds: input.targetVideoSeconds ?? null,
    brollFolderPath: input.brollFolderPath ?? null,
    sunoStylePrompt: input.sunoStylePrompt ?? null,
    promptAlbumBrief: input.promptAlbumBrief ?? null,
    promptTrackBriefs: input.promptTrackBriefs ?? null,
    promptCoverImage: input.promptCoverImage ?? null,
    promptThumbnail: input.promptThumbnail ?? null,
    promptYtMetadata: input.promptYtMetadata ?? null,
    youtubeImageAspect: input.youtubeImageAspect ?? null,
    distrokidSongwriterName: input.distrokidSongwriterName ?? null,
    distrokidPerformerName: input.distrokidPerformerName ?? null,
    distrokidPerformerRole: input.distrokidPerformerRole ?? null,
    distrokidProducerName: input.distrokidProducerName ?? null,
    distrokidProducerRole: input.distrokidProducerRole ?? null,
    rapClipStrategy: input.rapClipStrategy ?? null,
    sceneThemes: input.sceneThemes ?? null,
    seedanceMotionPrompt: input.seedanceMotionPrompt ?? null,
    imageStyleName: input.imageStyleName ?? null,
    sunoDualVariant: 0,
    createdAt: now,
    updatedAt: now,
  });
  return get(id, db)!;
}

export function get(id: string, db: Db = getDb()): Channel | null {
  const row = db.prepare(`SELECT ${COLS} FROM channels WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function getByName(name: string, db: Db = getDb()): Channel | null {
  const row = db.prepare(`SELECT ${COLS} FROM channels WHERE name = ?`).get(name) as
    | Row
    | undefined;
  return row ? fromRow(row) : null;
}

export function list(opts: { activeOnly?: boolean } = {}, db: Db = getDb()): Channel[] {
  const where = opts.activeOnly ? 'WHERE active = 1' : '';
  const rows = db
    .prepare(`SELECT ${COLS} FROM channels ${where} ORDER BY created_at ASC`)
    .all() as Row[];
  return rows.map(fromRow);
}

const PATCHABLE: Record<string, string> = {
  name: 'name',
  displayName: 'display_name',
  description: 'description',
  active: 'active',
  scheduleCron: 'schedule_cron',
  albumBriefTemplate: 'album_brief_template',
  trackBriefsTemplate: 'track_briefs_template',
  coverPromptTemplate: 'cover_prompt_template',
  thumbnailPromptTemplate: 'thumbnail_prompt_template',
  ytMetadataTemplate: 'yt_metadata_template',
  distrokidArtistName: 'distrokid_artist_name',
  distrokidPrimaryGenre: 'distrokid_primary_genre',
  distrokidLabelName: 'distrokid_label_name',
  youtubeChannelId: 'youtube_channel_id',
  youtubeChannelHandle: 'youtube_channel_handle',
  thumbnailOverlayText: 'thumbnail_overlay_text',
  spotifyPlaylistUrl: 'spotify_playlist_url',
  hashtags: 'hashtags',
  distrokidArtistVerifiedAt: 'distrokid_artist_verified_at',
  sunoModel: 'suno_model',
  sunoMode: 'suno_mode',
  sunoInstrumental: 'suno_instrumental',
  sunoPersonaId: 'suno_persona_id',
  workflow: 'workflow',
  tracksPerAlbum: 'tracks_per_album',
  targetVideoSeconds: 'target_video_seconds',
  brollFolderPath: 'broll_folder_path',
  sunoStylePrompt: 'suno_style_prompt',
  promptAlbumBrief: 'prompt_album_brief',
  promptTrackBriefs: 'prompt_track_briefs',
  promptCoverImage: 'prompt_cover_image',
  promptThumbnail: 'prompt_thumbnail',
  promptYtMetadata: 'prompt_yt_metadata',
  youtubeImageAspect: 'youtube_image_aspect',
  distrokidSongwriterName: 'distrokid_songwriter_name',
  distrokidPerformerName: 'distrokid_performer_name',
  distrokidPerformerRole: 'distrokid_performer_role',
  distrokidProducerName: 'distrokid_producer_name',
  distrokidProducerRole: 'distrokid_producer_role',
  rapClipStrategy: 'rap_clip_strategy',
  sceneThemes: 'scene_themes',
  seedanceMotionPrompt: 'seedance_motion_prompt',
  imageStyleName: 'image_style_name',
  sunoDualVariant: 'suno_dual_variant',
};

const BOOL_KEYS = new Set(['active', 'sunoInstrumental', 'sunoDualVariant']);

export function patch(
  id: string,
  fields: Partial<Omit<Channel, 'id' | 'createdAt' | 'updatedAt'>>,
  db: Db = getDb(),
): Channel | null {
  if (fields.sunoMode != null && !(SUNO_MODES as readonly string[]).includes(fields.sunoMode)) {
    throw new Error(`invalid suno_mode: ${fields.sunoMode}`);
  }
  if (fields.workflow != null && !(WORKFLOWS as readonly string[]).includes(fields.workflow)) {
    throw new Error(`invalid workflow: ${fields.workflow}`);
  }
  if (
    fields.youtubeImageAspect != null &&
    !(YOUTUBE_IMAGE_ASPECTS as readonly string[]).includes(fields.youtubeImageAspect)
  ) {
    throw new Error(`invalid youtube_image_aspect: ${fields.youtubeImageAspect}`);
  }
  if (
    fields.rapClipStrategy != null &&
    !(RAP_CLIP_STRATEGIES as readonly string[]).includes(fields.rapClipStrategy)
  ) {
    throw new Error(`invalid rap_clip_strategy: ${fields.rapClipStrategy}`);
  }
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, updatedAt: Date.now() };
  for (const [key, value] of Object.entries(fields)) {
    const col = PATCHABLE[key];
    if (!col) continue;
    sets.push(`${col} = @${key}`);
    params[key] = BOOL_KEYS.has(key) ? (value ? 1 : 0) : (value ?? null);
  }
  if (sets.length === 0) return get(id, db);
  sets.push('updated_at = @updatedAt');
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id, db);
}

export function softDelete(id: string, db: Db = getDb()): void {
  db.prepare('UPDATE channels SET active = 0, updated_at = ? WHERE id = ?').run(Date.now(), id);
}

export function markArtistVerified(id: string, db: Db = getDb()): Channel | null {
  return patch(id, { distrokidArtistVerifiedAt: Date.now() }, db);
}
