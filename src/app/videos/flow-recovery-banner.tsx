"use client";

import { useState } from "react";
import {
  AlertTriangle,
  Check,
  ExternalLink,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { relative } from "@/lib/flow-account-status";

interface FlowRecoveryBannerAccount {
  id: string;
  name: string;
  required_at: number;
}

interface FlowRecoveryBannerProps {
  accounts: FlowRecoveryBannerAccount[];
  onCleared: (accountId: string) => void;
}

const LABS_GOOGLE_URL = "https://labs.google/fx/tools/flow";

/**
 * Operator-gated reCAPTCHA recovery banner. One row per affected account,
 * each with an external link to labs.google and a per-row Mark recovered
 * button. The banner self-clears when the last affected account is
 * recovered (controlled via `onCleared`, which the parent uses to optimistic-
 * patch the accounts list — the next videos poll re-overwrites from the
 * server).
 */
export function FlowRecoveryBanner({
  accounts,
  onCleared,
}: FlowRecoveryBannerProps): JSX.Element | null {
  const [clearingId, setClearingId] = useState<string | null>(null);
  if (accounts.length === 0) return null;

  async function onMarkRecovered(id: string): Promise<void> {
    if (clearingId !== null) return;
    setClearingId(id);
    try {
      const res = await fetch(
        `/api/flow/accounts/${id}/clear-captcha-recovery`,
        { method: "POST" }
      );
      if (res.ok) {
        onCleared(id);
      } else {
        toast.error(`Failed to clear recovery for ${id}`);
      }
    } finally {
      setClearingId(null);
    }
  }

  const nowSec = Math.floor(Date.now() / 1000);

  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/50 dark:bg-red-950 dark:text-red-100"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle aria-hidden="true" className="h-4 w-4" />
        <strong>reCAPTCHA recovery required</strong>
      </div>
      <p className="mt-1">
        Open{" "}
        <code>labs.google/fx/tools/flow</code> in the same Chrome profile
        the affected account is signed into and interact with the page for
        ~30 seconds (scroll, click around) to re-establish the reCAPTCHA
        trust score. Recovery is per-Chrome-profile, not per-tab. Click{" "}
        <strong>Mark recovered</strong> once the session is engaged; the
        next dispatched task will validate.
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {accounts.map((a) => {
          const isClearing = clearingId === a.id;
          return (
            <li
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-white/40 px-2 py-1 dark:border-red-500/30 dark:bg-red-950/40"
            >
              <span className="font-mono text-xs">{a.id}</span>
              <span className="font-medium">{a.name}</span>
              <span className="text-xs text-red-700/80 dark:text-red-200/70">
                flagged {relative(a.required_at, nowSec)}
              </span>
              <a
                href={LABS_GOOGLE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-xs underline underline-offset-2 hover:no-underline"
              >
                <ExternalLink aria-hidden="true" className="h-3 w-3" />
                Open labs.google
              </a>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={clearingId !== null}
                onClick={() => {
                  void onMarkRecovered(a.id);
                }}
              >
                {isClearing ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <Check aria-hidden="true" />
                )}
                Mark recovered
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
