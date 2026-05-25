"use client";

import { useState } from "react";
import type { RefObject } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  Copy,
  Loader2,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
} from "lucide-react";
import type { QueueState, Video } from "@/types";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "../confirm-dialog";
import { DeleteConfirmDialog } from "../delete-confirm-dialog";
import {
  DeleteIconButton,
  DeletingLabel,
  canPauseVideo,
  canResumeVideo,
  canRestartVideo,
  canRetryVideo,
  predicateForRow,
} from "../_shared";
import { useVideoAction, type BusyHandle } from "../use-video-action";

type ActionPath = "start" | "retry" | "restart" | "pause" | "resume";

interface VideoActionsProps {
  video: Video;
  projectsDir: string;
  queueState: QueueState;
  pollNow: () => Promise<void>;
  latestVideoRef: RefObject<Video>;
}

/**
 * Per-status action surface on the detail page. Mirrors the queue-row
 * action column but with the richer `done`/`failed` options the detail
 * view exclusively hosts (Retry, Restart, Copy Path).
 *
 * - new: Start + Delete
 * - queued: Delete
 * - in_progress: Delete (or a "Deleting…" label when delete_requested=1)
 * - failed: Retry + Restart + Delete
 * - done: Copy Path
 */
export function VideoActions({
  video,
  projectsDir,
  queueState,
  pollNow,
  latestVideoRef,
}: VideoActionsProps): JSX.Element {
  const router = useRouter();
  const runAction = useVideoAction();
  const [inflight, setInflight] = useState<ActionPath | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmRestart, setConfirmRestart] = useState(false);
  const [copied, setCopied] = useState(false);
  const busy = inflight !== null;

  // Single-action lock: `inflight` doubles as the per-action label and the
  // global busy gate (mirrors `rowBusy` in `videos-client.tsx`). The derived
  // `busy` boolean keeps the delete button and confirm-restart dialog
  // gated without needing a separate flag.
  function actionBusy(path: ActionPath): BusyHandle {
    return {
      isBusy: inflight !== null,
      setBusy: (b) => setInflight(b ? path : null),
    };
  }

  async function runStart(): Promise<void> {
    await runAction({
      url: `/api/videos/${video.id}/start`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to start "${video.title}"` },
      busy: actionBusy("start"),
      waitFor: {
        pollNow,
        predicate: predicateForRow(
          () => latestVideoRef.current,
          (v) => v.status !== "new",
        ),
      },
    });
  }

  async function runRetry(): Promise<void> {
    await runAction({
      url: `/api/videos/${video.id}/retry`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to retry "${video.title}"` },
      busy: actionBusy("retry"),
      waitFor: {
        pollNow,
        // Retry and Restart share the same observable end-state from
        // `failed` — both routes' end-state is "no longer failed", so the
        // predicate is identical. The route bodies differ (state wipe vs
        // resume-failed-step) but that's reflected in the polled `steps`
        // payload, not the predicate's contract.
        predicate: predicateForRow(
          () => latestVideoRef.current,
          (v) => v.status !== "failed",
        ),
      },
    });
  }

  async function runRestart(): Promise<void> {
    await runAction({
      url: `/api/videos/${video.id}/restart`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to restart "${video.title}"` },
      busy: actionBusy("restart"),
      waitFor: {
        pollNow,
        predicate: predicateForRow(
          () => latestVideoRef.current,
          (v) => v.status !== "failed",
        ),
      },
    });
  }

  async function runPause(): Promise<void> {
    await runAction({
      url: `/api/videos/${video.id}/pause`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to pause "${video.title}"` },
      busy: actionBusy("pause"),
      waitFor: {
        pollNow,
        predicate: predicateForRow(
          () => latestVideoRef.current,
          (v) => v.paused === 1,
        ),
      },
    });
  }

  async function runResume(): Promise<void> {
    await runAction({
      url: `/api/videos/${video.id}/resume`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to resume "${video.title}"` },
      busy: actionBusy("resume"),
      waitFor: {
        pollNow,
        // Mirrors the list page's `onResumeVideo`: a video can be
        // `paused === 0 && deferred_until > now` — unpaused but still
        // scheduled out. Spinner clears only when actually eligible to
        // resume work. `deferred_until` is unix-seconds (matches the
        // worker's SQL filter using `unixepoch()`); compare in seconds.
        predicate: predicateForRow(
          () => latestVideoRef.current,
          (v) =>
            v.paused === 0 &&
            (v.deferred_until === null ||
              v.deferred_until <= Math.floor(Date.now() / 1000)),
        ),
      },
    });
  }

  async function copyPath(): Promise<void> {
    const path = `${projectsDir.replace(/\/+$/, "")}/${video.id}/`;
    try {
      await navigator.clipboard.writeText(path);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard blocked; silently no-op.
    }
  }

  // Spec: on a successful DELETE of a new/queued/failed video the row is
  // already gone, so send the user back to /videos instead of letting
  // router.refresh() trigger notFound() on the current route. For
  // in_progress deletions the row survives (delete_requested=1) and we
  // stay put — the detail client's poller will redirect once the
  // orchestrator tears the row down.
  function onDeleteSuccess(deferred: boolean): void {
    if (!deferred) {
      router.push("/videos");
    }
  }

  return (
    <>
      <div className="flex flex-col items-end gap-2">
        <div className="flex items-center gap-2">
          {video.status === "new" && (
            <Button
              type="button"
              variant="success"
              onClick={() => {
                void runStart();
              }}
              disabled={busy}
            >
              {inflight === "start" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Plus aria-hidden="true" />
              )}
              Add to queue
            </Button>
          )}

          {canRetryVideo(video) && (
            <Button
              type="button"
              variant="info"
              onClick={() => {
                void runRetry();
              }}
              disabled={busy}
            >
              {inflight === "retry" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              Retry failed step
            </Button>
          )}

          {canRestartVideo(video) && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmRestart(true)}
              disabled={busy}
            >
              {inflight === "restart" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <RotateCcw aria-hidden="true" />
              )}
              Restart from beginning
            </Button>
          )}

          {video.status === "done" && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void copyPath();
              }}
            >
              {copied ? (
                <Check aria-hidden="true" />
              ) : (
                <Copy aria-hidden="true" />
              )}
              {copied ? "Copied!" : "Copy Path"}
            </Button>
          )}

          {canPauseVideo(video) && (
            <Button
              type="button"
              variant="warning"
              onClick={() => {
                void runPause();
              }}
              disabled={busy}
            >
              {inflight === "pause" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Pause aria-hidden="true" />
              )}
              Pause
            </Button>
          )}

          {canResumeVideo(video) && (
            <Button
              type="button"
              variant="success"
              onClick={() => {
                void runResume();
              }}
              disabled={busy || queueState === "paused"}
              title={
                queueState === "paused" ? "Queue is globally paused" : undefined
              }
            >
              {inflight === "resume" ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <Play aria-hidden="true" />
              )}
              Resume
            </Button>
          )}

          {video.status !== "done" &&
            (video.status === "in_progress" && video.delete_requested === 1 ? (
              <DeletingLabel />
            ) : (
              <DeleteIconButton
                size="icon"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
              />
            ))}
        </div>
      </div>

      {confirmDelete && (
        <DeleteConfirmDialog
          video={video}
          onClose={() => setConfirmDelete(false)}
          onSuccess={onDeleteSuccess}
        />
      )}

      {confirmRestart && (
        <ConfirmDialog
          title="Restart from the beginning?"
          message="All artifacts will be deleted and the pipeline will run from step 1."
          confirmLabel="Restart"
          destructive
          busy={busy}
          onCancel={() => setConfirmRestart(false)}
          onConfirm={() => {
            setConfirmRestart(false);
            void runRestart();
          }}
        />
      )}
    </>
  );
}
