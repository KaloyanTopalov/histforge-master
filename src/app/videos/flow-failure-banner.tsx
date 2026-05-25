"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface FlowCreateProjectFailedPayload {
  errorCode: string | null;
  when: number | null;
  accountId: string | null;
}

function parseFlowCreateProjectFailed(
  raw: string
): FlowCreateProjectFailedPayload | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    return {
      errorCode: typeof obj.errorCode === "string" ? obj.errorCode : null,
      when: typeof obj.when === "number" ? obj.when : null,
      accountId: typeof obj.accountId === "string" ? obj.accountId : null,
    };
  } catch {
    return { errorCode: null, when: null, accountId: null };
  }
}

interface FlowFailureBannerProps {
  raw: string;
  onCleared: () => void;
}

export function FlowFailureBanner({
  raw,
  onCleared,
}: FlowFailureBannerProps): JSX.Element | null {
  const [dismissing, setDismissing] = useState(false);
  const payload = parseFlowCreateProjectFailed(raw);
  if (payload === null) return null;

  async function onDismiss(): Promise<void> {
    if (dismissing) return;
    setDismissing(true);
    try {
      const res = await fetch("/api/flow/clear-create-project-failed", {
        method: "POST",
      });
      if (res.ok) {
        onCleared();
      } else {
        toast.error("Failed to dismiss the create-project banner");
      }
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900 dark:border-red-500/50 dark:bg-red-950 dark:text-red-100"
    >
      <div>
        <strong>Flow project creation is failing.</strong> Check the
        YouForge Flow extension service-worker logs at{" "}
        <code>chrome://extensions</code> and verify the trpc envelope
        hasn&apos;t drifted. Last failure:{" "}
        <code>{payload.errorCode ?? "(unknown)"}</code> at{" "}
        <time
          dateTime={
            payload.when !== null
              ? new Date(payload.when * 1000).toISOString()
              : undefined
          }
        >
          {payload.when !== null
            ? new Date(payload.when * 1000)
                .toISOString()
                .replace("T", " ")
                .replace(/\.\d{3}Z$/, "Z")
            : "(unknown)"}
        </time>{" "}
        for account{" "}
        <code>{payload.accountId ?? "(unknown)"}</code>.
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => {
          void onDismiss();
        }}
        disabled={dismissing}
      >
        {dismissing ? (
          <Loader2 aria-hidden="true" className="animate-spin" />
        ) : (
          <X aria-hidden="true" />
        )}
        Dismiss
      </Button>
    </div>
  );
}
