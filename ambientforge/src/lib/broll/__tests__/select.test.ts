import { describe, it, expect } from 'vitest';
import { selectBroll, isVideoFile, type BrollClip } from '@/lib/broll/select';

const SAMPLE_CLIPS: BrollClip[] = Array.from({ length: 12 }, (_, i) => ({
  path: `/tmp/clip-${String(i + 1).padStart(2, '0')}.mp4`,
  durationSec: 2 + (i % 3), // durations 2, 3, 4, 2, 3, 4, ...
}));

describe('selectBroll', () => {
  it('returns enough clips to meet song duration', () => {
    const r = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'random-fill',
    });
    const total = r.reduce((s, c) => s + c.durationSec, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });

  it('is deterministic across runs (same album+track → same clips in order)', () => {
    const r1 = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'random-fill',
    });
    const r2 = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'random-fill',
    });
    expect(r2).toEqual(r1);
  });

  it('different track numbers produce different selections', () => {
    const r1 = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'random-fill',
    });
    const r2 = selectBroll({
      albumId: 'A1',
      trackNumber: 2,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'random-fill',
    });
    expect(r2.map((c) => c.path)).not.toEqual(r1.map((c) => c.path));
  });

  it('seeded-by-album: track number is ignored', () => {
    const r1 = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'seeded-by-album',
    });
    const r2 = selectBroll({
      albumId: 'A1',
      trackNumber: 99,
      clips: SAMPLE_CLIPS,
      songDurationSec: 30,
      strategy: 'seeded-by-album',
    });
    expect(r2.map((c) => c.path)).toEqual(r1.map((c) => c.path));
  });

  it('sequential strategy returns clips in path-sorted order', () => {
    const r = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: SAMPLE_CLIPS,
      songDurationSec: 5,
      strategy: 'sequential',
    });
    expect(r[0].path).toBe('/tmp/clip-01.mp4');
    expect(r[1].path).toBe('/tmp/clip-02.mp4');
  });

  it('cycles when total clip duration is less than song duration', () => {
    const tinyClips: BrollClip[] = [
      { path: '/a.mp4', durationSec: 1 },
      { path: '/b.mp4', durationSec: 1 },
    ];
    const r = selectBroll({
      albumId: 'A1',
      trackNumber: 1,
      clips: tinyClips,
      songDurationSec: 5,
      strategy: 'sequential',
    });
    const total = r.reduce((s, c) => s + c.durationSec, 0);
    expect(total).toBeGreaterThanOrEqual(5);
    expect(r.length).toBeGreaterThanOrEqual(5);
  });

  it('throws on empty clip list', () => {
    expect(() =>
      selectBroll({
        albumId: 'A1',
        trackNumber: 1,
        clips: [],
        songDurationSec: 5,
        strategy: 'sequential',
      }),
    ).toThrow();
  });
});

describe('isVideoFile', () => {
  it('accepts common video extensions', () => {
    expect(isVideoFile('clip.mp4')).toBe(true);
    expect(isVideoFile('clip.MOV')).toBe(true);
    expect(isVideoFile('clip.webm')).toBe(true);
    expect(isVideoFile('clip.mkv')).toBe(true);
  });

  it('rejects non-video files', () => {
    expect(isVideoFile('readme.md')).toBe(false);
    expect(isVideoFile('image.png')).toBe(false);
    expect(isVideoFile('notes.txt')).toBe(false);
  });
});
