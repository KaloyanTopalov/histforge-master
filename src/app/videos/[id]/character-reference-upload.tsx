"use client";

import { useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface CharacterReferenceUploadProps {
  videoId: string;
  /**
   * True when `character_reference.png` is already present in the
   * video's project folder. The worker's enqueue path picks it up
   * automatically on the next image-generation run, so this just
   * communicates state and offers a "Replace" affordance.
   */
  hasExistingReference: boolean;
}

/**
 * Per-video character reference upload widget. Sits alongside the
 * voiceover + alignment widgets on the video detail page.
 *
 * POSTs to `/api/videos/:id/character-reference` with a multipart
 * `file` field. The server transcodes non-PNG uploads (JPEG, WebP)
 * to PNG so the on-disk basename is always `character_reference.png`
 * — pending Flow queue rows captured at enqueue time can't dangle
 * after a re-upload.
 *
 * Once uploaded, the worker's `enqueueChunks` picks the file up on the
 * next image step, and the Flow dispatch route emits an artifact URL
 * on every `createImage` task. The youforge-flow extension fetches
 * that URL and uploads the bytes as `imageInputs` so Flow can lock
 * character identity across shots.
 */
export function CharacterReferenceUpload({
  videoId,
  hasExistingReference,
}: CharacterReferenceUploadProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onFileChange(
    e: React.ChangeEvent<HTMLInputElement>
  ): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`/api/videos/${videoId}/character-reference`, {
        method: "POST",
        body: fd,
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        bytes?: number;
        transcoded?: boolean;
        error?: string;
        message?: string;
      };
      if (!r.ok) {
        setError(data.message || data.error || `Upload failed (HTTP ${r.status}).`);
      } else {
        const bytesLabel =
          typeof data.bytes === "number" ? formatBytes(data.bytes) : "ok";
        setSuccess(
          data.transcoded
            ? `Uploaded and transcoded to PNG (${bytesLabel}). Reloading…`
            : `Uploaded PNG (${bytesLabel}). Reloading…`
        );
        // Soft reload so the artifacts panel + this widget pick up the
        // new file. setTimeout keeps the success message visible long
        // enough that the operator sees it before the page navigates.
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      // Reset the input so re-selecting the same file fires onChange.
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Character reference</h2>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Upload a reference image of the character that should appear in
          every shot. Google Flow uses it to lock identity across image
          generations. Accepted formats: PNG, JPEG, WebP (non-PNG files
          are transcoded via ffmpeg). If you upload after the image
          step has already run, click
          <strong> Retry failed step </strong>
          on the image row to regenerate with the new reference.
        </p>
        {hasExistingReference && (
          <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              <code>character_reference.png</code> is present — Flow
              will receive it on the next image run.
            </span>
          </p>
        )}
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp"
            className="hidden"
            onChange={(e) => void onFileChange(e)}
            disabled={busy}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {hasExistingReference
              ? "Replace reference"
              : "Upload reference"}
          </Button>
        </div>
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
        )}
        {success && (
          <p className="text-xs text-green-700 dark:text-green-400">{success}</p>
        )}
      </CardContent>
    </Card>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
