"use client";

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * Magnific UI URL the operator opens to select a variation. Must match
 * `MAGNIFIC_IMAGE_GEN_URL` in `extensions/magnific-ext/src/constants.js`
 * so the extension's content script injects on the same tab.
 */
const MAGNIFIC_IMAGE_GEN_URL = "https://www.magnific.com/app/ai-image-generator";

interface HitlPending {
  row_id: number;
  mode: string;
  prompt: string;
}

interface QueueSummary {
  hitl_pending: HitlPending | null;
}

export interface MagnificHitlBannerProps {
  videoId: string;
  /** Test seam — defaults to 5000ms, matching the worker step's poll cadence. */
  pollIntervalMs?: number;
}

export function MagnificHitlBanner({
  videoId,
  pollIntervalMs = 5000,
}: MagnificHitlBannerProps): JSX.Element | null {
  const [hitl, setHitl] = useState<HitlPending | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function poll(): Promise<void> {
      try {
        const res = await fetch(`/api/magnific/queue-summary/${videoId}`);
        if (!res.ok) return;
        const body = (await res.json()) as QueueSummary;
        if (cancelled) return;
        setHitl(body.hitl_pending ?? null);
      } catch {
        // Network blip — interval will retry. No-op.
      }
    }
    void poll();
    const id = setInterval(() => {
      void poll();
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [videoId, pollIntervalMs]);

  if (!hitl) return null;
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/50 dark:bg-amber-950 dark:text-amber-100"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <strong>Operator selection needed in Magnific tab</strong>
          <p className="mt-1 truncate italic">{hitl.prompt}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            window.open(MAGNIFIC_IMAGE_GEN_URL, "_blank");
          }}
        >
          <ExternalLink aria-hidden="true" className="h-3 w-3" />
          Open Magnific tab
        </Button>
      </div>
    </div>
  );
}
