"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Video } from "@/types";
import type { VideosClientWorkflow, VideosClientVisualStyle } from "./videos-client";
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
import { VisualStylePicker } from "./visual-style-picker";

interface AddVideoModalProps {
  mode: "add" | "edit";
  video?: Video;
  workflows: readonly VideosClientWorkflow[];
  visualStyles: readonly VideosClientVisualStyle[];
  onClose: () => void;
}

interface FormState {
  title: string;
  topic_info: string;
  workflow_id: string;
  visual_style_id: string;
}

function initialForm(
  mode: "add" | "edit",
  video: Video | undefined
): FormState {
  if (mode === "edit" && video) {
    return {
      title: video.title,
      topic_info: video.topic_info,
      workflow_id: video.workflow_id,
      visual_style_id: video.visual_style_id ?? "",
    };
  }
  return { title: "", topic_info: "", workflow_id: "", visual_style_id: "" };
}

/**
 * Modal for creating or editing a draft video. All three fields
 * (title, topic_info, workflow_id) are required; submit is disabled
 * until each has a non-empty value. Workflow has no default selection —
 * a placeholder option forces an explicit pick.
 */
export function AddVideoModal({
  mode,
  video,
  workflows,
  visualStyles,
  onClose,
}: AddVideoModalProps): JSX.Element {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialForm(mode, video));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Narrative-only modal — music-video workflows must not appear in the
  // dropdown. Mirrors `AddMusicVideoModal`'s in-component filter so the
  // parent can keep passing the unfiltered workflow list to every modal.
  const narrativeWorkflows = useMemo(
    () => workflows.filter((w) => w.kind === "narrative"),
    [workflows],
  );

  const canSubmit =
    !busy &&
    form.title.trim().length > 0 &&
    form.topic_info.trim().length > 0 &&
    form.workflow_id.length > 0;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        title: form.title.trim(),
        topic_info: form.topic_info.trim(),
        workflow_id: form.workflow_id,
        visual_style_id:
          form.visual_style_id === "" ? null : form.visual_style_id,
      };
      const url =
        mode === "edit" && video ? `/api/videos/${video.id}` : "/api/videos";
      const res = await fetch(url, {
        method: mode === "edit" ? "PATCH" : "POST",
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
              {mode === "edit" ? "Edit Topic" : "Add Topic"}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="add-video-title">Title</Label>
            <Input
              id="add-video-title"
              type="text"
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-video-topic-info">Topic info</Label>
            <Textarea
              id="add-video-topic-info"
              rows={6}
              value={form.topic_info}
              onChange={(e) =>
                setForm((f) => ({ ...f, topic_info: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-video-workflow">Workflow</Label>
            <Select
              value={form.workflow_id}
              onValueChange={(value) =>
                setForm((f) => ({ ...f, workflow_id: value }))
              }
            >
              <SelectTrigger id="add-video-workflow">
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
            id="add-video-visual-style"
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
