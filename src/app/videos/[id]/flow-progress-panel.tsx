"use client";

import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  Clock,
  Film,
  ImageIcon,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type {
  FlowKindCounts,
  FlowKindModerationSummary,
  FlowReviewItem,
  FlowSummary,
} from "@/lib/flow-summary";
import type { AccountListItem } from "@/lib/flow-account-status";
import { SectionHeading } from "../_shared";
import { FlowAccountsStrip } from "./flow-accounts-strip";

function sumCounts(c: FlowKindCounts): number {
  return c.pending + c.dispatched + c.done + c.failed;
}

type KindAccent = "sky" | "violet";

const KIND_ACCENT: Record<
  KindAccent,
  { iconBg: string; bar: string }
> = {
  sky: {
    iconBg:
      "bg-sky-50 text-sky-700 ring-1 ring-inset ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-500/30",
    bar: "bg-sky-500 dark:bg-sky-400",
  },
  violet: {
    iconBg:
      "bg-violet-50 text-violet-700 ring-1 ring-inset ring-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-500/30",
    bar: "bg-violet-500 dark:bg-violet-400",
  },
};

type PillTone = "failed" | "active" | "pending" | "moderating" | "done" | "idle";

const PILL_TONE: Record<PillTone, string> = {
  failed:
    "bg-red-50 text-red-700 ring-red-200 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/30",
  active:
    "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/10 dark:text-sky-200 dark:ring-sky-500/30",
  pending:
    "bg-zinc-100 text-zinc-700 ring-zinc-200 dark:bg-zinc-500/10 dark:text-zinc-300 dark:ring-zinc-500/30",
  moderating:
    "bg-amber-50 text-amber-900 ring-amber-200 dark:bg-amber-500/10 dark:text-amber-200 dark:ring-amber-500/30",
  done:
    "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-200 dark:ring-emerald-500/30",
  idle:
    "bg-muted text-muted-foreground ring-border",
};

function StatusPill({
  tone,
  children,
}: {
  tone: PillTone;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${PILL_TONE[tone]}`}
    >
      {children}
    </span>
  );
}

function KindRow({
  label,
  icon: Icon,
  accent,
  counts,
  moderation,
  maxRounds,
}: {
  label: string;
  icon: LucideIcon;
  accent: KindAccent;
  counts: FlowKindCounts;
  moderation?: FlowKindModerationSummary;
  maxRounds?: number;
}): JSX.Element {
  const total = sumCounts(counts);
  const pct = total === 0 ? 0 : Math.round((counts.done / total) * 100);
  const styles = KIND_ACCENT[accent];
  const allDone = total > 0 && counts.done === total && counts.failed === 0;

  return (
    <div className="space-y-2.5 rounded-lg border bg-background/40 p-3">
      <div className="flex items-center gap-2.5">
        <span
          className={`flex h-7 w-7 items-center justify-center rounded-md ${styles.iconBg}`}
        >
          <Icon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        <span className="font-medium">{label}</span>
        <span className="ml-auto font-mono text-xs font-medium tabular-nums text-foreground">
          {counts.done} / {total}
        </span>
      </div>

      {total > 0 && (
        <div
          className="relative h-1.5 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} progress`}
        >
          <div
            className={`h-full ${styles.bar} transition-[width] duration-700 ease-out`}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {total === 0 && <StatusPill tone="idle">idle</StatusPill>}
        {counts.failed > 0 && (
          <StatusPill tone="failed">
            <AlertTriangle aria-hidden="true" className="h-3 w-3" />
            {counts.failed} failed
          </StatusPill>
        )}
        {counts.dispatched > 0 && (
          <StatusPill tone="active">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            {counts.dispatched} in flight
          </StatusPill>
        )}
        {counts.pending > 0 && (
          <StatusPill tone="pending">{counts.pending} pending</StatusPill>
        )}
        {moderation && moderation.pending > 0 ? (
          <StatusPill tone="moderating">
            <Loader2 aria-hidden="true" className="h-3 w-3 animate-spin" />
            moderating {moderation.pending}&hellip;
          </StatusPill>
        ) : moderation && moderation.round > 0 && maxRounds !== undefined ? (
          <StatusPill tone="moderating">
            <ShieldAlert aria-hidden="true" className="h-3 w-3" />
            moderator rewrites: {moderation.round}/{maxRounds}
            {moderation.round >= maxRounds ? " (max)" : ""}
          </StatusPill>
        ) : null}
        {allDone && <StatusPill tone="done">all done</StatusPill>}
      </div>
    </div>
  );
}

interface ReviewCardProps {
  item: FlowReviewItem;
  onEditAndRetry: (rowId: number, prompt: string) => Promise<boolean>;
  onRetry: (rowId: number) => Promise<boolean>;
}

// Status-driven visual tone for the card. Failed rows stay red (urgent —
// the step is blocked on operator action); rows currently being re-tried
// after a moderation rewrite get amber (in flight, intervention optional)
// so the visual hierarchy matches the actual urgency.
const REVIEW_TONE: Record<
  FlowReviewItem["status"],
  {
    cardBorder: string;
    headerBg: string;
    headerBorder: string;
    statusTone: PillTone;
    statusLabel: string;
    statusIcon: LucideIcon;
    spin: boolean;
  }
> = {
  failed: {
    cardBorder: "border-red-200/70 dark:border-red-500/25",
    headerBg:
      "bg-red-50/40 border-red-200/40 dark:bg-red-500/[0.04] dark:border-red-500/20",
    headerBorder: "",
    statusTone: "failed",
    statusLabel: "failed",
    statusIcon: AlertTriangle,
    spin: false,
  },
  dispatched: {
    cardBorder: "border-amber-200/70 dark:border-amber-500/25",
    headerBg:
      "bg-amber-50/40 border-amber-200/40 dark:bg-amber-500/[0.04] dark:border-amber-500/20",
    headerBorder: "",
    statusTone: "active",
    statusLabel: "retrying (in flight)",
    statusIcon: Loader2,
    spin: true,
  },
  pending: {
    cardBorder: "border-amber-200/70 dark:border-amber-500/25",
    headerBg:
      "bg-amber-50/40 border-amber-200/40 dark:bg-amber-500/[0.04] dark:border-amber-500/20",
    headerBorder: "",
    statusTone: "moderating",
    statusLabel: "waiting for extension",
    statusIcon: Clock,
    spin: false,
  },
  // 'done' never reaches the review list (filtered out by the repo
  // query), but the type system needs a complete record — fall back to
  // the failed tone if we ever surface one here by accident.
  done: {
    cardBorder: "border-emerald-200/70 dark:border-emerald-500/25",
    headerBg:
      "bg-emerald-50/40 border-emerald-200/40 dark:bg-emerald-500/[0.04] dark:border-emerald-500/20",
    headerBorder: "",
    statusTone: "done",
    statusLabel: "done",
    statusIcon: RefreshCw,
    spin: false,
  },
};

function ReviewCard({
  item,
  onEditAndRetry,
  onRetry,
}: ReviewCardProps): JSX.Element {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.prompt);
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // When the row's prompt changes from a poll (e.g. moderation rewrote it
  // since last render), reset the draft to track the source of truth —
  // unless the operator is actively editing, in which case preserving
  // their in-progress text matters more than reflecting the latest poll.
  useEffect(() => {
    if (!editing) setDraft(item.prompt);
  }, [item.prompt, editing]);

  useEffect(() => {
    if (editing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      // Cursor at end without selecting everything, so a quick edit
      // doesn't accidentally clobber the prompt on first keystroke.
      const end = ta.value.length;
      ta.setSelectionRange(end, end);
    }
  }, [editing]);

  async function save(): Promise<void> {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError("Prompt cannot be empty.");
      return;
    }
    if (trimmed === item.prompt.trim()) {
      // Nothing to save — collapse the editor without bothering the API.
      setEditing(false);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const ok = await onEditAndRetry(item.id, trimmed);
      if (ok) {
        setEditing(false);
      } else {
        setError("Save failed. Check server logs and try again.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function retry(): Promise<void> {
    setRetrying(true);
    setError(null);
    try {
      const ok = await onRetry(item.id);
      if (!ok) {
        setError("Retry failed. Check server logs and try again.");
      }
    } finally {
      setRetrying(false);
    }
  }

  const isImage = item.kind === "image";
  const KindIcon = isImage ? ImageIcon : Film;
  const kindLabel = isImage ? "Image" : "Video";
  const kindChip = isImage
    ? "bg-sky-50 text-sky-800 ring-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:ring-sky-500/30"
    : "bg-violet-50 text-violet-800 ring-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:ring-violet-500/30";

  const tone = REVIEW_TONE[item.status];
  const StatusIcon = tone.statusIcon;
  const isFailed = item.status === "failed";
  // Disable Retry on `pending` rows: a fresh requeueTask is a no-op
  // there (row is already pending). Edit is still meaningful — it
  // installs a different prompt — so we leave it enabled.
  const retryDisabled = retrying || submitting || item.status === "pending";

  return (
    <article
      className={`overflow-hidden rounded-lg border bg-background shadow-sm transition-shadow hover:shadow ${tone.cardBorder}`}
    >
      <header
        className={`flex items-center justify-between gap-3 border-b px-3 py-2 ${tone.headerBg}`}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ring-1 ring-inset ${kindChip}`}
          >
            <KindIcon aria-hidden="true" className="h-3 w-3" />
            {kindLabel}
          </span>
          <span className="truncate font-mono text-xs font-medium text-foreground">
            {item.chunk_id ?? `row ${item.id}`}
          </span>
          <StatusPill tone={tone.statusTone}>
            <StatusIcon
              aria-hidden="true"
              className={`h-3 w-3 ${tone.spin ? "animate-spin" : ""}`}
            />
            {tone.statusLabel}
          </StatusPill>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[11px] tabular-nums text-muted-foreground">
          {item.retry_count > 0 && (
            <>
              <span title="Transient retries on this row">
                attempt {item.retry_count + 1}
              </span>
              <span aria-hidden="true" className="text-muted-foreground/50">
                ·
              </span>
            </>
          )}
          <span title="Moderation rewrite round">
            round {item.moderation_round}
          </span>
        </div>
      </header>

      <div className="space-y-2.5 px-3 pb-3 pt-2.5">
        {editing ? (
          <>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={submitting}
              rows={6}
              className="w-full resize-y rounded-md border bg-background px-2.5 py-2 font-mono text-xs leading-relaxed focus:outline-none focus:ring-1 focus:ring-ring"
              aria-label={`Prompt for ${item.chunk_id ?? `row ${item.id}`}`}
            />
            {error && (
              <p className="text-xs text-red-700 dark:text-red-400">
                {error}
              </p>
            )}
          </>
        ) : (
          <>
            <p className="line-clamp-3 whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-foreground/85">
              {item.prompt}
            </p>
            {error && (
              <p className="text-xs text-red-700 dark:text-red-400">
                {error}
              </p>
            )}
          </>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
          {isFailed ? (
            <span className="inline-flex items-center gap-1.5 rounded-md bg-red-50 px-2 py-1 font-mono text-[11px] font-medium text-red-700 ring-1 ring-inset ring-red-200/70 dark:bg-red-500/10 dark:text-red-300 dark:ring-red-500/25">
              <AlertTriangle aria-hidden="true" className="h-3 w-3" />
              {item.error_reason ?? "unknown error"}
            </span>
          ) : (
            <span className="text-[11px] text-muted-foreground">
              {item.status === "dispatched"
                ? "Auto-retry in flight — intervene only if it's stuck."
                : "Queued for auto-retry."}
            </span>
          )}
          {editing ? (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={submitting}
                onClick={() => {
                  setEditing(false);
                  setDraft(item.prompt);
                  setError(null);
                }}
              >
                <X aria-hidden="true" />
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                variant="infoSoft"
                disabled={submitting}
                onClick={() => void save()}
              >
                {submitting ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                Save &amp; retry
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={retryDisabled}
                onClick={() => void retry()}
                title={
                  item.status === "pending"
                    ? "Row is already queued for a retry."
                    : "Cancel the current attempt and queue another with the same prompt."
                }
              >
                {retrying ? (
                  <Loader2 aria-hidden="true" className="animate-spin" />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                Retry
              </Button>
              <Button
                type="button"
                size="sm"
                variant="secondarySoft"
                onClick={() => {
                  setDraft(item.prompt);
                  setError(null);
                  setEditing(true);
                }}
              >
                <Pencil aria-hidden="true" />
                Edit prompt
              </Button>
            </div>
          )}
        </div>
      </div>
    </article>
  );
}

interface FlowProgressPanelProps {
  flowAccounts: AccountListItem[];
  now: number;
  flowStepStarted: boolean;
  flowSummary: FlowSummary | null;
  requeuing: boolean;
  onRequeueFailed: (force: boolean) => void;
  onEditAndRetry: (rowId: number, prompt: string) => Promise<boolean>;
  onRetry: (rowId: number) => Promise<boolean>;
}

export function FlowProgressPanel({
  flowAccounts,
  now,
  flowStepStarted,
  flowSummary,
  requeuing,
  onRequeueFailed,
  onEditAndRetry,
  onRetry,
}: FlowProgressPanelProps): JSX.Element {
  const reviewItems = flowSummary?.needs_review ?? [];
  const hasReview = reviewItems.length > 0;
  const hasFailed = reviewItems.some((r) => r.status === "failed");

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <SectionHeading title="Flow progress" accent="emerald" />
        {flowStepStarted && flowSummary && (
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              variant="infoSoft"
              disabled={requeuing}
              onClick={() => onRequeueFailed(false)}
            >
              {requeuing ? (
                <Loader2 aria-hidden="true" className="animate-spin" />
              ) : (
                <RefreshCw aria-hidden="true" />
              )}
              Requeue failed
            </Button>
            <Button
              type="button"
              size="sm"
              variant="warningSoft"
              disabled={requeuing}
              onClick={() => onRequeueFailed(true)}
            >
              <AlertTriangle aria-hidden="true" />
              Force requeue
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="rounded-lg border bg-muted/30 px-3 py-2">
          <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            Accounts
          </div>
          <FlowAccountsStrip
            accounts={flowAccounts}
            nowSec={Math.floor(now / 1000)}
          />
        </div>

        {flowStepStarted && flowSummary && (
          <>
            <KindRow
              label="Images"
              icon={ImageIcon}
              accent="sky"
              counts={flowSummary.image}
              moderation={flowSummary.moderation.image}
              maxRounds={flowSummary.moderation.max_rounds}
            />
            <KindRow
              label="Clips"
              icon={Film}
              accent="violet"
              counts={flowSummary.clip}
              moderation={flowSummary.moderation.clip}
              maxRounds={flowSummary.moderation.max_rounds}
            />

            {hasReview && (
              <section
                className={`space-y-2.5 rounded-lg border p-3 ${
                  hasFailed
                    ? "border-red-200/80 bg-red-50/40 dark:border-red-500/30 dark:bg-red-500/[0.04]"
                    : "border-amber-200/80 bg-amber-50/40 dark:border-amber-500/30 dark:bg-amber-500/[0.04]"
                }`}
              >
                <header className="flex flex-wrap items-center gap-x-2.5 gap-y-1 px-0.5">
                  <span
                    className={`flex h-7 w-7 items-center justify-center rounded-md ring-1 ring-inset ${
                      hasFailed
                        ? "bg-red-100 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30"
                        : "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30"
                    }`}
                  >
                    {hasFailed ? (
                      <AlertTriangle
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                      />
                    ) : (
                      <ShieldAlert
                        aria-hidden="true"
                        className="h-3.5 w-3.5"
                      />
                    )}
                  </span>
                  <h3
                    className={`font-display text-base font-semibold tracking-tight ${
                      hasFailed
                        ? "text-red-900 dark:text-red-200"
                        : "text-amber-900 dark:text-amber-100"
                    }`}
                  >
                    {hasFailed ? "Needs your review" : "Manual review available"}
                  </h3>
                  <span
                    className={`rounded-full px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums ring-1 ring-inset ${
                      hasFailed
                        ? "bg-red-100 text-red-700 ring-red-200 dark:bg-red-500/15 dark:text-red-300 dark:ring-red-500/30"
                        : "bg-amber-100 text-amber-800 ring-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:ring-amber-500/30"
                    }`}
                  >
                    {reviewItems.length}
                  </span>
                  <p
                    className={`ml-auto text-[11px] ${
                      hasFailed
                        ? "text-red-800/80 dark:text-red-300/70"
                        : "text-amber-900/80 dark:text-amber-200/70"
                    }`}
                  >
                    {hasFailed
                      ? "Edit the prompt to remove flagged content, then save to retry."
                      : "Auto-retry in progress. Edit or retry to take over."}
                  </p>
                </header>
                <div className="space-y-2">
                  {reviewItems.map((f) => (
                    <ReviewCard
                      key={f.id}
                      item={f}
                      onEditAndRetry={onEditAndRetry}
                      onRetry={onRetry}
                    />
                  ))}
                </div>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
