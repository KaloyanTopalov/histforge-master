"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { Video, VideoStatus } from "@/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DeleteConfirmDialogProps {
  video: Video;
  onClose: () => void;
  /**
   * Optional hook fired after a successful DELETE. `deferred` is true
   * when the server accepted the request but left cleanup to the
   * orchestrator (HTTP 202, in_progress videos). Callers on the detail
   * page use this to redirect immediately when the row really is gone.
   */
  onSuccess?: (deferred: boolean) => void;
}

function confirmMessage(status: VideoStatus): string {
  switch (status) {
    case "in_progress":
      return "This video is being generated. Deletion will take effect after the current step finishes and will remove all generated files.";
    case "queued":
    case "failed":
    case "done":
      return "All generated files will be permanently removed.";
    case "new":
    default:
      return "This will remove the video entry.";
  }
}

export function DeleteConfirmDialog({
  video,
  onClose,
  onSuccess,
}: DeleteConfirmDialogProps): JSX.Element {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDelete(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/videos/${video.id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(body.message ?? `Delete failed (${res.status})`);
        return;
      }
      const deferred = res.status === 202;
      onSuccess?.(deferred);
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete video?</AlertDialogTitle>
          <AlertDialogDescription>
            {confirmMessage(video.status)}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p className="text-sm text-destructive" role="alert">
            {error}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={busy}
            onClick={(e) => {
              e.preventDefault();
              void onDelete();
            }}
            className={cn(buttonVariants({ variant: "destructive" }))}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
