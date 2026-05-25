import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

// next-themes has no provider in this test; useTheme() returns
// { theme: undefined } and the ThemeToggle button still renders.
vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: undefined, setTheme: vi.fn() }),
}));

import { NavBar } from "@/app/nav-bar";

afterEach(() => {
  cleanup();
  mockPathname = "/";
});

describe("NavBar", () => {
  it("renders the logo linking to /", () => {
    render(<NavBar />);
    const logo = screen.getByRole("link", { name: /histforge/i });
    expect(logo.getAttribute("href")).toBe("/");
  });

  it("renders Videos, Workflows, and Settings nav links", () => {
    render(<NavBar />);
    expect(screen.getByRole("link", { name: "Videos" })).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Workflows" })
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
  });

  it("marks Workflows link as current page when pathname starts with /workflows", () => {
    mockPathname = "/workflows";
    render(<NavBar />);
    const workflowsLink = screen.getByRole("link", { name: "Workflows" });
    const videosLink = screen.getByRole("link", { name: "Videos" });
    expect(workflowsLink.getAttribute("aria-current")).toBe("page");
    expect(videosLink.getAttribute("aria-current")).toBeNull();
  });

  it("marks Videos link as current page when pathname starts with /videos", () => {
    mockPathname = "/videos/abc";
    render(<NavBar />);
    const videosLink = screen.getByRole("link", { name: "Videos" });
    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(videosLink.getAttribute("aria-current")).toBe("page");
    expect(settingsLink.getAttribute("aria-current")).toBeNull();
  });

  it("marks Settings link as current page when pathname starts with /settings", () => {
    mockPathname = "/settings";
    render(<NavBar />);
    const videosLink = screen.getByRole("link", { name: "Videos" });
    const settingsLink = screen.getByRole("link", { name: "Settings" });
    expect(settingsLink.getAttribute("aria-current")).toBe("page");
    expect(videosLink.getAttribute("aria-current")).toBeNull();
  });

  it("mounts the theme toggle", () => {
    render(<NavBar />);
    expect(
      screen.getByRole("button", { name: /toggle theme/i }),
    ).toBeTruthy();
  });
});
