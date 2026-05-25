"use client";

import { Layers } from "lucide-react";
import { NumberField } from "../field-primitives";
import { Section, type LlmTabProps } from "./section";

/**
 * Visual-prompt generation tuning panel (step 09). One coherent place for
 * the three throughput knobs: batch size + per-provider concurrency.
 * Operators see "visual prompts have three knobs" rather than the
 * Claude-CLI concurrency hiding behind a tab they don't open on
 * OpenRouter.
 */
export function VisualPromptsView({ values, update }: LlmTabProps): JSX.Element {
  return (
    <Section
      title="Visual Prompts — Batching & Concurrency"
      accent={<Layers className="h-3.5 w-3.5" />}
    >
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Tunes step 09 (<code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">generate_visual_prompts</code>).
          Higher batch size amortizes the static safety preamble across
          more chunks; higher concurrency runs more batches in flight.
          K=1 reverts to one chunk per call.
        </p>
        <NumberField
          id="visual_prompts_batch_size"
          label="Batch Size (K)"
          value={values.visual_prompts_batch_size}
          onChange={(v) => update("visual_prompts_batch_size", v)}
          step={1}
          min={1}
          hint="Chunks per LLM call. 1–16."
        />
        <NumberField
          id="claude_cli_visual_prompts_concurrency"
          label="Claude CLI Concurrency"
          value={values.claude_cli_visual_prompts_concurrency}
          onChange={(v) => update("claude_cli_visual_prompts_concurrency", v)}
          step={1}
          min={1}
          hint="In-flight batches when the snapshot pins Claude CLI. 1–8 (process-spawn-bound)."
        />
        <NumberField
          id="openrouter_visual_prompts_concurrency"
          label="OpenRouter Concurrency"
          value={values.openrouter_visual_prompts_concurrency}
          onChange={(v) => update("openrouter_visual_prompts_concurrency", v)}
          step={1}
          min={1}
          hint="In-flight batches when the snapshot pins OpenRouter. 1–32 (HTTP-bound)."
        />
      </div>
    </Section>
  );
}
