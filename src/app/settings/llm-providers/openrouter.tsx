"use client";

import { Globe } from "lucide-react";
import { TextField } from "../field-primitives";
import { Section, type LlmTabProps } from "./section";

export function OpenRouterView({ values, update }: LlmTabProps): JSX.Element {
  return (
    <Section title="OpenRouter" accent={<Globe className="h-3.5 w-3.5" />}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          OpenRouter model IDs, e.g.{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            anthropic/claude-sonnet-4.6
          </code>
          .
        </p>
        <TextField
          id="openrouter_script_model"
          label="Script Model"
          value={values.openrouter_script_model}
          onChange={(v) => update("openrouter_script_model", v)}
        />
        <TextField
          id="openrouter_visual_model"
          label="Visual Model"
          value={values.openrouter_visual_model}
          onChange={(v) => update("openrouter_visual_model", v)}
        />
      </div>
    </Section>
  );
}
