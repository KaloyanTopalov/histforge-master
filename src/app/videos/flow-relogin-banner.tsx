"use client";

import { useState } from "react";
import { Loader2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

interface FlowReloginBannerProps {
  visible: boolean;
  onCleared: () => void;
}

/**
 * Shown when `google_flow_relogin_needed` is true. The flag is set by
 * `/api/flow/status` on a `session_expired` event and auto-cleared by
 * `/api/flow/next-task` on the first successful claim — Dismiss is a
 * snooze, the banner returns on the next session_expired event.
 */
export function FlowReloginBanner({
  visible,
  onCleared,
}: FlowReloginBannerProps): JSX.Element | null {
  const [dismissing, setDismissing] = useState(false);
  if (!visible) return null;

  async function onDismiss(): Promise<void> {
    if (dismissing) return;
    setDismissing(true);
    try {
      const res = await fetch("/api/flow/clear-relogin-needed", {
        method: "POST",
      });
      if (res.ok) {
        onCleared();
      } else {
        toast.error("Failed to dismiss the session-expired banner");
      }
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div
      role="alert"
      className="mb-4 flex items-start justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-950 dark:text-amber-100"
    >
      <div>
        <strong>YouForge Flow session expired.</strong> Re-login at{" "}
        <code>labs.google</code> on the main page (not inside a project),
        then the extension auto-resumes polling within ~1 minute. The
        banner clears on the next successful task dispatch.
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
