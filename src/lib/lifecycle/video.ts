/**
 * Named composed multi-write transactional transitions over the `videos`
 * + `video_steps` aggregates. Each exported method opens its own
 * `db.transaction()` and composes atomic helpers from `lib/repos/videos`
 * and `lib/repos/steps`.
 *
 * Reentrant transactions are safe: better-sqlite3 nests an inner
 * `db.transaction(fn)` call as a SAVEPOINT, so a transition method
 * invoked from inside another lifecycle transition (e.g.
 * `flowLifecycle.requeueFailedTask` → `videoLifecycle.unfailToQueued`)
 * gets correct rollback propagation without shared-tx plumbing.
 *
 * Single-statement transitions live in callers, not here (narrow scope
 * per ADR-0007 §4): `markInProgress`, `setDeferredUntil` /
 * `clearDeferredUntil`, `setDeleteRequested`, `videosRepo.markDone`
 * finalize, `stepsRepo.markDone`. Internally-transactional repo helpers
 * (`createNewVideo`, `updateVideoDraft`, `transitionNewToQueued`,
 * `transitionAllNewToQueued`, `deleteVideoFullyRemoved`) also stay in
 * the repos because the composition is intrinsic to their identity.
 *
 * See ADR-0007 (`docs/adr/0007-video-and-flow-lifecycle-modules.md`)
 * for the full design rationale.
 */

import type { Database as DatabaseType } from "better-sqlite3";
import { rmSync } from "node:fs";
import { join } from "node:path";
import * as videosRepo from "@/lib/repos/videos";
import * as stepsRepo from "@/lib/repos/steps";
import * as videoPredicates from "@/lib/lifecycle/predicates/video";

export type PauseResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_pausable" };

export type ResumeResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_resumable" };

export type RetryResult =
  | { ok: true }
  | {
      ok: false;
      reason: "not_found" | "not_failed" | "missing_failed_step";
    };

export type RestartResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_restartable" };

export type RerenderLastStepResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "wrong_kind" | "not_done" };

/**
 * Atomic pause: read the video, guard via `videoPredicates.isPausable`,
 * flip `paused=1`. Read-check-write runs in one transaction so a
 * concurrent delete or status change cannot slip between the guard and
 * the write.
 */
export function pauseIfPausable(
  db: DatabaseType,
  videoId: string
): PauseResult {
  return db.transaction((): PauseResult => {
    const video = videosRepo.findById(db, videoId);
    if (!video) return { ok: false, reason: "not_found" };
    if (!videoPredicates.isPausable(video)) {
      return { ok: false, reason: "not_pausable" };
    }
    videosRepo.setPaused(db, videoId);
    return { ok: true };
  })();
}

/**
 * Atomic resume: read the video, guard via `videoPredicates.isResumable`,
 * flip `paused=0`. Status is intentionally unconstrained — a queued
 * video can be paused and resumed without ever entering `in_progress`.
 */
export function resumeIfResumable(
  db: DatabaseType,
  videoId: string
): ResumeResult {
  return db.transaction((): ResumeResult => {
    const video = videosRepo.findById(db, videoId);
    if (!video) return { ok: false, reason: "not_found" };
    if (!videoPredicates.isResumable(video)) {
      return { ok: false, reason: "not_resumable" };
    }
    videosRepo.clearPaused(db, videoId);
    return { ok: true };
  })();
}

/**
 * Re-queue a failed video from its failed step. Three writes in one
 * txn: reset the failed step row to pending, clear failure metadata on
 * the video, set status back to `queued`. Deliberately preserves
 * `started_at` (original pickup time) and leaves `current_step`
 * untouched — the orchestrator will set it on the next iteration.
 */
export function retry(db: DatabaseType, videoId: string): RetryResult {
  return db.transaction((): RetryResult => {
    const video = videosRepo.findById(db, videoId);
    if (!video) return { ok: false, reason: "not_found" };
    if (!videoPredicates.isRetryable(video)) {
      if (video.status !== "failed") {
        return { ok: false, reason: "not_failed" };
      }
      return { ok: false, reason: "missing_failed_step" };
    }
    // Predicate already proved failed_step is non-null.
    const failedStep = video.failed_step as string;
    stepsRepo.resetToPending(db, videoId, failedStep);
    videosRepo.clearFailure(db, videoId);
    videosRepo.setStatus(db, videoId, "queued");
    return { ok: true };
  })();
}

/**
 * Hard-delete a video: wipe its on-disk project directory, then remove
 * the video + video_steps rows. FS write precedes the DB write — if the
 * FS throws, the row stays as a marker; the inverse (DB-then-FS) would
 * leave orphan files with no row to find them by. `rmSync` with
 * `force:true` is a safe no-op on missing dirs so callers don't need to
 * pre-check.
 *
 * Note: `videosRepo.deleteVideoFullyRemoved` is internally transactional
 * (deletes step rows + video row in one txn), so the DB side is atomic
 * on its own; this method's "FS-precedes-DB" ordering is a separate
 * concern handled by sequencing.
 */
export function deleteFully(
  db: DatabaseType,
  videoId: string,
  projectsDir: string
): void {
  rmSync(join(projectsDir, videoId), { recursive: true, force: true });
  videosRepo.deleteVideoFullyRemoved(db, videoId);
}

/**
 * Restart a finished video (`failed` or `done`) from step 1: wipe the
 * on-disk project dir, then delete its step rows and reset the video
 * row. Active states (`new`, `queued`, `in_progress`) are rejected to
 * avoid a concurrency hazard with the orchestrator.
 *
 * Unlike the other read-check-write transitions, the eligibility read
 * lives OUTSIDE the inner `db.transaction()` — `rmSync` sits between
 * the check and the DB writes, and FS work can't roll back. The repo
 * writes are idempotent on missing rows, so a concurrent delete racing
 * with this method's pre-check just no-ops the DB side.
 *
 * FS removal precedes the DB transaction so a crash mid-restart leaves
 * the row pointing at no artifacts rather than vice versa. The
 * orchestrator's pre-loop upsert recreates the step rows on the next
 * tick. Ready-script videos still need `applyReadyScriptArtifacts` to
 * re-prep on-disk script files — the caller owns that, since
 * ready-script is its own concept (decision 7 in the handoff).
 */
export function restart(
  db: DatabaseType,
  videoId: string,
  projectsDir: string
): RestartResult {
  const video = videosRepo.findById(db, videoId);
  if (!video) return { ok: false, reason: "not_found" };
  if (!videoPredicates.isRestartable(video)) {
    return { ok: false, reason: "not_restartable" };
  }
  // rmSync with force:true tolerates missing dirs; runs BEFORE the DB
  // write to mirror deleteFully's FS-precedes-DB ordering.
  rmSync(join(projectsDir, videoId), { recursive: true, force: true });
  db.transaction(() => {
    stepsRepo.deleteAllForVideo(db, videoId);
    videosRepo.resetToQueued(db, videoId);
  })();
  return { ok: true };
}

/**
 * Re-render the last step of a finished music_video: wipe the cheap
 * outputs (final.mp4 + build/) on disk, then flip the `render_music_video`
 * step row back to pending and move the video back to `queued` so the
 * orchestrator picks it up on the next tick. The expensive Magnific
 * artifacts (`loop_image.png`, `loop_clip.mp4`) and the music outputs
 * (`songs/`, `thumbnail.jpg`, `pipeline.log`) are preserved by design —
 * that's the whole point of this action vs. `restart`.
 *
 * FS-precedes-DB ordering mirrors `restart()` above: `rmSync` runs
 * BEFORE the inner `db.transaction()` because the FS work can't roll
 * back. A crash between the FS wipe and the DB writes leaves the row
 * still showing `done` but with no `final.mp4` on disk — the operator
 * can re-click the action to retry.
 *
 * Eligibility is owned by `videoPredicates.isRerenderable` and the
 * reason-mapping fork mirrors `retry()`: not_found first, then a
 * predicate check that destructures into wrong_kind / not_done.
 * wrong_kind is checked before not_done because kind is immutable —
 * surfacing the deeper reason makes the error message more actionable.
 */
export function rerenderLastStep(
  db: DatabaseType,
  videoId: string,
  projectsDir: string
): RerenderLastStepResult {
  const video = videosRepo.findById(db, videoId);
  if (!video) return { ok: false, reason: "not_found" };
  if (!videoPredicates.isRerenderable(video)) {
    if (video.kind !== "music_video") {
      return { ok: false, reason: "wrong_kind" };
    }
    return { ok: false, reason: "not_done" };
  }
  const projDir = join(projectsDir, videoId);
  rmSync(join(projDir, "final.mp4"), { force: true });
  rmSync(join(projDir, "build"), { recursive: true, force: true });
  db.transaction(() => {
    stepsRepo.resetToPending(db, videoId, "render_music_video");
    videosRepo.setCurrentStep(db, videoId, null);
    videosRepo.setStatus(db, videoId, "queued");
  })();
  return { ok: true };
}

/**
 * Mark a step as the one in flight: flip its row to `running` with a
 * fresh `started_at`, and denormalize the step name onto
 * `videos.current_step` (used by the dashboard column). Atomic so an
 * observer never sees `current_step` and the step row disagree about
 * which step is in flight.
 */
export function enterStep(
  db: DatabaseType,
  videoId: string,
  stepName: string,
  atMs: number
): void {
  db.transaction(() => {
    stepsRepo.markRunning(db, videoId, stepName, atMs);
    videosRepo.setCurrentStep(db, videoId, stepName);
  })();
}

/**
 * DB side of step-failure recording: mark the step row failed and
 * mark the video failed (which also clears `current_step` for
 * consistency with the success/pause/session-lost paths — `failed_step`
 * already records which step failed). One transaction.
 *
 * Filesystem cleanup (log append, output deletion) is the orchestrator's
 * concern and runs BEFORE this call — if cleanup throws, this method
 * must not execute. See worker/pipeline.ts's `recordStepFailure` helper
 * for the FS-then-DB sequencing.
 */
export function recordStepFailure(
  db: DatabaseType,
  videoId: string,
  stepName: string,
  message: string,
  atMs: number
): void {
  db.transaction(() => {
    stepsRepo.markFailed(db, videoId, stepName, atMs);
    videosRepo.markFailed(db, videoId, stepName, message, atMs);
  })();
}

/**
 * Re-queue a failed video from its failed step. Mirror of `retry` for
 * internal callers that already know the video might be failed (no
 * caller-visible error path needed): resets the failed step row to
 * pending, clears failure metadata, sets status back to `queued`. Owns
 * the eligibility gate via `videoPredicates.isRetryable`, so callers
 * never need to pre-check — they pass any video id and read the boolean
 * return to learn whether the cascade fired.
 *
 * Called by `flowLifecycle.requeueFailedTask` to compose the resume
 * cascade (Phase 3) — the better-sqlite3 reentrant transaction means
 * this method's `db.transaction` nests as a SAVEPOINT inside the
 * caller's outer txn, so a throw here rolls the caller's writes back
 * too.
 *
 * Returns `true` when the cascade actually ran (video was failed with a
 * non-null `failed_step`), `false` when the video was missing, not
 * failed, or had a null `failed_step`.
 *
 * Open question (Task 1.8 Context): today the cascade does not clear
 * `deferred_until` or `paused`. Preserved as-is for now; surface if an
 * observed need arises.
 */
export function unfailToQueued(db: DatabaseType, videoId: string): boolean {
  return db.transaction((): boolean => {
    const video = videosRepo.findById(db, videoId);
    if (!video) return false;
    if (!videoPredicates.isRetryable(video)) return false;
    // Predicate proved failed_step is non-null.
    stepsRepo.resetToPending(db, videoId, video.failed_step as string);
    videosRepo.clearFailure(db, videoId);
    videosRepo.setStatus(db, videoId, "queued");
    return true;
  })();
}
