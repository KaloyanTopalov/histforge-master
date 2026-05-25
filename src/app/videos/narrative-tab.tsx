"use client";

import { FileText, ListPlus, Loader2, Pause, Play, Plus } from "lucide-react";
import type { BannerFlags } from "@/lib/videos-page-state";
import type { QueueState, Video, VideoListItem } from "@/types";
import { Button } from "@/components/ui/button";
import { TopicsTable } from "./topics-table";
import { VideoQueueTable } from "./video-queue-table";
import { FinishedVideosTable } from "./finished-videos-table";
import { FlowFailureBanner } from "./flow-failure-banner";
import { FlowRecoveryBanner } from "./flow-recovery-banner";
import { FlowReloginBanner } from "./flow-relogin-banner";
import { FlowServiceOverloadBanner } from "./flow-service-overload-banner";
import { QueueStatusPill, SectionHeading } from "./_shared";
import type { RowInflight, VideosClientWorkflow } from "./videos-client";

interface NarrativeTabProps {
  topics: readonly VideoListItem[];
  queue: readonly VideoListItem[];
  finished: readonly VideoListItem[];
  workflows: readonly VideosClientWorkflow[];
  queueState: QueueState;
  rowInflight: RowInflight;
  now: number;
  projectsDir: string;
  togglingQueue: boolean;
  startingAll: boolean;
  hasNew: boolean;
  bannerFlags: BannerFlags;
  setBannerFlags: (flags: Partial<BannerFlags>) => void;
  onOpenAdd: () => void;
  onOpenAddReadyScript: () => void;
  onStartAll: () => void;
  onStartVideo: (video: Video) => void;
  onEditVideo: (video: Video) => void;
  onDelete: (video: Video) => void;
  onPause: (video: Video) => void;
  onResume: (video: Video) => void;
  onToggleQueue: () => void;
}

/**
 * Narrative-kind tab. Owns the Flow banners (Flow only produces
 * narrative-kind assets) plus the Topics → Queue → Finished sections
 * filtered to `kind='narrative'`. Two Add CTAs (Add Topic + Add Ready
 * Script) — the music-videos tab collapses to one (Add Music Video).
 */
export function NarrativeTab({
  topics,
  queue,
  finished,
  workflows,
  queueState,
  rowInflight,
  now,
  projectsDir,
  togglingQueue,
  startingAll,
  hasNew,
  bannerFlags,
  setBannerFlags,
  onOpenAdd,
  onOpenAddReadyScript,
  onStartAll,
  onStartVideo,
  onEditVideo,
  onDelete,
  onPause,
  onResume,
  onToggleQueue,
}: NarrativeTabProps): JSX.Element {
  return (
    <>
      <FlowFailureBanner
        raw={bannerFlags.flowCreateProjectFailed}
        onCleared={() => setBannerFlags({ flowCreateProjectFailed: "" })}
      />

      <FlowReloginBanner
        visible={bannerFlags.googleFlowReloginNeeded}
        onCleared={() => setBannerFlags({ googleFlowReloginNeeded: false })}
      />

      <FlowRecoveryBanner
        accounts={bannerFlags.flowRecoveryAccounts}
        onCleared={(id) =>
          setBannerFlags({
            flowRecoveryAccounts: bannerFlags.flowRecoveryAccounts.filter(
              (a) => a.id !== id,
            ),
          })
        }
      />

      <FlowServiceOverloadBanner
        overloadUntilRaw={bannerFlags.flowServiceOverloadUntil}
      />

      <section className="mb-6 rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b p-4">
          <SectionHeading title="Topics" count={topics.length} accent="emerald" />
          <div className="flex items-center gap-2">
            <Button type="button" variant="default" onClick={onOpenAdd}>
              <Plus aria-hidden="true" />
              Add Topic
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={onOpenAddReadyScript}
            >
              <FileText aria-hidden="true" />
              Add Ready Script
            </Button>
            <Button
              type="button"
              variant="success"
              onClick={onStartAll}
              disabled={!hasNew || startingAll}
            >
              {startingAll ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <ListPlus aria-hidden="true" />
              )}
              Add all to queue
            </Button>
          </div>
        </div>
        <div className="p-4">
          <TopicsTable
            rows={topics}
            workflows={workflows}
            rowInflight={rowInflight}
            onStart={(v) => onStartVideo(v)}
            onEdit={(v) => onEditVideo(v)}
            onDelete={(v) => onDelete(v)}
          />
        </div>
      </section>

      <section className="mb-6 rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b p-4">
          <SectionHeading
            title="Video queue"
            count={queue.length}
            accent={queueState === "running" ? "emerald" : "amber"}
            status={<QueueStatusPill state={queueState} />}
          />
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant={queueState === "running" ? "warning" : "success"}
              onClick={onToggleQueue}
              disabled={togglingQueue}
            >
              {togglingQueue ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : queueState === "running" ? (
                <Pause aria-hidden="true" />
              ) : (
                <Play aria-hidden="true" />
              )}
              {queueState === "running" ? "Pause queue" : "Start queue"}
            </Button>
          </div>
        </div>
        <div className="p-4">
          {queueState === "paused" && (
            <div
              role="status"
              className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-950 dark:text-amber-100"
            >
              Queue is paused — no videos are processing. Click{" "}
              <strong>Start queue</strong> to continue.
            </div>
          )}
          <VideoQueueTable
            rows={queue}
            workflows={workflows}
            queueState={queueState}
            rowInflight={rowInflight}
            now={now}
            onEdit={(v) => onEditVideo(v)}
            onDelete={(v) => onDelete(v)}
            onPause={(v) => onPause(v)}
            onResume={(v) => onResume(v)}
          />
        </div>
      </section>

      <section className="rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="border-b p-4">
          <SectionHeading
            title="Finished videos"
            count={finished.length}
            accent="emerald"
          />
        </div>
        <div className="p-4">
          <FinishedVideosTable
            rows={finished}
            projectsDir={projectsDir}
            onDelete={(v) => onDelete(v)}
          />
        </div>
      </section>
    </>
  );
}
