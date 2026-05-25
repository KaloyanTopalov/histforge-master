"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Check,
  ChevronRight,
  Circle,
  Loader2,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type {
  QueueState,
  Video,
  VideoStep,
  VideoStepStatus,
} from "@/types";
import { parseVisualStyleSnapshot } from "@/lib/visual-styles";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { computeRuntimeMs, formatDuration } from "@/lib/runtime";
import { useNowTick } from "@/lib/use-now-tick";
import { useVideoAction } from "../use-video-action";
import { ConfirmDialog } from "../confirm-dialog";
import type { FlowSummary } from "@/lib/flow-summary";
import type { AccountListItem } from "@/lib/flow-account-status";
import type { FlowRecoveryAccount } from "@/lib/videos-page-state";
import {
  DeletingLabel,
  PausedLabel,
  PausingLabel,
  SectionHeading,
  StatusBadge,
  predicateForRow,
} from "../_shared";
import { FlowRecoveryBanner } from "../flow-recovery-banner";
import { FlowServiceOverloadBanner } from "../flow-service-overload-banner";
import { MagnificHitlBanner } from "./magnific-hitl-banner";
import { VideoActions } from "./video-actions";
import { FlowModerationPanel } from "./flow-moderation-panel";
import { FlowProgressPanel } from "./flow-progress-panel";
import { ArtifactsPanel } from "./artifacts-panel";
import { VoiceoverUpload } from "./voiceover-upload";
import { AlignmentUpload } from "./alignment-upload";

export type { FlowSummary } from "@/lib/flow-summary";

interface VideoDetailClientProps {
  videoId: string;
  initialVideo: Video;
  initialSteps: VideoStep[];
  initialArtifacts: string[];
  projectsDir: string;
  initialWorkflowLabel: string;
  // Optional with sensible defaults so unit tests can render the
  // detail page without re-stating queue / provider context they do
  // not exercise. The production caller (`app/videos/[id]/page.tsx`)
  // always passes both explicitly.
  initialQueueState?: QueueState;
  usesGoogleFlow?: boolean;
  initialFlowSummary?: FlowSummary | null;
  // Accounts currently in operator-gated reCAPTCHA recovery. Server-
  // seeded so the banner shows immediately on first paint; the client
  // refreshes on the same 5-second cadence as the flow summary.
  initialFlowRecoveryAccounts?: FlowRecoveryAccount[];
  // Raw `flow_service_overload_until` setting — empty string means no
  // overload pause pending. Server-seeded so the banner shows on first
  // paint; refreshed via the `/api/videos/[id]` poll.
  initialFlowServiceOverloadUntil?: string;
  // Server's `Date.now()` at render time. Feeds `useNowTick`'s initial
  // state so SSR and client hydration agree on timer text — see
  // `lib/use-now-tick.ts`.
  serverNow: number;
}

const STEP_ICONS: Record<VideoStepStatus, LucideIcon> = {
  pending: Circle,
  running: Play,
  done: Check,
  failed: X,
};

const STEP_ICON_COLORS: Record<VideoStepStatus, string> = {
  pending: "text-muted-foreground",
  running: "text-primary",
  done: "text-green-600 dark:text-green-400",
  failed: "text-destructive",
};

const POLL_MS = 5000;

function stepNumber(i: number): string {
  return String(i + 1).padStart(2, "0");
}

function stepDuration(
  step: VideoStep,
  now: number,
): string | null {
  if (!step.started_at) return null;
  const end = step.finished_at ?? now;
  return formatDuration(end - step.started_at);
}

export function VideoDetailClient({
  videoId,
  initialVideo,
  initialSteps,
  initialArtifacts,
  projectsDir,
  initialWorkflowLabel,
  initialQueueState = "running",
  usesGoogleFlow = false,
  initialFlowSummary,
  initialFlowRecoveryAccounts,
  initialFlowServiceOverloadUntil,
  serverNow,
}: VideoDetailClientProps): JSX.Element {
  const router = useRouter();
  const [video, setVideo] = useState(initialVideo);
  const [steps, setSteps] = useState(initialSteps);
  const [artifacts, setArtifacts] = useState(initialArtifacts);
  const [workflowLabel, setWorkflowLabel] = useState(initialWorkflowLabel);
  const [queueState, setQueueState] = useState(initialQueueState);
  const [flowSummary, setFlowSummary] = useState<FlowSummary | null>(
    initialFlowSummary ?? null
  );
  const [flowAccounts, setFlowAccounts] = useState<AccountListItem[]>([]);
  const [flowRecoveryAccounts, setFlowRecoveryAccounts] = useState<
    FlowRecoveryAccount[]
  >(initialFlowRecoveryAccounts ?? []);
  const [flowServiceOverloadUntil, setFlowServiceOverloadUntil] =
    useState<string>(initialFlowServiceOverloadUntil ?? "");
  const [requeuing, setRequeuing] = useState(false);
  const [rerendering, setRerendering] = useState(false);
  const [confirmRerender, setConfirmRerender] = useState(false);
  const [showStylePrompt, setShowStylePrompt] = useState(false);
  const runAction = useVideoAction();
  // Derived from the polled video row — the snapshot is pinned at
  // create/queue time and won't change mid-flight, but reading it off
  // `video` keeps a single source of truth and picks up edits to
  // draft-state videos via the regular poll.
  const visualStyle = parseVisualStyleSnapshot(video.visual_style_snapshot);
  const hasRunningStep = steps.some((s) => s.status === "running");
  const now = useNowTick(hasRunningStep, serverNow);
  const isFlow = usesGoogleFlow;
  // Predicates passed to `useVideoAction({ waitFor })` close over this ref so
  // each 250 ms predicate tick reads the latest polled video. Writing to the
  // ref during render (rather than in `useEffect`) keeps it in sync with the
  // *current* render's state — the predicate's interval handler runs on the
  // timer queue, which is not synchronized with React's commit phase. Same
  // rationale as `latestRowsRef` in `videos-client.tsx`.
  const latestVideoRef = useRef<Video>(initialVideo);
  latestVideoRef.current = video;
  const inFlightRef = useRef<Promise<void> | null>(null);
  // Gate the panel on an actual Flow step having started. Fresh google-
  // flow videos still have an empty queue until research/chunking runs;
  // showing a zero-count panel in that window is misleading. The image /
  // video module steps are unified across providers — `isFlow` above gates
  // the panel by workflow_id, so `started_at` on either is the right signal.
  const flowStepStarted = steps.some(
    (s) =>
      (s.step_name === "generate_images" ||
        s.step_name === "generate_clips") &&
      s.started_at !== null
  );

  const cancelledRef = useRef(false);

  const pollNow = useCallback((): Promise<void> => {
    if (inFlightRef.current) return inFlightRef.current;

    const promise = (async () => {
      try {
        const res = await fetch(`/api/videos/${videoId}`);
        if (cancelledRef.current) return;
        if (res.status === 404) {
          // Orchestrator finished deleting this video — bounce home.
          router.push("/videos");
          return;
        }
        if (!res.ok) return;
        const payload: {
          video: Video;
          steps: VideoStep[];
          artifacts?: string[];
          workflow_label?: string;
          queueState?: QueueState;
          flowServiceOverloadUntil?: string;
        } = await res.json();
        if (cancelledRef.current) return;
        setVideo(payload.video);
        setSteps(payload.steps);
        if (payload.artifacts !== undefined) setArtifacts(payload.artifacts);
        if (payload.workflow_label !== undefined) {
          setWorkflowLabel(payload.workflow_label);
        }
        if (payload.queueState !== undefined) {
          setQueueState(payload.queueState);
        }
        if (payload.flowServiceOverloadUntil !== undefined) {
          setFlowServiceOverloadUntil(payload.flowServiceOverloadUntil);
        }
      } catch {
        // Network hiccups; next poll recovers.
      } finally {
        inFlightRef.current = null;
      }
    })();

    inFlightRef.current = promise;
    return promise;
  }, [videoId, router]);

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

  const refreshFlowSummary = useCallback(async () => {
    try {
      const res = await fetch(`/api/flow/queue-summary/${videoId}`);
      if (!res.ok) return;
      setFlowSummary((await res.json()) as FlowSummary);
    } catch {
      // Ignore — next tick retries.
    }
  }, [videoId]);

  const refreshFlowAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/flow/accounts");
      if (!res.ok) return;
      const body = (await res.json()) as { accounts: AccountListItem[] };
      setFlowAccounts(body.accounts);
    } catch {
      // Ignore — next tick retries.
    }
  }, []);

  const refreshFlowRecoveryAccounts = useCallback(async () => {
    try {
      const res = await fetch("/api/flow/recovery-accounts");
      if (!res.ok) return;
      const body = (await res.json()) as { accounts?: FlowRecoveryAccount[] };
      if (Array.isArray(body.accounts)) {
        setFlowRecoveryAccounts(body.accounts);
      }
    } catch {
      // Ignore — next tick retries.
    }
  }, []);

  useEffect(() => {
    if (!isFlow) return;
    void refreshFlowSummary();
    void refreshFlowAccounts();
    void refreshFlowRecoveryAccounts();
    const id = setInterval(() => {
      void refreshFlowSummary();
      void refreshFlowAccounts();
      void refreshFlowRecoveryAccounts();
    }, POLL_MS);
    return () => clearInterval(id);
  }, [
    isFlow,
    refreshFlowSummary,
    refreshFlowAccounts,
    refreshFlowRecoveryAccounts,
  ]);

  async function requeueFailed(force: boolean): Promise<void> {
    setRequeuing(true);
    try {
      const res = await fetch(
        `/api/flow/requeue-failed/${videoId}${force ? "?force=1" : ""}`,
        { method: "POST" }
      );
      await refreshFlowSummary();
      // The route resets the failed step + flips video back to 'queued'
      // when at least one row was requeued on a failed video. Refresh
      // server props so the status badge / VideoActions surface follows.
      const body = (await res.json().catch(() => ({}))) as {
        resumedFailedStep?: boolean;
      };
      if (body.resumedFailedStep) {
        router.refresh();
      }
    } finally {
      setRequeuing(false);
    }
  }

  async function postQueueRowAction(
    rowId: number,
    body: Record<string, unknown>
  ): Promise<boolean> {
    try {
      const res = await fetch(`/api/flow/queue-row/${rowId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) return false;
      const payload = (await res.json().catch(() => ({}))) as {
        resumedFailedStep?: boolean;
      };
      await refreshFlowSummary();
      if (payload.resumedFailedStep) {
        // The route resets the failed step + flips the video back to
        // 'queued' when the parent video was failed. Refresh server
        // props so the status badge follows.
        router.refresh();
      }
      return true;
    } catch {
      return false;
    }
  }

  function editAndRetry(rowId: number, prompt: string): Promise<boolean> {
    return postQueueRowAction(rowId, { prompt });
  }

  function retryRow(rowId: number): Promise<boolean> {
    return postQueueRowAction(rowId, {});
  }

  async function runRerender(): Promise<void> {
    await runAction({
      url: `/api/videos/${videoId}/rerender-last-step`,
      onSuccess: "router-refresh",
      errorToast: { fallback: `Failed to re-render "${video.title}"` },
      busy: {
        isBusy: rerendering,
        setBusy: setRerendering,
      },
      waitFor: {
        pollNow,
        // Spinner clears once the worker has picked the row back up —
        // status moves off 'done' (to 'queued' immediately, then
        // 'in_progress' once the orchestrator ticks). Vanish-as-satisfied
        // for the deleted-row case is handled by `predicateForRow`.
        predicate: predicateForRow(
          () => latestVideoRef.current,
          (v) => v.status !== "done",
        ),
      },
    });
  }

  const showRerender =
    video.kind === "music_video" && video.status === "done";

  const totalMs = computeRuntimeMs(steps, now);
  const total = totalMs !== null ? formatDuration(totalMs) : null;

  return (
    <>
      <header className="mb-8 flex items-start justify-between gap-6 border-b pb-8">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium uppercase tracking-widest text-muted-foreground">
            <a href="/videos" className="hover:text-foreground hover:underline">
              Videos
            </a>{" "}
            <span aria-hidden="true">/</span> Detail
          </p>
          <h1 className="mt-4 break-words font-display text-4xl font-medium tracking-tight">
            {video.title}
          </h1>
          <dl className="mt-6 flex flex-wrap items-baseline gap-x-8 gap-y-3 text-sm">
            <div className="flex items-baseline gap-2.5">
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Workflow
              </dt>
              <dd className="font-medium text-foreground">{workflowLabel}</dd>
            </div>
            <div className="flex items-baseline gap-2.5">
              <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Style
              </dt>
              <dd className="font-medium text-foreground">
                {visualStyle?.title ?? "Default"}
                {visualStyle && (
                  <button
                    type="button"
                    onClick={() => setShowStylePrompt((v) => !v)}
                    className="ml-2 inline-flex items-baseline gap-1 text-xs font-normal text-muted-foreground hover:text-foreground"
                    aria-expanded={showStylePrompt}
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={`h-3 w-3 transition-transform ${
                        showStylePrompt ? "rotate-90" : ""
                      }`}
                    />
                    Show prompt
                  </button>
                )}
              </dd>
            </div>
          </dl>
          {visualStyle && showStylePrompt && (
            <pre className="mt-3 max-w-2xl whitespace-pre-wrap rounded border bg-muted/40 p-2 text-xs text-muted-foreground">
              {visualStyle.prompt}
            </pre>
          )}
        </div>
        <div className="flex items-center gap-2">
          <VideoActions
            video={video}
            projectsDir={projectsDir}
            queueState={queueState}
            pollNow={pollNow}
            latestVideoRef={latestVideoRef}
          />
        </div>
      </header>

      <FlowRecoveryBanner
        accounts={flowRecoveryAccounts}
        onCleared={(id) =>
          setFlowRecoveryAccounts((prev) => prev.filter((a) => a.id !== id))
        }
      />

      <FlowServiceOverloadBanner
        overloadUntilRaw={flowServiceOverloadUntil}
      />

      {video.kind === "music_video" && (
        <MagnificHitlBanner videoId={video.id} />
      )}

      {video.failed_reason && (
        <pre className="mb-6 whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/30 dark:bg-red-950 dark:text-red-100">
          {video.failed_reason}
        </pre>
      )}

      <div className="relative grid gap-10 lg:grid-cols-2 lg:items-start lg:gap-16">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-4 left-1/2 hidden w-[3px] -translate-x-1/2 lg:block"
          style={{
            backgroundImage:
              "radial-gradient(circle, hsl(var(--muted-foreground) / 0.35) 1px, transparent 1.2px)",
            backgroundSize: "3px 9px",
            backgroundRepeat: "repeat-y",
          }}
        />

        <div className="space-y-6">
          <Card>
            <CardHeader className="flex-row flex-wrap items-center justify-between gap-x-4 gap-y-2 space-y-0">
              <SectionHeading
                title="Steps"
                accent="primary"
                status={
                  <span className="flex flex-wrap items-center gap-2">
                    {video.delete_requested === 1 ? (
                      <DeletingLabel />
                    ) : video.paused === 1 && hasRunningStep ? (
                      <PausingLabel />
                    ) : video.paused === 1 ? (
                      <PausedLabel />
                    ) : (
                      <StatusBadge status={video.status} />
                    )}
                    {video.failed_step && (
                      <span className="text-sm text-muted-foreground">
                        · failed at{" "}
                        <strong className="text-foreground">
                          {video.failed_step}
                        </strong>
                      </span>
                    )}
                  </span>
                }
              />
              {total && (
                <span className="text-sm font-medium text-muted-foreground">
                  Total: {total}
                </span>
              )}
            </CardHeader>
            <CardContent>
              <ol className="space-y-1 text-sm">
                {steps.map((s, i) => {
                  const status = s.status as VideoStepStatus;
                  const Icon = STEP_ICONS[status];
                  const isRerenderRow =
                    showRerender && s.step_name === "render_music_video";
                  return (
                    <li
                      key={s.step_name}
                      className="flex justify-between border-b py-1 last:border-b-0"
                    >
                      <span className="inline-flex items-center gap-2.5">
                        <span className="w-5 text-right font-mono text-xs font-medium tabular-nums text-muted-foreground/70">
                          {stepNumber(i)}
                        </span>
                        <span
                          className={`inline-flex h-4 w-4 items-center justify-center ${STEP_ICON_COLORS[status]}`}
                          title={status}
                        >
                          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
                        </span>
                        <strong>{s.step_name.replace(/_/g, " ")}</strong>
                      </span>
                      <span className="inline-flex items-center gap-3">
                        <span className="tabular-nums text-muted-foreground">
                          {stepDuration(s, now) ?? "\u2014"}
                        </span>
                        {isRerenderRow && (
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() => setConfirmRerender(true)}
                            disabled={rerendering}
                          >
                            {rerendering ? (
                              <Loader2
                                aria-hidden="true"
                                className="animate-spin"
                              />
                            ) : (
                              <RefreshCw aria-hidden="true" />
                            )}
                            Re-render
                          </Button>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </CardContent>
          </Card>

          {isFlow && (
            <FlowProgressPanel
              flowAccounts={flowAccounts}
              now={now}
              flowStepStarted={flowStepStarted}
              flowSummary={flowSummary}
              requeuing={requeuing}
              onRequeueFailed={(force) => void requeueFailed(force)}
              onEditAndRetry={editAndRetry}
              onRetry={retryRow}
            />
          )}

          {isFlow &&
            flowSummary &&
            flowSummary.moderation.events.length > 0 && (
              <FlowModerationPanel events={flowSummary.moderation.events} />
            )}
        </div>

        <VoiceoverUpload
          videoId={videoId}
          hasExistingVoiceover={artifacts.includes("audio/narration.mp3")}
        />

        <AlignmentUpload
          videoId={videoId}
          hasExistingAlignment={artifacts.includes("alignment/alignment.json")}
        />

        <ArtifactsPanel videoId={videoId} artifacts={artifacts} steps={steps} />
      </div>

      {confirmRerender && (
        <ConfirmDialog
          title="Re-render the music video?"
          message="final.mp4 will be overwritten. The loop clip and other artifacts are preserved."
          confirmLabel="Re-render"
          destructive
          busy={rerendering}
          onCancel={() => setConfirmRerender(false)}
          onConfirm={() => {
            setConfirmRerender(false);
            void runRerender();
          }}
        />
      )}
    </>
  );
}
