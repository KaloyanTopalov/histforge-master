"use client";

import { Loader2, Pencil, Plus } from "lucide-react";
import type { Video } from "@/types";
import type { RowInflight, VideosClientWorkflow } from "./videos-client";
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

interface TopicsTableProps {
  rows: readonly Video[];
  workflows: readonly VideosClientWorkflow[];
  rowInflight: RowInflight;
  onStart: (video: Video) => void;
  onEdit: (video: Video) => void;
  onDelete: (video: Video) => void;
}

function workflowLabels(
  workflows: readonly VideosClientWorkflow[],
  id: string
): { short: string; full: string } {
  const w = workflows.find((x) => x.id === id);
  return { short: w?.shortLabel ?? id, full: w?.label ?? id };
}

export function TopicsTable({
  rows,
  workflows,
  rowInflight,
  onStart,
  onEdit,
  onDelete,
}: TopicsTableProps): JSX.Element {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Title</TableHead>
          <TableHead>Workflow</TableHead>
          <TableHead>Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.length === 0 ? (
          <TableRow>
            <TableCell
              className="py-4 text-center text-muted-foreground"
              colSpan={3}
            >
              No topics yet.
            </TableCell>
          </TableRow>
        ) : (
          rows.map((v) => {
            const wf = workflowLabels(workflows, v.workflow_id);
            const busyStart =
              rowInflight?.id === v.id && rowInflight.action === "start";
            return (
              <TableRow key={v.id} data-testid={`topic-row-${v.id}`}>
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
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="successSoft"
                      onClick={() => onStart(v)}
                      disabled={busyStart}
                    >
                      {busyStart ? (
                        <Loader2
                          aria-hidden="true"
                          className="animate-spin"
                        />
                      ) : (
                        <Plus aria-hidden="true" />
                      )}
                      Add to queue
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => onEdit(v)}
                    >
                      <Pencil aria-hidden="true" />
                      Edit
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
