/**
 * Deterministic B-roll clip selection for the rap-compilation workflow.
 * Given a folder of clips and a target song duration, returns a list of clips
 * whose total duration meets or exceeds the song length.
 *
 * Determinism: the seed is `hash(albumId + ':' + trackNumber)`, so the same
 * (album, track) always picks the same clips in the same order — regardless
 * of test re-runs or different machines. That makes the rap pipeline
 * reproducible: re-running step 09 produces the same final.mp4.
 */

import crypto from 'node:crypto';

export type BrollClip = {
  path: string;
  durationSec: number;
};

export type BrollStrategy = 'random-fill' | 'sequential' | 'seeded-by-album';

export type SelectBrollOpts = {
  albumId: string;
  trackNumber: number;
  clips: BrollClip[];
  songDurationSec: number;
  strategy: BrollStrategy;
};

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm', '.mkv'];

export function isVideoFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Hash an arbitrary string into a 32-bit unsigned integer. Used as the seed
 * for the deterministic shuffle. SHA-256 is overkill but cheap; we slice
 * the first 4 bytes and read them as uint32.
 */
function seedFrom(input: string): number {
  const h = crypto.createHash('sha256').update(input).digest();
  return h.readUInt32BE(0);
}

/**
 * Linear-congruential PRNG. xorshift would be faster but LCG keeps the math
 * obvious and well-tested. Returns a float in [0, 1).
 */
function lcgNext(state: { value: number }): number {
  state.value = (state.value * 1664525 + 1013904223) >>> 0;
  return state.value / 0x100000000;
}

/** Fisher-Yates shuffle parameterized by a seed. Returns a new array. */
function seededShuffle<T>(arr: T[], seed: number): T[] {
  const out = [...arr];
  const state = { value: seed >>> 0 };
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(lcgNext(state) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pick clips in the configured order, accumulating duration until the total
 * meets or exceeds `songDurationSec`. Returns the picked subset *in the
 * order they should be concat'd*. The total duration may exceed the song's
 * by up to one clip — step 09 trims to exact song duration after concat.
 *
 * If the total clip duration in the folder is less than the song duration,
 * we cycle through the picked order again (rare, but possible with tiny
 * fixture folders). Always returns at least one clip when input is non-empty.
 */
export function selectBroll(opts: SelectBrollOpts): BrollClip[] {
  if (opts.clips.length === 0) {
    throw new Error('selectBroll: clips array is empty');
  }
  if (opts.songDurationSec <= 0) {
    throw new Error(`selectBroll: songDurationSec must be > 0; got ${opts.songDurationSec}`);
  }

  const ordered = orderClips(opts);
  const picked: BrollClip[] = [];
  let acc = 0;
  let cursor = 0;
  while (acc < opts.songDurationSec) {
    const clip = ordered[cursor % ordered.length];
    picked.push(clip);
    acc += clip.durationSec;
    cursor += 1;
    // Safety net: even if every clip has 0 duration, don't loop forever.
    if (cursor > ordered.length * 1000) {
      throw new Error('selectBroll: clip durations sum to ~0; cannot fill song duration');
    }
  }
  return picked;
}

function orderClips(opts: SelectBrollOpts): BrollClip[] {
  if (opts.strategy === 'sequential') {
    return [...opts.clips].sort((a, b) => a.path.localeCompare(b.path));
  }
  // 'random-fill' and 'seeded-by-album' both seed off the album+track id; the
  // distinction is reserved for a future strategy where 'random-fill' might
  // re-seed every track but 'seeded-by-album' uses just the album id.
  // Today both produce a deterministic shuffle keyed on album+track.
  const seedKey =
    opts.strategy === 'seeded-by-album'
      ? opts.albumId
      : `${opts.albumId}:${opts.trackNumber}`;
  return seededShuffle(opts.clips, seedFrom(seedKey));
}
