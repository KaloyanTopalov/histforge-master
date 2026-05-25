import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";

const routerRefreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}));

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  routerRefreshMock.mockClear();
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type HarnessProps = {
  url: string;
  onSuccess: "router-refresh" | (() => void);
  errorToast: false | string | { fallback: string };
  initialBusy?: boolean;
  onBusyChange?: (b: boolean) => void;
};

async function Harness({
  url,
  onSuccess,
  errorToast,
  initialBusy,
  onBusyChange,
}: HarnessProps): Promise<JSX.Element> {
  const { useVideoAction } = await import("@/app/videos/use-video-action");
  return <HarnessInner
    useVideoAction={useVideoAction}
    url={url}
    onSuccess={onSuccess}
    errorToast={errorToast}
    initialBusy={initialBusy}
    onBusyChange={onBusyChange}
  />;
}

function HarnessInner({
  useVideoAction,
  url,
  onSuccess,
  errorToast,
  initialBusy,
  onBusyChange,
}: HarnessProps & {
  useVideoAction: typeof import("@/app/videos/use-video-action").useVideoAction;
}): JSX.Element {
  const runAction = useVideoAction();
  const [busy, setBusy] = useState(initialBusy ?? false);
  return (
    <button
      type="button"
      onClick={() => {
        void runAction({
          url,
          onSuccess,
          errorToast,
          busy: {
            isBusy: busy,
            setBusy: (b) => {
              setBusy(b);
              onBusyChange?.(b);
            },
          },
        });
      }}
    >
      go
    </button>
  );
}

async function renderHarness(props: HarnessProps): Promise<void> {
  const node = await Harness(props);
  render(node);
}

describe("useVideoAction wire shape", () => {
  it("POSTs to the configured URL with method POST", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await renderHarness({
      url: "/api/test/endpoint",
      onSuccess: "router-refresh",
      errorToast: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const call = calls.find((c) => c[0] === "/api/test/endpoint");
    expect(call).toBeDefined();
    expect(call?.[1].method).toBe("POST");
  });
});

describe("useVideoAction onSuccess", () => {
  it("calls router.refresh() on 2xx when onSuccess is 'router-refresh'", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(routerRefreshMock).toHaveBeenCalledTimes(1);
  });

  it("invokes the callback (not router.refresh) on 2xx when onSuccess is a function", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const onSuccessSpy = vi.fn();
    await renderHarness({
      url: "/api/x",
      onSuccess: onSuccessSpy,
      errorToast: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(onSuccessSpy).toHaveBeenCalledTimes(1);
    expect(routerRefreshMock).not.toHaveBeenCalled();
  });

  it("does not call router.refresh on non-OK response", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 500 })
    );

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(routerRefreshMock).not.toHaveBeenCalled();
  });
});

describe("useVideoAction errorToast", () => {
  it("stays silent on non-OK when errorToast is false", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    );

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("toasts the constant string on non-OK when errorToast is a string", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "ignored" }), { status: 500 })
    );

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: "Failed to do thing",
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith("Failed to do thing");
  });

  it("toasts body.message when present and { fallback } is provided", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "server says no" }), {
        status: 409,
      })
    );

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "fallback msg" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith("server says no");
  });

  it("toasts the fallback when body.message is missing or malformed", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response("not-json{", { status: 500 })
    );

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "fallback msg" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith("fallback msg");
  });
});

describe("useVideoAction waitFor", () => {
  type WaitForHarnessProps = HarnessProps & {
    pollNow: () => Promise<void>;
    predicate: () => boolean;
    timeoutToast?: false | string;
  };

  async function WaitForHarness({
    url,
    onSuccess,
    errorToast,
    initialBusy,
    onBusyChange,
    pollNow,
    predicate,
    timeoutToast,
  }: WaitForHarnessProps): Promise<JSX.Element> {
    const { useVideoAction } = await import("@/app/videos/use-video-action");
    function Inner(): JSX.Element {
      const runAction = useVideoAction();
      const [busy, setBusy] = useState(initialBusy ?? false);
      return (
        <button
          type="button"
          onClick={() => {
            void runAction({
              url,
              onSuccess,
              errorToast,
              timeoutToast,
              busy: {
                isBusy: busy,
                setBusy: (b) => {
                  setBusy(b);
                  onBusyChange?.(b);
                },
              },
              waitFor: { pollNow, predicate },
            });
          }}
        >
          go
        </button>
      );
    }
    return <Inner />;
  }

  async function renderWaitForHarness(
    props: WaitForHarnessProps
  ): Promise<void> {
    const node = await WaitForHarness(props);
    render(node);
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears busy immediately after pollNow when predicate is already true", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const busyChanges: boolean[] = [];

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      onBusyChange: (b) => busyChanges.push(b),
      pollNow: pollNowMock,
      predicate: () => true,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(pollNowMock).toHaveBeenCalledTimes(1);
    expect(busyChanges).toEqual([true, false]);
  });

  it("keeps busy true while predicate is false and clears when it becomes true on a later tick", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const busyChanges: boolean[] = [];
    let predicateValue = false;
    const predicate = vi.fn(() => predicateValue);

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      onBusyChange: (b) => busyChanges.push(b),
      pollNow: pollNowMock,
      predicate,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(busyChanges).toEqual([true]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(busyChanges).toEqual([true]);

    predicateValue = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(busyChanges).toEqual([true, false]);
  });

  it("clears busy at the 8s timeout and emits a generic toast for non-silent handlers", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const busyChanges: boolean[] = [];

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "non-silent" },
      onBusyChange: (b) => busyChanges.push(b),
      pollNow: pollNowMock,
      predicate: () => false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(busyChanges).toEqual([true]);
    expect(toastErrorMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(busyChanges).toEqual([true, false]);
    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith(
      expect.stringContaining("hasn't updated")
    );
  });

  it("uses the configured timeoutToast string on 8s timeout instead of the generic message", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "post-failure msg" },
      timeoutToast: "Took too long, check the queue.",
      pollNow: pollNowMock,
      predicate: () => false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("Took too long, check the queue.");
  });

  it("clears busy at the 8s timeout silently when timeoutToast is false", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const busyChanges: boolean[] = [];

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      timeoutToast: false,
      onBusyChange: (b) => busyChanges.push(b),
      pollNow: pollNowMock,
      predicate: () => false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(busyChanges).toEqual([true, false]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("on timeout when errorToast is a string, timeoutToast: false silences the timeout branch", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: "POST failed loud",
      timeoutToast: false,
      pollNow: pollNowMock,
      predicate: () => false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("on POST-failure when timeoutToast is false, the configured errorToast string still fires", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "ignored" }), { status: 500 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const predicate = vi.fn(() => false);

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: "POST failed loud",
      timeoutToast: false,
      pollNow: pollNowMock,
      predicate,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("POST failed loud");
    expect(pollNowMock).not.toHaveBeenCalled();
    expect(predicate).not.toHaveBeenCalled();
  });

  it("on POST-failure when errorToast is false, no toast fires even with a loud timeoutToast string", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const predicate = vi.fn(() => false);

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      timeoutToast: "would be loud on timeout",
      pollNow: pollNowMock,
      predicate,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
    expect(pollNowMock).not.toHaveBeenCalled();
    expect(predicate).not.toHaveBeenCalled();
  });

  it("on timeout when errorToast is false, the configured timeoutToast string still fires", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      timeoutToast: "timed out — check the queue",
      pollNow: pollNowMock,
      predicate: () => false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(toastErrorMock).toHaveBeenCalledTimes(1);
    expect(toastErrorMock).toHaveBeenCalledWith("timed out — check the queue");
  });

  it("on non-OK response, ignores waitFor: clears busy synchronously and never calls pollNow", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "boom" }), { status: 500 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const predicate = vi.fn(() => false);
    const busyChanges: boolean[] = [];

    await renderWaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "fallback msg" },
      onBusyChange: (b) => busyChanges.push(b),
      pollNow: pollNowMock,
      predicate,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(busyChanges).toEqual([true, false]);
    expect(pollNowMock).not.toHaveBeenCalled();
    expect(predicate).not.toHaveBeenCalled();
    expect(toastErrorMock).toHaveBeenCalledWith("boom");
  });

  it("clears the interval on unmount and emits no further state updates", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 200 })
    );
    const pollNowMock = vi.fn().mockResolvedValue(undefined);
    const predicate = vi.fn(() => false);
    const busyChanges: boolean[] = [];

    const node = await WaitForHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "non-silent" },
      onBusyChange: (b) => busyChanges.push(b),
      pollNow: pollNowMock,
      predicate,
    });
    const { unmount } = render(node);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(busyChanges).toEqual([true]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    const callsBeforeUnmount = predicate.mock.calls.length;

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });

    expect(predicate.mock.calls.length).toBe(callsBeforeUnmount);
    expect(busyChanges).toEqual([true]);
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});

describe("useVideoAction network failure", () => {
  // A `fetch` rejection (TypeError: Failed to fetch) used to escape the
  // hook as an unhandled promise rejection — the dev overlay caught it
  // and the busy spinner stayed accurate but no toast told the user the
  // action had failed. The catch routes network failures through the
  // same `errorToast` policy as a non-2xx, so the surface is uniform.

  it("toasts the constant string on network failure when errorToast is a string", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: "Failed to do thing",
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith("Failed to do thing");
  });

  it("toasts the fallback on network failure when errorToast is { fallback }", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "fallback msg" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith("fallback msg");
  });

  it("stays silent on network failure when errorToast is false", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("clears the busy flag on network failure and does not call router.refresh", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"));

    const busyChanges: boolean[] = [];
    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: { fallback: "fallback msg" },
      onBusyChange: (b) => busyChanges.push(b),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(busyChanges).toEqual([true, false]);
    expect(routerRefreshMock).not.toHaveBeenCalled();
  });
});

describe("useVideoAction busy guard", () => {
  it("short-circuits without fetching when isBusy is true", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;

    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      initialBusy: true,
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("toggles setBusy(true) before fetch and setBusy(false) after, including on error", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), { status: 500 })
    );

    const busyChanges: boolean[] = [];
    await renderHarness({
      url: "/api/x",
      onSuccess: "router-refresh",
      errorToast: false,
      onBusyChange: (b) => busyChanges.push(b),
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /go/i }));
    });

    expect(busyChanges).toEqual([true, false]);
  });
});
