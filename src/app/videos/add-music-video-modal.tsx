"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { VideosClientWorkflow } from "./videos-client";
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

interface AddMusicVideoModalProps {
  workflows: readonly VideosClientWorkflow[];
  onClose: () => void;
}

interface FormState {
  title: string;
  workflow_id: string;
  magnific_image_prompt: string;
  magnific_motion_prompt: string;
  suno_style_prompt: string;
  song_count: number;
  repeat_factor: number;
}

const SONG_COUNT_MIN = 1;
const SONG_COUNT_MAX = 30;
const REPEAT_FACTOR_MIN = 1;
const REPEAT_FACTOR_MAX = 10;

function initialForm(): FormState {
  return {
    title: "",
    workflow_id: "",
    magnific_image_prompt: "",
    magnific_motion_prompt: "",
    suno_style_prompt: "",
    song_count: 10,
    repeat_factor: 3,
  };
}

/**
 * Modal for creating a music-video draft. Mirrors `AddVideoModal`'s
 * Dialog → form → footer shape so operators keep a stable mental model
 * across kinds, but swaps narrative-only fields (topic_info, visual
 * style) for the music-video tuple required by the
 * `music-video-magnific-suno` workflow. No edit flow in Plan 1.
 */
export function AddMusicVideoModal({
  workflows,
  onClose,
}: AddMusicVideoModalProps): JSX.Element {
  const router = useRouter();
  const [form, setForm] = useState<FormState>(initialForm);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const musicVideoWorkflows = useMemo(
    () => workflows.filter((w) => w.kind === "music_video"),
    [workflows],
  );

  const canSubmit =
    !busy &&
    form.title.trim().length > 0 &&
    form.workflow_id.length > 0 &&
    form.magnific_image_prompt.trim().length > 0 &&
    form.magnific_motion_prompt.trim().length > 0 &&
    form.suno_style_prompt.trim().length > 0 &&
    form.song_count >= SONG_COUNT_MIN &&
    form.song_count <= SONG_COUNT_MAX &&
    form.repeat_factor >= REPEAT_FACTOR_MIN &&
    form.repeat_factor <= REPEAT_FACTOR_MAX;

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const body = {
        kind: "music_video" as const,
        title: form.title.trim(),
        workflow_id: form.workflow_id,
        magnific_image_prompt: form.magnific_image_prompt.trim(),
        magnific_motion_prompt: form.magnific_motion_prompt.trim(),
        suno_style_prompt: form.suno_style_prompt.trim(),
        song_count: form.song_count,
        repeat_factor: form.repeat_factor,
      };
      const res = await fetch("/api/videos", {
        method: "POST",
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
            <DialogTitle>Add Music Video</DialogTitle>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="add-music-video-title">Title</Label>
            <Input
              id="add-music-video-title"
              type="text"
              value={form.title}
              onChange={(e) =>
                setForm((f) => ({ ...f, title: e.target.value }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-music-video-workflow">Workflow</Label>
            <Select
              value={form.workflow_id}
              onValueChange={(value) =>
                setForm((f) => ({ ...f, workflow_id: value }))
              }
            >
              <SelectTrigger id="add-music-video-workflow">
                <SelectValue placeholder="Select a workflow…" />
              </SelectTrigger>
              <SelectContent>
                {musicVideoWorkflows.map((w, i) => (
                  <SelectItem key={w.id} value={w.id} title={w.label}>
                    {i + 1}. {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-music-video-magnific-prompt">
              Magnific image prompt
            </Label>
            <Textarea
              id="add-music-video-magnific-prompt"
              rows={4}
              value={form.magnific_image_prompt}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  magnific_image_prompt: e.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-music-video-magnific-motion-prompt">
              Magnific motion prompt
            </Label>
            <Textarea
              id="add-music-video-magnific-motion-prompt"
              rows={3}
              placeholder="slow cinematic motion, smooth loop, looping camera"
              value={form.magnific_motion_prompt}
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  magnific_motion_prompt: e.target.value,
                }))
              }
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="add-music-video-suno-style-prompt">
              Suno style prompt
            </Label>
            <Textarea
              id="add-music-video-suno-style-prompt"
              rows={3}
              value={form.suno_style_prompt}
              onChange={(e) =>
                setForm((f) => ({ ...f, suno_style_prompt: e.target.value }))
              }
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="add-music-video-song-count">Song count</Label>
              <Input
                id="add-music-video-song-count"
                type="number"
                min={SONG_COUNT_MIN}
                max={SONG_COUNT_MAX}
                value={form.song_count}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    song_count: Number(e.target.value),
                  }))
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="add-music-video-repeat-factor">
                Repeat factor
              </Label>
              <Input
                id="add-music-video-repeat-factor"
                type="number"
                min={REPEAT_FACTOR_MIN}
                max={REPEAT_FACTOR_MAX}
                value={form.repeat_factor}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    repeat_factor: Number(e.target.value),
                  }))
                }
              />
            </div>
          </div>

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
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
