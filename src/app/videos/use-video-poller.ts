"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type {
  BannerFlags,
  VideosPageState,
} from "@/lib/videos-page-state";
import type { QueueState, VideoListItem, VideoStatus } from "@/types";

const POLL_MS = 5000;

const QUEUE_STATUSES: readonly VideoStatus[] = [
  "queued",
  "in_progress",
  "failed",
];

function splitRows(all: VideoListItem[]): {
  topics: VideoListItem[];
  queue: VideoListItem[];
  finished: VideoListItem[];
} {
  const topics = all
    .filter((v) => v.status === "new")
    .sort((a, b) => a.created_at - b.created_at);
  const queue = all
    .filter((v) => QUEUE_STATUSES.includes(v.status))
    .sort((a, b) => a.created_at - b.created_at);
  const finished = all
    .filter((v) => v.status === "done")
    .sort((a, b) => (b.finished_at ?? 0) - (a.finished_at ?? 0));
  return { topics, queue, finished };
}

export interface UseVideoPollerResult {
  topics: VideoListItem[];
  queue: VideoListItem[];
  finished: VideoListItem[];
  queueState: QueueState;
  setQueueState: (next: QueueState) => void;
  bannerFlags: BannerFlags;
  setBannerFlags: (patch: Partial<BannerFlags>) => void;
  pollNow: () => Promise<void>;
}

/**
 * Owns the videos-list polling loop: 5s `setInterval` against `/api/videos`,
 * the row-split policy (topics / queue / finished), and the status-diff
 * toast emission (success on `done`, error on `failed`). Toasting is the
 * hook's contractual side effect — callers don't opt in or out.
 *
 * Setters are exposed so the orchestrator can override polled state
 * synchronously: `setQueueState` for the optimistic pause/resume toggle,
 * `setBannerFlags` (partial-patch) for banner Dismiss callbacks. The next
 * poll cycle will re-overwrite from the server payload.
 */
export function useVideoPoller(
  initial: VideosPageState
): UseVideoPollerResult {
  const initialSplit = useMemo(
    () => splitRows(initial.videos),
    [initial.videos]
  );
  const [topics, setTopics] = useState(initialSplit.topics);
  const [queue, setQueue] = useState(initialSplit.queue);
  const [finished, setFinished] = useState(initialSplit.finished);
  const [queueState, setQueueState] = useState(initial.queueState);
  const [bannerFlags, setBannerFlagsState] = useState<BannerFlags>(
    initial.bannerFlags
  );

  const setBannerFlags = useCallback((patch: Partial<BannerFlags>): void => {
    setBannerFlagsState((prev) => ({ ...prev, ...patch }));
  }, []);

  const prevStatuses = useRef(
    new Map(initial.videos.map((v) => [v.id, v.status]))
  );
  const cancelledRef = useRef(false);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const pollNow = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;

    const promise = (async () => {
      try {
        const res = await fetch("/api/videos");
        if (!res.ok || cancelledRef.current) return;
        const payload: VideosPageState = await res.json();
        const fresh = payload.videos;

        for (const v of fresh) {
          const prev = prevStatuses.current.get(v.id);
          if (prev !== v.status) {
            if (v.status === "done") {
              toast.success(`"${v.title}" finished`);
            } else if (v.status === "failed") {
              toast.error(
                `"${v.title}" failed${v.failed_step ? ` at ${v.failed_step}` : ""}`
              );
            }
          }
          prevStatuses.current.set(v.id, v.status);
        }

        if (cancelledRef.current) return;

        const split = splitRows(fresh);
        setTopics(split.topics);
        setQueue(split.queue);
        setFinished(split.finished);
        setQueueState(payload.queueState);
        setBannerFlagsState(payload.bannerFlags);
      } catch {
        // Network hiccups are expected; the next poll will recover.
      } finally {
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = promise;
    return promise;
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    const id = setInterval(() => {
      void pollNow();
    }, POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [pollNow]);

  return {
    topics,
    queue,
    finished,
    queueState,
    setQueueState,
    bannerFlags,
    setBannerFlags,
    pollNow,
  };
}
