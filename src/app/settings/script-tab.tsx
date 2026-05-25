"use client";

import { useState } from "react";
import type { AllSettings } from "@/lib/settings";
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
import { NumberField, Panel } from "./field-primitives";
import { OpenRouterView } from "./llm-providers/openrouter";
import { ClaudeCliView } from "./llm-providers/claude-cli";
import { VisualPromptsView } from "./llm-providers/visual-prompts";
import type { LlmTabProps } from "./llm-providers/section";

interface ScriptTabProps {
  values: AllSettings;
  update: <K extends keyof AllSettings>(key: K, value: AllSettings[K]) => void;
}

const PROVIDER_VIEW_OPTIONS: ReadonlyArray<{
  value: LlmProviderName;
  label: string;
}> = LLM_PROVIDER_NAMES.map((value) => ({
  value,
  label: LLM_PROVIDER_LABELS[value],
}));

const PROVIDER_VIEWS: Record<
  LlmProviderName,
  React.ComponentType<LlmTabProps>
> = {
  openrouter: OpenRouterView,
  claude_cli: ClaudeCliView,
};

export function ScriptTab({ values, update }: ScriptTabProps): JSX.Element {
  const [view, setView] = useState<LlmProviderName>(LLM_PROVIDER_NAMES[0]);
  const View = PROVIDER_VIEWS[view];

  return (
    <div className="space-y-8">
      <Panel className="space-y-4">
        <NumberField
          id="script_length_minutes"
          label="Script Length (minutes)"
          value={values.script_length_minutes}
          onChange={(v) => update("script_length_minutes", v)}
          step={6}
          min={6}
          hint="Total chapter narration length in minutes. Chapters of ~6 min each are produced internally."
        />
        <NumberField
          id="hook_length_seconds"
          label="Hook Length (seconds)"
          value={values.hook_length_seconds}
          onChange={(v) => update("hook_length_seconds", v)}
          step={4}
          min={4}
          hint="Total hook section length in seconds. The chunker derives the clip count from this and the provider's clip-seconds."
        />
        <NumberField
          id="hook_video_clip_seconds"
          label="Hook Clip Seconds"
          value={values.hook_video_clip_seconds}
          onChange={(v) => update("hook_video_clip_seconds", v)}
          step={0.5}
          hint="ComfyUI hook clip length. Set to match your ComfyUI workflow's output. For Google Flow, use the Google Flow tab's Hook Clip Seconds setting."
        />
      </Panel>

      <div className="space-y-4">
        <div className="flex max-w-sm items-center gap-3">
          <Label
            htmlFor="llm_provider_view"
            className="text-[11px] font-semibold uppercase tracking-[0.18em] text-foreground/85 dark:text-[hsl(220_8%_80%)]"
          >
            Provider
          </Label>
          <Select
            value={view}
            onValueChange={(v) => setView(v as LlmProviderName)}
          >
            <SelectTrigger
              id="llm_provider_view"
              className="flex-1 border-slate-300 bg-background text-sm font-medium shadow-sm dark:border-[hsl(225_22%_24%)]"
            >
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

        <p className="text-xs text-muted-foreground">
          Provider per video is chosen by its workflow — these are the model
          fields the chosen provider will use.
        </p>

        <View values={values} update={update} />

        <VisualPromptsView values={values} update={update} />
      </div>
    </div>
  );
}
