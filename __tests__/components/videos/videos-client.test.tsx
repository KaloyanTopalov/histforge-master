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
} from "@testing-library/react";
import type { QueueState, Video, VideoListItem } from "@/types";

const refreshMock = vi.fn();
const replaceMock = vi.fn();
let searchParamsForMock = new URLSearchParams();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, replace: replaceMock }),
  useSearchParams: () => searchParamsForMock,
  usePathname: () => "/videos",
}));

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
  refreshMock.mockClear();
  replaceMock.mockClear();
  searchParamsForMock = new URLSearchParams();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const WORKFLOWS = [
  {
    id: "comfyui",
    shortLabel: "ComfyUI",
    label: "ComfyUI full label",
    kind: "narrative" as const,
  },
  {
    id: "google-flow",
    shortLabel: "Google Flow",
    label: "Google Flow full label",
    kind: "narrative" as const,
  },
  {
    id: "music-video-magnific-suno",
    shortLabel: "Magnific × Suno",
    label: "Magnific × Suno full label",
    kind: "music_video" as const,
  },
];

const VISUAL_STYLES: { id: string; title: string; prompt: string }[] = [];

async function renderWith(opts: {
  queue?: VideoListItem[];
  finished?: VideoListItem[];
  queueState?: QueueState;
  flowCreateProjectFailed?: string;
  flowServiceOverloadUntil?: string;
  googleFlowReloginNeeded?: boolean;
  flowRecoveryAccounts?: Array<{
    id: string;
    name: string;
    required_at: number;
  }>;
}): Promise<void> {
  const { VideosClient } = await import("@/app/videos/videos-client");
  render(
    <VideosClient
      initialVideos={[...(opts.queue ?? []), ...(opts.finished ?? [])]}
      initialQueueState={opts.queueState ?? "running"}
      initialBannerFlags={{
        flowCreateProjectFailed: opts.flowCreateProjectFailed ?? "",
        flowServiceOverloadUntil: opts.flowServiceOverloadUntil ?? "",
        googleFlowReloginNeeded: opts.googleFlowReloginNeeded ?? false,
        flowRecoveryAccounts: opts.flowRecoveryAccounts ?? [],
      }}
      workflows={WORKFLOWS}
      visualStyles={VISUAL_STYLES}
      projectsDir="/tmp/projects"
      serverNow={Date.now()}
    />
  );
}

async function advancePoll(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
}

describe("VideosClient layout", () => {
  it("renders Topics, Video queue, and Finished Videos headings", async () => {
    await renderWith({ queue: [], finished: [] });
    expect(screen.getByRole("heading", { name: /topics/i })).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: /video queue/i })
    ).not.toBeNull();
    expect(
      screen.getByRole("heading", { name: /finished videos/i })
    ).not.toBeNull();
  });

  it("Add Topic button opens the add modal", async () => {
    await renderWith({ queue: [], finished: [] });
    // Before click: no dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /add topic/i }));
    // After click: modal rendered.
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBeNull();
    // And it's the *add* flow: submit says "Create" (edit mode says "Save").
    expect(
      screen.getByRole("button", { name: /create/i })
    ).not.toBeNull();
  });

  it("Add Ready Script button opens the ready-script modal", async () => {
    await renderWith({ queue: [], finished: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /add ready script/i })
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBeNull();
    // The ready-script modal is distinct from the add-topic modal — its
    // title is "Add Ready Script", and it has a Load-from-file button.
    expect(
      screen.getByRole("heading", { name: /add ready script/i })
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /load from file/i })
    ).not.toBeNull();
  });

  it("disables Add All to Queue when no new videos are present", async () => {
    await renderWith({
      queue: [video({ status: "queued" })],
      finished: [],
    });
    const btn = screen.getByRole("button", { name: /add all to queue/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Add All to Queue when at least one new video is present", async () => {
    await renderWith({
      queue: [video({ status: "new" })],
      finished: [],
    });
    const btn = screen.getByRole("button", { name: /add all to queue/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it("mounts FlowRecoveryBanner when flowRecoveryAccounts is non-empty and removes a row optimistically after Mark recovered", async () => {
    await renderWith({
      queue: [],
      finished: [],
      flowRecoveryAccounts: [
        { id: "acc_01", name: "Primary", required_at: 1_700_000_000 },
        { id: "acc_02", name: "Secondary", required_at: 1_700_001_000 },
      ],
    });

    expect(screen.getByText(/reCAPTCHA recovery required/i)).not.toBeNull();
    expect(screen.getByText("Primary")).not.toBeNull();
    expect(screen.getByText("Secondary")).not.toBeNull();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    const buttons = screen.getAllByRole("button", { name: /mark recovered/i });
    await act(async () => {
      fireEvent.click(buttons[0]);
    });

    // Optimistic removal: the first account drops out, the second remains.
    expect(screen.queryByText("Primary")).toBeNull();
    expect(screen.getByText("Secondary")).not.toBeNull();
  });

  it("does NOT render the recovery banner when flowRecoveryAccounts is empty", async () => {
    await renderWith({ queue: [], finished: [], flowRecoveryAccounts: [] });
    expect(screen.queryByText(/reCAPTCHA recovery required/i)).toBeNull();
  });

  it("POSTs to /api/videos/start-all when Add All to Queue is clicked", async () => {
    await renderWith({
      queue: [video({ status: "new" })],
      finished: [],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 1 }), { status: 200 })
    );

    const btn = screen.getByRole("button", { name: /add all to queue/i });
    await act(async () => {
      fireEvent.click(btn);
    });

    const calls = fetchMock.mock.calls as unknown[][];
    const postCall = calls.find(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).includes("/start-all")
    );
    expect(postCall).toBeDefined();
    const init = postCall?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
  });
});

describe("VideosClient global pause/resume", () => {
  it("running: header shows Pause button; no paused banner", async () => {
    await renderWith({ queue: [], finished: [], queueState: "running" });
    expect(
      screen.getByRole("button", { name: /^pause queue$/i })
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /^resume queue$/i })
    ).toBeNull();
    expect(screen.queryByText(/queue is paused/i)).toBeNull();
  });

  it("paused: header shows Start queue button and a paused banner", async () => {
    await renderWith({ queue: [], finished: [], queueState: "paused" });
    expect(
      screen.getByRole("button", { name: /^start queue$/i })
    ).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /^pause queue$/i })
    ).toBeNull();
    expect(screen.getByText(/queue is paused/i)).not.toBeNull();
  });

  it("click Pause queue POSTs /api/queue/pause", async () => {
    await renderWith({ queue: [], finished: [], queueState: "running" });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause queue$/i }));
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const call = calls.find((c) => c[0] === "/api/queue/pause");
    expect(call).toBeDefined();
    expect(call?.[1].method).toBe("POST");
  });

  it("click Start queue POSTs /api/queue/start", async () => {
    await renderWith({ queue: [], finished: [], queueState: "paused" });
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^start queue$/i }));
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const call = calls.find((c) => c[0] === "/api/queue/start");
    expect(call).toBeDefined();
    expect(call?.[1].method).toBe("POST");
  });
});

describe("VideosClient flow_create_project_failed banner", () => {
  it("hides the banner when the setting is empty", async () => {
    await renderWith({ flowCreateProjectFailed: "" });
    expect(
      screen.queryByText(/flow project creation is failing/i)
    ).toBeNull();
  });

  it("renders the banner with errorCode, timestamp, and accountId from valid JSON", async () => {
    await renderWith({
      flowCreateProjectFailed: JSON.stringify({
        errorCode: "createProject_envelope_drift",
        httpStatus: 200,
        taskId: "task_42",
        when: 1714150000,
        accountId: "acc_03",
      }),
    });

    const banner = screen.getByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/flow project creation is failing/i);
    expect(banner.textContent).toMatch(/createProject_envelope_drift/);
    expect(banner.textContent).toMatch(/acc_03/);
    // Timestamp renders in deterministic ISO-ish form (locale-independent
    // so the test passes on any runner). 1714150000s == 2024-04-26 16:46:40 UTC.
    expect(banner.textContent).toMatch(/2024-04-26 16:46:40Z/);
  });

  it("renders a defensive banner when the setting JSON is malformed", async () => {
    await renderWith({ flowCreateProjectFailed: "not-json{" });
    const banner = screen.getByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/flow project creation is failing/i);
    // Defensive parse falls back to "(unknown)" placeholders rather than
    // crashing. If a future change drops a fallback, this assertion fails.
    expect(banner.textContent).toMatch(/\(unknown\)/);
  });

  it("appears mid-session when polling surfaces a non-empty flowCreateProjectFailed", async () => {
    await renderWith({ flowCreateProjectFailed: "" });
    expect(screen.queryByRole("alert")).toBeNull();

    mockFetchOnce({
      videos: [],
      queueState: "running",
      bannerFlags: {
        flowCreateProjectFailed: JSON.stringify({
          errorCode: "createProject_envelope_drift",
          httpStatus: 200,
          taskId: "task_42",
          when: 1714150000,
          accountId: "acc_03",
        }),
        flowServiceOverloadUntil: "",
        googleFlowReloginNeeded: false,
        flowRecoveryAccounts: [],
      },
    });

    await advancePoll();

    const banner = screen.getByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/createProject_envelope_drift/);
  });

  it("Dismiss button POSTs /api/flow/clear-create-project-failed and hides the banner", async () => {
    await renderWith({
      flowCreateProjectFailed: JSON.stringify({
        errorCode: "createProject_envelope_drift",
        httpStatus: 200,
        taskId: "task_42",
        when: 1714150000,
        accountId: "acc_03",
      }),
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    expect(screen.getByRole("alert")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const call = calls.find(
      (c) => c[0] === "/api/flow/clear-create-project-failed"
    );
    expect(call).toBeDefined();
    expect(call?.[1].method).toBe("POST");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("VideosClient flow_service_overload_until banner", () => {
  it("hides the banner when overload-until is empty", async () => {
    await renderWith({ flowServiceOverloadUntil: "" });
    expect(
      screen.queryByText(/high backend traffic/i)
    ).toBeNull();
  });

  it("renders the banner when overload-until is a future timestamp", async () => {
    const future = Math.floor(Date.now() / 1000) + 15 * 60;
    await renderWith({ flowServiceOverloadUntil: String(future) });
    const banner = screen.getByText(/high backend traffic/i)
      .closest("[role='alert']") as HTMLElement;
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/Veo/);
  });
});

describe("VideosClient google_flow_relogin_needed banner", () => {
  it("hides the banner when the flag is false", async () => {
    await renderWith({ googleFlowReloginNeeded: false });
    expect(
      screen.queryByText(/youforge flow session expired/i)
    ).toBeNull();
  });

  it("renders the banner when the flag is true", async () => {
    await renderWith({ googleFlowReloginNeeded: true });
    const banner = screen.getByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/youforge flow session expired/i);
    // Operator instruction copy — the banner's reason for existing.
    expect(banner.textContent).toMatch(/re-login at/i);
  });

  it("appears mid-session when polling surfaces googleFlowReloginNeeded=true", async () => {
    await renderWith({ googleFlowReloginNeeded: false });
    expect(
      screen.queryByText(/youforge flow session expired/i)
    ).toBeNull();

    mockFetchOnce({
      videos: [],
      queueState: "running",
      bannerFlags: {
        flowCreateProjectFailed: "",
        flowServiceOverloadUntil: "",
        googleFlowReloginNeeded: true,
        flowRecoveryAccounts: [],
      },
    });

    await advancePoll();

    const banner = screen.getByRole("alert");
    expect(banner).not.toBeNull();
    expect(banner.textContent).toMatch(/youforge flow session expired/i);
  });

  it("Dismiss button POSTs /api/flow/clear-relogin-needed and hides the banner", async () => {
    await renderWith({ googleFlowReloginNeeded: true });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );

    expect(screen.getByRole("alert")).not.toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const call = calls.find(
      (c) => c[0] === "/api/flow/clear-relogin-needed"
    );
    expect(call).toBeDefined();
    expect(call?.[1].method).toBe("POST");

    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("VideosClient polling", () => {
  it("moves a done video from queue to finished section and shows toast", async () => {
    await renderWith({
      queue: [video({ id: "v1", status: "queued" })],
      finished: [],
    });

    mockFetchOnce({
      videos: [
        video({
          id: "v1",
          status: "done",
          finished_at: 9999,
        }),
      ],
      queueState: "running",
      bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
    });

    await advancePoll();

    expect(toastSuccessMock).toHaveBeenCalledWith(
      expect.stringMatching(/"Test video" finished/i)
    );
  });
});

describe("VideosClient action spinner sync", () => {
  // Helper: count rendered spinner icons by their .animate-spin marker.
  function spinnerCount(): number {
    return document.querySelectorAll(".animate-spin").length;
  }

  it("Start row: spinner persists past POST and clears once the row leaves topics", async () => {
    await renderWith({
      queue: [video({ id: "v1", status: "new" })],
      finished: [],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // 1) POST /api/videos/v1/start → 200
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    // 2) pollNow GET /api/videos → row has moved off "new"
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videos: [video({ id: "v1", status: "queued" })],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    });

    // Flush microtasks + the predicate's 250 ms interval if it kicked in.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Row left topics, landed in queue, no spinners remain.
    expect(screen.queryByTestId("topic-row-v1")).toBeNull();
    expect(screen.queryByTestId("queue-row-v1")).not.toBeNull();
    expect(spinnerCount()).toBe(0);
  });

  it("Start all: keeps the spinner spinning while an originally-listed topic is still in topics, even if a new topic appears", async () => {
    await renderWith({
      queue: [
        video({ id: "v1", status: "new", created_at: 1000 }),
        video({ id: "v2", status: "new", created_at: 2000 }),
      ],
      finished: [],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // POST /api/videos/start-all → 200
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 2 }), { status: 200 })
    );
    // pollNow: v1 moved off "new", v2 still "new", v3 freshly added in
    // status "new". Predicate captured targetIds=[v1,v2]; v2 is still in
    // topics so predicate is false; v3 is irrelevant.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videos: [
            video({ id: "v1", status: "queued", created_at: 1000 }),
            video({ id: "v2", status: "new", created_at: 2000 }),
            video({ id: "v3", status: "new", created_at: 3000 }),
          ],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );

    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add all to queue/i })
      );
    });

    // After pollNow returns, run a couple of predicate ticks.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Header button still disabled because v2 is still in topics.
    const headerBtn = screen.getByRole("button", {
      name: /add all to queue/i,
    }) as HTMLButtonElement;
    expect(headerBtn.disabled).toBe(true);
    expect(spinnerCount()).toBeGreaterThan(0);

    // Now the regular 5 s poll fires and v2 also leaves topics. v3 is
    // still "new" but it's not in targetIds, so predicate is satisfied.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videos: [
            video({ id: "v1", status: "queued", created_at: 1000 }),
            video({ id: "v2", status: "queued", created_at: 2000 }),
            video({ id: "v3", status: "new", created_at: 3000 }),
          ],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );

    // Two-stage advance: the first lets the regular poll fire and React
    // commit at the end of `act`. The second gives the predicate's 250 ms
    // interval a tick that sees the freshly-committed ref.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(
      (screen.getByRole("button", {
        name: /add all to queue/i,
      }) as HTMLButtonElement).disabled
    ).toBe(false);
    expect(spinnerCount()).toBe(0);
  });

  it("Pause row: spinner persists past POST and clears once paused becomes 1", async () => {
    await renderWith({
      queue: [video({ id: "v1", status: "in_progress", paused: 0 })],
      finished: [],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videos: [video({ id: "v1", status: "in_progress", paused: 1 })],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    expect(spinnerCount()).toBe(0);
    // The paused indicator now appears in the row.
    expect(screen.getByText(/^paused$/i)).not.toBeNull();
  });

  it("Resume row: predicate gates on deferred_until — rowInflight lock holds while paused=0 but deferred_until is still in the future", async () => {
    // `deferred_until` is unix-seconds (matches the worker SQL at
    // `repos/videos.ts:241` using `unixepoch()`). Use a value 60 s ahead
    // of now-seconds — far enough that fake-clock advances inside the
    // test (which advance Date.now() in ms) won't reach it, but small
    // enough that a unit mismatch (ms vs s) would mis-satisfy.
    const future = Math.floor(Date.now() / 1000) + 60;
    await renderWith({
      queue: [
        video({
          id: "v1",
          status: "queued",
          paused: 1,
          deferred_until: future,
        }),
        // Probe row: in_progress + paused=0 means it has a Pause button
        // we can use to verify the global rowInflight lock state.
        video({ id: "v2", status: "in_progress", paused: 0 }),
      ],
      finished: [],
    });

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // POST /api/videos/v1/resume → 200
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    // pollNow: v1 unpaused, but deferred_until still in the future →
    // predicate must NOT satisfy.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videos: [
            video({
              id: "v1",
              status: "queued",
              paused: 0,
              deferred_until: future,
            }),
            video({ id: "v2", status: "in_progress", paused: 0 }),
          ],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    // Probe: clicking Pause on v2 while the resume wait still holds must
    // be gated by the global rowInflight lock — no fetch fires.
    const callsBeforeProbe = fetchMock.mock.calls.length;
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    });
    expect(fetchMock.mock.calls.length).toBe(callsBeforeProbe);

    // Next regular 5 s poll: deferred_until cleared → predicate
    // satisfies, busy clears, rowInflight lock releases. Two-stage
    // advance so React commits the poll response before the next
    // predicate tick reads the ref.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          videos: [
            video({
              id: "v1",
              status: "queued",
              paused: 0,
              deferred_until: null,
            }),
            video({ id: "v2", status: "in_progress", paused: 0 }),
          ],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });

    // Lock released — Pause on v2 now goes through.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    // Subsequent polls return a stable shape.
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          videos: [
            video({
              id: "v1",
              status: "queued",
              paused: 0,
              deferred_until: null,
            }),
            video({ id: "v2", status: "in_progress", paused: 1 }),
          ],
          queueState: "running",
          bannerFlags: { flowCreateProjectFailed: "", flowServiceOverloadUntil: "", googleFlowReloginNeeded: false, flowRecoveryAccounts: [] },
        }),
        { status: 200 }
      )
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    });

    expect(
      fetchMock.mock.calls.some(
        (c) =>
          typeof c[0] === "string" &&
          (c[0] as string).includes("/v2/pause")
      )
    ).toBe(true);
  });
});

describe("VideosClient kind tabs", () => {
  it("renders the VideosTabs switcher with Narrative active by default", async () => {
    await renderWith({ queue: [], finished: [] });
    const narrative = screen.getByRole("tab", { name: /narrative/i });
    const music = screen.getByRole("tab", { name: /music videos/i });
    expect(narrative.getAttribute("aria-selected")).toBe("true");
    expect(music.getAttribute("aria-selected")).toBe("false");
  });

  it("renders Narrative content (Add Topic, Flow banners visible) by default", async () => {
    await renderWith({
      queue: [],
      finished: [],
      flowRecoveryAccounts: [
        { id: "acc_01", name: "Primary", required_at: 1_700_000_000 },
      ],
    });
    // Add Topic button (narrative-only) is visible.
    expect(
      screen.getByRole("button", { name: /add topic/i }),
    ).not.toBeNull();
    // Flow recovery banner (narrative-only) is visible.
    expect(screen.getByText(/recaptcha recovery required/i)).not.toBeNull();
  });

  it("?tab=music_videos marks Music videos tab active and hides narrative content", async () => {
    searchParamsForMock = new URLSearchParams("tab=music_videos");
    await renderWith({
      queue: [],
      finished: [],
      flowRecoveryAccounts: [
        { id: "acc_01", name: "Primary", required_at: 1_700_000_000 },
      ],
    });

    expect(
      screen.getByRole("tab", { name: /music videos/i }).getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.getByRole("tab", { name: /narrative/i }).getAttribute("aria-selected"),
    ).toBe("false");

    // Add Topic (narrative-only) gone.
    expect(screen.queryByRole("button", { name: /add topic/i })).toBeNull();
    // Flow recovery banner (narrative-only) gone.
    expect(screen.queryByText(/recaptcha recovery required/i)).toBeNull();
  });

  it("clicking the Music videos tab calls router.replace with ?tab=music_videos", async () => {
    await renderWith({ queue: [], finished: [] });
    fireEvent.click(screen.getByRole("tab", { name: /music videos/i }));
    expect(replaceMock).toHaveBeenCalled();
    const arg = replaceMock.mock.calls[0][0] as string;
    expect(arg).toMatch(/tab=music_videos/);
  });

  it("clicking the Narrative tab clears ?tab= from the URL", async () => {
    searchParamsForMock = new URLSearchParams("tab=music_videos");
    await renderWith({ queue: [], finished: [] });
    fireEvent.click(screen.getByRole("tab", { name: /narrative/i }));
    expect(replaceMock).toHaveBeenCalled();
    const arg = replaceMock.mock.calls[0][0] as string;
    // Narrative is the default; do not pollute URL with tab=narrative.
    expect(arg).not.toMatch(/tab=music_videos/);
  });

  it("on the music videos tab, only kind=music_video rows render", async () => {
    searchParamsForMock = new URLSearchParams("tab=music_videos");
    await renderWith({
      queue: [
        video({ id: "narr-1", title: "Narrative row", kind: "narrative" }),
        video({
          id: "mv-1",
          title: "Music video row",
          kind: "music_video",
          workflow_id: "music-video-magnific-suno",
        }),
      ],
      finished: [],
    });
    expect(screen.getByText(/Music video row/)).not.toBeNull();
    expect(screen.queryByText(/Narrative row/)).toBeNull();
  });

  it("music videos tab renders an Add Music Video button", async () => {
    searchParamsForMock = new URLSearchParams("tab=music_videos");
    await renderWith({ queue: [], finished: [] });
    expect(
      screen.getByRole("button", { name: /add music video/i }),
    ).not.toBeNull();
  });

  it("clicking Add Music Video opens the AddMusicVideoModal dialog", async () => {
    searchParamsForMock = new URLSearchParams("tab=music_videos");
    await renderWith({ queue: [], finished: [] });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: /add music video/i }),
    );
    const dialog = screen.getByRole("dialog");
    expect(dialog).not.toBeNull();
    // The Add Music Video modal heading distinguishes it from
    // narrative-only Add Topic / Add Ready Script modals.
    expect(
      screen.getByRole("heading", { name: /add music video/i }),
    ).not.toBeNull();
  });

  it("Cancel closes the AddMusicVideoModal", async () => {
    searchParamsForMock = new URLSearchParams("tab=music_videos");
    await renderWith({ queue: [], finished: [] });
    fireEvent.click(
      screen.getByRole("button", { name: /add music video/i }),
    );
    expect(screen.queryByRole("dialog")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
