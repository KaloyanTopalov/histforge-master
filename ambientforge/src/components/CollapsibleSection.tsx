'use client';

import { type ReactNode } from 'react';

type Props = {
  title: string;
  /** Optional secondary line shown next to the title (e.g., "rap-only"). */
  hint?: string;
  /** Default-open. Required-fields sections should default open; advanced
   * sections (LLM Prompts, Cover/Thumbnail) default closed. */
  defaultOpen?: boolean;
  children: ReactNode;
};

/**
 * Lightweight collapsible section using semantic <details>/<summary>. No new
 * dependency, no animation — clicking the title toggles open/closed.
 */
export default function CollapsibleSection({
  title,
  hint,
  defaultOpen = true,
  children,
}: Props) {
  return (
    <details
      open={defaultOpen}
      className="rounded-md border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40"
    >
      <summary className="cursor-pointer select-none px-4 py-3 text-sm font-semibold uppercase tracking-wide text-zinc-700 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100">
        {title}
        {hint && (
          <span className="ml-2 text-xs font-normal normal-case text-zinc-500 dark:text-zinc-400">
            {hint}
          </span>
        )}
      </summary>
      <div className="space-y-3 border-t border-zinc-200 px-4 py-4 dark:border-zinc-800">
        {children}
      </div>
    </details>
  );
}
