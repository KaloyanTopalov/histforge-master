import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

beforeEach(() => {
  installRadixJsdomPolyfills();
});

import { ConfirmDialog } from "@/app/videos/confirm-dialog";

afterEach(cleanup);

function renderDialog(overrides: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const props = {
    title: "Restart pipeline?",
    message: "Wipes previous outputs and starts from the beginning.",
    confirmLabel: "Restart",
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
    ...overrides,
  };
  render(<ConfirmDialog {...props} />);
  return props;
}

describe("ConfirmDialog", () => {
  it("shows the title, message, and confirm label", () => {
    renderDialog();
    expect(screen.getByText(/restart pipeline\?/i)).toBeTruthy();
    expect(screen.getByText(/wipes previous outputs/i)).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /^restart$/i }),
    ).toBeTruthy();
  });

  it("calls onConfirm when the confirm button is clicked", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /^restart$/i }));
    expect(props.onConfirm).toHaveBeenCalledOnce();
  });

  it("calls onCancel when the cancel button is clicked", () => {
    const props = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(props.onCancel).toHaveBeenCalledOnce();
  });

  it("disables the confirm button when busy", () => {
    renderDialog({ busy: true });
    const confirm = screen.getByRole("button", {
      name: /^restart$/i,
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });

  it("applies the destructive Button variant when destructive=true", () => {
    renderDialog({ destructive: true, confirmLabel: "Delete" });
    const confirm = screen.getByRole("button", { name: /^delete$/i });
    expect(confirm.className).toMatch(/\bbg-destructive\b/);
  });
});
