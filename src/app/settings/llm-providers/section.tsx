"use client";

import type { AllSettings } from "@/lib/settings";
import { Panel } from "../field-primitives";

// Shared types + chrome for the per-provider LLM panels. Lives here
// (rather than in their parent `script-tab.tsx`) so the per-provider files
// do not import their parent — keeping the dependency graph one-directional.

export interface LlmTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
}

// Visual twin of the section header used in tts-settings.tsx so the LLM
// and TTS panels share an editorial rhythm. Emerald accent bar, emerald
// title, emerald icon — the whole settings form converges on a single
// accent voice. The header sits on the outer card; children render inside
// a Panel so each section reads as its own grouped "well".
export function Section({
  title,
  accent,
  children,
}: {
  title: string;
  accent: React.ReactNode;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-3">
        <span
          aria-hidden="true"
          className="inline-block h-5 w-1 rounded-full bg-gradient-to-b from-emerald-300 to-emerald-600 shadow-[0_0_8px_-1px_rgba(16,185,129,0.45)] dark:from-emerald-300 dark:to-emerald-500 dark:shadow-[0_0_12px_-1px_hsl(160_70%_45%/0.6)]"
        />
        <h3 className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-900/85 dark:text-emerald-100/90">
          {title}
        </h3>
        <span className="text-emerald-700/70 dark:text-emerald-300/80">
          {accent}
        </span>
        <span
          aria-hidden="true"
          className="h-px flex-1 bg-gradient-to-r from-border to-transparent dark:from-[hsl(222_20%_22%)]"
        />
      </div>
      <Panel>{children}</Panel>
    </section>
  );
}
