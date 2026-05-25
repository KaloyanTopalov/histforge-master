import * as albumsRepo from '@/lib/repos/albums';
import * as channelsRepo from '@/lib/repos/channels';
import { getSettings } from '@/lib/settings';
import type { Album } from '@/lib/repos/albums';
import { makePipelineLog, type LogFn } from './pipelineLog';
import type { PreflightCheck } from './workflows/types';

// Branch isolation invariant:
//   Branch A (DistroKid) may only write distrokid_* DB columns and projects/<ch>/<alb>/distrokid-*.png|json.
//   Branch B (video render) may only write video_* DB columns (incl. video_progress_pct) and
//     projects/<ch>/<alb>/build/* + final.mp4.
//   The orchestrator joins them via Promise.allSettled and proceeds to seqAfter only when both fulfill.
//
// Single permitted exception: step 06 may write album.status='awaiting_captcha' when the DistroKid
// extension reports a captcha challenge. The runner detects this state after runPipeline returns and
// skips the final status='done' write so the resume-captcha API can patch back to 'queued' once the
// operator solves the challenge.
//
// Per-branch retry: when album.retry_branch_only is set ('A' or 'B'), the orchestrator runs ONLY
// that branch and resolves the other to a no-op. The flag is cleared in a finally block so the
// next run is a normal full fork. Step 06 itself is idempotent (skips on existing dryrun artifact);
// branch B steps 07-09 are idempotent on their respective output files.

export type PipelineStep = (album: Album, log: LogFn) => Promise<void>;

export type PipelineDeps = {
  step01: PipelineStep;
  step02: PipelineStep;
  step03: PipelineStep;
  step04: PipelineStep;
  step05a: PipelineStep;
  step05b: PipelineStep;
  branchA: PipelineStep;
  branchB: PipelineStep;
  /** Runs ONLY when both fork branches succeed (post-join). */
  step10: PipelineStep;
  /**
   * Runs UNCONDITIONALLY after the fork (success or failure). Logs disk-size
   * summary + sets terminal album.status. Must not throw — its failure would
   * mask the underlying branch error.
   */
  step11: PipelineStep;
  /**
   * Optional workflow context. Production runner resolves the channel's
   * workflow and injects this. Tests can omit (no preflight runs, no name
   * gets logged — preserves the existing test behavior).
   */
  workflow?: {
    name: string;
    preflightChecks: PreflightCheck[];
  };
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const step01Noop: PipelineStep = async (_album, log) => {
  log('step01-noop', 'start');
  log('step01-noop', 'done');
};

export const step02Noop: PipelineStep = async (_album, log) => {
  log('step02-noop', 'start');
  log('step02-noop', 'done');
};

export const step03Noop: PipelineStep = async (_album, log) => {
  log('step03-noop', 'start');
  log('step03-noop', 'done');
};

export const step04Noop: PipelineStep = async (_album, log) => {
  log('step04-noop', 'start');
  log('step04-noop', 'done');
};

export const step05aNoop: PipelineStep = async (_album, log) => {
  log('step05a-noop', 'start');
  log('step05a-noop', 'done');
};

export const step05bNoop: PipelineStep = async (_album, log) => {
  log('step05b-noop', 'start');
  log('step05b-noop', 'done');
};

export const branchANoop: PipelineStep = async (_album, log) => {
  log('branchA-noop', 'start');
  await sleep(50);
  log('branchA-noop', 'done');
};

export const branchBNoop: PipelineStep = async (_album, log) => {
  log('branchB-noop', 'start');
  await sleep(50);
  log('branchB-noop', 'done');
};

export const seqNoop: PipelineStep = async (_album, log) => {
  log('seq-noop', 'start');
  await sleep(10);
  log('seq-noop', 'done');
};

export const step10Noop: PipelineStep = async (_album, log) => {
  log('step10-noop', 'start');
  log('step10-noop', 'done');
};

export const step11Noop: PipelineStep = async (_album, log) => {
  log('step11-noop', 'start');
  log('step11-noop', 'done');
};

export const defaultDeps: PipelineDeps = {
  step01: step01Noop,
  step02: step02Noop,
  step03: step03Noop,
  step04: step04Noop,
  step05a: step05aNoop,
  step05b: step05bNoop,
  branchA: branchANoop,
  branchB: branchBNoop,
  step10: step10Noop,
  step11: step11Noop,
};

export class PipelineError extends Error {
  readonly causes: unknown[];
  constructor(message: string, causes: unknown[]) {
    super(message);
    this.name = 'PipelineError';
    this.causes = causes;
  }
}

function stringifyErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Wrap branch A so a rejection patches distrokid_status='failed' before
 * propagating. Step 06 writes most of its terminal states itself, but on a
 * thrown DistrokidError before any patch we still need a consistent column.
 * Skipped on retry-branch=B.
 */
async function runBranchA(
  album: Album,
  deps: PipelineDeps,
  log: LogFn,
  skip: boolean,
): Promise<void> {
  if (skip) {
    log('orchestrator', 'branch-A skipped (retry-branch=B)');
    return;
  }
  try {
    await deps.branchA(album, log);
  } catch (err) {
    try {
      const fresh = albumsRepo.get(album.id);
      if (fresh && fresh.distrokidStatus !== 'failed') {
        albumsRepo.patch(album.id, { distrokidStatus: 'failed' });
      }
    } catch {
      // best-effort — never mask the original error
    }
    throw err;
  }
}

/** Wrap branch B so a rejection patches video_status='failed'. Step 09 writes
 * 'rendered' on success; we own 'failed' for any throw across 07/08/09.
 * Skipped on retry-branch=A. */
async function runBranchB(
  album: Album,
  deps: PipelineDeps,
  log: LogFn,
  skip: boolean,
): Promise<void> {
  if (skip) {
    log('orchestrator', 'branch-B skipped (retry-branch=A)');
    return;
  }
  try {
    await deps.branchB(album, log);
  } catch (err) {
    try {
      albumsRepo.patch(album.id, { videoStatus: 'failed' });
    } catch {
      // best-effort
    }
    throw err;
  }
}

export async function runPipeline(
  album: Album,
  deps: PipelineDeps = defaultDeps,
): Promise<void> {
  const log = makePipelineLog(album.id);
  log('orchestrator', 'start');
  if (deps.workflow) {
    log('orchestrator', `workflow=${deps.workflow.name}`);
  }
  // The runner refetches the album immediately before calling runPipeline, so
  // retry_branch_only is already current. Capture it once — re-reading mid-run
  // could race a parallel PATCH from the API.
  const retryOnly = album.retryBranchOnly;
  if (retryOnly) {
    log('orchestrator', `retry-branch=${retryOnly} (skipping the other branch + steps 01-05b)`);
  } else {
    // Preflight checks (workflow-injected) run BEFORE step 01. Failures
    // surface as PipelineError so the runner patches status='failed' and the
    // operator sees a clear code in the dashboard banner.
    if (deps.workflow && deps.workflow.preflightChecks.length > 0) {
      const channel = channelsRepo.get(album.channelId);
      const settings = getSettings();
      for (const check of deps.workflow.preflightChecks) {
        const result = await check({ album, channel, settings });
        if (!result.ok) {
          log('orchestrator', `preflight-fail code=${result.code} msg=${result.message}`);
          throw new PipelineError(
            `preflight failed: ${result.code}`,
            [new Error(`${result.code}: ${result.message}`)],
          );
        }
      }
      log('orchestrator', `preflight ok (${deps.workflow.preflightChecks.length} checks)`);
    }
    await deps.step01(album, log);
    await deps.step02(album, log);
    await deps.step03(album, log);
    await deps.step04(album, log);
    await deps.step05a(album, log);
    await deps.step05b(album, log);
  }
  log('orchestrator', 'fork-start');
  try {
    const results = await Promise.allSettled([
      runBranchA(album, deps, log, retryOnly === 'B'),
      runBranchB(album, deps, log, retryOnly === 'A'),
    ]);
    const [a, b] = results;
    const failures: string[] = [];
    const causes: unknown[] = [];
    if (a.status === 'rejected') {
      failures.push('branchA');
      causes.push(a.reason);
    }
    if (b.status === 'rejected') {
      failures.push('branchB');
      causes.push(b.reason);
    }
    // captcha pause is a deliberate clean-return from step 06 — bail out
    // before step 10/11 so the runner can detect awaiting_captcha and skip
    // the terminal status write. Resume-captcha API patches the album back
    // to 'queued' for a fresh run.
    const afterFork = albumsRepo.get(album.id);
    if (afterFork?.status === 'awaiting_captcha') {
      log('orchestrator', 'awaiting_captcha — skipping step 10/11');
      return;
    }
    if (failures.length > 0) {
      log('orchestrator', `fork-fail: ${failures.join(' + ')}`);
      // Surface each branch's actual error to pipeline.log so triage doesn't
      // require digging through runner stderr. Without this the operator only
      // sees the branch name, not the underlying code/message.
      for (let i = 0; i < failures.length; i++) {
        log('orchestrator', `  ${failures[i]} cause: ${stringifyErr(causes[i])}`);
      }
    } else {
      log('orchestrator', 'fork-join-ok');
      await deps.step10(album, log);
    }
    // Step 11 runs unconditionally — even on failure — so disk size +
    // terminal status get logged. Errors thrown here are swallowed so they
    // don't mask the branch failure that already occurred.
    try {
      await deps.step11(album, log);
    } catch (err) {
      log('orchestrator', `step 11 swallowed-error: ${stringifyErr(err)}`);
    }
    if (failures.length > 0) {
      throw new PipelineError(
        `pipeline failed in ${failures.join(' + ')}`,
        causes,
      );
    }
    log('orchestrator', 'pipeline-complete');
  } finally {
    // One-shot retry semantics: clear the flag whether we succeeded or failed.
    if (retryOnly) {
      try {
        albumsRepo.patch(album.id, { retryBranchOnly: null });
      } catch {
        // best-effort
      }
    }
  }
}
