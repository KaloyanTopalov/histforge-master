"use client";

import { useRef, useState } from "react";
import { CheckCircle2, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface VoiceoverUploadProps {
  videoId: string;
  /**
   * True when `audio/narration.mp3` is already present in the video's
   * project folder — either because the operator previously uploaded
   * one or because step 06 has run with TTS. In both cases the
   * pipeline will reuse the file; this component just communicates
   * that fact and offers a "Replace" affordance.
   */
  hasExistingVoiceover: boolean;
}

/**
 * Voiceover upload widget on the video detail page.
 *
 * POSTs to `/api/videos/:id/voiceover` with a multipart `file` field;
 * the server writes (or transcodes) the upload to
 * `audio/narration.mp3` inside the video's project directory. Step 06
 * (`worker/steps/06-voiceover.ts`) then detects the file at step
 * entry and skips the TTS provider call.
 *
 * The component re-loads the page on success so the artifacts panel
 * + step list pick up the new file without a manual refresh.
 */
export function VoiceoverUpload({
  videoId,
  hasExistingVoiceover,
}: VoiceoverUploadProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onFileChange(e: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const r = await fetch(`/api/videos/${videoId}/voiceover`, {
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
        const bytesLabel = typeof data.bytes === "number" ? formatBytes(data.bytes) : "ok";
        setSuccess(
          data.transcoded
            ? `Uploaded and transcoded to MP3 (${bytesLabel}). Reloading…`
            : `Uploaded MP3 (${bytesLabel}). Reloading…`,
        );
        // Soft reload so the artifacts panel + step list pick up the
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
        <h2 className="text-sm font-semibold">Voiceover</h2>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Upload a pre-rendered narration to skip the TTS step. The
          pipeline will run alignment against this audio instead of
          generating one. Accepted formats: mp3, wav, m4a, aac, ogg,
          flac (non-mp3 files are transcoded via ffmpeg). If you
          upload after the voiceover step has already run, click
          <strong> Retry failed step </strong>
          on the voiceover row to re-pick the file.
        </p>
        {hasExistingVoiceover && (
          <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              <code>audio/narration.mp3</code> is present — TTS will be skipped on the next run.
            </span>
          </p>
        )}
        <div>
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.aac,.ogg,.flac"
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
            {hasExistingVoiceover ? "Replace voiceover" : "Upload voiceover"}
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
