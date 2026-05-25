import { describe, it, expect } from "vitest";
import { getLlmProvider } from "@/lib/llm";
import { openrouterProvider } from "@/lib/llm/openrouter";

describe("getLlmProvider", () => {
  it("returns the openrouter provider by name", () => {
    expect(getLlmProvider("openrouter")).toBe(openrouterProvider);
  });

  it("throws on an unknown provider name", () => {
    expect(() => getLlmProvider("nope")).toThrow(/Unknown LLM provider/);
  });
});
