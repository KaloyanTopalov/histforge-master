"use client";

import { Loader2, Pause, Pencil, Play } from "lucide-react";
import type { QueueState, Video, VideoListItem } from "@/types";
import type { RowInflight, VideosClientWorkflow } from "./videos-client";
import { Button } from "@/components/ui/button";
import { videoTimerLabel } from "@/lib/runtime";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DeleteIconButton,
  DeletingLabel,
  PausedLabel,
  PausingLabel,
  ReadyScriptBadge,
  StatusBadge,
  canPauseVideo,
  canResumeVideo,
} from "./_shared";

interface VideoQueueTableProps {
  rows: readonly VideoListItem[];
  workflows: readonly VideosClientWorkflow[];
  queueState: QueueState;
  rowInflight: RowInflight;
  /** Live `Date.now()` clock from `useNowTick`; drives the per-row timer. */
  now: number;
  onEdit: (video: Video) => void;
  onDelete: (video: Video) => void;
  onPause: (video: Video) => void;
  onResume: (video: Video) => void;
}

function workflowLabels(
  workflows: readonly VideosClientWorkflow[],
  id: string
): { short: string; full: string } {
  const w = workflows.find((x) => x.id === id);
  return { short: w?.shortLabel ?? id, full: w?.label ?? id };
}

export function VideoQueueTable({
  rows,
  workflows,
  queueState,
  rowInflight,
  now,
  onEdit,
  onDelete,
  onPause,
  onResume,
}: VideoQueueTableProps): JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Workflow</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Step</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              className="py-4 text-center text-muted-foreground"
              colSpan={6}
            >
              No videos in the queue.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((v) => {
            const wf = workflowLabels(workflows, v.workflow_id);
            const deleting = v.delete_requested === 1;
            const paused = v.paused === 1;
            const canPause = canPauseVideo(v);
            const canResume = canResumeVideo(v);
            const busyPause =
              rowInflight?.id === v.id && rowInflight.action === "pause";
            const busyResume =
              rowInflight?.id === v.id && rowInflight.action === "resume";
            return (
              <TableRow key={v.id} data-testid={`queue-row-${v.id}`}>
                <TableCell>
                  <a
                    href={`/videos/${v.id}`}
                    className="font-medium text-foreground decoration-primary/60 underline-offset-4 transition-colors hover:text-primary hover:underline"
                  >
                    {v.title}
                  </a>
                  {v.provided_script !== null && <ReadyScriptBadge />}
                </TableCell>
                <TableCell title={wf.full}>{wf.short}</TableCell>
                <TableCell>
                  {deleting ? (
                    <DeletingLabel />
                  ) : paused && v.running_step_started_at !== null ? (
                    <PausingLabel />
                  ) : paused ? (
                    <PausedLabel />
                  ) : (
                    <StatusBadge status={v.status} />
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {v.failed_step ?? v.current_step ?? "—"}
                </TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {videoTimerLabel(v, now) ?? "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    {v.status === "queued" && (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={() => onEdit(v)}
                      >
                        <Pencil aria-hidden="true" />
                        Edit
                      </Button>
                    )}
                    {canPause && (
                      <Button
                        type="button"
                        size="sm"
                        variant="warningSoft"
                        onClick={() => onPause(v)}
                        disabled={busyPause}
                      >
                        {busyPause ? (
                          <Loader2
                            aria-hidden="true"
                            className="animate-spin"
                          />
                        ) : (
                          <Pause aria-hidden="true" />
                        )}
                        Pause
                      </Button>
                    )}
                    {canResume && (
                      <Button
                        type="button"
                        size="sm"
                        variant="successSoft"
                        onClick={() => onResume(v)}
                        disabled={busyResume || queueState === "paused"}
                        title={
                          queueState === "paused"
                            ? "Queue is globally paused"
                            : undefined
                        }
                      >
                        {busyResume ? (
                          <Loader2
                            aria-hidden="true"
                            className="animate-spin"
                          />
                        ) : (
                          <Play aria-hidden="true" />
                        )}
                        Resume
                      </Button>
                    )}
                    {!deleting && (
                      <DeleteIconButton onClick={() => onDelete(v)} />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
