"use client";

import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import type { Video } from "@/types";
import type { VideosClientWorkflow, VideosClientVisualStyle } from "./videos-client";
import { VisualStylePicker } from "./visual-style-picker";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

interface AddReadyScriptModalProps {
  mode: "add" | "edit";
  video?: Video;
  workflows: readonly VideosClientWorkflow[];
  visualStyles: readonly VideosClientVisualStyle[];
  onClose: () => void;
}

interface FormState {
  title: string;
  provided_script: string;
  workflow_id: string;
  visual_style_id: string;
}

// Sentinel `topic_info` for ready-script videos — script generation
// (steps 01–05) is skipped, so the field carries no real value. The
// schema layer still requires `topic_info`; this string makes the
// "irrelevant" intent obvious if anyone ever inspects the row.
const SENTINEL_TOPIC_INFO = "[ready script — generation skipped]";

function initialForm(
  mode: "add" | "edit",
  video: Video | undefined
): FormState {
  if (mode === "edit" && video) {
    return {
      title: video.title,
      provided_script: video.provided_script ?? "",
      workflow_id: video.workflow_id,
      visual_style_id: video.visual_style_id ?? "",
    };
  }
  return {
    title: "",
    provided_script: "",
    workflow_id: "",
    visual_style_id: "",
  };
}

export function AddReadyScriptModal({
  mode,
  video,
  workflows,
  visualStyles,
  onClose,
}: AddReadyScriptModalProps): JSX.Element {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialForm(mode, video));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Narrative-only modal — music-video workflows must not appear in the
  // dropdown. Mirrors `AddMusicVideoModal`'s in-component filter.
  const narrativeWorkflows = useMemo(
    () => workflows.filter((w) => w.kind === "narrative"),
    [workflows],
  );

  const canSubmit =
    !busy &&
    form.title.trim().length > 0 &&
    form.provided_script.trim().length > 0 &&
    form.workflow_id.length > 0;

  function onLoadFromFile(): void {
    fileInputRef.current?.click();
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>): void {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text =
        typeof reader.result === "string" ? reader.result : "";
      setForm((f) => ({ ...f, provided_script: text }));
    };
    reader.readAsText(file);
    // Reset so picking the same file twice still fires `change`.
    e.target.value = "";
  }

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const isEdit = mode === "edit" && video;
      const url = isEdit ? `/api/videos/${video.id}` : "/api/videos";
      const method = isEdit ? "PATCH" : "POST";
      // PATCH does not re-send topic_info — the sentinel is set at create
      // time and never changes via this modal (Edit cannot switch a
      // ready-script video into a topic-driven one; see plan Scope).
      const visual_style_id =
        form.visual_style_id === "" ? null : form.visual_style_id;
      const body = isEdit
        ? {
            title: form.title.trim(),
            workflow_id: form.workflow_id,
            provided_script: form.provided_script,
            visual_style_id,
          }
        : {
            title: form.title.trim(),
            topic_info: SENTINEL_TOPIC_INFO,
            workflow_id: form.workflow_id,
            provided_script: form.provided_script,
            visual_style_id,
          };
      const res = await fetch(url, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          message?: string;
        };
        setError(errBody.message ?? `Save failed (${res.status})`);
        return;
      }
      router.refresh();
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent aria-describedby={undefined}>
        <form onSubmit={onSubmit} className="min-w-0 space-y-4">
          <DialogHeader>
            <DialogTitle>
              {mode === "edit" ? "Edit Ready Script" : "Add Ready Script"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="ready-script-title">Title</Label>
            <Input
              id="ready-script-title"
              type="text"
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="ready-script-body">Script</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={onLoadFromFile}
              >
                <Upload aria-hidden="true" className="mr-1 h-4 w-4" />
                Load from file…
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".txt,.md"
                className="hidden"
                onChange={onFileChange}
                aria-hidden="true"
              />
            </div>
            <Textarea
              id="ready-script-body"
              rows={14}
              value={form.provided_script}
              onChange={(e) =>
                setForm((f) => ({ ...f, provided_script: e.target.value }))
              }
              placeholder="Paste the full script here, or use Load from file…"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="ready-script-workflow">Workflow</Label>
            <Select
              value={form.workflow_id}
              onValueChange={(value) =>
                setForm((f) => ({ ...f, workflow_id: value }))
              }
            >
              <SelectTrigger id="ready-script-workflow">
                <SelectValue placeholder="Select a workflow…" />
              </SelectTrigger>
              <SelectContent>
                {narrativeWorkflows.map((w, i) => (
                  <SelectItem key={w.id} value={w.id} title={w.label}>
                    {i + 1}. {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <VisualStylePicker
            id="ready-script-visual-style"
            visualStyles={visualStyles}
            value={form.visual_style_id}
            onChange={(value) =>
              setForm((f) => ({ ...f, visual_style_id: value }))
            }
          />

          {error && (
            <p className="text-sm text-destructive" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {mode === "edit" ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
