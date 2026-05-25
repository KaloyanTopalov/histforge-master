"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Download,
  Pencil,
  Power,
  PowerOff,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/app/videos/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { WorkflowApiSummary } from "@/lib/workflows-api";
import {
  decodeImportError,
  runImport,
  useOverwriteConfirm,
  type ImportErrorBody,
  type ZodIssue,
} from "./use-import-with-overwrite";

interface WorkflowsTableProps {
  rows: readonly WorkflowApiSummary[];
}

type CloneState = { source: WorkflowApiSummary };
type ConfirmState =
  | { kind: "delete"; row: WorkflowApiSummary; busy: boolean }
  | { kind: "reset"; row: WorkflowApiSummary; busy: boolean };

export function WorkflowsTable({
  rows: initialRows,
}: WorkflowsTableProps): JSX.Element {
  const router = useRouter();
  const [rows, setRows] = useState<WorkflowApiSummary[]>(() => [
    ...initialRows,
  ]);
  // After router.refresh() re-runs the parent server component, the new
  // initialRows arrives as a prop. Without this sync, useState's
  // initializer-only semantics keep the stale array, so a deleted row
  // visually persists and a cloned/imported row never appears until a
  // hard reload. Toggle Enabled's optimistic patchRow stays correct: the
  // next sync from the server just confirms what the local state already
  // reflects.
  useEffect(() => {
    setRows([...initialRows]);
  }, [initialRows]);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const overwrite = useOverwriteConfirm();
  const [clone, setClone] = useState<CloneState | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  function patchRow(id: string, patch: Partial<WorkflowApiSummary>): void {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  async function onToggleEnabled(r: WorkflowApiSummary): Promise<void> {
    if (togglingId !== null) return;
    setTogglingId(r.id);
    try {
      const res = await fetch(`/api/workflows/${r.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          enabled: r.enabled === 1 ? false : true,
          expected_version: r.version,
        }),
      });
      if (res.status === 409) {
        toast.error(
          "Workflow was modified elsewhere — refresh page",
        );
        router.refresh();
        return;
      }
      if (!res.ok) {
        toast.error(`Failed to toggle (${res.status})`);
        return;
      }
      const body = (await res.json()) as { workflow: WorkflowApiSummary };
      patchRow(r.id, {
        enabled: body.workflow.enabled,
        version: body.workflow.version,
      });
    } finally {
      setTogglingId(null);
    }
  }

  async function onDeleteConfirmed(): Promise<void> {
    if (!confirm || confirm.kind !== "delete" || confirm.busy) return;
    setConfirm({ ...confirm, busy: true });
    const r = confirm.row;
    try {
      const res = await fetch(`/api/workflows/${r.id}`, { method: "DELETE" });
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as {
          videos_count?: number;
        };
        const n = body.videos_count ?? 0;
        toast.error(
          `This workflow is used by ${n} ${n === 1 ? "video" : "videos"}. Delete or reassign them first.`,
        );
        setConfirm(null);
        return;
      }
      if (!res.ok) {
        toast.error(`Failed to delete (${res.status})`);
        setConfirm(null);
        return;
      }
      toast.success(`Deleted workflow ${r.id}`);
      setConfirm(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed");
      setConfirm(null);
    }
  }

  async function onResetConfirmed(): Promise<void> {
    if (!confirm || confirm.kind !== "reset" || confirm.busy) return;
    setConfirm({ ...confirm, busy: true });
    const r = confirm.row;
    try {
      const res = await fetch(`/api/workflows/${r.id}/reset`, {
        method: "POST",
      });
      if (!res.ok) {
        toast.error(`Failed to reset (${res.status})`);
        setConfirm(null);
        return;
      }
      toast.success(`Reset ${r.id} to default`);
      setConfirm(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reset failed");
      setConfirm(null);
    }
  }

  async function onCloneSubmitted(form: {
    new_id: string;
    new_label?: string;
    new_short_label?: string;
  }): Promise<void> {
    if (!clone) return;
    const sourceId = clone.source.id;
    const body: Record<string, string> = { new_id: form.new_id };
    if (form.new_label) body.new_label = form.new_label;
    if (form.new_short_label) body.new_short_label = form.new_short_label;

    const res = await fetch(`/api/workflows/${sourceId}/clone`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 409) {
      toast.error(
        `A workflow named "${form.new_id}" already exists. Pick a different id.`,
      );
      return;
    }
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as {
        issues?: ZodIssue[];
      };
      const msg = errBody.issues?.[0]?.message ?? `Clone failed (${res.status})`;
      toast.error(msg);
      return;
    }
    toast.success(`Cloned ${sourceId} → ${form.new_id}`);
    setClone(null);
    router.refresh();
  }

  async function onFileChosen(
    e: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    let parsed: unknown;
    try {
      const text = await file.text();
      parsed = JSON.parse(text);
    } catch {
      toast.error("Invalid JSON file");
      return;
    }
    const id =
      typeof parsed === "object" &&
      parsed !== null &&
      "id" in parsed &&
      typeof (parsed as { id: unknown }).id === "string"
        ? (parsed as { id: string }).id
        : "(unknown)";

    try {
      const result = await runImport({
        post: (doOverwrite) =>
          fetch(
            doOverwrite
              ? "/api/workflows/import?overwrite=1"
              : "/api/workflows/import",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(parsed),
            },
          ),
        onConflict: () => overwrite.requestConfirm(id),
      });
      if (result.cancelled) return;
      if (result.ok) {
        toast.success(`Imported ${id}`);
        router.refresh();
        return;
      }
      const body = result.body as ImportErrorBody | null;
      const decoded = decodeImportError(body, result.status, {});
      toast.error(decoded.message);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
    } finally {
      overwrite.endRequest();
    }
  }

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
          Registry · {rows.length}{" "}
          {rows.length === 1 ? "workflow" : "workflows"}
        </p>
        <Button
          type="button"
          variant="outline"
          onClick={() => fileInputRef.current?.click()}
        >
          <Upload aria-hidden="true" />
          Import workflow
        </Button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => {
            void onFileChosen(e);
          }}
        />
      </div>

      <div className="space-y-5">
        {rows.map((r, idx) => {
          const isBuiltin = r.isBuiltin === 1;
          const isEnabled = r.enabled === 1;
          const toggleBusy = togglingId === r.id;
          const num = String(idx + 1).padStart(2, "0");
          return (
            <Card
              key={r.id}
              data-testid={`workflow-row-${r.id}`}
              className={cn(
                "overflow-hidden border border-slate-200 bg-slate-50 shadow-md ring-1 ring-black/5 dark:border-[hsl(225_22%_18%)] dark:bg-[hsl(222_22%_12%)] dark:ring-white/5",
                !isEnabled && "bg-slate-100/70 dark:bg-[hsl(225_22%_9%)]",
              )}
            >
              {/* Identity band */}
              <div className="flex items-start gap-5 px-5 pb-4 pt-5">
                <div
                  className={cn(
                    "shrink-0 select-none font-mono text-4xl font-semibold leading-none tabular-nums",
                    isEnabled
                      ? "text-slate-400 dark:text-[hsl(220_10%_50%)]"
                      : "text-slate-300 dark:text-[hsl(225_15%_28%)]",
                  )}
                  aria-hidden="true"
                >
                  {num}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                    <code>{r.id}</code>
                    <span className="text-muted-foreground/40">/</span>
                    <span>v{r.version}</span>
                    <span className="text-muted-foreground/40">·</span>
                    <span
                      className={cn(
                        "tracking-[0.2em]",
                        isBuiltin
                          ? "text-slate-600 dark:text-slate-400"
                          : "text-violet-700 dark:text-violet-300",
                      )}
                    >
                      {isBuiltin ? "Built-in" : "Custom"}
                    </span>
                  </div>
                  <h2
                    className={cn(
                      "mt-1.5 truncate font-display text-2xl font-medium leading-tight tracking-tight",
                      !isEnabled && "text-muted-foreground",
                    )}
                  >
                    {r.label}
                  </h2>
                  <p className="mt-0.5 truncate text-sm text-muted-foreground">
                    {r.shortLabel}
                  </p>
                </div>
                <div className="shrink-0">
                  {isEnabled ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-500/30">
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                      Enabled
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-600 ring-1 ring-inset ring-slate-300 dark:bg-slate-500/10 dark:text-slate-400 dark:ring-slate-500/30">
                      <span className="size-1.5 rounded-full bg-slate-400 dark:bg-slate-500" />
                      Disabled
                    </span>
                  )}
                </div>
              </div>

              {/* Providers band */}
              <div className="border-y border-slate-200 bg-slate-100 px-5 py-3 dark:border-[hsl(225_22%_16%)] dark:bg-[hsl(228_25%_8%)]">
                <div className="grid grid-cols-2 gap-x-4 gap-y-3 md:grid-cols-4">
                  <ProviderCell kind="script" value={r.providers.script} />
                  <ProviderCell kind="tts" value={r.providers.tts} />
                  <ProviderCell kind="image" value={r.providers.image} />
                  <ProviderCell kind="video" value={r.providers.video} />
                </div>
              </div>

              {/* Actions band */}
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
                  <span className="mr-1.5 text-base font-semibold tabular-nums text-foreground">
                    {r.stepCount}
                  </span>
                  steps
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button asChild type="button" size="sm" variant="infoSoft">
                    <Link href={`/workflows/${r.id}/edit`}>
                      <Pencil aria-hidden="true" />
                      Edit
                    </Link>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="accentSoft"
                    onClick={() => setClone({ source: r })}
                  >
                    <Copy aria-hidden="true" />
                    Clone
                  </Button>
                  <Button
                    asChild
                    type="button"
                    size="sm"
                    variant="secondarySoft"
                  >
                    <a
                      href={`/api/workflows/${r.id}/export`}
                      download={`${r.id}.json`}
                    >
                      <Download aria-hidden="true" />
                      Export
                    </a>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={isEnabled ? "warningSoft" : "successSoft"}
                    onClick={() => {
                      void onToggleEnabled(r);
                    }}
                    disabled={toggleBusy}
                  >
                    {isEnabled ? (
                      <>
                        <PowerOff aria-hidden="true" />
                        Disable
                      </>
                    ) : (
                      <>
                        <Power aria-hidden="true" />
                        Enable
                      </>
                    )}
                  </Button>
                  {isBuiltin ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondarySoft"
                      onClick={() =>
                        setConfirm({
                          kind: "reset",
                          row: r,
                          busy: false,
                        })
                      }
                    >
                      <RotateCcw aria-hidden="true" />
                      Reset
                    </Button>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      variant="destructiveSoft"
                      onClick={() =>
                        setConfirm({
                          kind: "delete",
                          row: r,
                          busy: false,
                        })
                      }
                    >
                      <Trash2 aria-hidden="true" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      {confirm?.kind === "delete" && (
        <ConfirmDialog
          title="Delete workflow?"
          message={`Delete workflow "${confirm.row.id}"? This cannot be undone.`}
          confirmLabel="Delete"
          destructive
          busy={confirm.busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void onDeleteConfirmed();
          }}
        />
      )}
      {confirm?.kind === "reset" && (
        <ConfirmDialog
          title="Reset to default?"
          message="Reset built-in to default? Any customizations to its label, providers, or step list will be lost."
          confirmLabel="Reset"
          destructive
          busy={confirm.busy}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            void onResetConfirmed();
          }}
        />
      )}
      {overwrite.dialog}
      {clone && (
        <CloneDialog
          source={clone.source}
          onCancel={() => setClone(null)}
          onSubmit={onCloneSubmitted}
        />
      )}
    </>
  );
}

type ProviderKind = "script" | "tts" | "image" | "video";

const PROVIDER_LABEL: Record<ProviderKind, string> = {
  script: "Script",
  tts: "Voice",
  image: "Image",
  video: "Video",
};

// Each category gets its own hue so the four-up grid is scannable at a glance —
// the colored caption is what the eye latches onto, not the (often verbose)
// provider id below it.
const PROVIDER_TONE: Record<ProviderKind, string> = {
  script: "text-indigo-700 dark:text-indigo-300",
  tts: "text-amber-700 dark:text-amber-300",
  image: "text-teal-700 dark:text-teal-300",
  video: "text-rose-700 dark:text-rose-300",
};

function ProviderCell({
  kind,
  value,
}: {
  kind: ProviderKind;
  value: string | null;
}): JSX.Element {
  return (
    <div className="min-w-0">
      <p
        className={cn(
          "font-mono text-[10px] font-semibold uppercase tracking-[0.18em]",
          PROVIDER_TONE[kind],
        )}
      >
        {PROVIDER_LABEL[kind]}
      </p>
      <p
        className={cn(
          "mt-0.5 truncate font-mono text-sm",
          value === null ? "text-muted-foreground/60" : "text-foreground",
        )}
      >
        {value ?? "—"}
      </p>
    </div>
  );
}

interface CloneFormState {
  new_id: string;
  new_label: string;
  new_short_label: string;
}

interface CloneSubmitPayload {
  new_id: string;
  new_label?: string;
  new_short_label?: string;
}

function CloneDialog({
  source,
  onCancel,
  onSubmit,
}: {
  source: WorkflowApiSummary;
  onCancel: () => void;
  onSubmit: (form: CloneSubmitPayload) => Promise<void>;
}): JSX.Element {
  const [form, setForm] = useState<CloneFormState>({
    new_id: "",
    new_label: "",
    new_short_label: "",
  });
  const [busy, setBusy] = useState(false);
  const canSubmit = form.new_id.trim().length > 0 && !busy;

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit({
        new_id: form.new_id.trim(),
        new_label: form.new_label.trim() || undefined,
        new_short_label: form.new_short_label.trim() || undefined,
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onCancel()}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={submit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>Clone &ldquo;{source.id}&rdquo;</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="clone-new-id">New id</Label>
            <Input
              id="clone-new-id"
              type="text"
              placeholder={`${source.id}-copy`}
              value={form.new_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, new_id: e.target.value }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits, and hyphens (kebab-case). The slug is
              the workflow&rsquo;s permanent id.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="clone-new-label">New label (optional)</Label>
            <Input
              id="clone-new-label"
              type="text"
              placeholder={`${source.label} (copy)`}
              value={form.new_label}
              onChange={(e) =>
                setForm((f) => ({ ...f, new_label: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="clone-new-short-label">
              New short label (optional)
            </Label>
            <Input
              id="clone-new-short-label"
              type="text"
              placeholder={source.shortLabel}
              value={form.new_short_label}
              onChange={(e) =>
                setForm((f) => ({ ...f, new_short_label: e.target.value }))
              }
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              Clone
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
