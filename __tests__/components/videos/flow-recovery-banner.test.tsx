import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { FlowRecoveryBanner } from "@/app/videos/flow-recovery-banner";

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  toastErrorMock.mockReset();
});

describe("FlowRecoveryBanner", () => {
  it("renders null when the accounts list is empty", () => {
    const { container } = render(
      <FlowRecoveryBanner accounts={[]} onCleared={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per account with name, link, and Mark recovered button", () => {
    render(
      <FlowRecoveryBanner
        accounts={[
          { id: "acc_01", name: "Primary", required_at: 1_700_000_000 },
          { id: "acc_02", name: "Secondary", required_at: 1_700_001_000 },
        ]}
        onCleared={() => {}}
      />
    );

    expect(screen.getByText(/reCAPTCHA recovery required/i)).toBeTruthy();
    expect(screen.getByText(/Primary/)).toBeTruthy();
    expect(screen.getByText(/Secondary/)).toBeTruthy();

    const links = screen.getAllByRole("link", { name: /open labs\.google/i });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("href")).toBe(
      "https://labs.google/fx/tools/flow"
    );
    expect(links[0].getAttribute("target")).toBe("_blank");
    expect(links[0].getAttribute("rel")).toMatch(/noopener/);

    const buttons = screen.getAllByRole("button", { name: /mark recovered/i });
    expect(buttons).toHaveLength(2);
  });

  it("POSTs to /api/flow/accounts/{id}/clear-captcha-recovery and calls onCleared(id) on success", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onCleared = vi.fn();

    render(
      <FlowRecoveryBanner
        accounts={[
          { id: "acc_42", name: "Stuck", required_at: 1_700_000_000 },
        ]}
        onCleared={onCleared}
      />
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /mark recovered/i })
      );
    });

    await waitFor(() => expect(onCleared).toHaveBeenCalledWith("acc_42"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/flow/accounts/acc_42/clear-captcha-recovery",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows a toast and does NOT call onCleared when the POST fails", async () => {
    const fetchMock = vi.fn(
      async () => new Response("nope", { status: 500 })
    );
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);
    const onCleared = vi.fn();

    render(
      <FlowRecoveryBanner
        accounts={[
          { id: "acc_01", name: "Stuck", required_at: 1_700_000_000 },
        ]}
        onCleared={onCleared}
      />
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /mark recovered/i })
      );
    });

    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(onCleared).not.toHaveBeenCalled();
  });

  it("names labs.google/fx/tools/flow, the ~30 second engagement guidance, and the right-Chrome-profile requirement in the body", () => {
    render(
      <FlowRecoveryBanner
        accounts={[{ id: "acc_01", name: "X", required_at: 1_700_000_000 }]}
        onCleared={() => {}}
      />
    );
    const banner = screen.getByRole("alert");
    // Recovery instructions must be precise per ADR §6.
    expect(banner.textContent).toMatch(/labs\.google\/fx\/tools\/flow/);
    expect(banner.textContent).toMatch(/30 second/i);
    expect(banner.textContent).toMatch(/Chrome profile/i);
  });
});
