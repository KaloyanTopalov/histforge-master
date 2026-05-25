import type { Album } from '@/lib/repos/albums';
import type { Channel, Workflow } from '@/lib/repos/channels';
import type { Settings } from '@/lib/settings';
import type { PipelineStep } from '../pipeline';

/** Preflight context passed to every check. Channel may be null in pathological
 * cases (channel deleted between album creation and worker pickup). Each check
 * decides whether to fail loudly or treat that as recoverable. */
export type PreflightContext = {
  album: Album;
  channel: Channel | null;
  settings: Settings;
};

export type PreflightCheckResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export type PreflightCheck = (ctx: PreflightContext) => Promise<PreflightCheckResult>;

export type WorkflowDefinition = {
  name: Workflow;
  /** Spec default for tracks per album; channel.tracksPerAlbum overrides;
   * settings.tracks_per_album_override (test-only) trumps both. */
  defaultTracksPerAlbum: number;
  /** Optional override for step 01 (album brief). When set, the runner injects
   * this in place of the default `step01AlbumBrief`. ambient-video composes
   * `step01AlbumBrief → step01bSceneGenerator` here. */
  step01?: PipelineStep;
  /** Optional override for step 05a (cover image). When set, replaces the
   * default Flow-based cover step. ambient-video uses this to swap the Flow
   * call for a `source.jpg`-based copy + post-process. */
  step05a?: PipelineStep;
  /** Optional override for step 05b (thumbnail). When set, replaces the
   * default Flow-based thumbnail step. ambient-video uses this to generate
   * the thumbnail via the Magnific reference-image flow instead of Flow. */
  step05b?: PipelineStep;
  /** Branch B implementation (sequential video-render path). For ambient this
   * is 07→08→09; for rap-compilation it is 07-rap → 09-rap (no loop step). */
  branchB: PipelineStep;
  /** Run before step 01. Any non-ok result aborts the pipeline with the
   * given code. Empty list = no preflight. */
  preflightChecks: PreflightCheck[];
  /** Channel fields that must be non-null for this workflow. Surfaced in API
   * 400s when missing on POST/PATCH. */
  requiredChannelFields: (keyof Channel)[];
};
