import { ulid } from 'ulid';
import { getDb, type Db } from '../db';

export type TrackStatus = 'pending' | 'submitted' | 'downloading' | 'done' | 'failed';

export type Track = {
  id: string;
  albumId: string;
  trackNumber: number;
  title: string;
  fileName: string;
  duration: number;
  sunoTaskId: string | null;
  sunoLyrics: string | null;
  audioPath: string | null;
  status: TrackStatus;
  /** Which prompt from channel_suno_prompts produced this track. NULL for
   * legacy tracks (pre-v8) or after a cascade-delete of the source prompt. */
  sunoPromptId: string | null;
  /** Snapshot of the prompt content at submission time. Survives a later
   * prompt deletion so audit can still attribute each track to its style. */
  sunoPromptResolvedText: string | null;
  /** Suno-dual-variant only: which of the shared generation's 2 clips this
   * track maps to (0 or 1). NULL = legacy single-clip download (clip 0),
   * byte-identical to pre-v11. Two tracks in a pair share sunoTaskId. */
  sunoClipIndex: number | null;
};

export type TrackInput = {
  albumId: string;
  trackNumber: number;
  title: string;
  fileName: string;
  sunoLyrics?: string | null;
};

type Row = {
  id: string;
  album_id: string;
  track_number: number;
  title: string;
  file_name: string;
  duration: number;
  suno_task_id: string | null;
  suno_lyrics: string | null;
  audio_path: string | null;
  status: TrackStatus;
  suno_prompt_id: string | null;
  suno_prompt_resolved_text: string | null;
  suno_clip_index: number | null;
};

function fromRow(r: Row): Track {
  return {
    id: r.id,
    albumId: r.album_id,
    trackNumber: r.track_number,
    title: r.title,
    fileName: r.file_name,
    duration: r.duration,
    sunoTaskId: r.suno_task_id,
    sunoLyrics: r.suno_lyrics,
    audioPath: r.audio_path,
    status: r.status,
    sunoPromptId: r.suno_prompt_id,
    sunoPromptResolvedText: r.suno_prompt_resolved_text,
    sunoClipIndex: r.suno_clip_index,
  };
}

const COLS = `id, album_id, track_number, title, file_name, duration,
  suno_task_id, suno_lyrics, audio_path, status,
  suno_prompt_id, suno_prompt_resolved_text, suno_clip_index`;

export function insertMany(inputs: TrackInput[], db: Db = getDb()): Track[] {
  const stmt = db.prepare(
    `INSERT INTO tracks (id, album_id, track_number, title, file_name, suno_lyrics)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const tx = db.transaction((rows: TrackInput[]) => {
    for (const r of rows) {
      stmt.run(ulid(), r.albumId, r.trackNumber, r.title, r.fileName, r.sunoLyrics ?? null);
    }
  });
  tx(inputs);
  return listByAlbum(inputs[0]?.albumId ?? '', db);
}

export function get(id: string, db: Db = getDb()): Track | null {
  const row = db.prepare(`SELECT ${COLS} FROM tracks WHERE id = ?`).get(id) as Row | undefined;
  return row ? fromRow(row) : null;
}

export function listByAlbum(albumId: string, db: Db = getDb()): Track[] {
  const rows = db
    .prepare(`SELECT ${COLS} FROM tracks WHERE album_id = ? ORDER BY track_number ASC`)
    .all(albumId) as Row[];
  return rows.map(fromRow);
}

export function deleteByAlbum(albumId: string, db: Db = getDb()): void {
  db.prepare('DELETE FROM tracks WHERE album_id = ?').run(albumId);
}

const PATCHABLE: Record<string, string> = {
  title: 'title',
  fileName: 'file_name',
  duration: 'duration',
  sunoTaskId: 'suno_task_id',
  sunoLyrics: 'suno_lyrics',
  audioPath: 'audio_path',
  status: 'status',
  sunoPromptId: 'suno_prompt_id',
  sunoPromptResolvedText: 'suno_prompt_resolved_text',
  sunoClipIndex: 'suno_clip_index',
};

export function patch(
  id: string,
  fields: Partial<Omit<Track, 'id' | 'albumId' | 'trackNumber'>>,
  db: Db = getDb(),
): Track | null {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id };
  for (const [key, value] of Object.entries(fields)) {
    const col = PATCHABLE[key];
    if (!col) continue;
    sets.push(`${col} = @${key}`);
    params[key] = value ?? null;
  }
  if (sets.length === 0) return get(id, db);
  db.prepare(`UPDATE tracks SET ${sets.join(', ')} WHERE id = @id`).run(params);
  return get(id, db);
}
