import fs from 'node:fs';
import path from 'node:path';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import * as tracksRepo from '@/lib/repos/tracks';
import {
  ffprobe,
  FfmpegError,
  runFfmpeg,
  runFfmpegStreaming,
} from '@/lib/audio/ffmpeg';
import { selectBroll, type BrollClip } from '@/lib/broll/select';
import {
  assertBrollPathAllowed,
  preflightBrollFolder,
  readAllowedBrollRoots,
} from '@/lib/broll/preflight';
import { pickEncoder, type NvencMode } from '@/lib/render/mux';
import { getSettings } from '@/lib/settings';
import type { RapClipStrategy } from '@/lib/repos/channels';
import type { Album } from '@/lib/repos/albums';
import type { LogFn } from '../pipelineLog';
import type { PipelineStep } from '../pipeline';

/**
 * Rap-compilation variant of step 09. Builds per-track B-roll videos via
 * FFmpeg stream-copy concat, trims each to exact song length, concats them
 * into one full video, then muxes with the audio concat.wav. The final mux
 * re-encodes both video and audio: video is scaled to 1920×1080 with
 * letterbox/pillarbox padding (preserves aspect for any source resolution)
 * and audio is encoded to AAC. Per-track + full-video intermediates are
 * still stream-copy at native source resolution; the resolution normalization
 * happens once at the final mux to keep encoding cost minimal.
 *
 * `-map 0:v -map 1:a` is explicit so concat.wav (input 1) drives the audio,
 * not the AAC stream that ffmpeg auto-selects from full-video.mp4 (input 0).
 * Without `-map`, broll audio leaks into final.mp4 and the song goes missing.
 *
 * Output: projects/<ch>/<alb>/final.mp4 (1920×1080, h264, aac 192k)
 * Intermediates: build/song-NN-video.mp4, build/song-NN-final.mp4, build/full-video.mp4
 *
 * Idempotency: each per-track artifact + full-video.mp4 check duration; final.mp4
 * additionally checks dimensions == 1920×1080 so a 360p file from the prior
 * stream-copy era gets re-rendered into 1080p on the next run.
 */

// Idempotency tolerances. Per-song trims are tighter (we trim with -c copy -t
// and expect exact match); the final mux uses -shortest which can drift up to
// ~2s on libx264, hence the looser final tolerance.
const PER_SONG_TOLERANCE_S = 0.5;
const FINAL_TOLERANCE_S = 3;

export type Step09RapOpts = {
  projectsDir?: string;
};

export const step09RapBrollMux: PipelineStep = async (album, log) =>
  step09RapInternal(album, log);

export async function step09RapInternal(
  album: Album,
  log: LogFn,
  opts: Step09RapOpts = {},
): Promise<void> {
  log('step 09-rap', 'start');
  const projectsDir = opts.projectsDir ?? path.join(process.cwd(), 'projects');
  const albumDir = path.join(projectsDir, album.channelId, album.id);
  const buildDir = path.join(albumDir, 'build');
  const concatWavPath = path.join(buildDir, 'concat.wav');
  const fullVideoPath = path.join(buildDir, 'full-video.mp4');
  const finalPath = path.join(albumDir, 'final.mp4');

  const channel = channelsRepo.get(album.channelId);
  if (!channel) {
    throw new FfmpegError(
      'CHANNEL_NOT_FOUND',
      `channel ${album.channelId} not found for album ${album.id}`,
    );
  }
  if (!channel.brollFolderPath || channel.brollFolderPath.trim().length === 0) {
    throw new FfmpegError(
      'BROLL_FOLDER_MISSING',
      `channel ${channel.id} has no brollFolderPath set`,
    );
  }
  if (!fs.existsSync(concatWavPath)) {
    throw new FfmpegError(
      'STEP_09_RAP_CONCAT_AUDIO_MISSING',
      `expected step 07-rap output at ${concatWavPath}`,
    );
  }

  const tracks = tracksRepo
    .listByAlbum(album.id)
    .filter((t) => t.audioPath != null && t.duration > 0)
    .sort((a, b) => a.trackNumber - b.trackNumber);
  if (tracks.length === 0) {
    throw new FfmpegError(
      'STEP_09_RAP_NO_USABLE_TRACKS',
      `album ${album.id} has no tracks with audio + duration`,
    );
  }
  const totalDur = tracks.reduce((sum, t) => sum + t.duration, 0);

  // Idempotent skip: final.mp4 already looks correct.
  if (await finalLooksCorrect(finalPath, totalDur)) {
    log('step 09-rap', `noop (final.mp4 exists with duration ~${totalDur.toFixed(2)}s)`);
    albumsRepo.patch(album.id, {
      videoStatus: 'rendered',
      finalVideoPath: finalPath,
      videoProgressPct: 100,
    });
    return;
  }

  await fs.promises.mkdir(buildDir, { recursive: true });

  // Preflight B-roll. The workflow's own preflight already runs at orchestrator
  // start; running it again here keeps step 09-rap usable in isolation (e.g.,
  // retry-branch) and detects folder mutations between preflight and step 09.
  // C5: also re-check the allowlist defense-in-depth — operator may have
  // removed the path from broll_allowed_root_paths between preflight and now.
  const allowedRoots = readAllowedBrollRoots();
  const allowed = assertBrollPathAllowed(channel.brollFolderPath, allowedRoots);
  if (!allowed.ok) {
    throw new FfmpegError(
      'BROLL_PATH_NOT_ALLOWED',
      `brollFolderPath ${channel.brollFolderPath} rejected: ${allowed.reason} (code=${allowed.code})`,
    );
  }
  const preflight = await preflightBrollFolder(allowed.resolvedPath);
  if (!preflight.ok) {
    throw new FfmpegError(
      'BROLL_FOLDER_INVALID',
      `brollFolderPath ${channel.brollFolderPath} failed preflight: ${preflight.reasons.join('; ')}`,
    );
  }
  log(
    'step 09-rap',
    `preflight ok: ${preflight.videoCount} clips, codecs=${preflight.codecsDetected.join(',') || '?'}`,
  );

  const strategy: RapClipStrategy = channel.rapClipStrategy ?? 'random-fill';
  log('step 09-rap', `strategy=${strategy}`);

  // ---- 1. Per-track: select clips → song-NN-video.mp4 → song-NN-final.mp4 ----
  for (const track of tracks) {
    const num = String(track.trackNumber).padStart(2, '0');
    const songVideoPath = path.join(buildDir, `song-${num}-video.mp4`);
    const songFinalPath = path.join(buildDir, `song-${num}-final.mp4`);

    if (await fileDurationMatches(songFinalPath, track.duration, PER_SONG_TOLERANCE_S)) {
      log('step 09-rap', `track ${num} noop (song-${num}-final.mp4 already correct)`);
      continue;
    }

    const picked = selectBroll({
      albumId: album.id,
      trackNumber: track.trackNumber,
      clips: preflight.clips,
      songDurationSec: track.duration,
      strategy,
    });
    log(
      'step 09-rap',
      `track ${num} duration=${track.duration.toFixed(2)}s picked=${picked.length} clips`,
    );

    // Concat clips → song-NN-video.mp4 (stream-copy)
    const concatList = path.join(buildDir, `song-${num}-list.txt`);
    await fs.promises.writeFile(concatList, listBody(picked), 'utf8');
    try {
      await runFfmpeg([
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        concatList,
        '-c',
        'copy',
        songVideoPath,
      ]);
    } finally {
      await fs.promises.unlink(concatList).catch(() => {});
    }

    // Trim to exact song duration (stream-copy -t).
    await runFfmpeg([
      '-y',
      '-i',
      songVideoPath,
      '-c',
      'copy',
      '-t',
      String(track.duration),
      songFinalPath,
    ]);

    // Verify the trimmed file is within tolerance.
    const trimmedProbe = await ffprobe(songFinalPath);
    if (
      trimmedProbe.duration === undefined ||
      Math.abs(trimmedProbe.duration - track.duration) > PER_SONG_TOLERANCE_S
    ) {
      throw new FfmpegError(
        'STEP_09_RAP_TRIM_DURATION_MISMATCH',
        `song-${num}-final.mp4 duration=${trimmedProbe.duration} expected=${track.duration} tolerance=${PER_SONG_TOLERANCE_S}`,
      );
    }
  }

  // ---- 2. Concat song-N-final.mp4 → full-video.mp4 (stream-copy) ----
  const fullList = path.join(buildDir, 'full-video-list.txt');
  const fullClips: BrollClip[] = tracks.map((t) => ({
    path: path.join(buildDir, `song-${String(t.trackNumber).padStart(2, '0')}-final.mp4`),
    durationSec: t.duration,
  }));
  await fs.promises.writeFile(fullList, listBody(fullClips), 'utf8');
  try {
    await runFfmpeg([
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      fullList,
      '-c',
      'copy',
      fullVideoPath,
    ]);
  } finally {
    await fs.promises.unlink(fullList).catch(() => {});
  }
  const fullProbe = await ffprobe(fullVideoPath);
  log(
    'step 09-rap',
    `full-video.mp4 codec=${fullProbe.codec} duration=${(fullProbe.duration ?? 0).toFixed(2)}s expected=${totalDur.toFixed(2)}s`,
  );

  // ---- 3. Final mux: full-video.mp4 + concat.wav → final.mp4 ----
  // Video re-encoded to scale source resolution to 1920×1080 with
  // letterbox/pillarbox padding (force_original_aspect_ratio=decrease + pad)
  // so any source aspect ratio fits cleanly without distortion. setsar=1
  // ensures square pixels in the output. Audio is taken from concat.wav
  // (input 1) via explicit `-map`; without that ffmpeg auto-selects the AAC
  // stream from full-video.mp4 instead and the song would never reach the
  // viewer.
  const nvencMode = (getSettings().nvenc_enabled as NvencMode) ?? 'auto';
  const { useNvenc, reason: encoderReason } = await pickEncoder(nvencMode);
  log('step 09-rap', `encoder=${useNvenc ? 'nvenc' : 'libx264'} (${encoderReason})`);
  const videoCodec = useNvenc
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'hq', '-rc', 'vbr', '-cq', '23']
    : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20'];
  const SCALE_PAD =
    'scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1';
  let lastLoggedPct = -10;
  await runFfmpegStreaming(
    [
      '-y',
      '-i',
      fullVideoPath,
      '-i',
      concatWavPath,
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-vf',
      SCALE_PAD,
      ...videoCodec,
      '-pix_fmt',
      'yuv420p',
      '-r',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      '-movflags',
      '+faststart',
      '-shortest',
      finalPath,
    ],
    {
      onStderrLine: (line) => {
        const elapsed = parseTimeSeconds(line);
        if (elapsed === null) return;
        const pct = Math.max(0, Math.min(99, Math.round((elapsed / totalDur) * 100)));
        if (pct >= lastLoggedPct + 10) {
          lastLoggedPct = pct;
          albumsRepo.patch(album.id, { videoProgressPct: pct });
          log('step 09-rap', `progress ${pct}%`);
        }
      },
    },
  );

  const finalProbe = await ffprobe(finalPath);
  const stat = await fs.promises.stat(finalPath);
  albumsRepo.patch(album.id, {
    videoStatus: 'rendered',
    finalVideoPath: finalPath,
    videoProgressPct: 100,
  });
  log(
    'step 09-rap',
    `done codec=${finalProbe.codec} audio=${finalProbe.audioCodec} duration=${(finalProbe.duration ?? 0).toFixed(3)}s ` +
      `dims=${finalProbe.width}x${finalProbe.height} size=${(stat.size / 1024 / 1024).toFixed(2)}MB`,
  );
}

function listBody(clips: BrollClip[]): string {
  return (
    clips
      .map((c) => `file '${escapeForConcat(forwardSlash(path.resolve(c.path)))}'`)
      .join('\n') + '\n'
  );
}

function forwardSlash(p: string): string {
  return p.replace(/\\/g, '/');
}

/** Same gotcha as src/lib/audio/concat.ts: paths with single quotes
 * terminate the `file '...'` string early and silently truncate the
 * concat demuxer's input list. Escape via FFmpeg's `'\''` sequence. */
function escapeForConcat(raw: string): string {
  return raw.replace(/'/g, "'\\''");
}

const TIME_RE = /time=(\d+):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/;

function parseTimeSeconds(line: string): number | null {
  const m = TIME_RE.exec(line);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const cs = m[4] ? Number(m[4].padEnd(2, '0').slice(0, 2)) / 100 : 0;
  return h * 3600 + min * 60 + s + cs;
}

async function fileDurationMatches(p: string, expected: number, tolerance: number): Promise<boolean> {
  if (!fs.existsSync(p)) return false;
  try {
    const probe = await ffprobe(p);
    if (probe.duration === undefined) return false;
    return Math.abs(probe.duration - expected) <= tolerance;
  } catch {
    return false;
  }
}

async function finalLooksCorrect(p: string, expectedDur: number): Promise<boolean> {
  if (!fs.existsSync(p)) return false;
  try {
    const probe = await ffprobe(p);
    if (probe.codec !== 'h264' || probe.audioCodec !== 'aac') return false;
    if (probe.duration === undefined) return false;
    // A 360p file from the prior stream-copy era should re-render, not skip.
    if (probe.width !== 1920 || probe.height !== 1080) return false;
    return Math.abs(probe.duration - expectedDur) <= FINAL_TOLERANCE_S;
  } catch {
    return false;
  }
}
