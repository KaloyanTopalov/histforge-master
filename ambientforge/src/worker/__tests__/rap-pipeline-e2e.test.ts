/**
 * Rap-compilation end-to-end test (runtime verification — Check C).
 *
 * Exercises the new rap pipeline steps end-to-end against real fixtures:
 *   - 5 fixture audio WAVs from tests/fixtures/audio/concat-set/
 *   - 12 fixture B-roll MP4s generated on-demand under tests/fixtures/broll/rap-test/
 *
 * Verifies on disk:
 *   - build/concat.wav (no loop.wav)
 *   - build/song-NN-final.mp4 for each track
 *   - build/full-video.mp4
 *   - final.mp4 with correct codec + duration ≈ sum of song durations
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb, initSchema, __setDbForTests, type Db } from '@/lib/db';
import * as channelsRepo from '@/lib/repos/channels';
import * as albumsRepo from '@/lib/repos/albums';
import * as tracksRepo from '@/lib/repos/tracks';
import { setSetting } from '@/lib/settings';
import { ffprobe } from '@/lib/audio/ffmpeg';
import { step07RapInternal } from '@/worker/steps/07-rap-audio-concat';
import { step09RapInternal } from '@/worker/steps/09-rap-broll-mux';

const execFileAsync = promisify(execFile);

const AUDIO_FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'audio', 'concat-set');
const BROLL_FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'broll', 'rap-test');

let db: Db;
let workDir: string;
let projectsDir: string;

async function ensureBrollFixtures() {
  if (
    fs.existsSync(BROLL_FIXTURES) &&
    fs.readdirSync(BROLL_FIXTURES).filter((f) => f.endsWith('.mp4')).length >= 12
  ) {
    return;
  }
  fs.mkdirSync(BROLL_FIXTURES, { recursive: true });
  const colors = [
    'blue',
    'red',
    'green',
    'yellow',
    'magenta',
    'cyan',
    'orange',
    'purple',
    'gray',
    'navy',
    'maroon',
    'teal',
  ];
  for (let i = 0; i < 12; i++) {
    const dest = path.join(BROLL_FIXTURES, `clip-${String(i + 1).padStart(2, '0')}.mp4`);
    if (fs.existsSync(dest)) continue;
    const dur = 2 + (i % 3); // 2, 3, 4 seconds
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${colors[i]}:s=1920x1080:r=30:d=${dur}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-tune',
        'stillimage',
        '-preset',
        'ultrafast',
        '-crf',
        '32',
        dest,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
  }
}

beforeAll(async () => {
  await ensureBrollFixtures();
}, 120_000);

beforeEach(() => {
  db = openDb(':memory:');
  initSchema(db);
  __setDbForTests(db);
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rap-e2e-'));
  projectsDir = path.join(workDir, 'projects');
});

afterEach(() => {
  __setDbForTests(null);
  db.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const noopLog = (_stage: string, _msg: string) => {};

describe('rap-compilation pipeline e2e (Check C)', () => {
  it('produces final.mp4 with correct codec + duration via 07-rap → 09-rap', async () => {
    // C5 allowlist: step 09-rap now enforces broll_allowed_root_paths.
    setSetting(
      'broll_allowed_root_paths',
      JSON.stringify([path.join(process.cwd(), 'tests', 'fixtures', 'broll')]),
      db,
    );
    const channel = channelsRepo.create({
      name: 'rap-e2e',
      displayName: 'Rap E2E',
      description: 'rap test channel',
      scheduleCron: '0 9 * * 1',
      albumBriefTemplate: null,
      trackBriefsTemplate: null,
      coverPromptTemplate: null,
      thumbnailPromptTemplate: null,
      ytMetadataTemplate: null,
      distrokidArtistName: 'Rap E2E Artist',
      distrokidPrimaryGenre: 'Hip-Hop',
      distrokidLabelName: null,
      youtubeChannelId: null,
      youtubeChannelHandle: null,
      thumbnailOverlayText: null,
      spotifyPlaylistUrl: null,
      hashtags: '',
      workflow: 'rap-compilation',
      brollFolderPath: BROLL_FIXTURES,
      rapClipStrategy: 'random-fill',
    });
    const album = albumsRepo.create({
      channelId: channel.id,
      artistName: 'Rap E2E Artist',
    });
    expect(album.workflow).toBe('rap-compilation');

    // Insert 5 tracks with paths to the existing audio fixtures + ffprobe
    // duration. Real pipeline does this via step 04; for this e2e we shortcut.
    const fixtureWavs = ['01.wav', '02.wav', '03.wav', '04.wav', '05.wav'];
    for (let i = 0; i < fixtureWavs.length; i++) {
      const wavPath = path.join(AUDIO_FIXTURES, fixtureWavs[i]);
      const probe = await ffprobe(wavPath);
      tracksRepo.insertMany([
        {
          albumId: album.id,
          trackNumber: i + 1,
          title: `Track ${i + 1}`,
          fileName: `0${i + 1} - Track ${i + 1}.wav`,
          sunoLyrics: null,
        },
      ]);
      const created = tracksRepo.listByAlbum(album.id);
      const t = created.find((x) => x.trackNumber === i + 1)!;
      tracksRepo.patch(t.id, {
        audioPath: wavPath,
        duration: probe.duration ?? 0,
        status: 'done',
      });
    }

    const tracks = tracksRepo.listByAlbum(album.id);
    expect(tracks).toHaveLength(5);
    const totalDur = tracks.reduce((s, t) => s + t.duration, 0);
    expect(totalDur).toBeGreaterThan(0);

    // Step 07-rap: concat the 5 WAVs into build/concat.wav.
    await step07RapInternal(albumsRepo.get(album.id)!, noopLog, { projectsDir });
    const concatWavPath = path.join(
      projectsDir,
      channel.id,
      album.id,
      'build',
      'concat.wav',
    );
    expect(fs.existsSync(concatWavPath)).toBe(true);
    const loopPath = path.join(projectsDir, channel.id, album.id, 'build', 'loop.wav');
    // Step 08 is intentionally skipped for rap.
    expect(fs.existsSync(loopPath)).toBe(false);

    // Step 09-rap: per-track B-roll concat → trim → assemble → final mux.
    await step09RapInternal(albumsRepo.get(album.id)!, noopLog, { projectsDir });

    const buildDir = path.join(projectsDir, channel.id, album.id, 'build');
    for (const t of tracks) {
      const songFinal = path.join(
        buildDir,
        `song-${String(t.trackNumber).padStart(2, '0')}-final.mp4`,
      );
      expect(fs.existsSync(songFinal)).toBe(true);
    }
    const fullVideo = path.join(buildDir, 'full-video.mp4');
    expect(fs.existsSync(fullVideo)).toBe(true);

    const finalPath = path.join(projectsDir, channel.id, album.id, 'final.mp4');
    expect(fs.existsSync(finalPath)).toBe(true);

    const finalProbe = await ffprobe(finalPath);
    expect(finalProbe.codec).toBe('h264');
    expect(finalProbe.audioCodec).toBe('aac');
    expect(finalProbe.duration).toBeDefined();
    // Duration should be within ±3s of the sum of track durations (FFmpeg
    // -shortest can drift a tiny bit at GOP boundaries).
    expect(Math.abs((finalProbe.duration ?? 0) - totalDur)).toBeLessThan(3);

    // DB should reflect rendered state.
    const updatedAlbum = albumsRepo.get(album.id)!;
    expect(updatedAlbum.videoStatus).toBe('rendered');
    expect(updatedAlbum.finalVideoPath).toBe(finalPath);
    expect(updatedAlbum.videoProgressPct).toBe(100);
  }, 240_000);
});
