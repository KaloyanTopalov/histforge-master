import { describe, it, expect } from "vitest";
import {
  LLM_PROVIDER_NAMES,
  LLM_PROVIDER_LABELS,
  type LlmProviderName,
} from "@/lib/llm/names";

describe("LLM_PROVIDER_NAMES", () => {
  it("lists the two real provider IDs", () => {
    expect([...LLM_PROVIDER_NAMES]).toEqual(["openrouter", "claude_cli"]);
  });

  it("has a label for every provider name", () => {
    for (const name of LLM_PROVIDER_NAMES) {
      const label: string = LLM_PROVIDER_LABELS[name];
      expect(label).toBeTruthy();
    }
  });

  it("uses operator-facing labels", () => {
    expect(LLM_PROVIDER_LABELS.openrouter).toBe("OpenRouter");
    expect(LLM_PROVIDER_LABELS.claude_cli).toBe("Claude CLI");
  });
});

// Compile-time smoke test: a value typed as LlmProviderName must be one of
// the tuple entries. Regression: if the union is detached from the tuple,
// this assignment errors.
const _smoke: LlmProviderName = "openrouter";
void _smoke;
