"use client";

import { AlertTriangle, Trash2, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import type { DraftRow, DraftRowProviders } from "@/lib/workflows-api";

export function DraftTableRow({
  row,
  busy,
  anyBusy,
  onImport,
  onDiscard,
}: {
  row: DraftRow;
  busy: boolean;
  anyBusy: boolean;
  onImport: () => void;
  onDiscard: () => void;
}): JSX.Element {
  const isInvalidJson = row.errors.includes("invalid_json");
  const isMissingFields = row.errors.includes("missing_fields");
  const hasUnknownField = row.errors.includes("unknown_field");
  const importDisabled = isInvalidJson || isMissingFields || anyBusy;

  return (
    <TableRow>
      <TableCell className="font-medium">
        <div className="flex flex-col gap-1">
          <span>{row.filename}</span>
          {hasUnknownField && (
            <Badge variant="outline" className="w-fit gap-1 text-xs">
              <AlertTriangle aria-hidden="true" className="h-3 w-3" />
              unknown field
            </Badge>
          )}
        </div>
      </TableCell>
      {isInvalidJson ? (
        <TableCell colSpan={3} className="text-sm text-destructive">
          Invalid JSON — cannot import. Discard the file or fix it.
        </TableCell>
      ) : isMissingFields ? (
        <TableCell colSpan={3} className="text-sm text-destructive">
          Missing required <code className="text-xs">id</code> field — cannot
          import. Fix the file or discard.
        </TableCell>
      ) : (
        <>
          <TableCell>{row.label ?? "—"}</TableCell>
          <TableCell className="text-sm text-muted-foreground">
            <ProvidersCell
              providers={row.providers}
              chunker_step={row.chunker_step}
            />
          </TableCell>
          <TableCell className="text-right tabular-nums">
            {row.stepCount ?? "—"}
          </TableCell>
        </>
      )}
      <TableCell>
        <div className="flex items-center justify-end gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onImport}
            disabled={importDisabled}
          >
            <Upload aria-hidden="true" />
            {busy ? "Importing…" : "Import"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructiveSoft"
            onClick={onDiscard}
            disabled={anyBusy}
          >
            <Trash2 aria-hidden="true" />
            Discard
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

function ProvidersCell({
  providers,
  chunker_step,
}: {
  providers: DraftRowProviders | null;
  chunker_step: string | null;
}): JSX.Element {
  if (!providers) return <>—</>;
  const parts = [
    `script: ${providers.script ?? "—"}`,
    `tts: ${providers.tts ?? "—"}`,
    `image: ${providers.image ?? "—"}`,
    `video: ${providers.video ?? "—"}`,
    `chunker: ${chunker_step ?? "—"}`,
  ];
  return <span>{parts.join(" · ")}</span>;
}
