"use client";

import { Loader2, Pause, Play, Plus } from "lucide-react";
import type { QueueState, Video, VideoListItem } from "@/types";
import { Button } from "@/components/ui/button";
import { TopicsTable } from "./topics-table";
import { VideoQueueTable } from "./video-queue-table";
import { FinishedVideosTable } from "./finished-videos-table";
import type { RowInflight, VideosClientWorkflow } from "./videos-client";
import { QueueStatusPill, SectionHeading } from "./_shared";

interface MusicVideosTabProps {
  topics: readonly VideoListItem[];
  queue: readonly VideoListItem[];
  finished: readonly VideoListItem[];
  workflows: readonly VideosClientWorkflow[];
  queueState: QueueState;
  rowInflight: RowInflight;
  now: number;
  projectsDir: string;
  togglingQueue: boolean;
  onOpenAdd: () => void;
  onStartVideo: (video: Video) => void;
  onDelete: (video: Video) => void;
  onPause: (video: Video) => void;
  onResume: (video: Video) => void;
  onToggleQueue: () => void;
}

/**
 * Music-videos tab. Mirrors the narrative tab's three-section shape
 * (Topics → Queue → Finished) but filtered to `kind='music_video'` rows
 * and exposing only one Add CTA (Add Music Video). No Flow banners
 * (Flow is narrative-only). No edit flow in Plan 1 — operators delete
 * + recreate.
 */
export function MusicVideosTab({
  topics,
  queue,
  finished,
  workflows,
  queueState,
  rowInflight,
  now,
  projectsDir,
  togglingQueue,
  onOpenAdd,
  onStartVideo,
  onDelete,
  onPause,
  onResume,
  onToggleQueue,
}: MusicVideosTabProps): JSX.Element {
  return (
    <>
      <section className="mb-6 rounded-xl border bg-card text-card-foreground shadow-sm">
        <div className="flex items-center justify-between gap-2 border-b p-4">
          <SectionHeading title="Topics" count={topics.length} accent="emerald" />
          <div className="flex items-center gap-2">
            <Button type="button" variant="default" onClick={onOpenAdd}>
              <Plus aria-hidden="true" />
              Add Music Video
            </Button>
          </div>
        </div>
        <div className="p-4">
          <TopicsTable
            rows={topics}
            workflows={workflows}
            rowInflight={rowInflight}
            onStart={(v) => onStartVideo(v)}
            // Plan 1 defers edit-music-video; operators delete + recreate.
            // The button still renders (kind-agnostic table) but the
            // callback no-ops here. Plan 2 wires this to a real edit modal.
            onEdit={() => {}}
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
            onEdit={() => {}}
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
