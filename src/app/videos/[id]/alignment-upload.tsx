"use client";

import { useRef, useState } from "react";
import { CheckCircle2, Loader2, Sparkles, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

interface AlignmentUploadProps {
  videoId: string;
  /**
   * True when `alignment/alignment.json` is already present in the
   * video's project folder. Either because the operator uploaded one
   * or because step 07 has already run with aeneas. In both cases the
   * pipeline will reuse the file; this component just communicates
   * that fact and offers a "Replace" affordance.
   */
  hasExistingAlignment: boolean;
  /**
   * True when `audio/narration.mp3` is present. The auto-transcribe
   * button is only enabled when there's audio to transcribe.
   */
  hasVoiceover: boolean;
}

/**
 * Alignment upload widget on the video detail page.
 *
 * POSTs to `/api/videos/:id/alignment` with a multipart `file` field;
 * the server validates JSON shape (or parses SRT/VTT) and writes the
 * normalised payload to `alignment/alignment.json`. Step 07
 * (`worker/steps/07-align.ts`) then detects the file at step entry
 * and skips the WSL/aeneas call.
 *
 * Useful when the host doesn't have WSL installed (Windows without
 * dev features enabled), or when the operator already has a
 * Whisper/Descript SRT they want to reuse.
 *
 * Re-loads the page on success so the artifacts panel + step list
 * pick up the new file.
 */
export function AlignmentUpload({
  videoId,
  hasExistingAlignment,
  hasVoiceover,
}: AlignmentUploadProps): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
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
      const r = await fetch(`/api/videos/${videoId}/alignment`, {
        method: "POST",
        body: fd,
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        entries?: number;
        sourceFormat?: string;
        error?: string;
        message?: string;
      };
      if (!r.ok) {
        setError(data.message || data.error || `Upload failed (HTTP ${r.status}).`);
      } else {
        const entries = typeof data.entries === "number" ? data.entries : 0;
        const src = data.sourceFormat === "srt" ? "SRT/VTT" : "JSON";
        setSuccess(`Saved ${entries} entries from ${src}. Reloading…`);
        setTimeout(() => {
          window.location.reload();
        }, 1200);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function onAutoTranscribe(): Promise<void> {
    setTranscribing(true);
    setError(null);
    setSuccess(null);
    try {
      const r = await fetch(`/api/videos/${videoId}/alignment/auto-transcribe`, {
        method: "POST",
      });
      const data = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        entries?: number;
        model?: string;
        durationSec?: number | null;
        error?: string;
        message?: string;
      };
      if (!r.ok) {
        setError(data.message || data.error || `Auto-transcribe failed (HTTP ${r.status}).`);
      } else {
        const entries = typeof data.entries === "number" ? data.entries : 0;
        const dur = typeof data.durationSec === "number" ? ` (${Math.round(data.durationSec)}s)` : "";
        setSuccess(`Whisper produced ${entries} entries${dur} via ${data.model || "default model"}. Reloading…`);
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTranscribing(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <h2 className="text-sm font-semibold">Alignment</h2>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">
          Upload a pre-computed alignment to skip the WSL/aeneas step.
          Accepts <code>.json</code> (aeneas-shape{" "}
          <code>{"[{ id, text, begin, end }]"}</code>) or{" "}
          <code>.srt</code> / <code>.vtt</code> (parsed and converted
          automatically). Useful when WSL isn&apos;t installed locally or
          you already have a Whisper/Descript transcript. If you upload
          after the align step has already run, click{" "}
          <strong>Retry failed step</strong> on the align row to re-pick
          the file.
        </p>
        {hasExistingAlignment && (
          <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
            <CheckCircle2 className="h-3.5 w-3.5" />
            <span>
              <code>alignment/alignment.json</code> is present — aeneas
              will be skipped on the next run.
            </span>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept=".json,.srt,.vtt,application/json,text/plain"
            className="hidden"
            onChange={(e) => void onFileChange(e)}
            disabled={busy || transcribing}
          />
          <Button
            type="button"
            variant="secondary"
            disabled={busy || transcribing}
            onClick={() => inputRef.current?.click()}
          >
            {busy ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {hasExistingAlignment ? "Replace alignment" : "Upload alignment"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            disabled={busy || transcribing || !hasVoiceover}
            title={
              !hasVoiceover
                ? "Upload or generate a voiceover first."
                : "Run Whisper against audio/narration.mp3 and save the result as alignment.json."
            }
            onClick={() => void onAutoTranscribe()}
          >
            {transcribing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            Auto-transcribe (Whisper)
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
