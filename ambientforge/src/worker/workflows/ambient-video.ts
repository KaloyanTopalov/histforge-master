import path from 'node:path';
import { ffprobe } from '@/lib/audio/ffmpeg';
import { step01AlbumBrief } from '../steps/01-album-brief';
import { step01bSceneGenerator } from '../steps/01b-scene-generator';
import { step05aAmbientVideoCover } from '../steps/05a-ambient-video-cover';
import { step05bAmbientVideoThumbnail } from '../steps/05b-ambient-video-thumbnail';
import { step07AudioConcat } from '../steps/07-audio-concat';
import { step08SeedanceClip } from '../steps/08-seedance-clip';
import { step09AmbientVideoInternal } from '../steps/09-ambient-video-mux';
import {
  requireSceneThemesValidOrNull,
  requireSourceJpg,
  requireSunoStylePromptSource,
} from './checks';
import { step05bNoop, type PipelineStep } from '../pipeline';
import type { WorkflowDefinition } from './types';

/** Composed step 01: album brief first, then scene generator. */
const step01Composed: PipelineStep = async (album, log) => {
  await step01AlbumBrief(album, log);
  await step01bSceneGenerator(album, log);
};

/**
 * How many times the full song set repeats in the final video.
 *   1 = "normal" — every song once, no repeat (final ≈ the natural concat)
 *   2 = every song heard twice (the original spec default)
 *   3 = every song heard three times
 * Default 2 — kept for every non-launcher ambient-video run and all tests.
 * The medieval one-click launcher (make-medieval-video.bat) prompts the
 * operator for 1, 2 or 3 and exports AMBIENT_VIDEO_LOOP_FACTOR; the worker
 * runs in-process (the .bat → make-medieval-video.ts → runForever() → this
 * branch are one process) so the env var is visible here. Only the literals
 * "1" / "3" select 1× / 3× — anything else (unset / "2" / garbage) falls
 * back to the safe default of 2. Exported so the launcher banner resolves
 * the factor through the same logic (no drift).
 */
export function resolveAmbientVideoLoopFactor(): 1 | 2 | 3 {
  const v = process.env.AMBIENT_VIDEO_LOOP_FACTOR;
  if (v === '1') return 1;
  if (v === '3') return 3;
  return 2;
}

/**
 * Branch B for the ambient-video pipeline: 07 → 08-seedance → 09-ambient-video-mux.
 *
 * After step 07 writes concat.wav, we ffprobe it and pass
 * `targetSecondsOverride = floor(factor × duration)` to step 09 so the bed
 * plays through `factor` times exactly — every song heard `factor` times
 * (factor ∈ {1, 2, 3}, default 2; 1 = single pass / no repeat;
 * see resolveAmbientVideoLoopFactor).
 * Channel.targetVideoSeconds is ignored for ambient-video albums; it's the
 * wrong unit (a per-channel constant) for a per-album "exact factor× through"
 * semantic.
 */
const branchBAmbientVideo: PipelineStep = async (album, log) => {
  await step07AudioConcat(album, log);
  const concatPath = path.join(
    process.cwd(),
    'projects',
    album.channelId,
    album.id,
    'build',
    'concat.wav',
  );
  const probe = await ffprobe(concatPath);
  const concatDuration = probe.duration ?? 0;
  const factor = resolveAmbientVideoLoopFactor();
  const targetSecondsOverride = Math.floor(factor * concatDuration);
  log(
    'branch-B-amv',
    `${factor}x bed: concat=${concatDuration.toFixed(2)}s → target=${targetSecondsOverride}s (every song heard ${factor}x)`,
  );
  await step08SeedanceClip(album, log);
  await step09AmbientVideoInternal(album, log, { targetSecondsOverride });
  // Thumbnail runs LAST in branch B — strictly AFTER step 08. step 08
  // (Seedance) reads its START frame from whatever image is the just-generated
  // result in the shared Magnific tab; its END frame is source.jpg (CDP
  // upload) for a seamless loop. The original Task 11 placement ran this
  // Magnific reference-thumbnail step PRE-FORK (before step 08), so step 08
  // animated a title-text thumbnail → text baked into the video bed AND
  // start≠end (no loop). Running it here keeps step 08 on the clean cover.
  // Best-effort: a flaky Magnific thumbnail must not fail an already-rendered
  // video (the 4 thumbs are a deferred-selection extra, not the deliverable).
  try {
    await step05bAmbientVideoThumbnail(album, log);
  } catch (err) {
    const code =
      err instanceof Error ? (err as { code?: string }).code ?? err.message : String(err);
    log('branch-B-amv', `thumbnail step failed (non-fatal — video already rendered): ${code}`);
  }
};

export const ambientVideoWorkflow: WorkflowDefinition = {
  name: 'ambient-video',
  defaultTracksPerAlbum: 30,
  step01: step01Composed,
  step05a: step05aAmbientVideoCover,
  // Pre-fork slot is a noop: the Magnific thumbnail must NOT run before the
  // fork (it pollutes the Magnific tab that step 08 reads). It is invoked at
  // the end of branchBAmbientVideo instead. (A bare fallback here would run
  // the Flow-based step05bThumbnail, which ambient-video has no Flow for.)
  step05b: step05bNoop,
  branchB: branchBAmbientVideo,
  preflightChecks: [
    requireSunoStylePromptSource,
    requireSourceJpg,
    requireSceneThemesValidOrNull,
  ],
  requiredChannelFields: [],
};
