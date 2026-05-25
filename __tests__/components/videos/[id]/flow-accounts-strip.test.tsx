import { describe, it, expect, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FlowAccountsStrip } from "@/app/videos/[id]/flow-accounts-strip";
import type { AccountListItem } from "@/lib/flow-account-status";

const NOW = 1_700_000_000;

function acc(overrides: Partial<AccountListItem> = {}): AccountListItem {
  return {
    id: "acc_01",
    name: "Primary",
    token_display: "…abcd",
    paused_until: null,
    last_seen_at: NOW - 2,
    credits: null,
    credits_updated_at: null,
    enabled: 1,
    recovery_reason: null,
    recovery_required_at: null,
    created_at: NOW - 1000,
    ...overrides,
  };
}

afterEach(cleanup);

describe("FlowAccountsStrip — severity-ramped scheme", () => {
  it("online: green filled dot + default-colored label", () => {
    render(<FlowAccountsStrip accounts={[acc()]} nowSec={NOW} />);
    const item = screen.getByRole("listitem");
    const dot = item.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(dot.className).toMatch(/bg-green-600/);
    // No severity color class on label.
    expect(item.textContent).toContain("seen 2s ago");
    expect(item.innerHTML).not.toMatch(/text-amber-/);
    expect(item.innerHTML).not.toMatch(/text-red-/);
  });

  it("paused: amber dot + amber-colored label text", () => {
    render(
      <FlowAccountsStrip
        accounts={[acc({ paused_until: NOW + 3600 })]}
        nowSec={NOW}
      />
    );
    const item = screen.getByRole("listitem");
    const dot = item.querySelector("[aria-hidden='true']") as HTMLElement;
    expect(dot.className).toMatch(/amber/);
    // Status text wrapper is amber.
    expect(item.innerHTML).toMatch(/text-amber-/);
  });

  it("recovery_needed: red dot + AlertTriangle icon + red-colored label", () => {
    render(
      <FlowAccountsStrip
        accounts={[
          acc({
            recovery_reason: "captcha",
            recovery_required_at: NOW - 47 * 60,
          }),
        ]}
        nowSec={NOW}
      />
    );
    const item = screen.getByRole("listitem");
    expect(item.innerHTML).toMatch(/text-red-/);
    // Inline alert icon rendered alongside the dot slot (lucide-react
    // renders an <svg>; we don't care about the exact class but it must
    // be present in the recovery_needed row).
    expect(item.querySelectorAll("svg").length).toBeGreaterThan(0);
    expect(item.textContent).toContain("reCAPTCHA recovery needed (47m)");
  });

  it("stopped (disabled): muted-grey label, no severity colors", () => {
    render(
      <FlowAccountsStrip
        accounts={[acc({ enabled: 0 })]}
        nowSec={NOW}
      />
    );
    const item = screen.getByRole("listitem");
    expect(item.textContent).toContain("disabled");
    expect(item.innerHTML).not.toMatch(/text-amber-/);
    expect(item.innerHTML).not.toMatch(/text-red-/);
  });
});
