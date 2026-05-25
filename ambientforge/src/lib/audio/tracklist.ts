import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import { ffprobe, FfmpegError } from './ffmpeg';

export type TracklistEntry = {
  trackNumber: number;
  title: string;
  /** Cumulative start timestamp formatted as `M:SS` or `H:MM:SS` once any entry crosses 1:00:00. */
  timestamp: string;
};

export type TracklistResult = {
  text: string;
  entries: TracklistEntry[];
};

/**
 * Format `M:SS - Title` (or `H:MM:SS - Title` when `useHours`). Two-digit minutes
 * are only padded when the hour component is rendered, matching @songsforcry style.
 */
export function formatTimestamp(totalSeconds: number, useHours: boolean): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (useHours) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * Build the entries + formatted text from raw track durations. Cumulative
 * timestamps start at `0:00`. Once any cumulative timestamp crosses 1:00:00 we
 * switch *that entry and all later entries* to `H:MM:SS` so the column is
 * consistent past the hour mark.
 */
export function buildTracklist(
  tracks: { trackNumber: number; title: string; durationSec: number }[],
): TracklistResult {
  const sorted = [...tracks].sort((a, b) => a.trackNumber - b.trackNumber);
  const cumulative: number[] = [];
  let acc = 0;
  for (const t of sorted) {
    cumulative.push(acc);
    acc += t.durationSec;
  }
  const switchIdx = cumulative.findIndex((c) => c >= 3600);
  const entries: TracklistEntry[] = sorted.map((t, i) => {
    const useHours = switchIdx !== -1 && i >= switchIdx;
    return {
      trackNumber: t.trackNumber,
      title: t.title,
      timestamp: formatTimestamp(cumulative[i], useHours),
    };
  });
  const text = entries.map((e) => `${e.timestamp} - ${e.title}`).join('\n');
  return { text, entries };
}

/**
 * Parse `tracklist.txt` back into entries. Used by the idempotent path so we
 * don't ffprobe again when the file already exists. Format must match what
 * `buildTracklist` writes (`{timestamp} - {title}` per line).
 */
export function parseTracklistText(text: string): TracklistEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  return lines.map((line, i) => {
    const dashIdx = line.indexOf(' - ');
    if (dashIdx === -1) {
      throw new FfmpegError('TRACKLIST_PARSE_FAILED', `tracklist.txt line ${i + 1} missing " - " separator: "${line}"`);
    }
    const timestamp = line.slice(0, dashIdx);
    const title = line.slice(dashIdx + 3);
    return { trackNumber: i + 1, title, timestamp };
  });
}

export type GenerateTracklistOpts = {
  projectsDir?: string;
};

/**
 * Generate the cumulative tracklist for an album. Reads the 30 tracks ordered
 * by trackNumber, ffprobes each `audioPath` for an authoritative duration, and
 * writes `projects/<channelId>/<albumId>/tracklist.txt`.
 *
 * Idempotent: if `tracklist.txt` exists with non-empty content, the file is
 * parsed and returned without ffprobing.
 */
export async function generateTracklist(
  albumId: string,
  opts: GenerateTracklistOpts = {},
): Promise<TracklistResult & { filePath: string }> {
  const album = albumsRepo.get(albumId);
  if (!album) {
    throw new FfmpegError('TRACKLIST_ALBUM_NOT_FOUND', `album ${albumId} not found`);
  }
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const albumDir = path.join(projectsDir, album.channelId, album.id);
  const filePath = path.join(albumDir, 'tracklist.txt');

  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf8');
    if (existing.trim().length > 0) {
      const entries = parseTracklistText(existing);
      return { text: existing.replace(/\r?\n+$/, ''), entries, filePath };
    }
  }

  const tracks = tracksRepo.listByAlbum(albumId);
  if (tracks.length === 0) {
    throw new FfmpegError('TRACKLIST_NO_TRACKS', `album ${albumId} has zero tracks`);
  }

  const probed: { trackNumber: number; title: string; durationSec: number }[] = [];
  for (const t of tracks) {
    if (!t.audioPath) {
      throw new FfmpegError(
        'TRACKLIST_TRACK_MISSING_AUDIO',
        `track ${t.trackNumber} ("${t.title}") has no audioPath`,
      );
    }
    const probe = await ffprobe(t.audioPath);
    if (probe.duration === undefined || probe.duration <= 0) {
      throw new FfmpegError(
        'TRACKLIST_TRACK_DURATION_MISSING',
        `ffprobe returned no duration for track ${t.trackNumber} at ${t.audioPath}`,
      );
    }
    probed.push({ trackNumber: t.trackNumber, title: t.title, durationSec: probe.duration });
  }

  const built = buildTracklist(probed);
  await fs.promises.mkdir(albumDir, { recursive: true });
  await fs.promises.writeFile(filePath, built.text, 'utf8');
  return { ...built, filePath };
}
