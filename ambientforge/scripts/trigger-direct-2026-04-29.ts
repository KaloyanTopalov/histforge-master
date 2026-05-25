/**
 * Trigger 3 mock albums directly via runner.runOnce, bypassing /api/albums and
 * Next.js entirely (avoids .next-dir contention with concurrent prod dev).
 *
 * Usage: AMBIENTFORGE_DB_PATH=data/session-prompt-validation.db SUNO_MODE=mock FLOW_MODE=mock DISTROKID_MODE=mock tsx scripts/trigger-direct-2026-04-29.ts
 */
import * as channelsRepo from '../src/lib/repos/channels';
import * as albumsRepo from '../src/lib/repos/albums';
import { recoverInProgress, runOnce } from '../src/worker/runner';
import { openDb } from '../src/lib/db';

const CHANNEL_ID = '01KQ7HRA4SJ9GX6JMC4Q3CNWR1';
const N = 3;

async function main(): Promise<void> {
  console.log(`Direct pipeline run; AMBIENTFORGE_DB_PATH=${process.env.AMBIENTFORGE_DB_PATH ?? '(default)'}`);
  console.log(`SUNO_MODE=${process.env.SUNO_MODE} FLOW_MODE=${process.env.FLOW_MODE} DISTROKID_MODE=${process.env.DISTROKID_MODE}`);

  const recovered = recoverInProgress();
  if (recovered > 0) console.log(`recovered ${recovered} in_progress -> queued`);

  const channel = channelsRepo.get(CHANNEL_ID);
  if (!channel) {
    console.error(`channel ${CHANNEL_ID} not found`);
    process.exit(1);
  }
  console.log(`channel: ${channel.displayName} workflow=${channel.workflow}`);

  const albumIds: string[] = [];

  for (let i = 1; i <= N; i++) {
    const album = albumsRepo.create({
      channelId: CHANNEL_ID,
      themePrompt: null,
      artistName: channel.distrokidArtistName,
      status: 'queued',
    });
    albumIds.push(album.id);
    console.log(`\n--- album ${i}/${N}: ${album.id} ---`);

    const startedAt = Date.now();
    let lastStatus = '';
    while (true) {
      const result = await runOnce();
      const fresh = albumsRepo.get(album.id);
      if (!fresh) throw new Error(`album ${album.id} disappeared from DB`);
      const sig = `status=${fresh.status} video=${fresh.videoStatus} dk=${fresh.distrokidStatus}`;
      if (sig !== lastStatus) {
        console.log(`  ${sig}`);
        lastStatus = sig;
      }
      if (fresh.status === 'done') break;
      if (fresh.status === 'failed') {
        console.error(`  FAILED at ${sig}`);
        process.exit(2);
      }
      // No work picked but album not done — should not happen with mock-mode synchronous flow.
      if (result.picked === null && fresh.status === 'queued') {
        console.error('  runner did not pick the queued album; exiting');
        process.exit(3);
      }
    }
    console.log(`  done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  }

  console.log(`\n${N} albums done`);
  console.log('album_ids:', albumIds.join(' '));

  // Print so the validate script can pick them up via stdout if piped.
  console.log('\n--- ALBUM_IDS ---');
  for (const id of albumIds) console.log(id);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
