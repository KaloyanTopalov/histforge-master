"use client";

import { Terminal } from "lucide-react";
import { TextField } from "../field-primitives";
import { Section, type LlmTabProps } from "./section";

export function ClaudeCliView({ values, update }: LlmTabProps): JSX.Element {
  return (
    <Section title="Claude CLI" accent={<Terminal className="h-3.5 w-3.5" />}>
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Binary is hardcoded to{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
            claude
          </code>{" "}
          and must be on PATH.
        </p>
        <TextField
          id="claude_cli_script_model"
          label="Script Model"
          value={values.claude_cli_script_model}
          onChange={(v) => update("claude_cli_script_model", v)}
        />
        <TextField
          id="claude_cli_visual_model"
          label="Visual Model"
          value={values.claude_cli_visual_model}
          onChange={(v) => update("claude_cli_visual_model", v)}
        />
      </div>
    </Section>
  );
}
