"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ConfirmDialog } from "@/app/videos/confirm-dialog";
import type { DraftRow } from "@/lib/workflows-api";
import { DraftTableRow } from "./drafts-table-row";
import { useDraftsList } from "./use-drafts-list";
import {
  decodeImportError,
  runImport,
  useOverwriteConfirm,
  type ImportErrorBody,
} from "./use-import-with-overwrite";

interface ValidationWarning {
  step_name: string;
  missing_input: string;
  message: string;
}

interface ImportSuccessBody {
  workflow: { id: string };
  warnings: ValidationWarning[];
  archiveError?: string;
}

type DiscardConfirm = {
  filename: string;
  busy: boolean;
};

export function DraftsSection(): JSX.Element {
  const router = useRouter();
  const { drafts, loading, refreshing, reload } = useDraftsList();
  const [busyFilename, setBusyFilename] = useState<string | null>(null);
  const overwrite = useOverwriteConfirm();
  const [discardConfirm, setDiscardConfirm] = useState<DiscardConfirm | null>(
    null,
  );

  async function onImport(row: DraftRow): Promise<void> {
    if (busyFilename !== null) return;
    if (
      row.errors.includes("invalid_json") ||
      row.errors.includes("missing_fields")
    ) {
      return;
    }
    setBusyFilename(row.filename);
    try {
      const result = await runImport({
        post: (doOverwrite) => {
          const url = doOverwrite
            ? `/api/workflows/drafts/${row.filename}/import?overwrite=1`
            : `/api/workflows/drafts/${row.filename}/import`;
          return fetch(url, { method: "POST" });
        },
        onConflict: () => overwrite.requestConfirm(row.slug ?? row.filename),
      });

      if (result.cancelled) return;

      if (result.ok) {
        const body = result.body as ImportSuccessBody | null;
        const slug = body?.workflow.id ?? row.slug ?? row.filename;
        const warnings = body?.warnings ?? [];
        showImportSuccessToast(slug, warnings, () =>
          router.push(`/workflows/${slug}/edit`),
        );
        if (body?.archiveError !== undefined) {
          toast.error(
            "Imported but draft file remains in drafts/ — discard manually.",
          );
        }
        await reload();
        router.refresh();
        return;
      }

      // 409 was already resolved inside runImport (retry or cancel); this
      // arm only sees other 4xx/5xx.
      const err = result.body as ImportErrorBody | null;
      const decoded = decodeImportError(err, result.status, {
        reloadDrafts: reload,
      });
      toast.error(decoded.message);
      await decoded.sideEffect?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      overwrite.endRequest();
      setBusyFilename(null);
    }
  }

  async function onDiscardConfirmed(): Promise<void> {
    if (!discardConfirm || discardConfirm.busy) return;
    const filename = discardConfirm.filename;
    setDiscardConfirm({ ...discardConfirm, busy: true });
    try {
      const res = await fetch(`/api/workflows/drafts/${filename}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        if (body.error === "draft_not_found") {
          toast.error("Draft file no longer exists");
        } else if (body.error === "invalid_filename") {
          toast.error("Invalid draft filename");
        } else {
          toast.error(`Discard failed (${res.status})`);
        }
        setDiscardConfirm(null);
        await reload();
        return;
      }
      toast.success(`Discarded ${filename}`);
      setDiscardConfirm(null);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Discard failed");
      setDiscardConfirm(null);
    }
  }

  const heading = `Drafts (${drafts.length})`;

  return (
    <Card className="mb-6">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-lg">{heading}</CardTitle>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            void reload();
          }}
          disabled={refreshing || loading}
        >
          <RefreshCw
            aria-hidden="true"
            className={refreshing ? "animate-spin" : undefined}
          />
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading drafts…</p>
        ) : drafts.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No drafts here yet. The AI skill writes drafts to{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              prompts/workflows/drafts/
            </code>
            . See{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">
              docs/histforge-spec.md § AI workflow drafts
            </code>{" "}
            for the contract.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Filename</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Providers</TableHead>
                <TableHead className="text-right">Steps</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {drafts.map((row) => (
                <DraftTableRow
                  key={row.filename}
                  row={row}
                  busy={busyFilename === row.filename}
                  anyBusy={busyFilename !== null}
                  onImport={() => {
                    void onImport(row);
                  }}
                  onDiscard={() =>
                    setDiscardConfirm({
                      filename: row.filename,
                      busy: false,
                    })
                  }
                />
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      {overwrite.dialog}
      {discardConfirm && (
        <ConfirmDialog
          title="Discard draft?"
          message={`Discard draft "${discardConfirm.filename}"? The file will be deleted.`}
          confirmLabel="Discard"
          destructive
          busy={discardConfirm.busy}
          onCancel={() => setDiscardConfirm(null)}
          onConfirm={() => {
            void onDiscardConfirmed();
          }}
        />
      )}
    </Card>
  );
}

function showImportSuccessToast(
  slug: string,
  warnings: ValidationWarning[],
  view: () => void,
): void {
  if (warnings.length === 0) {
    toast.success(`Imported \`${slug}\``, {
      action: { label: "View", onClick: view },
    });
    return;
  }
  toast.warning(
    `Imported \`${slug}\` with ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`,
    {
      description: warnings.map((w) => w.message).join("\n"),
      action: { label: "View", onClick: view },
      duration: 8000,
    },
  );
}
