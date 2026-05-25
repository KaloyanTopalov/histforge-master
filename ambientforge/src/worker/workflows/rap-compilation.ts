import { step07RapAudioConcat } from '../steps/07-rap-audio-concat';
import { step09RapBrollMux } from '../steps/09-rap-broll-mux';
import {
  assertBrollPathAllowed,
  preflightBrollFolder,
  readAllowedBrollRoots,
} from '@/lib/broll/preflight';
import { requireSunoStylePromptSource } from './checks';
import type { PipelineStep } from '../pipeline';
import type {
  PreflightCheck,
  PreflightCheckResult,
  WorkflowDefinition,
} from './types';

/** Branch B for the rap-compilation pipeline: 07-rap → 09-rap.
 * Step 08 (loop-to-2h) is intentionally absent — rap compilations use the
 * natural sum of song durations and B-roll video, not a static-image loop. */
const branchBRap: PipelineStep = async (album, log) => {
  await step07RapAudioConcat(album, log);
  await step09RapBrollMux(album, log);
};

const requireBrollFolder: PreflightCheck = async ({ channel }): Promise<PreflightCheckResult> => {
  if (!channel) {
    return {
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
      message: 'rap-compilation pipeline requires a channel row',
    };
  }
  const p = channel.brollFolderPath;
  if (!p || p.trim().length === 0) {
    return {
      ok: false,
      code: 'BROLL_FOLDER_MISSING',
      message: `channel ${channel.id} has no brollFolderPath set`,
    };
  }
  const allowedRoots = readAllowedBrollRoots();
  const check = assertBrollPathAllowed(p, allowedRoots);
  if (!check.ok) {
    return {
      ok: false,
      code: 'BROLL_PATH_NOT_ALLOWED',
      message: `brollFolderPath ${p} rejected: ${check.reason} (code=${check.code})`,
    };
  }
  const result = await preflightBrollFolder(check.resolvedPath);
  if (!result.ok) {
    return {
      ok: false,
      code: 'BROLL_FOLDER_INVALID',
      message: `brollFolderPath ${p} failed preflight: ${result.reasons.join('; ')}`,
    };
  }
  return { ok: true };
};

export const rapCompilationWorkflow: WorkflowDefinition = {
  name: 'rap-compilation',
  // Smaller default because rap compilations are typically 8-15 tracks.
  // Channels can override to 30+ via channel.tracksPerAlbum.
  defaultTracksPerAlbum: 10,
  branchB: branchBRap,
  preflightChecks: [requireSunoStylePromptSource, requireBrollFolder],
  requiredChannelFields: ['brollFolderPath'],
};
