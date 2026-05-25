import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const setThemeMock = vi.fn();
let resolvedTheme: string | undefined = "light";

vi.mock("next-themes", () => ({
  useTheme: () => ({ resolvedTheme, setTheme: setThemeMock }),
}));

import { ThemeToggle } from "@/components/theme-toggle";

afterEach(() => {
  cleanup();
  setThemeMock.mockReset();
});

beforeEach(() => {
  resolvedTheme = "light";
});

describe("ThemeToggle", () => {
  it("renders a button with an accessible 'Toggle theme' name", () => {
    render(<ThemeToggle />);
    expect(
      screen.getByRole("button", { name: /toggle theme/i }),
    ).toBeTruthy();
  });

  it("toggles between light and dark based on resolvedTheme", () => {
    resolvedTheme = "light";
    const { rerender } = render(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /toggle theme/i }));
    expect(setThemeMock).toHaveBeenLastCalledWith("dark");

    resolvedTheme = "dark";
    rerender(<ThemeToggle />);
    fireEvent.click(screen.getByRole("button", { name: /toggle theme/i }));
    expect(setThemeMock).toHaveBeenLastCalledWith("light");
  });
});
