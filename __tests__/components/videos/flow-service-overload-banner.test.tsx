import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FlowServiceOverloadBanner } from "@/app/videos/flow-service-overload-banner";

// Fixed "now" so the future / past timestamp logic is deterministic.
const FIXED_NOW_MS = Date.UTC(2026, 4, 14, 12, 0, 0); // 2026-05-14T12:00:00Z
const FIXED_NOW_SEC = Math.floor(FIXED_NOW_MS / 1000);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("FlowServiceOverloadBanner", () => {
  it("renders null when overloadUntilRaw is empty", () => {
    const { container } = render(
      <FlowServiceOverloadBanner overloadUntilRaw="" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders null when overloadUntilRaw is not a number", () => {
    const { container } = render(
      <FlowServiceOverloadBanner overloadUntilRaw="not-a-number" />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders null when overloadUntilRaw is in the past", () => {
    const past = String(FIXED_NOW_SEC - 60);
    const { container } = render(
      <FlowServiceOverloadBanner overloadUntilRaw={past} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders a role=alert banner with copy, ISO time, and remaining minutes when in the future", () => {
    // 15 minutes in the future — matches the default cooldown.
    const future = FIXED_NOW_SEC + 15 * 60;
    render(<FlowServiceOverloadBanner overloadUntilRaw={String(future)} />);

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/Veo/);
    expect(banner.textContent).toMatch(/high backend traffic/i);
    // ISO timestamp for 2026-05-14T12:15:00Z should be present.
    expect(banner.textContent).toMatch(/2026-05-14T12:15:00/);
    // Rough remaining minutes ("~15 minutes").
    expect(banner.textContent).toMatch(/15 minutes/);
  });

  it("does NOT render a Dismiss button (informational, self-clearing)", () => {
    const future = FIXED_NOW_SEC + 600;
    render(<FlowServiceOverloadBanner overloadUntilRaw={String(future)} />);
    expect(
      screen.queryByRole("button", { name: /dismiss/i })
    ).toBeNull();
  });
});
