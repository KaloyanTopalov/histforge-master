"use client";

import {
  AlertTriangle,
  Pause,
  Play,
  Power,
  PowerOff,
  Trash2,
} from "lucide-react";
import {
  futureDelta,
  getAccountStatus,
  relative,
  type AccountListItem,
  type AccountStatus,
} from "@/lib/flow-account-status";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

function renderPausedCell(status: AccountStatus): React.ReactNode {
  // Severity-ramped state column. Online → em-dash (nothing to surface).
  // Paused → amber; recovery_needed → red + alert icon; stopped → muted.
  // Mirrors the four-state scheme in `flow-accounts-strip.tsx`.
  if (status.kind === "online") {
    return "—";
  }
  if (status.kind === "recovery_needed") {
    return (
      <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
        <AlertTriangle aria-hidden="true" className="h-3.5 w-3.5" />
        {status.label}
      </span>
    );
  }
  if (status.kind === "paused") {
    return (
      <span className="text-amber-600 dark:text-amber-400">{status.label}</span>
    );
  }
  return <span className="text-muted-foreground">{status.label}</span>;
}

function renderCreditsCell(
  row: AccountListItem,
  nowMs: number = Date.now()
): React.ReactNode {
  const nowSec = Math.floor(nowMs / 1000);
  if (row.credits !== null) {
    return (
      <>
        {row.credits}
        {row.credits_updated_at !== null && (
          <span className="ml-1 text-muted-foreground">
            ({relative(row.credits_updated_at, nowSec)})
          </span>
        )}
      </>
    );
  }
  const status = getAccountStatus(row, nowSec);
  if (status.kind === "stopped") {
    return <span className="text-muted-foreground">{status.label}</span>;
  }
  return (
    <span className="text-muted-foreground">— (awaiting first poll)</span>
  );
}

export interface GoogleFlowAccountsTableProps {
  accounts: AccountListItem[];
  editing: { id: string; draft: string } | null;
  onStartEdit: (id: string, currentName: string) => void;
  onUpdateDraft: (draft: string) => void;
  onCommitEdit: () => void;
  onCancelEdit: () => void;
  onPauseFor: (id: string, hours: number) => void;
  onResume: (id: string) => void;
  onToggleEnabled: (row: AccountListItem) => void;
  togglingId: string | null;
  onRequestDelete: (row: AccountListItem) => void;
}

export function GoogleFlowAccountsTable({
  accounts,
  editing,
  onStartEdit,
  onUpdateDraft,
  onCommitEdit,
  onCancelEdit,
  onPauseFor,
  onResume,
  onToggleEnabled,
  togglingId,
  onRequestDelete,
}: GoogleFlowAccountsTableProps): JSX.Element {
  return (
    <Table className="mt-2 overflow-hidden rounded-lg border border-slate-200 dark:border-[hsl(225_22%_18%)]">
      <TableHeader className="bg-slate-200/70 dark:bg-[hsl(228_22%_12%)]">
        <TableRow className="hover:bg-transparent">
          <TableHead className="border-r border-slate-200 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-700 dark:border-[hsl(225_22%_18%)] dark:text-[hsl(220_10%_72%)]">
            Name
          </TableHead>
          <TableHead className="border-r border-slate-200 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-700 dark:border-[hsl(225_22%_18%)] dark:text-[hsl(220_10%_72%)]">
            Token
          </TableHead>
          <TableHead className="border-r border-slate-200 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-700 dark:border-[hsl(225_22%_18%)] dark:text-[hsl(220_10%_72%)]">
            Credits
          </TableHead>
          <TableHead className="border-r border-slate-200 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-700 dark:border-[hsl(225_22%_18%)] dark:text-[hsl(220_10%_72%)]">
            Paused
          </TableHead>
          <TableHead className="border-r border-slate-200 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-700 dark:border-[hsl(225_22%_18%)] dark:text-[hsl(220_10%_72%)]">
            Seen
          </TableHead>
          <TableHead className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-slate-700 dark:text-[hsl(220_10%_72%)]">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {accounts.map((row) => {
          const nowSec = Math.floor(Date.now() / 1000);
          const pausedLeft = futureDelta(row.paused_until, nowSec);
          const status = getAccountStatus(row, nowSec);
          return (
            <TableRow
              key={row.id}
              className="border-slate-200 odd:bg-white/70 even:bg-transparent hover:bg-slate-50 dark:border-[hsl(225_22%_18%)] dark:odd:bg-[hsl(225_22%_10%)] dark:hover:bg-[hsl(222_22%_14%)]"
            >
              <TableCell className="border-r border-slate-200 font-mono text-xs dark:border-[hsl(225_22%_18%)]">
                {editing?.id === row.id ? (
                  <Input
                    type="text"
                    aria-label={`edit name ${row.id}`}
                    autoFocus
                    value={editing.draft}
                    onChange={(e) => onUpdateDraft(e.target.value)}
                    onBlur={() => onCommitEdit()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        onCommitEdit();
                      } else if (e.key === "Escape") {
                        e.preventDefault();
                        onCancelEdit();
                      }
                    }}
                    className="h-7 w-32 text-xs"
                  />
                ) : (
                  <button
                    type="button"
                    className="text-left hover:underline"
                    onClick={() => onStartEdit(row.id, row.name)}
                  >
                    {row.name}
                  </button>
                )}
                <span className="ml-2 text-muted-foreground">
                  ({row.id})
                </span>
              </TableCell>
              <TableCell className="border-r border-slate-200 font-mono text-xs dark:border-[hsl(225_22%_18%)]">
                {row.token_display}
              </TableCell>
              <TableCell className="border-r border-slate-200 text-xs dark:border-[hsl(225_22%_18%)]">
                {renderCreditsCell(row)}
              </TableCell>
              <TableCell className="border-r border-slate-200 text-xs dark:border-[hsl(225_22%_18%)]">
                {renderPausedCell(status)}
              </TableCell>
              <TableCell className="border-r border-slate-200 text-xs dark:border-[hsl(225_22%_18%)]">
                {row.last_seen_at === null
                  ? "offline"
                  : `seen ${relative(row.last_seen_at, nowSec)}`}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                <div className="flex items-center gap-1">
                  {row.enabled === 1 &&
                    (pausedLeft ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="successSoft"
                        onClick={() => onResume(row.id)}
                      >
                        <Play aria-hidden="true" />
                        Resume
                      </Button>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="infoSoft"
                        onClick={() => onPauseFor(row.id, 4)}
                      >
                        <Pause aria-hidden="true" />
                        Pause 4h
                      </Button>
                    ))}
                  <Button
                    type="button"
                    size="sm"
                    variant={row.enabled === 1 ? "warningSoft" : "successSoft"}
                    onClick={() => onToggleEnabled(row)}
                    disabled={togglingId !== null}
                  >
                    {row.enabled === 1 ? (
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
                  <Button
                    type="button"
                    size="iconSm"
                    variant="outline"
                    onClick={() => onRequestDelete(row)}
                    title="Delete"
                    aria-label="Delete"
                    className="text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Trash2 aria-hidden="true" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
