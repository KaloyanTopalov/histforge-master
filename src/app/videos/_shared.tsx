import { Loader2, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import type { QueueState, Video, VideoStatus } from "@/types";
import * as videoPredicates from "@/lib/lifecycle/predicates/video";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

const STATUS_BADGE: Record<VideoStatus, string> = {
  new: "bg-yellow-100 text-yellow-900 dark:bg-yellow-500/25 dark:text-yellow-100",
  queued: "bg-slate-100 text-slate-900 dark:bg-slate-500/25 dark:text-slate-100",
  in_progress:
    "bg-sky-100 text-sky-900 dark:bg-sky-500/25 dark:text-sky-100",
  done: "bg-emerald-100 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-100",
  failed: "bg-red-100 text-red-900 dark:bg-red-500/25 dark:text-red-100",
};

const PAUSED_BADGE =
  "bg-amber-100 text-amber-900 dark:bg-amber-500/25 dark:text-amber-100";

export function StatusBadge({ status }: { status: VideoStatus }): JSX.Element {
  return (
    <Badge
      variant="outline"
      className={`border-transparent ${STATUS_BADGE[status]}`}
    >
      {status.replace(/_/g, " ")}
    </Badge>
  );
}

export function DeletingLabel(): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
      <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
      Deleting&hellip;
    </span>
  );
}

export function PausedLabel(): JSX.Element {
  return (
    <Badge variant="outline" className={`border-transparent ${PAUSED_BADGE}`}>
      paused
    </Badge>
  );
}

// Shown after the user clicks Pause but the running step hasn't yielded
// yet — the worker only checks the pause flag between steps, so there is
// a window where `paused = 1` but a step is still executing. Surfacing
// this distinct from `<PausedLabel />` is the whole point: the user
// otherwise sees "paused" and assumes work has stopped. Same Badge shape
// and palette as `<PausedLabel />` so the transition Pausing → Paused is
// just the spinner disappearing — no shape/color jump.
export function PausingLabel(): JSX.Element {
  return (
    <Badge
      variant="outline"
      className={`gap-1 border-transparent ${PAUSED_BADGE}`}
    >
      <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
      pausing&hellip;
    </Badge>
  );
}

// Subtle title-cell indicator for ready-script videos. Sits inline next to
// the title link so the operator can tell at a glance which rows skipped
// LLM script generation. Muted styling on purpose — this is metadata, not
// action; uses the same Badge primitive as StatusBadge / PausedLabel for
// shape consistency.
export function ReadyScriptBadge(): JSX.Element {
  return (
    <Badge variant="outline" className="ml-2 font-medium text-muted-foreground">
      Ready script
    </Badge>
  );
}

// Dashboard pause-eligibility is intentionally narrower than the API's
// `videoPredicates.isPausable`: the API accepts queued OR in_progress,
// but the dashboard surfaces the Pause button only on in_progress rows.
// Both behaviors are valid — queued videos can still be paused via the
// list-page action — so the divergence is preserved by composing the
// API predicate with the extra in_progress check.
export function canPauseVideo(v: Video): boolean {
  return videoPredicates.isPausable(v) && v.status === "in_progress";
}

// Matches `videoPredicates.isResumable` exactly; re-exported here so the
// dashboard imports stay grouped with the other UI helpers.
export const canResumeVideo = videoPredicates.isResumable;

// Matches `videoPredicates.isRetryable` exactly. The retry button is gated
// off the same predicate the lifecycle method uses, so a `failed` video
// missing its `failed_step` (corrupt state) hides the button rather than
// surfacing a 500 from the API.
export const canRetryVideo = videoPredicates.isRetryable;

// Dashboard restart-eligibility is intentionally narrower than the API's
// `videoPredicates.isRestartable`: the API accepts failed OR done, but the
// dashboard surfaces Restart only on failed rows (done rows get the Copy
// Path action instead — same trade-off as canPauseVideo's UI/API split).
export function canRestartVideo(v: Video): boolean {
  return videoPredicates.isRestartable(v) && v.status === "failed";
}

// Vanish-as-satisfied predicate builder for `useVideoAction({ waitFor })`.
// A row that disappears between the click and the next poll (deleted, moved
// off-table, etc.) must satisfy the predicate so the spinner clears — never
// hang on a row that no longer exists. `getRow` is invoked on every tick so
// callers can close over a live ref.
export function predicateForRow<T>(
  getRow: () => T | null | undefined,
  condition: (row: T) => boolean,
): () => boolean {
  return () => {
    const row = getRow();
    if (row === null || row === undefined) return true;
    return condition(row);
  };
}

export function DeleteIconButton({
  onClick,
  disabled,
  size = "iconSm",
  label = "Delete",
}: {
  onClick: () => void;
  disabled?: boolean;
  size?: "icon" | "iconSm";
  label?: string;
}): JSX.Element {
  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <Trash2 aria-hidden="true" />
    </Button>
  );
}

const ACCENT_COLORS = {
  primary: "bg-primary",
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  slate: "bg-slate-400 dark:bg-slate-500",
} as const;

export type AccentColor = keyof typeof ACCENT_COLORS;

export function SectionHeading({
  title,
  count,
  accent = "primary",
  status,
  trailing,
}: {
  title: string;
  count?: number;
  accent?: AccentColor;
  status?: ReactNode;
  trailing?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-3">
      <span
        aria-hidden="true"
        className={`inline-block h-6 w-1 rounded-full ${ACCENT_COLORS[accent]}`}
      />
      <h2 className="font-display text-xl font-semibold tracking-tight">
        {title}
      </h2>
      {typeof count === "number" && (
        <span className="rounded-full bg-muted px-2 py-0.5 font-mono text-xs font-medium tabular-nums text-muted-foreground">
          {count}
        </span>
      )}
      {status}
      {trailing}
    </div>
  );
}

export function QueueStatusPill({
  state,
}: {
  state: QueueState;
}): JSX.Element {
  if (state === "running") {
    return (
      <span
        role="status"
        className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/30"
      >
        <span className="relative inline-flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-75" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        Running
      </span>
    );
  }
  return (
    <span
      role="status"
      className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30"
    >
      <span className="inline-block h-2 w-2 rounded-full bg-amber-500" />
      Paused
    </span>
  );
}
