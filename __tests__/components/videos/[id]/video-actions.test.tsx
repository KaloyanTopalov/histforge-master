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
  within,
} from "@testing-library/react";
import type { QueueState, Video } from "@/types";

const refreshMock = vi.fn();
const pushMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock, push: pushMock }),
}));

const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: "v1",
    title: "Test video",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "new",
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
    suno_style_prompt: null,
    song_count: null,
    repeat_factor: null,
    created_at: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  refreshMock.mockClear();
  pushMock.mockClear();
  toastErrorMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderActions(
  v: Video,
  projectsDir = "/tmp/projects",
  queueState: QueueState = "running",
  refOverride?: Video,
): Promise<{ pollNow: ReturnType<typeof vi.fn>; ref: { current: Video } }> {
  const { VideoActions } = await import("@/app/videos/[id]/video-actions");
  // Default ref points at the rendered video. Tests that exercise the
  // waitFor branch can pass `refOverride` to seed a state that already
  // satisfies the predicate (so the spinner clears in the same tick as
  // the POST resolves rather than waiting on the 8s timeout).
  const ref: { current: Video } = { current: refOverride ?? v };
  const pollNow = vi.fn(async () => {
    // No-op default — tests can override to mutate `ref.current`.
  });
  render(
    <VideoActions
      video={v}
      projectsDir={projectsDir}
      queueState={queueState}
      pollNow={pollNow}
      latestVideoRef={ref}
    />
  );
  return { pollNow, ref };
}

describe("VideoActions per status", () => {
  it("new: Add to Queue + Delete", async () => {
    await renderActions(video({ status: "new" }));
    expect(
      screen.getByRole("button", { name: /add to queue/i })
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /^delete$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /restart/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /copy path/i })).toBeNull();
  });

  it("queued: Delete only", async () => {
    await renderActions(video({ status: "queued" }));
    expect(screen.getByRole("button", { name: /^delete$/i })).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: /add to queue/i })
    ).toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("in_progress: Delete only (no retry/restart)", async () => {
    await renderActions(video({ status: "in_progress" }));
    expect(screen.getByRole("button", { name: /^delete$/i })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
  });

  it("in_progress + delete_requested=1: Deleting… label with spinner, no Delete button", async () => {
    await renderActions(
      video({ status: "in_progress", delete_requested: 1 })
    );
    expect(screen.queryByRole("button", { name: /^delete$/i })).toBeNull();
    const label = screen.getByText(/deleting/i);
    // Spinner sits alongside the label inside the same flex container.
    const wrapper = label.closest("span");
    expect(wrapper?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("failed: Retry + Restart + Delete", async () => {
    await renderActions(video({ status: "failed", failed_step: "voiceover" }));
    expect(
      screen.getByRole("button", { name: /retry failed step/i })
    ).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /restart from beginning/i })
    ).not.toBeNull();
    expect(screen.getByRole("button", { name: /^delete$/i })).not.toBeNull();
  });

  it("done: Copy Path", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    await renderActions(
      video({ id: "abc123", status: "done", finished_at: 9999 }),
      "/tmp/projects"
    );
    const btn = screen.getByRole("button", { name: /copy path/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(writeText).toHaveBeenCalledWith("/tmp/projects/abc123/");
  });

  it("Add to Queue on new POSTs /api/videos/:id/start", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const v = video({ id: "v42", status: "new" });
    await renderActions(v, "/tmp/projects", "running", {
      ...v,
      status: "queued",
    });
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", { name: /add to queue/i })
      );
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v42/start");
    expect(calls[0][1].method).toBe("POST");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("Delete click opens confirm dialog", async () => {
    await renderActions(video({ status: "queued" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    // The dialog renders its own "Delete video?" heading.
    expect(screen.getByText(/delete video\?/i)).not.toBeNull();
  });

  it("redirects to /videos after a successful non-deferred delete", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await renderActions(video({ id: "v7", status: "queued" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    });
    expect(pushMock).toHaveBeenCalledWith("/videos");
  });

  it("stays on the page when the delete is deferred (202 — in_progress)", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, deferred: true }), {
        status: 202,
      })
    );
    await renderActions(video({ id: "v8", status: "in_progress" }));
    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^delete$/i }));
    });
    expect(pushMock).not.toHaveBeenCalled();
  });
});

describe("VideoActions pause/resume", () => {
  it("in_progress + paused=0: shows Pause; click POSTs /pause", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const v = video({ id: "v1", status: "in_progress" });
    await renderActions(v, "/tmp/projects", "running", { ...v, paused: 1 });
    const pause = screen.getByRole("button", { name: /^pause$/i });
    expect((pause as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(pause);
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v1/pause");
    expect(calls[0][1].method).toBe("POST");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("queued: does NOT show Pause (only the running video gets Pause)", async () => {
    await renderActions(video({ id: "v1", status: "queued" }));
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
  });

  it("paused=1: shows Resume; click POSTs /resume", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const v = video({ id: "v1", status: "in_progress", paused: 1 });
    await renderActions(v, "/tmp/projects", "running", {
      ...v,
      paused: 0,
      deferred_until: null,
    });
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
    const resume = screen.getByRole("button", { name: /^resume$/i });
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      fireEvent.click(resume);
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v1/resume");
    expect(calls[0][1].method).toBe("POST");
  });

  it("paused=1 + queueState=paused: disables Resume with tooltip", async () => {
    await renderActions(
      video({ id: "v1", status: "in_progress", paused: 1 }),
      "/tmp/projects",
      "paused"
    );
    const resume = screen.getByRole("button", { name: /^resume$/i });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(resume.getAttribute("title")).toMatch(/globally paused/i);
  });

  it("delete_requested=1 hides Pause/Resume (delete wins)", async () => {
    await renderActions(
      video({
        id: "v1",
        status: "in_progress",
        paused: 1,
        delete_requested: 1,
      })
    );
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^resume$/i })).toBeNull();
  });

  it("new: no Pause button", async () => {
    await renderActions(video({ id: "v1", status: "new" }));
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
  });
});

describe("VideoActions retry/restart routes", () => {
  it("Retry on failed POSTs /api/videos/:id/retry and refreshes", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const v = video({ id: "v9", status: "failed", failed_step: "voiceover" });
    await renderActions(v, "/tmp/projects", "running", { ...v, status: "queued" });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /retry failed step/i }));
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v9/retry");
    expect(calls[0][1].method).toBe("POST");
    expect(refreshMock).toHaveBeenCalled();
  });

  it("Restart on failed POSTs /api/videos/:id/restart after confirm", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    const v = video({ id: "v10", status: "failed", failed_step: "render" });
    await renderActions(v, "/tmp/projects", "running", { ...v, status: "queued" });
    fireEvent.click(
      screen.getByRole("button", { name: /restart from beginning/i }),
    );
    // Confirm dialog opens; click its Restart button.
    const dialog = screen.getByRole("alertdialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: /^restart$/i }));
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const restartCall = calls.find((c) => c[0] === "/api/videos/v10/restart");
    expect(restartCall).toBeDefined();
    expect(restartCall?.[1].method).toBe("POST");
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("VideoActions waitFor predicates", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function spinnerOn(button: HTMLElement): boolean {
    return button.querySelector(".animate-spin") !== null;
  }

  it("Start: spinner persists until ref.current.status flips off 'new'", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const v = video({ id: "v1", status: "new" });
    // Seed ref with the same `new` status — predicate stays false initially.
    const { ref } = await renderActions(v, "/tmp/projects", "running", v);
    const button = screen.getByRole("button", { name: /add to queue/i });

    await act(async () => {
      fireEvent.click(button);
    });
    // POST resolved, router.refresh fired, pollNow ran, predicate is still
    // false (status === "new"); spinner should persist.
    expect(spinnerOn(button)).toBe(true);

    // One predicate tick — still false.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(spinnerOn(button)).toBe(true);

    // Flip the polled status → predicate satisfies on the next tick.
    ref.current = { ...v, status: "queued" };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(spinnerOn(button)).toBe(false);
  });

  it("Pause: spinner persists until ref.current.paused === 1", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const v = video({ id: "v1", status: "in_progress", paused: 0 });
    const { ref } = await renderActions(v, "/tmp/projects", "running", v);
    const button = screen.getByRole("button", { name: /^pause$/i });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(spinnerOn(button)).toBe(true);

    ref.current = { ...v, paused: 1 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(spinnerOn(button)).toBe(false);
  });

  it("Resume: spinner persists until paused === 0 AND deferred_until is null/elapsed", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const v = video({ id: "v1", status: "in_progress", paused: 1 });
    const { ref } = await renderActions(v, "/tmp/projects", "running", v);
    const button = screen.getByRole("button", { name: /^resume$/i });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(spinnerOn(button)).toBe(true);

    // paused=0 but still deferred → predicate stays false.
    ref.current = {
      ...v,
      paused: 0,
      deferred_until: Math.floor(Date.now() / 1000) + 60,
    };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(spinnerOn(button)).toBe(true);

    // Defer cleared → predicate satisfies.
    ref.current = { ...v, paused: 0, deferred_until: null };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(spinnerOn(button)).toBe(false);
  });
});

describe("VideoActions error surfacing", () => {
  it("non-OK POST: toasts body.message and renders no inline alert", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "server says no" }), {
        status: 409,
      }),
    );
    await renderActions(video({ id: "v1", status: "new" }));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add to queue/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith("server says no");
    // The inline `<p role="alert">` was removed in the migration.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("non-OK POST without message: toasts the configured fallback", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response("not-json{", { status: 500 }),
    );
    const v = video({ id: "v1", title: "My Video", status: "in_progress" });
    await renderActions(v);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^pause$/i }));
    });

    expect(toastErrorMock).toHaveBeenCalledWith('Failed to pause "My Video"');
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("VideoActions inflight lock", () => {
  it("clicking Restart while Retry is in flight is blocked by the busy gate", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    let resolvePost: (r: Response) => void = () => undefined;
    fetchMock.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          resolvePost = resolve;
        }),
    );

    await renderActions(
      video({ id: "v1", status: "failed", failed_step: "render" }),
    );

    const retry = screen.getByRole("button", { name: /retry failed step/i });
    const restart = screen.getByRole("button", { name: /restart from beginning/i });
    const deleteBtn = screen.getByRole("button", { name: /^delete$/i });

    // Click Retry — fetch is pending; setBusy(true) has fired.
    fireEvent.click(retry);
    await act(async () => {
      await Promise.resolve();
    });

    expect((retry as HTMLButtonElement).disabled).toBe(true);
    expect((restart as HTMLButtonElement).disabled).toBe(true);
    expect((deleteBtn as HTMLButtonElement).disabled).toBe(true);

    // Resolve so cleanup is clean.
    await act(async () => {
      resolvePost(new Response(JSON.stringify({}), { status: 200 }));
    });
  });
});
