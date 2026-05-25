import type { Database as DatabaseType } from "better-sqlite3";
import { getSetting } from "./settings";
import * as videosRepo from "./repos/videos";
import * as stepsRepo from "./repos/steps";
import * as gfRepo from "./repos/google-flow";
import type { QueueState, VideoListItem } from "@/types";

export interface FlowRecoveryAccount {
  id: string;
  name: string;
  required_at: number;
}

/**
 * Operator-facing Flow flags surfaced via the videos poller. Grouped so
 * the `useVideoPoller` hook signature, the page server-fetch, and the
 * `/api/videos` wire response stay stable when a new banner flag is
 * added — the only edits are this interface + the setting reads inside
 * `getVideosPageState`.
 */
export interface BannerFlags {
  // Raw `flow_create_project_failed` setting — empty string means no
  // failure pending. Parsed defensively inside `<FlowFailureBanner>`.
  flowCreateProjectFailed: string;
  // Raw `flow_service_overload_until` setting (Unix-seconds string) —
  // empty string means no service-overload pause pending. Parsed
  // defensively inside `<FlowServiceOverloadBanner>` (auto-clears when
  // the timestamp elapses).
  flowServiceOverloadUntil: string;
  // Coerced boolean from `google_flow_relogin_needed`.
  googleFlowReloginNeeded: boolean;
  // Per-account operator-gated reCAPTCHA recovery list (oldest first).
  // Empty array when no accounts are flagged.
  flowRecoveryAccounts: FlowRecoveryAccount[];
}

export interface VideosPageState {
  videos: VideoListItem[];
  queueState: QueueState;
  bannerFlags: BannerFlags;
}

/**
 * Single source for the videos-page polled state. Both the /videos
 * server component (initial render) and /api/videos GET (poll response)
 * read through this helper so the projection + setting fan-in cannot
 * drift between the two call sites. Adding a new operator-facing Flow
 * flag surfaced via the videos poller is a one-line change here.
 */
export function getVideosPageState(db: DatabaseType): VideosPageState {
  const videos = videosRepo.list(db);
  const snapshots = stepsRepo.runtimeSnapshots(db);
  const items: VideoListItem[] = videos.map((v) => {
    const snap = snapshots.get(v.id);
    return {
      ...v,
      runtime_ms: snap?.runtime_ms ?? 0,
      running_step_started_at: snap?.running_step_started_at ?? null,
    };
  });
  return {
    videos: items,
    queueState: getSetting("queue_state", db),
    bannerFlags: {
      flowCreateProjectFailed: getSetting("flow_create_project_failed", db),
      flowServiceOverloadUntil: getSetting("flow_service_overload_until", db),
      googleFlowReloginNeeded: getSetting("google_flow_relogin_needed", db),
      flowRecoveryAccounts: gfRepo.listRecoveryAccounts(db),
    },
  };
}
