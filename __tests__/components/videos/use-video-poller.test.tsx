import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { QueueState, VideoListItem } from "@/types";

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

function video(overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id: "v1",
    title: "Test video",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "queued",
    current_step: null,
    failed_step: null,
    failed_reason: null,
    started_at: null,
    finished_at: null,
    output_path: null,
    delete_requested: 0,
    paused: 0,
    deferred_until: null,
    provided_script: null,
    visual_style_id: null,
    visual_style_snapshot: null,
    kind: "narrative",
    magnific_image_prompt: null,
    magnific_motion_prompt: null,
    suno_style_prompt: null,
    song_count: null,
    repeat_factor: null,
    image_chunk_target_seconds: null,
    image_chunk_min_seconds: null,
    image_chunk_max_seconds: null,
    magnific_project_id: null,
    created_at: 1000,
    runtime_ms: 0,
    running_step_started_at: null,
    ...overrides,
  };
}

function mockFetchOnce(payload: unknown): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status: 200 })
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", vi.fn());
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type HarnessProps = {
  initialVideos: VideoListItem[];
  initialQueueState?: QueueState;
  initialFlowCreateProjectFailed?: string;
  initialGoogleFlowReloginNeeded?: boolean;
};

async function Harness(props: HarnessProps): Promise<JSX.Element> {
  const { useVideoPoller } = await import("@/app/videos/use-video-poller");
  return <HarnessInner useVideoPoller={useVideoPoller} {...props} />;
}

function HarnessInner({
  useVideoPoller,
  initialVideos,
  initialQueueState,
  initialFlowCreateProjectFailed,
  initialGoogleFlowReloginNeeded,
}: HarnessProps & {
  useVideoPoller: typeof import("@/app/videos/use-video-poller").useVideoPoller;
}): JSX.Element {
  const { topics, queue, finished, queueState, bannerFlags } = useVideoPoller({
    videos: initialVideos,
    queueState: initialQueueState ?? "running",
    bannerFlags: {
      flowCreateProjectFailed: initialFlowCreateProjectFailed ?? "",
      flowServiceOverloadUntil: "",
      googleFlowReloginNeeded: initialGoogleFlowReloginNeeded ?? false,
      flowRecoveryAccounts: [],
    },
  });
  return (
    <div>
      <ul data-testid="topics">
        {topics.map((v) => (
          <li key={v.id}>{v.id}</li>
        ))}
      </ul>
      <ul data-testid="queue">
        {queue.map((v) => (
          <li key={v.id}>{v.id}</li>
        ))}
      </ul>
      <ul data-testid="finished">
        {finished.map((v) => (
          <li key={v.id}>{v.id}</li>
        ))}
      </ul>
      <span data-testid="queueState">{queueState}</span>
      <span data-testid="flowCreateProjectFailed">
        {bannerFlags.flowCreateProjectFailed}
      </span>
      <span data-testid="googleFlowReloginNeeded">
        {String(bannerFlags.googleFlowReloginNeeded)}
      </span>
    </div>
  );
}

async function renderHarness(props: HarnessProps): Promise<void> {
  const node = await Harness(props);
  render(node);
}

async function advancePoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

function ids(testid: string): string[] {
  const list = screen.getByTestId(testid);
  return Array.from(list.querySelectorAll("li")).map((li) => li.textContent ?? "");
}

describe("useVideoPoller initial split", () => {
  it("partitions initialVideos into topics/queue/finished by status", async () => {
    await renderHarness({
      initialVideos: [
        video({ id: "n1", status: "new", created_at: 100 }),
        video({ id: "q1", status: "queued", created_at: 200 }),
        video({ id: "ip1", status: "in_progress", created_at: 300 }),
        video({ id: "f1", status: "failed", created_at: 400 }),
        video({ id: "d1", status: "done", finished_at: 500 }),
      ],
    });

    expect(ids("topics")).toEqual(["n1"]);
    expect(ids("queue")).toEqual(["q1", "ip1", "f1"]);
    expect(ids("finished")).toEqual(["d1"]);
  });
});

describe("useVideoPoller polling", () => {
  it("polls /api/videos after 5s and re-partitions on the response", async () => {
    await renderHarness({
      initialVideos: [video({ id: "v1", status: "queued" })],
    });

    expect(ids("queue")).toEqual(["v1"]);
    expect(ids("finished")).toEqual([]);

    mockFetchOnce({
      videos: [video({ id: "v1", status: "done", finished_at: 9999 })],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await advancePoll();

    expect(ids("queue")).toEqual([]);
    expect(ids("finished")).toEqual(["v1"]);
  });

  it("surfaces googleFlowReloginNeeded=true when a poll response carries the flag", async () => {
    await renderHarness({
      initialVideos: [],
      initialGoogleFlowReloginNeeded: false,
    });

    expect(screen.getByTestId("googleFlowReloginNeeded").textContent).toBe(
      "false"
    );

    mockFetchOnce({
      videos: [],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: true, flowRecoveryAccounts: [] },
    });

    await advancePoll();

    expect(screen.getByTestId("googleFlowReloginNeeded").textContent).toBe(
      "true"
    );
  });
});

describe("useVideoPoller pollNow", () => {
  async function renderPollNowHarness(
    initialVideos: VideoListItem[]
  ): Promise<void> {
    const { useVideoPoller } = await import("@/app/videos/use-video-poller");
    function PollNowHarness(): JSX.Element {
      const { topics, queue, finished, pollNow } = useVideoPoller({
        videos: initialVideos,
        queueState: "running",
        bannerFlags: {
          flowCreateProjectFailed: "",
          flowServiceOverloadUntil: "",
          googleFlowReloginNeeded: false,
          flowRecoveryAccounts: [],
        },
      });
      return (
        <div>
          <button
            type="button"
            onClick={() => {
              void pollNow();
            }}
          >
            poll
          </button>
          <ul data-testid="topics">
            {topics.map((v) => (
              <li key={v.id}>{v.id}</li>
            ))}
          </ul>
          <ul data-testid="queue">
            {queue.map((v) => (
              <li key={v.id}>{v.id}</li>
            ))}
          </ul>
          <ul data-testid="finished">
            {finished.map((v) => (
              <li key={v.id}>{v.id}</li>
            ))}
          </ul>
        </div>
      );
    }
    render(<PollNowHarness />);
  }

  async function clickPollAndFlush(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /poll/i }));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function renderCapturingPollNow(
    initialVideos: VideoListItem[]
  ): Promise<{
    getPollNow: () => () => Promise<void>;
    unmount: () => void;
  }> {
    const { useVideoPoller } = await import("@/app/videos/use-video-poller");
    let captured: (() => Promise<void>) | null = null;
    function CaptureHarness(): JSX.Element {
      const { pollNow } = useVideoPoller({
        videos: initialVideos,
        queueState: "running",
        bannerFlags: {
          flowCreateProjectFailed: "",
          flowServiceOverloadUntil: "",
          googleFlowReloginNeeded: false,
          flowRecoveryAccounts: [],
        },
      });
      captured = pollNow;
      return <div />;
    }
    const { unmount } = render(<CaptureHarness />);
    return {
      getPollNow: () => {
        if (!captured) throw new Error("pollNow not captured");
        return captured;
      },
      unmount,
    };
  }

  it("triggers a fetch when called outside the interval cadence", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({
      videos: [video({ id: "v1", status: "queued" })],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await renderPollNowHarness([video({ id: "v1", status: "new" })]);

    expect(fetchMock).not.toHaveBeenCalled();

    await clickPollAndFlush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe("/api/videos");
  });

  it("updates rendered state with the fresh payload", async () => {
    mockFetchOnce({
      videos: [video({ id: "v1", status: "queued" })],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await renderPollNowHarness([video({ id: "v1", status: "new" })]);

    expect(ids("topics")).toEqual(["v1"]);
    expect(ids("queue")).toEqual([]);

    await clickPollAndFlush();

    expect(ids("topics")).toEqual([]);
    expect(ids("queue")).toEqual(["v1"]);
  });

  it("dedupes back-to-back calls into a single in-flight fetch", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let resolveFetch!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { getPollNow } = await renderCapturingPollNow([
      video({ id: "v1", status: "new" }),
    ]);
    const pollNow = getPollNow();

    await act(async () => {
      const p1 = pollNow();
      const p2 = pollNow();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(p1).toBe(p2);
      resolveFetch(
        new Response(
          JSON.stringify({
            videos: [video({ id: "v1", status: "queued" })],
            queueState: "running",
            bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
          }),
          { status: 200 }
        )
      );
      await p1;
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("clears the interval on unmount and a late-resolving in-flight fetch does not throw or write state", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let resolveFetch!: (res: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { getPollNow, unmount } = await renderCapturingPollNow([
      video({ id: "v1", status: "queued" }),
    ]);
    const pollNow = getPollNow();

    let inFlight!: Promise<void>;
    await act(async () => {
      inFlight = pollNow();
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      resolveFetch(
        new Response(
          JSON.stringify({
            videos: [
              video({ id: "v1", title: "Alpha", status: "done" }),
            ],
            queueState: "running",
            bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
          }),
          { status: 200 }
        )
      );
      await inFlight;
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });

  it("swallows fetch rejection and the interval still ticks afterward", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    await renderPollNowHarness([video({ id: "v1", status: "new" })]);

    await clickPollAndFlush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(ids("topics")).toEqual(["v1"]);

    mockFetchOnce({
      videos: [video({ id: "v1", status: "queued" })],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ids("topics")).toEqual([]);
    expect(ids("queue")).toEqual(["v1"]);
  });
});

describe("useVideoPoller setBannerFlags partial patch", () => {
  it("merges a partial patch — clears one flag, leaves the other untouched", async () => {
    const { useVideoPoller } = await import("@/app/videos/use-video-poller");
    let captured: ReturnType<typeof useVideoPoller> | null = null;
    function CaptureHarness(): JSX.Element {
      captured = useVideoPoller({
        videos: [],
        queueState: "running",
        bannerFlags: {
          flowCreateProjectFailed: '{"err":"x"}',
          flowServiceOverloadUntil: "",
          googleFlowReloginNeeded: true,
          flowRecoveryAccounts: [],
        },
      });
      return (
        <div>
          <span data-testid="fcp">
            {captured.bannerFlags.flowCreateProjectFailed}
          </span>
          <span data-testid="gfr">
            {String(captured.bannerFlags.googleFlowReloginNeeded)}
          </span>
        </div>
      );
    }
    render(<CaptureHarness />);

    expect(screen.getByTestId("fcp").textContent).toBe('{"err":"x"}');
    expect(screen.getByTestId("gfr").textContent).toBe("true");

    await act(async () => {
      captured!.setBannerFlags({ flowCreateProjectFailed: "" });
    });

    expect(screen.getByTestId("fcp").textContent).toBe("");
    expect(screen.getByTestId("gfr").textContent).toBe("true");

    await act(async () => {
      captured!.setBannerFlags({ googleFlowReloginNeeded: false });
    });

    expect(screen.getByTestId("fcp").textContent).toBe("");
    expect(screen.getByTestId("gfr").textContent).toBe("false");
  });
});

describe("useVideoPoller status-transition toasts", () => {
  it("toasts success when a video transitions to done", async () => {
    await renderHarness({
      initialVideos: [
        video({ id: "v1", title: "Alpha", status: "queued" }),
      ],
    });

    mockFetchOnce({
      videos: [video({ id: "v1", title: "Alpha", status: "done" })],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await advancePoll();

    expect(toastSuccessMock).toHaveBeenCalledWith('"Alpha" finished');
  });

  it("toasts error with failed_step when a video transitions to failed", async () => {
    await renderHarness({
      initialVideos: [
        video({ id: "v1", title: "Beta", status: "in_progress" }),
      ],
    });

    mockFetchOnce({
      videos: [
        video({
          id: "v1",
          title: "Beta",
          status: "failed",
          failed_step: "render",
        }),
      ],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await advancePoll();

    expect(toastErrorMock).toHaveBeenCalledWith('"Beta" failed at render');
  });

  it("does not toast when a video stays at the same status", async () => {
    await renderHarness({
      initialVideos: [video({ id: "v1", status: "queued" })],
    });

    mockFetchOnce({
      videos: [video({ id: "v1", status: "queued" })],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await advancePoll();

    expect(toastSuccessMock).not.toHaveBeenCalled();
    expect(toastErrorMock).not.toHaveBeenCalled();
  });
});
