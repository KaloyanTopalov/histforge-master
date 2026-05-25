import { describe, it, expect } from "vitest";
import { sanitizeScript } from "@/lib/script-sanitize";

describe("sanitizeScript (shared module)", () => {
  it("replaces em-dashes with ', ' and reports the count", () => {
    const input = "lived—seventeen talents—enough.";
    const { text, emDashCount } = sanitizeScript(input);
    expect(text).toBe("lived, seventeen talents, enough.");
    expect(emDashCount).toBe(2);
  });

  it("leaves em-dash-free text untouched and reports zero", () => {
    const input = "co-author pages 1–5 only.";
    const { text, emDashCount } = sanitizeScript(input);
    expect(text).toBe(input);
    expect(emDashCount).toBe(0);
  });
});
