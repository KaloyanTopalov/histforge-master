"use client";

import { useState } from "react";
import type { AllSettings } from "@/lib/settings";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { ChevronDown, Eye, EyeOff } from "lucide-react";
import {
  FieldGrid,
  FieldGroup,
  NumberField,
  Panel,
  ReadOnlyField,
  TextField,
} from "./field-primitives";

interface MagnificTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
  /**
   * Syncs the dirty-diff baseline after a non-form mutation (token
   * regenerate) so the just-rotated value doesn't show as dirty in the
   * tab indicator. Optional — when unset the form treats the token like
   * any user edit.
   */
  syncTokenBaseline?: (token: string) => void;
}

// Mirrors the four operator-facing webhook routes the magnific-ext
// extension consumes — the fifth `/artifact/[token]` is omitted because
// it's constructed per-task by the next-task response, not pasted by
// the operator.
const WEBHOOK_PATHS = [
  { id: "magnific_url_next_task", label: "Next Task URL", path: "/api/magnific/next-task" },
  { id: "magnific_url_submit_result", label: "Submit Result URL", path: "/api/magnific/submit-result" },
  { id: "magnific_url_status", label: "Status URL", path: "/api/magnific/status" },
  { id: "magnific_url_queue_summary", label: "Queue Summary URL", path: "/api/magnific/queue-summary" },
] as const;

function buildWebhookUrl(path: string, token: string): string {
  // SSR renders this component first with an empty origin (window is
  // undefined). The client hydrate fills in the real origin on first
  // render — the operator only interacts after hydration, so the brief
  // blank value is harmless.
  if (typeof window === "undefined") return token ? `…${path}/${token}` : path;
  const origin = window.location.origin;
  return token ? `${origin}${path}/${token}` : `${origin}${path}/…`;
}

export function MagnificTab({
  values,
  update,
  syncTokenBaseline,
}: MagnificTabProps): JSX.Element {
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  async function regenerate(): Promise<void> {
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/magnific/regenerate-token", {
        method: "POST",
      });
      if (!res.ok) return;
      const body = (await res.json()) as { token: string };
      update("magnific_token", body.token);
      // Server is the source of truth for this rotation — sync the
      // dirty-diff baseline so the tab indicator doesn't pop after the
      // page already saved the new value.
      syncTokenBaseline?.(body.token);
    } finally {
      setBusy(false);
    }
  }

  async function copyToken(): Promise<void> {
    if (!values.magnific_token) return;
    try {
      await navigator.clipboard.writeText(values.magnific_token);
    } catch {
      /* clipboard rejected — silent; the field is also selectable */
    }
  }

  const tokenDisplay = revealed
    ? values.magnific_token
    : values.magnific_token
      ? "•".repeat(Math.min(32, values.magnific_token.length))
      : "";

  return (
    <div className="space-y-6">
      <Panel className="space-y-4">
        <div className="space-y-1.5">
          <label
            htmlFor="magnific_token"
            className="flex flex-wrap items-baseline gap-x-2"
          >
            <span className="text-sm font-medium text-foreground/85">
              Token
            </span>
            <span className="font-mono text-[11px] font-normal text-muted-foreground/70">
              [magnific_token]
            </span>
          </label>
          <div className="flex items-center gap-2">
            <input
              id="magnific_token"
              type="text"
              readOnly
              value={tokenDisplay}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setRevealed((v) => !v)}
              aria-label={revealed ? "Hide token" : "Reveal token"}
            >
              {revealed ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!values.magnific_token}
              onClick={() => void copyToken()}
            >
              Copy
            </Button>
            <Button
              type="button"
              variant="success"
              size="sm"
              disabled={busy}
              onClick={() => void regenerate()}
            >
              {busy ? "…" : "Regenerate"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste this token into the magnific-ext popup&rsquo;s Token field.
            Regenerating rotates the credential immediately — the previous
            value stops working on the next request.
          </p>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <TextField
          id="magnific_image_model"
          label="Image Model"
          value={values.magnific_image_model}
          onChange={(v) => update("magnific_image_model", v)}
          hint="Free-text Magnific model slug for image-hitl mode (generate_loop_image). Verify the slug Magnific's UI exposes."
        />
        <TextField
          id="magnific_video_model"
          label="Video Model"
          value={values.magnific_video_model}
          onChange={(v) => update("magnific_video_model", v)}
          hint="Free-text Magnific model slug for image-to-video mode (generate_loop_clip). Verify the slug Magnific's UI exposes."
        />
      </Panel>

      <Panel className="space-y-4">
        <FieldGrid>
          {WEBHOOK_PATHS.map((w) => (
            <ReadOnlyField
              key={w.id}
              id={w.id}
              label={w.label}
              value={buildWebhookUrl(w.path, values.magnific_token)}
            />
          ))}
        </FieldGrid>
      </Panel>

      <Collapsible className="space-y-4">
        <CollapsibleTrigger className="group inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-background px-3 py-2 text-sm font-medium text-foreground shadow-sm transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 dark:border-[hsl(225_22%_24%)] dark:hover:bg-[hsl(228_22%_12%)]">
          <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-data-[state=closed]:-rotate-90 group-data-[state=open]:text-emerald-700 group-data-[state=open]:dark:text-emerald-300" />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
            Advanced
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-6">
          <FieldGroup title="Dispatch">
            <FieldGrid>
              <NumberField
                id="magnific_dispatch_timeout_minutes"
                label="Dispatch Timeout (minutes)"
                value={values.magnific_dispatch_timeout_minutes}
                onChange={(v) =>
                  update("magnific_dispatch_timeout_minutes", v)
                }
                hint="Reaper requeues image-to-video rows older than this. image-hitl rows (no_timeout=1) bypass the cap."
              />
            </FieldGrid>
          </FieldGroup>
          <FieldGroup title="Loop seam mitigation">
            <FieldGrid>
              <NumberField
                id="music_video_loop_trim_tail_seconds"
                label="Trim Tail (seconds)"
                value={values.music_video_loop_trim_tail_seconds}
                onChange={(v) =>
                  update("music_video_loop_trim_tail_seconds", v)
                }
                step={0.1}
                min={0}
                hint="Tail seconds dropped from each loop iteration to hide Seedance's end-frame drift. Larger = more aggressive trim, more motion-arc lost."
              />
              <NumberField
                id="music_video_loop_xfade_seconds"
                label="Crossfade (seconds)"
                value={values.music_video_loop_xfade_seconds}
                onChange={(v) =>
                  update("music_video_loop_xfade_seconds", v)
                }
                step={0.05}
                min={0}
                hint="Crossfade duration between consecutive loop iterations. 0 = no crossfade (plain stream-loop mux); larger = softer seam but more visible blend."
              />
            </FieldGrid>
          </FieldGroup>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
