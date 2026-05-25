"use client";

import { cn } from "@/lib/utils";

export type VideosTab = "narrative" | "music_videos";

export interface VideosTabsProps {
  active: VideosTab;
  onChange: (tab: VideosTab) => void;
}

const TABS: ReadonlyArray<{ value: VideosTab; label: string }> = [
  { value: "narrative", label: "Narrative" },
  { value: "music_videos", label: "Music videos" },
];

export function VideosTabs({ active, onChange }: VideosTabsProps): JSX.Element {
  return (
    <div
      role="tablist"
      aria-label="Video kind"
      className="mb-6 inline-flex items-center gap-1 rounded-full border bg-card p-1 text-sm shadow-sm"
    >
      {TABS.map((t) => {
        const isActive = t.value === active;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => {
              if (!isActive) onChange(t.value);
            }}
            className={cn(
              "rounded-full px-4 py-1.5 transition-colors",
              isActive
                ? "bg-emerald-500/15 text-emerald-900 dark:bg-emerald-500/25 dark:text-emerald-100"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
