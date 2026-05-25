// Load .env.local before any module reads process.env (db.ts, settings.ts, etc.).
// Next.js auto-loads .env.local; tsx does not, so the worker has to.
import { config as dotenvConfig } from 'dotenv';
import path from 'node:path';
dotenvConfig({ path: path.join(process.cwd(), '.env.local'), override: false });

import { getDb, type Db } from '@/lib/db';
import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { getSettings } from '@/lib/settings';
import { tryAutoResumeAfterBridgeRecovery } from './bridge-recovery';
import {
  runPipeline,
  type PipelineDeps,
} from './pipeline';
import { step01AlbumBrief } from './steps/01-album-brief';
import { step02TrackBriefs } from './steps/02-track-briefs';
import { step03SunoGenerate } from './steps/03-suno-generate';
import { step04SunoDownload } from './steps/04-suno-download';
import { step05aCoverImage } from './steps/05a-cover-image';
import { step05bThumbnail } from './steps/05b-thumbnail';
import { step06DistrokidSubmit } from './steps/06-distrokid-submit';
import { step10YoutubeMetadata } from './steps/10-youtube-metadata';
import { step11Finalize } from './steps/11-finalize';
import { getWorkflow } from './workflows';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export type RunnerDeps = {
  db?: Db;
  pipelineDeps?: PipelineDeps;
};

export type RunOnceResult = {
  picked: string | null;
  finalStatus: 'done' | 'failed' | null;
};

/**
 * Reset any albums stuck in `in_progress` back to `queued`.
 * Run on worker startup to recover cleanly from kill -9 / crashes.
 *
 * Also clears the `suno_cookie_rotated` and `suno_bridge_disrupted` flags —
 * stale flags from a crashed worker would otherwise show the banner forever
 * even though the runtime state is fresh.
 */
export function recoverInProgress(db: Db = getDb()): number {
  const info = db
    .prepare("UPDATE albums SET status = 'queued', updated_at = ? WHERE status = 'in_progress'")
    .run(Date.now());
  db.prepare("DELETE FROM settings WHERE key = 'suno_cookie_rotated'").run();
  db.prepare("DELETE FROM settings WHERE key = 'suno_bridge_disrupted'").run();
  return info.changes;
}

/**
 * Single tick of the worker loop. Returns what (if anything) was processed.
 * Strictly serial: refuses to pick a new album while any album is in_progress.
 */
export async function runOnce(deps: RunnerDeps = {}): Promise<RunOnceResult> {
  const db = deps.db ?? getDb();
  const settings = getSettings(db);
  if (settings.queue_state !== 'running') {
    return { picked: null, finalStatus: null };
  }
  // Phase-3 auto-resume: when an album was paused mid-step-03/04 because the
  // Suno bridge / Chrome chain disrupted, this probes the chain on each tick
  // (throttled to 30s). When healthy again, the paused album returns to
  // 'queued' and step 03 picks up exactly the unsubmitted tracks. Cookie-
  // rotation pauses are skipped — those need `npm run suno:login`.
  await tryAutoResumeAfterBridgeRecovery(db).catch((err) => {
    console.error('[runner] bridge-recovery probe error:', err);
  });
  if (albumsRepo.hasInProgress(db)) {
    return { picked: null, finalStatus: null };
  }
  const album = albumsRepo.nextQueued(db);
  if (!album) {
    return { picked: null, finalStatus: null };
  }
  albumsRepo.patch(album.id, { status: 'in_progress' }, db);
  const inProgress = albumsRepo.get(album.id, db)!;
  // Resolve workflow once per album. The album row was created with a
  // workflow snapshot, but we read from the channel here so a channel
  // configured AFTER album creation still gets its workflow honored. (In
  // practice the snapshot and the channel agree; this is defense-in-depth.)
  const channel = channelsRepo.get(inProgress.channelId, db);
  const workflow = getWorkflow(channel?.workflow ?? inProgress.workflow);
  const pipelineDeps: PipelineDeps = deps.pipelineDeps ?? {
    step01: workflow.step01 ?? step01AlbumBrief,
    step02: step02TrackBriefs,
    step03: step03SunoGenerate,
    step04: step04SunoDownload,
    step05a: workflow.step05a ?? step05aCoverImage,
    step05b: workflow.step05b ?? step05bThumbnail,
    branchA: step06DistrokidSubmit,
    branchB: workflow.branchB,
    step10: step10YoutubeMetadata,
    step11: step11Finalize,
    workflow: {
      name: workflow.name,
      preflightChecks: workflow.preflightChecks,
    },
  };
  try {
    await runPipeline(inProgress, pipelineDeps);
    const after = albumsRepo.get(album.id, db);
    // Deliberate pauses set by step 06 (DistroKid captcha) or step 04 (Suno
    // cookie rotation). Resume endpoints patch status back to 'queued'.
    if (after?.status === 'awaiting_captcha' || after?.status === 'awaiting_suno_relogin') {
      return { picked: album.id, finalStatus: null };
    }
    // Step 11's terminal verdict is authoritative. If it set 'failed' (e.g.,
    // retry-branch=B succeeded but branch A is still failed → Album E bug),
    // do NOT overwrite with 'done'.
    if (after?.status === 'failed') {
      return { picked: album.id, finalStatus: 'failed' };
    }
    if (after?.status !== 'done') {
      albumsRepo.patch(album.id, { status: 'done' }, db);
    }
    return { picked: album.id, finalStatus: 'done' };
  } catch (err) {
    console.error(`[runner] album ${album.id} failed:`, err);
    const after = albumsRepo.get(album.id, db);
    if (after?.status === 'awaiting_captcha' || after?.status === 'awaiting_suno_relogin') {
      return { picked: album.id, finalStatus: null };
    }
    const errMsg = formatErrorForDb(err);
    if (after?.status === 'failed' || after?.status === 'done') {
      // Preserve the existing terminal verdict but record the catch-site error
      // if the row doesn't already carry one (step 11 may have set its own).
      if (after.status === 'failed' && !after.lastError) {
        albumsRepo.patch(album.id, { lastError: errMsg }, db);
      }
      return { picked: album.id, finalStatus: after.status };
    }
    albumsRepo.patch(album.id, { status: 'failed', lastError: errMsg }, db);
    return { picked: album.id, finalStatus: 'failed' };
  }
}

function formatErrorForDb(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const codeStr = typeof code === 'string' ? `${code}: ` : '';
    return `${codeStr}${err.message}`.slice(0, 2000);
  }
  return String(err).slice(0, 2000);
}

const POLL_INTERVAL_MS = 1000;

let stopRequested = false;

export async function runForever(): Promise<void> {
  console.log('[runner] startup');
  const recovered = recoverInProgress();
  if (recovered > 0) {
    console.log(`[runner] recovered ${recovered} in_progress album(s) -> queued`);
  }
  const handleSignal = (sig: string) => {
    console.log(`[runner] ${sig} - shutting down after current tick`);
    stopRequested = true;
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  while (!stopRequested) {
    try {
      await runOnce();
    } catch (err) {
      console.error('[runner] tick error:', err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.log('[runner] exited');
}

// Auto-start when invoked directly (via `tsx src/worker/runner.ts` or the
// concurrently dev script). Tests import this module without triggering the loop
// because vitest's process.argv[1] points at the vitest binary, not at runner.ts.
const invokedPath = process.argv[1] ?? '';
if (invokedPath.endsWith('runner.ts') || invokedPath.endsWith('runner.js')) {
  runForever().catch((err) => {
    console.error('[runner] fatal:', err);
    process.exit(1);
  });
}
