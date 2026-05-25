"use client";

import { AlertTriangle } from "lucide-react";
import {
  getAccountStatus,
  type AccountListItem,
  type AccountStatusKind,
} from "@/lib/flow-account-status";

interface FlowAccountsStripProps {
  accounts: AccountListItem[];
  nowSec: number;
}

/**
 * Severity-ramped visual tokens, parallel to the account state machine in
 * `getAccountStatus`. Centralised so the dot, optional inline icon, and
 * label color stay in lock-step — drift between any two of them produces
 * the kind of contradictory affordance ("red dot, neutral text") that
 * defeats the purpose of severity ramping.
 */
const SEVERITY: Record<
  AccountStatusKind,
  { dot: string; label: string | null }
> = {
  online: {
    dot: "border-green-600 bg-green-600 dark:border-green-400 dark:bg-green-400",
    label: null,
  },
  paused: {
    dot: "border-amber-500 bg-amber-500 dark:border-amber-400 dark:bg-amber-400",
    label: "text-amber-600 dark:text-amber-400",
  },
  recovery_needed: {
    dot: "border-red-600 bg-red-600 dark:border-red-400 dark:bg-red-400",
    label: "text-red-600 dark:text-red-400",
  },
  stopped: {
    dot: "border-muted-foreground",
    label: null,
  },
};

/**
 * Compact, read-only health list for Flow accounts. One row per account
 * (dot + name on the left, status + credits on the right) so the panel
 * stays scannable inside the narrow video-detail left column. Full CRUD
 * still lives in Settings > Google Flow.
 */
export function FlowAccountsStrip({
  accounts,
  nowSec,
}: FlowAccountsStripProps): JSX.Element {
  if (accounts.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No Flow accounts configured — add one in Settings &gt; Google Flow
      </p>
    );
  }
  return (
    <ul className="flex flex-col divide-y divide-border/60 text-sm">
      {accounts.map((a) => {
        const status = getAccountStatus(a, nowSec);
        const severity = SEVERITY[status.kind];
        return (
          <li
            key={a.id}
            className="flex items-center gap-3 py-1.5 first:pt-0 last:pb-0"
          >
            <span
              aria-hidden="true"
              className={`inline-block h-2 w-2 shrink-0 rounded-full border ${severity.dot}`}
              title={status.kind}
            />
            {status.kind === "recovery_needed" && (
              <AlertTriangle
                aria-hidden="true"
                className="h-3.5 w-3.5 shrink-0 text-red-600 dark:text-red-400"
              />
            )}
            <span className="font-medium">{a.name}</span>
            <span
              className={`ml-auto inline-flex flex-wrap items-center justify-end gap-x-2 text-xs ${
                severity.label ?? "text-muted-foreground"
              }`}
            >
              <span>{status.label}</span>
              {a.credits !== null && (
                <span className="font-mono tabular-nums">
                  ({a.credits} credits)
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
