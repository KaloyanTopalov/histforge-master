/**
 * Generate 12 B-roll fixture clips under tests/fixtures/broll/rap-test/.
 * Used by the rap-compilation integration tests + the runtime verification.
 *
 * Idempotent: skips clips that already exist with the right size+format.
 * Run via `npm run fixtures:broll` or hooked into pretest.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);

const FIXTURES_DIR = path.join(
  process.cwd(),
  'tests',
  'fixtures',
  'broll',
  'rap-test',
);

// 12 clips with deliberately varied colors + durations so a deterministic
// shuffle picks visually distinct clips and the duration accumulator has
// enough headroom to fill arbitrary track lengths.
const CLIPS: { name: string; color: string; durationSec: number }[] = [
  { name: 'clip-01.mp4', color: 'blue', durationSec: 2 },
  { name: 'clip-02.mp4', color: 'red', durationSec: 3 },
  { name: 'clip-03.mp4', color: 'green', durationSec: 2 },
  { name: 'clip-04.mp4', color: 'yellow', durationSec: 3 },
  { name: 'clip-05.mp4', color: 'magenta', durationSec: 2 },
  { name: 'clip-06.mp4', color: 'cyan', durationSec: 3 },
  { name: 'clip-07.mp4', color: 'orange', durationSec: 2 },
  { name: 'clip-08.mp4', color: 'purple', durationSec: 3 },
  { name: 'clip-09.mp4', color: 'gray', durationSec: 2 },
  { name: 'clip-10.mp4', color: 'navy', durationSec: 3 },
  { name: 'clip-11.mp4', color: 'maroon', durationSec: 2 },
  { name: 'clip-12.mp4', color: 'teal', durationSec: 3 },
];

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  let generated = 0;
  let skipped = 0;
  for (const clip of CLIPS) {
    const dest = path.join(FIXTURES_DIR, clip.name);
    if (fs.existsSync(dest)) {
      const stat = fs.statSync(dest);
      if (stat.size > 0) {
        skipped++;
        continue;
      }
    }
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=${clip.color}:s=1920x1080:r=30:d=${clip.durationSec}`,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-tune',
        'stillimage',
        '-preset',
        'ultrafast',
        '-crf',
        '28',
        dest,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    generated++;
  }
  console.log(
    `[fixtures:broll] generated=${generated} skipped=${skipped} dir=${FIXTURES_DIR}`,
  );
}

main().catch((err) => {
  console.error('[fixtures:broll] failed:', err);
  process.exit(1);
});
