"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { VideoStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ConfirmDialog } from "../confirm-dialog";
import { SectionHeading } from "../_shared";
import { useVideoAction } from "../use-video-action";

/**
 * The irreversibility warning rendered in the cleanup confirmation
 * dialog. Exported so the component test can assert against this
 * constant (not a literal string copy) — any future wording change
 * must touch this file and surfaces in code review.
 */
export const CLEANUP_CONFIRM_TEXT =
  "This will permanently delete all intermediates (images, audio, alignment, chunks) for this video. The final video stays. This cannot be undone. Continue?";

interface CleanupSectionProps {
  videoId: string;
  status: VideoStatus;
  intermediatesPresent: boolean;
}

/**
 * Operator-triggered cleanup surface on the video detail page. Renders
 * only on `done` videos (matches the `isCleanupable` predicate that
 * gates the API route). The button is disabled when the four
 * intermediate dirs are already absent so a re-click after cleanup
 * doesn't look interactive. Click → confirm dialog → POST to
 * `/api/videos/:id/cleanup`.
 *
 * Independent of the `auto_cleanup_after_render` setting — this is the
 * explicit operator trigger and runs regardless of the gate.
 */
export function CleanupSection({
  videoId,
  status,
  intermediatesPresent,
}: CleanupSectionProps): JSX.Element | null {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const runAction = useVideoAction();

  if (status !== "done") return null;

  const disabled = !intermediatesPresent || busy;

  async function runCleanup(): Promise<void> {
    await runAction({
      url: `/api/videos/${videoId}/cleanup`,
      onSuccess: () => {
        toast.success("Intermediates removed.");
      },
      errorToast: { fallback: "Cleanup failed" },
      busy: { isBusy: busy, setBusy },
    });
  }

  return (
    <>
      <Card>
        <CardHeader>
          <SectionHeading title="Storage" accent="slate" />
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Intermediate artifacts (images, audio, alignment, chunks)
            are kept after render so a failed run can be diagnosed or
            re-tried. Remove them when no longer needed — the final
            video stays.
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            title={
              !intermediatesPresent && !busy
                ? "Intermediates already removed"
                : undefined
            }
            onClick={() => setConfirmOpen(true)}
          >
            {busy ? (
              <Loader2 aria-hidden="true" className="animate-spin" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
            Cleanup intermediates
          </Button>
        </CardContent>
      </Card>

      {confirmOpen && (
        <ConfirmDialog
          title="Delete intermediates?"
          message={CLEANUP_CONFIRM_TEXT}
          confirmLabel="Cleanup"
          destructive
          busy={busy}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            void runCleanup();
          }}
        />
      )}
    </>
  );
}
