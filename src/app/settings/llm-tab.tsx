"use client";

import { useState } from "react";
import {
  LLM_PROVIDER_NAMES,
  LLM_PROVIDER_LABELS,
  type LlmProviderName,
} from "@/lib/llm/names";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OpenRouterView } from "./llm-providers/openrouter";
import { ClaudeCliView } from "./llm-providers/claude-cli";
import { type LlmTabProps } from "./llm-providers/section";

// View dropdown options derive from the canonical name tuple; adding a
// future provider in `lib/llm/names.ts` flows through here automatically.
const PROVIDER_VIEW_OPTIONS: ReadonlyArray<{
  value: LlmProviderName;
  label: string;
}> = LLM_PROVIDER_NAMES.map((value) => ({
  value,
  label: LLM_PROVIDER_LABELS[value],
}));

// Provider-panel dispatch. The `Record<LlmProviderName, …>` type forces
// every name in `LLM_PROVIDER_NAMES` to register a panel — adding a
// future provider without a panel is a compile error here, not a silent
// fallback at render time.
const PROVIDER_VIEWS: Record<
  LlmProviderName,
  React.ComponentType<LlmTabProps>
> = {
  openrouter: OpenRouterView,
  claude_cli: ClaudeCliView,
};

/**
 * LLM settings panel. The top-of-panel Provider dropdown is a view filter
 * (mirrors the TTS panel) — it only swaps which provider's settings are
 * shown. Defaults to the first provider in the canonical roster; the
 * actual provider used by each pipeline step now lives on the workflow
 * row's `script_llm_provider` column (snapshot-pinned per video), not in
 * global settings.
 */
export function LlmTab({ values, update }: LlmTabProps): JSX.Element {
  const [view, setView] = useState<LlmProviderName>(LLM_PROVIDER_NAMES[0]);
  const View = PROVIDER_VIEWS[view];

  return (
    <div className="space-y-8">
      <div className="flex max-w-sm items-center gap-3">
        <Label
          htmlFor="llm_provider_view"
          className="text-sm font-medium text-muted-foreground"
        >
          Provider
        </Label>
        <Select
          value={view}
          onValueChange={(v) => setView(v as LlmProviderName)}
        >
          <SelectTrigger id="llm_provider_view" className="flex-1 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROVIDER_VIEW_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <View values={values} update={update} />
    </div>
  );
}

