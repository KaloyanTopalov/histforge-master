import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";

afterEach(cleanup);

describe("Button success variant", () => {
  it("renders with an emerald background class in light mode", () => {
    render(<Button variant="success">Start</Button>);
    const button = screen.getByRole("button", { name: "Start" });
    expect(button.className).toMatch(/\bbg-emerald-600\b/);
    expect(button.className).toMatch(/\btext-white\b/);
  });

  it("includes a dark-mode emerald class so it stays readable when themed dark", () => {
    render(<Button variant="success">Start</Button>);
    const button = screen.getByRole("button", { name: "Start" });
    expect(button.className).toMatch(/\bdark:bg-emerald-500\b/);
  });
});
