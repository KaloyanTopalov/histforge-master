/**
 * Pure predicates over `Video` row state. No DB access, no logging, no
 * side effects. The lifecycle module guards (in `lib/lifecycle/video.ts`)
 * and the route / UI guards (API routes under `app/api/videos/`, the
 * dashboard action buttons under `app/videos/`) should consume these
 * predicates instead of inlining `video.status === ...` comparisons —
 * that's the SRP split that lets the lifecycle modules stay narrow and
 * keeps presentation in sync with the API's eligibility rules.
 *
 * Convention: import as `import * as videoPredicates from
 * "@/lib/lifecycle/predicates/video"` and call site-by-site (matches the
 * `videosRepo` / `stepsRepo` / `gfRepo` style used elsewhere).
 */

import type { Video } from "@/types";

/**
 * True when the API accepts a pause request: a queued or in-progress video
 * that is not already paused and not pending deletion. The dashboard's
 * narrower `canPauseVideo` (in `app/videos/_shared.tsx`) intentionally
 * requires `in_progress` only — both behaviors are valid, the API surface
 * is broader so a queued-but-not-yet-started video can be paused too.
 */
export function isPausable(video: Video): boolean {
  return (
    (video.status === "queued" || video.status === "in_progress") &&
    video.delete_requested === 0 &&
    video.paused === 0
  );
}

/**
 * True when the API accepts a resume request: a paused video that is not
 * pending deletion. Status is intentionally unconstrained — a queued
 * video can be paused and resumed without ever entering `in_progress`.
 */
export function isResumable(video: Video): boolean {
  return video.paused === 1 && video.delete_requested === 0;
}

/**
 * True when the retry route accepts: video is failed and the failed_step
 * is recorded. A `failed` row with `failed_step=null` is corrupt — the
 * route surfaces 500 rather than silently no-op'ing — so the predicate
 * still flags it as not-retryable.
 */
export function isRetryable(video: Video): boolean {
  return video.status === "failed" && video.failed_step !== null;
}

/**
 * True when the restart route accepts: video has reached a terminal
 * state (`failed` or `done`). Active states (`new`, `queued`,
 * `in_progress`) are rejected to avoid a concurrency hazard with the
 * orchestrator.
 */
export function isRestartable(video: Video): boolean {
  return video.status === "failed" || video.status === "done";
}

/**
 * True for every video — the DELETE route accepts all statuses and
 * branches behavior (in_progress defers via `setDeleteRequested`,
 * everything else wipes immediately). The predicate exists for symmetry
 * with the others and so a future "delete forbidden" rule has a single
 * place to land.
 */
export function isDeletable(_video: Video): boolean {
  return true;
}

/**
 * True when the re-render-last-step action accepts: a finished
 * music_video. Narrative videos don't have an equivalent surface (their
 * render step's inputs — chunks/, alignment, images, clips — are
 * intermediate enough that re-render needs its own design), and a
 * music_video that hasn't reached `done` has nothing to re-render yet.
 */
export function isRerenderable(video: Video): boolean {
  return video.kind === "music_video" && video.status === "done";
}

/**
 * True when the operator-triggered cleanup endpoint accepts: a finished
 * video. Non-done statuses are rejected uniformly because the dashboard
 * surface is done-only — there's no scenario where the operator wants to
 * wipe a queued / in_progress / failed video's intermediates from this
 * action (failed videos still need their intermediates for recovery,
 * which is the whole reason the auto-cleanup gate exists).
 */
export function isCleanupable(video: Video): boolean {
  return video.status === "done";
}
