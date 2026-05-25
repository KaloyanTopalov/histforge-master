"use client";

import { useState } from "react";
import type { ModerationEvent } from "@/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { SectionHeading } from "../_shared";

const PROMPT_PREVIEW_CHARS = 120;

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

function ModerationRow({ event }: { event: ModerationEvent }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const needsExpand =
    event.original_prompt.length > PROMPT_PREVIEW_CHARS ||
    event.rewritten_prompt.length > PROMPT_PREVIEW_CHARS;
  return (
    <li className="space-y-1 border-l-2 border-muted pl-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-xs">
          [{event.kind}] {event.chunk_id}
        </span>
        {event.reason_tag && (
          <span className="rounded bg-destructive/10 px-1.5 py-0.5 font-mono text-xs text-destructive">
            {event.reason_tag}
          </span>
        )}
        {needsExpand && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="text-xs underline"
          >
            {expanded ? "(hide)" : "(expand)"}
          </button>
        )}
      </div>
      <div className="text-xs">
        <span className="text-muted-foreground">original: </span>
        <span className="whitespace-pre-wrap">
          {expanded
            ? event.original_prompt
            : truncate(event.original_prompt, PROMPT_PREVIEW_CHARS)}
        </span>
      </div>
      <div className="text-xs">
        <span className="text-muted-foreground">rewritten: </span>
        <span className="whitespace-pre-wrap">
          {expanded
            ? event.rewritten_prompt
            : truncate(event.rewritten_prompt, PROMPT_PREVIEW_CHARS)}
        </span>
      </div>
    </li>
  );
}

interface FlowModerationPanelProps {
  events: ModerationEvent[];
}

export function FlowModerationPanel({
  events,
}: FlowModerationPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  // Group events by round, oldest-first within each group.
  const grouped = new Map<number, ModerationEvent[]>();
  for (const e of events) {
    const arr = grouped.get(e.round) ?? [];
    arr.push(e);
    grouped.set(e.round, arr);
  }
  const rounds = Array.from(grouped.keys()).sort((a, b) => a - b);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <SectionHeading title="Content moderation" accent="amber" />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs font-medium underline"
        >
          {events.length} {events.length === 1 ? "event" : "events"}
          {expanded ? " (hide)" : " (expand)"}
        </button>
      </CardHeader>
      {expanded && (
        <CardContent className="space-y-4 text-sm">
          {rounds.map((round) => (
            <div key={round} className="space-y-1">
              <div className="text-xs font-medium uppercase text-muted-foreground">
                Round {round}
              </div>
              <ul className="space-y-2">
                {(grouped.get(round) ?? []).map((e) => (
                  <ModerationRow key={e.id} event={e} />
                ))}
              </ul>
            </div>
          ))}
        </CardContent>
      )}
    </Card>
  );
}
