"use client";

import { useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { BannerFlags } from "@/lib/videos-page-state";
import type { QueueState, Video, VideoKind, VideoListItem } from "@/types";
import { useNowTick } from "@/lib/use-now-tick";
import { AddVideoModal } from "./add-video-modal";
import { AddMusicVideoModal } from "./add-music-video-modal";
import { AddReadyScriptModal } from "./add-ready-script-modal";
import { DeleteConfirmDialog } from "./delete-confirm-dialog";
import { useVideoAction, type BusyHandle } from "./use-video-action";
import { useVideoPoller } from "./use-video-poller";
import { predicateForRow } from "./_shared";
import { VideosTabs, type VideosTab } from "./videos-tabs";
import { MusicVideosTab } from "./music-videos-tab";
import { NarrativeTab } from "./narrative-tab";

function parseTab(params: URLSearchParams | null): VideosTab {
  const v = params?.get("tab");
  return v === "music_videos" ? "music_videos" : "narrative";
}

export interface VideosClientWorkflow {
  id: string;
  shortLabel: string;
  label: string;
  kind: VideoKind;
}

/**
 * Projection of a `visual_styles` row down to the fields the modals
 * need: id for the FK, title for the dropdown, prompt for the
 * disclosure preview. Mirrors `VideosClientWorkflow` — parent fetches
 * once and passes the same prop into both modals.
 */
export interface VideosClientVisualStyle {
  id: string;
  title: string;
  prompt: string;
}

export type RowInflight = {
  id: string;
  action: "start" | "pause" | "resume";
} | null;

interface VideosClientProps {
  initialVideos: VideoListItem[];
  initialQueueState: QueueState;
  // Operator-facing Flow flags. Grouped so adding a new banner does not
  // change this prop list (see `BannerFlags` in `lib/videos-page-state`).
  initialBannerFlags: BannerFlags;
  workflows: readonly VideosClientWorkflow[];
  visualStyles: readonly VideosClientVisualStyle[];
  projectsDir: string;
  // Server's `Date.now()` at render time. Feeds `useNowTick`'s initial
  // state so SSR and client hydration agree on timer text — see
  // `lib/use-now-tick.ts`.
  serverNow: number;
}

export function VideosClient({
  initialVideos,
  initialQueueState,
  initialBannerFlags,
  workflows,
  visualStyles,
  projectsDir,
  serverNow,
}: VideosClientProps): JSX.Element {
  const runAction = useVideoAction();
  const {
    topics,
    queue,
    finished,
    queueState,
    setQueueState,
    bannerFlags,
    setBannerFlags,
    pollNow,
  } = useVideoPoller({
    videos: initialVideos,
    queueState: initialQueueState,
    bannerFlags: initialBannerFlags,
  });
  // Predicates passed to `useVideoAction({ waitFor })` capture closures at
  // click time. Reading `topics` / `queue` directly would freeze the
  // predicate against stale state and never re-evaluate. The ref lets each
  // 250 ms predicate tick read the latest polled rows. Writing to the ref
  // during render (rather than in `useEffect`) keeps it in sync with the
  // *current* render's state without depending on commit timing — the
  // predicate's interval handler runs on the timer queue, which is not
  // synchronized with React's commit phase.
  const latestRowsRef = useRef<{ topics: VideoListItem[]; queue: VideoListItem[] }>({
    topics,
    queue,
  });
  latestRowsRef.current = { topics, queue };
  // Drive the per-row timer's live tick from one hook at the table level
  // so every queue row reads the same `now` and we don't pay for N
  // intervals when there are N rows. Only ticks when at least one queue
  // row is mid-step; finished rows are frozen and don't need it.
  const hasRunningStep = queue.some(
    (v) => v.running_step_started_at !== null,
  );
  const now = useNowTick(hasRunningStep, serverNow);
  const [startingAll, setStartingAll] = useState(false);
  const [togglingQueue, setTogglingQueue] = useState(false);
  const [rowInflight, setRowInflight] = useState<RowInflight>(null);
  const [modal, setModal] = useState<
    | { mode: "add" }
    | { mode: "edit"; video: Video }
    | { mode: "addReadyScript" }
    | { mode: "editReadyScript"; video: Video }
    | { mode: "addMusicVideo" }
    | null
  >(null);
  const [deleteTarget, setDeleteTarget] = useState<Video | null>(null);

  const router = useRouter();
  const pathname = usePathname() ?? "/videos";
  const searchParams = useSearchParams();
  const activeTab = parseTab(searchParams);

  function setTab(next: VideosTab): void {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next === "narrative") {
      params.delete("tab");
    } else {
      params.set("tab", next);
    }
    const qs = params.toString();
    router.replace(qs.length > 0 ? `${pathname}?${qs}` : pathname);
  }

  const hasNew = topics.length > 0;

  async function onStartAll(): Promise<void> {
    if (!hasNew) return;
    // Snapshot the IDs of topics targeted by *this* click. New topics
    // added during the wait window are not "started by this click" and
    // must not affect the predicate.
    const targetIds = new Set(topics.map((t) => t.id));
    await runAction({
      url: "/api/videos/start-all",
      onSuccess: "router-refresh",
      // The route returns no actionable info on failure; the next poll
      // will re-render any rows that stayed in `new`. Silence on the
      // wait-for timeout for the same reason.
      errorToast: false,
      timeoutToast: false,
      busy: { isBusy: startingAll, setBusy: setStartingAll },
      waitFor: {
        pollNow,
        predicate: () =>
          !latestRowsRef.current.topics.some((t) => targetIds.has(t.id)),
      },
    });
  }

  // Single-row global lock: once any row is busy, every row's action is
  // gated. Multi-row concurrency is intentionally out of scope — widening
  // this requires modeling per-row inflight state and re-thinking the
  // wait-for-poll window across rows.
  function rowBusy(id: string, action: "start" | "pause" | "resume"): BusyHandle {
    return {
      isBusy: rowInflight !== null,
      setBusy: (busy) => setRowInflight(busy ? { id, action } : null),
    };
  }

  async function onStartVideo(id: string): Promise<void> {
    await runAction({
      url: `/api/videos/${id}/start`,
      onSuccess: "router-refresh",
      // Silent like onStartAll — the next poll surfaces the result.
      errorToast: false,
      timeoutToast: false,
      busy: rowBusy(id, "start"),
      waitFor: {
        pollNow,
        // Predicate satisfies when the row leaves topics (status moved
        // off "new"). Vanish-as-satisfied: a deleted row also drops out
        // of topics, which is the right behavior — we never want a
        // spinner to hang on a row that no longer exists.
        predicate: () =>
          !latestRowsRef.current.topics.some((t) => t.id === id),
      },
    });
  }

  async function onPauseVideo(v: Video): Promise<void> {
    await runAction({
      url: `/api/videos/${v.id}/pause`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to pause "${v.title}"` },
      busy: rowBusy(v.id, "pause"),
      waitFor: {
        pollNow,
        predicate: predicateForRow(
          () => latestRowsRef.current.queue.find((r) => r.id === v.id),
          (row) => row.paused === 1,
        ),
      },
    });
  }

  async function onResumeVideo(v: Video): Promise<void> {
    await runAction({
      url: `/api/videos/${v.id}/resume`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to resume "${v.title}"` },
      busy: rowBusy(v.id, "resume"),
      waitFor: {
        pollNow,
        predicate: predicateForRow(
          () => latestRowsRef.current.queue.find((r) => r.id === v.id),
          // A row can be `paused === 0 && deferred_until > now` — unpaused
          // but still scheduled out. Spinner should clear only when the
          // row is actually eligible to resume work. `deferred_until` is
          // stored as unix-seconds (matches the worker's SQL filter at
          // `repos/videos.ts:241` using `unixepoch()`); compare in seconds.
          (row) =>
            row.paused === 0 &&
            (row.deferred_until === null ||
              row.deferred_until <= Math.floor(Date.now() / 1000)),
        ),
      },
    });
  }

  async function onToggleQueue(): Promise<void> {
    const pausing = queueState === "running";
    const path = pausing ? "pause" : "start";
    // Intentional outlier: this handler does NOT use `waitFor`. Optimistic
    // `setQueueState` is a strictly better UX than a wait-for-poll spinner
    // when the post-action value is fully knowable client-side, and queue
    // state is the only handler that meets that bar. Don't migrate this to
    // `waitFor` to "match" the row handlers — the asymmetry is the point.
    await runAction({
      url: `/api/queue/${path}`,
      onSuccess: () => setQueueState(pausing ? "paused" : "running"),
      errorToast: pausing ? "Failed to pause queue" : "Failed to resume queue",
      busy: { isBusy: togglingQueue, setBusy: setTogglingQueue },
    });
  }

  return (
    <>
      <header className="relative mb-8 flex items-end justify-between pb-5">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-emerald-800/85 dark:text-emerald-300/85">
            Dashboard
          </p>
          <h1 className="mt-1.5 font-display text-[2.75rem] font-medium leading-[1.05] tracking-tight text-foreground">
            Videos
          </h1>
        </div>
        <span
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-px bg-emerald-500/35 dark:bg-emerald-400/40"
        />
      </header>

      <VideosTabs active={activeTab} onChange={setTab} />

      {activeTab === "music_videos" ? (
        <MusicVideosTab
          topics={topics.filter((v) => v.kind === "music_video")}
          queue={queue.filter((v) => v.kind === "music_video")}
          finished={finished.filter((v) => v.kind === "music_video")}
          workflows={workflows}
          queueState={queueState}
          rowInflight={rowInflight}
          now={now}
          projectsDir={projectsDir}
          togglingQueue={togglingQueue}
          onOpenAdd={() => setModal({ mode: "addMusicVideo" })}
          onStartVideo={(v) => {
            void onStartVideo(v.id);
          }}
          onDelete={(v) => setDeleteTarget(v)}
          onPause={(v) => {
            void onPauseVideo(v);
          }}
          onResume={(v) => {
            void onResumeVideo(v);
          }}
          onToggleQueue={() => {
            void onToggleQueue();
          }}
        />
      ) : (
        <NarrativeTab
          topics={topics.filter((v) => v.kind === "narrative")}
          queue={queue.filter((v) => v.kind === "narrative")}
          finished={finished.filter((v) => v.kind === "narrative")}
          workflows={workflows}
          queueState={queueState}
          rowInflight={rowInflight}
          now={now}
          projectsDir={projectsDir}
          togglingQueue={togglingQueue}
          startingAll={startingAll}
          hasNew={hasNew}
          bannerFlags={bannerFlags}
          setBannerFlags={setBannerFlags}
          onOpenAdd={() => setModal({ mode: "add" })}
          onOpenAddReadyScript={() => setModal({ mode: "addReadyScript" })}
          onStartAll={() => {
            void onStartAll();
          }}
          onStartVideo={(v) => {
            void onStartVideo(v.id);
          }}
          onEditVideo={(v) =>
            setModal(
              v.provided_script !== null
                ? { mode: "editReadyScript", video: v }
                : { mode: "edit", video: v },
            )
          }
          onDelete={(v) => setDeleteTarget(v)}
          onPause={(v) => {
            void onPauseVideo(v);
          }}
          onResume={(v) => {
            void onResumeVideo(v);
          }}
          onToggleQueue={() => {
            void onToggleQueue();
          }}
        />
      )}

      {(modal?.mode === "add" || modal?.mode === "edit") && (
        <AddVideoModal
          mode={modal.mode}
          video={modal.mode === "edit" ? modal.video : undefined}
          workflows={workflows}
          visualStyles={visualStyles}
          onClose={() => setModal(null)}
        />
      )}

      {(modal?.mode === "addReadyScript" ||
        modal?.mode === "editReadyScript") && (
        <AddReadyScriptModal
          mode={modal.mode === "editReadyScript" ? "edit" : "add"}
          video={modal.mode === "editReadyScript" ? modal.video : undefined}
          workflows={workflows}
          visualStyles={visualStyles}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.mode === "addMusicVideo" && (
        <AddMusicVideoModal
          workflows={workflows}
          onClose={() => setModal(null)}
        />
      )}

      {deleteTarget && (
        <DeleteConfirmDialog
          video={deleteTarget}
          onClose={() => setDeleteTarget(null)}
        />
      )}
    </>
  );
}
