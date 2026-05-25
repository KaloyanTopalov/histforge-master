import { describe, it, expect } from "vitest";
import { splitSentences } from "@/lib/sentences";

describe("splitSentences", () => {
  it("splits plain prose into individual sentences", () => {
    const text =
      "On the morning of January twenty-second, the city awoke. " +
      "Crowds gathered in the square. A single bell rang out.";
    const result = splitSentences(text);
    expect(result).toEqual([
      "On the morning of January twenty-second, the city awoke.",
      "Crowds gathered in the square.",
      "A single bell rang out.",
    ]);
  });

  it("collapses blank lines from multi-paragraph markdown without empty entries", () => {
    const text = [
      "The first paragraph has two sentences. It ends here.",
      "",
      "",
      "The second paragraph starts after blank lines. Done.",
    ].join("\n");
    const result = splitSentences(text);
    expect(result.length).toBe(4);
    expect(result.every((s) => s.length > 0)).toBe(true);
    expect(result).not.toContain("");
  });
});
