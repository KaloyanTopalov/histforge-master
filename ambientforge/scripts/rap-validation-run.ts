/**
 * One-shot validation runner for the rap-compilation workflow. Runs the same
 * code paths as the production worker but against a copy of the DB and with
 * all *_MODE=mock so no real Suno/Flow/DistroKid calls happen.
 *
 * Pre-reqs: data/session-rap-validation.db must exist (copied from main DB)
 * with mock-mode settings already applied.
 *
 * Usage: tsx scripts/rap-validation-run.ts <channelId>
 */
import path from 'node:path';

// MUST set env vars BEFORE importing any module that reads process.env.
const VALIDATION_DB = path.join(process.cwd(), 'data', 'session-rap-validation.db');
process.env.AMBIENTFORGE_DB_PATH = VALIDATION_DB;
process.env.SUNO_MODE = 'mock';
process.env.FLOW_MODE = 'mock';
process.env.DISTROKID_MODE = 'mock';
process.env.OPENROUTER_API_KEY = 'mock';

import { runOnce } from '../src/worker/runner';
import * as albumsRepo from '../src/lib/repos/albums';
import * as channelsRepo from '../src/lib/repos/channels';
import { getDb } from '../src/lib/db';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const channelId = process.argv[2];
  if (!channelId) {
    console.error('usage: tsx scripts/rap-validation-run.ts <channelId>');
    process.exit(1);
  }

  const db = getDb();
  const channel = channelsRepo.get(channelId, db);
  if (!channel) {
    console.error(`channel not found: ${channelId}`);
    process.exit(1);
  }
  console.log(`channel: ${channel.name} workflow=${channel.workflow}`);
  console.log(`db: ${VALIDATION_DB}`);

  // Belt-and-suspenders: clear any stale in_progress albums from a previous run.
  const stuck = db
    .prepare("UPDATE albums SET status = 'queued' WHERE status = 'in_progress'")
    .run();
  if (stuck.changes > 0) {
    console.log(`recovered ${stuck.changes} in_progress album(s) -> queued`);
  }

  // Create the album.
  const album = albumsRepo.create(
    {
      channelId: channel.id,
      themePrompt: null,
      artistName: channel.distrokidArtistName,
      status: 'queued',
    },
    db,
  );
  console.log(`album created: id=${album.id} workflow=${album.workflow} status=${album.status}`);

  // Loop runOnce until terminal status.
  const startedAt = Date.now();
  const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes hard cap
  while (true) {
    if (Date.now() - startedAt > TIMEOUT_MS) {
      console.error(`TIMEOUT after ${TIMEOUT_MS}ms`);
      const cur = albumsRepo.get(album.id, db);
      console.error(`current status: ${cur?.status} videoStatus=${cur?.videoStatus} distrokidStatus=${cur?.distrokidStatus}`);
      process.exit(2);
    }
    const result = await runOnce({ db });
    const cur = albumsRepo.get(album.id, db);
    if (!cur) {
      console.error('album disappeared');
      process.exit(3);
    }
    console.log(
      `[tick] picked=${result.picked ?? 'none'} status=${cur.status} videoStatus=${cur.videoStatus} distrokidStatus=${cur.distrokidStatus} retryBranch=${cur.retryBranchOnly ?? 'none'}`,
    );
    if (cur.status === 'done' || cur.status === 'failed') {
      console.log(`\nFINAL: ${cur.status}`);
      if (cur.lastError) console.log(`lastError: ${cur.lastError}`);
      console.log(`albumId: ${cur.id}`);
      console.log(`channelId: ${cur.channelId}`);
      process.exit(cur.status === 'done' ? 0 : 1);
    }
    if (cur.status === 'awaiting_captcha' || cur.status === 'awaiting_suno_relogin') {
      console.error(`paused: ${cur.status} — should never happen in mock mode`);
      process.exit(4);
    }
    await sleep(500);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(5);
});
