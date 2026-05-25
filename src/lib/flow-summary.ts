import type { Database as DatabaseType } from "better-sqlite3";
import * as gfRepo from "@/lib/repos/google-flow";
import { getSetting } from "@/lib/settings";
import type {
  GoogleFlowQueueKind,
  GoogleFlowQueueStatus,
  ModerationEvent,
} from "@/types";

export type FlowKindCounts = Record<GoogleFlowQueueStatus, number>;

/**
 * A queue row the dashboard surfaces in the "Manual review" card. Set
 * includes every `failed` row plus any non-`done` row that the moderation
 * loop has already rewritten — that second branch is what keeps the card
 * visible while an automatic rewrite is in flight, so the operator can
 * always cancel-and-override instead of being locked out until the
 * automatic retry settles.
 */
export interface FlowReviewItem {
  id: number;
  kind: GoogleFlowQueueKind;
  status: GoogleFlowQueueStatus;
  chunk_id: string | null;
  error_reason: string | null;
  retry_count: number;
  prompt: string;
  moderation_round: number;
}

/**
 * Per-kind moderation state — `round` is the highest moderation_round
 * across non-done queue rows of this kind (0 if none), and `pending`
 * counts failed-content-policy rows whose round is still < max_rounds
 * (i.e. eligible for another rewrite). Both fields are per-kind so the
 * UI can render an accurate inline indicator on each row without a
 * video-wide value bleeding across kinds.
 */
export interface FlowKindModerationSummary {
  round: number;
  pending: number;
}

export interface FlowModerationSummary {
  max_rounds: number;
  last_event_at: number | null;
  image: FlowKindModerationSummary;
  clip: FlowKindModerationSummary;
  events: ModerationEvent[];
}

export interface FlowSummary {
  image: FlowKindCounts;
  clip: FlowKindCounts;
  /**
   * Rows surfaced in the "Manual review" card. Superset of the failed
   * rows: also includes pending/dispatched rows whose moderation_round
   * is > 0 so the operator can intervene on an automatic retry in flight.
   */
  needs_review: FlowReviewItem[];
  moderation: FlowModerationSummary;
}

/**
 * Build the Flow progress summary for a video — used by both the
 * server-component pre-fetch (page.tsx) and the queue-summary API
 * route so the shape never drifts between the two entry points.
 *
 * The `moderation` block folds the content-policy moderation state into
 * the same poll: dashboard renders both the inline "round X/N" indicator
 * and the events panel from this single payload. Per-kind moderation
 * state mirrors the per-kind `image` / `clip` counts above.
 */
export function buildFlowSummary(
  db: DatabaseType,
  videoId: string
): FlowSummary {
  const events = gfRepo.listModerationEventsForVideo(db, videoId);
  const maxRounds = getSetting(
    "google_flow_content_moderation_max_rounds",
    db
  );

  return {
    image: gfRepo.countByStatusForVideo(db, videoId, "image"),
    clip: gfRepo.countByStatusForVideo(db, videoId, "clip"),
    needs_review: gfRepo.listRowsNeedingReview(db, videoId).map((r) => ({
      id: r.id,
      kind: r.kind,
      status: r.status,
      chunk_id: r.chunk_id,
      error_reason: r.error_reason,
      retry_count: r.retry_count,
      prompt: r.prompt,
      moderation_round: r.moderation_round,
    })),
    moderation: {
      max_rounds: maxRounds,
      last_event_at:
        events.length > 0 ? events[events.length - 1].created_at : null,
      image: kindModeration(db, videoId, "image", maxRounds),
      clip: kindModeration(db, videoId, "clip", maxRounds),
      events,
    },
  };
}

function kindModeration(
  db: DatabaseType,
  videoId: string,
  kind: GoogleFlowQueueKind,
  maxRounds: number
): FlowKindModerationSummary {
  const round = highestRoundForOpenRowsOfKind(db, videoId, kind);
  const pending = gfRepo
    .listFailedContentPolicyForVideo(db, videoId, kind)
    .filter((r) => r.moderation_round < maxRounds).length;
  return { round, pending };
}

function highestRoundForOpenRowsOfKind(
  db: DatabaseType,
  videoId: string,
  kind: GoogleFlowQueueKind
): number {
  const row = db
    .prepare(
      `SELECT MAX(moderation_round) AS r
         FROM google_flow_queue
        WHERE video_id = ? AND kind = ? AND status != 'done'`
    )
    .get(videoId, kind) as { r: number | null };
  return row.r ?? 0;
}
