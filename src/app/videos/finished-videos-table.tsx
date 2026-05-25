"use client";

import { useState } from "react";
import { Check, Copy, FolderOpen, FolderX } from "lucide-react";
import type { Video, VideoListItem } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DeleteIconButton, ReadyScriptBadge } from "./_shared";

interface FinishedVideosTableProps {
  rows: readonly VideoListItem[];
  projectsDir: string;
  onDelete: (video: Video) => void;
}

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function formatFinishedAt(ts: number | null): string {
  if (!ts) return "—";
  const d = new Date(ts);
  const day = d.getDate();
  const month = MONTHS_SHORT[d.getMonth()];
  const year = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm}`;
}

function formatRuntimeMinutes(ms: number): string {
  const totalMin = Math.floor(ms / 60000);
  if (totalMin <= 0) return "<1m";
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function runtimeLabel(v: VideoListItem): string {
  if (v.runtime_ms === 0 && v.running_step_started_at === null) return "—";
  return formatRuntimeMinutes(v.runtime_ms);
}

export function FinishedVideosTable({
  rows,
  projectsDir,
  onDelete,
}: FinishedVideosTableProps): JSX.Element {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [openErrorId, setOpenErrorId] = useState<string | null>(null);

  async function onCopy(videoId: string): Promise<void> {
    const path = `${projectsDir.replace(/\/+$/, "")}/${videoId}/`;
    try {
      await navigator.clipboard.writeText(path);
      setCopiedId(videoId);
      setTimeout(() => {
        setCopiedId((current) => (current === videoId ? null : current));
      }, 2000);
    } catch {
      // clipboard blocked; silently no-op.
    }
  }

  // Asymmetric: success is silent (Explorer is its own feedback); only failures swap.
  async function onOpenFolder(videoId: string): Promise<void> {
    try {
      const res = await fetch(`/api/videos/${videoId}/open-folder`, {
        method: "POST",
      });
      if (res.ok) return;
    } catch {
      // network error → fall through to failure swap
    }
    setOpenErrorId(videoId);
    setTimeout(() => {
      setOpenErrorId((current) => (current === videoId ? null : current));
    }, 2000);
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Finished</TableHead>
          <TableHead>Time</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              className="py-4 text-center text-muted-foreground"
              colSpan={4}
            >
              No finished videos yet.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((v) => {
            const isCopied = copiedId === v.id;
            const isOpenError = openErrorId === v.id;
            return (
              <TableRow key={v.id} data-testid={`finished-row-${v.id}`}>
                <TableCell>
                  <a
                    href={`/videos/${v.id}`}
                    className="font-medium text-foreground decoration-primary/60 underline-offset-4 transition-colors hover:text-primary hover:underline"
                  >
                    {v.title}
                  </a>
                  {v.provided_script !== null && <ReadyScriptBadge />}
                </TableCell>
                <TableCell>{formatFinishedAt(v.finished_at)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">
                  {runtimeLabel(v)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="iconSm"
                      variant="outline"
                      onClick={() => {
                        void onOpenFolder(v.id);
                      }}
                      title={isOpenError ? "Folder missing" : "Open folder"}
                      aria-label={isOpenError ? "Folder missing" : "Open folder"}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {isOpenError ? (
                        <FolderX aria-hidden="true" />
                      ) : (
                        <FolderOpen aria-hidden="true" />
                      )}
                    </Button>
                    <Button
                      type="button"
                      size="iconSm"
                      variant="outline"
                      onClick={() => {
                        void onCopy(v.id);
                      }}
                      title={isCopied ? "Copied!" : "Copy path"}
                      aria-label={isCopied ? "Copied" : "Copy path"}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground"
                    >
                      {isCopied ? (
                        <Check aria-hidden="true" />
                      ) : (
                        <Copy aria-hidden="true" />
                      )}
                    </Button>
                    <DeleteIconButton onClick={() => onDelete(v)} />
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
