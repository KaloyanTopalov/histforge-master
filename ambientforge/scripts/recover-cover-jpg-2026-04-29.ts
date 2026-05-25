/**
 * One-off recovery: produce cover.jpg for failed album 01KQCG9YSY5P0V7S1XSAYJ8QA9.
 *
 * Branch B is complete (final.mp4 rendered). Branch A failed because cover.png
 * is 13.15 MB > DistroKid's 10 MB upload cap. Step 06 already prefers cover.jpg
 * sibling when present (with mtime guard). Generate the JPG so the operator can
 * click "Retry DistroKid only" and drag-drop cover.jpg.
 */
import fs from 'node:fs';
import path from 'node:path';
import { compressToJpeg, ffprobe } from '../src/lib/audio/ffmpeg';

const ALBUM_ID = '01KQCG9YSY5P0V7S1XSAYJ8QA9';
const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';
const THRESHOLD_MB = 9.5;

async function main(): Promise<void> {
  const albumDir = path.resolve('projects', CHANNEL_ID, ALBUM_ID);
  const coverPng = path.join(albumDir, 'cover.png');
  const coverJpg = path.join(albumDir, 'cover.jpg');

  if (!fs.existsSync(coverPng)) {
    throw new Error(`cover.png not found at ${coverPng}`);
  }

  const pngStatBefore = fs.statSync(coverPng);
  console.log(`[recover] cover.png path=${coverPng}`);
  console.log(
    `[recover] cover.png size=${(pngStatBefore.size / 1024 / 1024).toFixed(2)}MB mtime=${new Date(
      pngStatBefore.mtimeMs,
    ).toISOString()}`,
  );

  const targetBytes = Math.floor(THRESHOLD_MB * 1024 * 1024);
  const result = await compressToJpeg(coverPng, coverJpg, targetBytes);

  console.log(
    `[recover] cover.jpg q=${result.qScale} attempts=${result.attempts} size=${(
      result.finalSizeBytes /
      1024 /
      1024
    ).toFixed(2)}MB path=${result.outputPath}`,
  );

  // Verify JPEG header (FF D8) + ffprobe dimensions.
  const head = fs.readFileSync(coverJpg).subarray(0, 2);
  if (head[0] !== 0xff || head[1] !== 0xd8) {
    throw new Error(`cover.jpg has bad header: ${head.toString('hex')}`);
  }
  const probe = await ffprobe(coverJpg);
  console.log(
    `[recover] cover.jpg ffprobe: ${probe.width}x${probe.height} codec=${probe.codec ?? '?'}`,
  );
  if (probe.width !== 3000 || probe.height !== 3000) {
    throw new Error(`cover.jpg dimensions ${probe.width}x${probe.height} != 3000x3000`);
  }

  // Confirm cover.png is byte-for-byte unchanged.
  const pngStatAfter = fs.statSync(coverPng);
  if (pngStatAfter.size !== pngStatBefore.size) {
    throw new Error(
      `cover.png size changed: before=${pngStatBefore.size} after=${pngStatAfter.size}`,
    );
  }
  if (pngStatAfter.mtimeMs !== pngStatBefore.mtimeMs) {
    throw new Error(`cover.png mtime changed: before=${pngStatBefore.mtimeMs} after=${pngStatAfter.mtimeMs}`);
  }
  console.log(`[recover] cover.png unchanged: size=${pngStatAfter.size} mtime preserved`);
  console.log(`[recover] OK — operator can now drag-drop ${path.basename(coverJpg)} to DistroKid.`);
}

main().catch((err) => {
  console.error('[recover] FAILED:', err);
  process.exit(1);
});
