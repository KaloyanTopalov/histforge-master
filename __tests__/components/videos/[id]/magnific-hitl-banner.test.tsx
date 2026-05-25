import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { MagnificHitlBanner } from "@/app/videos/[id]/magnific-hitl-banner";

function mockFetchOnce(payload: unknown, status = 200): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("MagnificHitlBanner", () => {
  async function flushMicrotasks(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it("polls /api/magnific/queue-summary/<videoId> on mount", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({ counts: {}, hitl_pending: null });

    await act(async () => {
      render(<MagnificHitlBanner videoId="v_42" />);
    });
    await flushMicrotasks();

    expect(fetchMock).toHaveBeenCalled();
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe(
      "/api/magnific/queue-summary/v_42"
    );
  });

  it("renders nothing when hitl_pending is null", async () => {
    mockFetchOnce({ counts: {}, hitl_pending: null });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<MagnificHitlBanner videoId="v_42" />));
    });
    await flushMicrotasks();

    expect(container.firstChild).toBeNull();
  });

  it("renders a banner with the prompt preview when hitl_pending is present", async () => {
    mockFetchOnce({
      counts: {},
      hitl_pending: {
        row_id: 17,
        mode: "image-hitl",
        prompt: "a renaissance fresco of a battle in the alps",
      },
    });

    await act(async () => {
      render(<MagnificHitlBanner videoId="v_42" />);
    });
    await flushMicrotasks();

    const banner = screen.getByRole("alert");
    expect(banner.textContent).toMatch(/Operator selection needed in Magnific tab/i);
    expect(banner.textContent).toMatch(/renaissance fresco of a battle in the alps/);
  });

  it("opens the Magnific image-gen tab in a new window when the button is clicked", async () => {
    mockFetchOnce({
      counts: {},
      hitl_pending: { row_id: 1, mode: "image-hitl", prompt: "x" },
    });
    const openMock = vi.fn();
    vi.stubGlobal("open", openMock);

    await act(async () => {
      render(<MagnificHitlBanner videoId="v_42" />);
    });
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /open magnific tab/i }));
    });

    expect(openMock).toHaveBeenCalledWith(
      "https://www.magnific.com/app/ai-image-generator",
      "_blank"
    );
  });

  it("clears the banner on the next poll when hitl_pending becomes null", async () => {
    mockFetchOnce({
      counts: {},
      hitl_pending: { row_id: 1, mode: "image-hitl", prompt: "first prompt" },
    });

    let container!: HTMLElement;
    await act(async () => {
      ({ container } = render(<MagnificHitlBanner videoId="v_42" />));
    });
    await flushMicrotasks();

    // First poll shows the banner.
    expect(screen.queryByRole("alert")).not.toBeNull();

    // Operator picks a variation → next poll returns null.
    mockFetchOnce({ counts: {}, hitl_pending: null });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await flushMicrotasks();

    expect(container.firstChild).toBeNull();
  });
});
