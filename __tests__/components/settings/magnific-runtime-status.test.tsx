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
} from "@testing-library/react";

interface RuntimeStatusBody {
  running: boolean;
  connected: boolean;
  session_valid: boolean;
  last_error: string | null;
}

function statusResponse(body: RuntimeStatusBody): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

async function renderPill(props: {
  enabled: boolean;
  onAction?: (a: "start" | "connect") => void;
}): Promise<void> {
  const { MagnificRuntimeStatus } = await import(
    "@/app/settings/magnific-runtime-status"
  );
  await act(async () => {
    render(
      <MagnificRuntimeStatus
        enabled={props.enabled}
        onAction={props.onAction ?? (() => {})}
      />,
    );
  });
}

function fetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

function setVisibility(value: "visible" | "hidden"): void {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => value,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      statusResponse({
        running: false,
        connected: false,
        session_valid: false,
        last_error: null,
      }),
    ) as unknown as typeof fetch,
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setVisibility("visible");
});

describe("MagnificRuntimeStatus — pill states", () => {
  it("renders Disabled and does NOT poll when enabled=false", async () => {
    vi.useFakeTimers();
    await renderPill({ enabled: false });
    expect(screen.getByText(/disabled/i)).toBeTruthy();
    // Advance well past the 5s interval; still no fetches.
    await act(async () => {
      vi.advanceTimersByTime(30_000);
    });
    expect(fetchMock()).not.toHaveBeenCalled();
  });

  it("renders Stopped + a Start button when status.running=false", async () => {
    fetchMock().mockResolvedValueOnce(
      statusResponse({
        running: false,
        connected: false,
        session_valid: false,
        last_error: null,
      }),
    );
    const onAction = vi.fn();
    await renderPill({ enabled: true, onAction });
    await waitFor(() =>
      expect(screen.getByText(/stopped/i)).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /start/i }));
    });
    expect(onAction).toHaveBeenCalledWith("start");
  });

  it("renders Session expired + a Reconnect button when running but !session_valid", async () => {
    fetchMock().mockResolvedValueOnce(
      statusResponse({
        running: true,
        connected: true,
        session_valid: false,
        last_error: null,
      }),
    );
    const onAction = vi.fn();
    await renderPill({ enabled: true, onAction });
    await waitFor(() =>
      expect(screen.getByText(/session expired/i)).toBeTruthy(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /reconnect/i }));
    });
    expect(onAction).toHaveBeenCalledWith("connect");
  });

  it("renders Connected (no contextual button) when running + session_valid + connected", async () => {
    fetchMock().mockResolvedValueOnce(
      statusResponse({
        running: true,
        connected: true,
        session_valid: true,
        last_error: null,
      }),
    );
    await renderPill({ enabled: true });
    await waitFor(() =>
      expect(screen.getByText(/connected/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /start/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
  });
});

describe("MagnificRuntimeStatus — polling", () => {
  it("fetches immediately on mount (not after 5s)", async () => {
    await renderPill({ enabled: true });
    await waitFor(() =>
      expect(fetchMock()).toHaveBeenCalledWith("/api/magnific/runtime/status"),
    );
    expect(fetchMock()).toHaveBeenCalledTimes(1);
  });

  it("fetches every 5s while the tab is visible", async () => {
    vi.useFakeTimers();
    await renderPill({ enabled: true });
    expect(fetchMock()).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock()).toHaveBeenCalledTimes(3);
  });

  it("does NOT fetch after unmount (interval cleared)", async () => {
    vi.useFakeTimers();
    const { MagnificRuntimeStatus } = await import(
      "@/app/settings/magnific-runtime-status"
    );
    const { unmount } = render(
      <MagnificRuntimeStatus enabled={true} onAction={() => {}} />,
    );
    // Initial mount fetch already in flight.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    const before = fetchMock().mock.calls.length;
    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock().mock.calls.length).toBe(before);
  });

  it("pauses polling when document.visibilityState=hidden and resumes with an immediate fetch on visible", async () => {
    vi.useFakeTimers();
    await renderPill({ enabled: true });
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    // Hidden: no new fetches past the initial mount fetch.
    expect(fetchMock()).toHaveBeenCalledTimes(1);

    await act(async () => {
      setVisibility("visible");
      // Drain the microtask the listener queued via `void tick()` — under
      // fake timers, waitFor's real-time polling can't advance, so push
      // the async fetcher forward explicitly.
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock()).toHaveBeenCalledTimes(2);
  });
});
