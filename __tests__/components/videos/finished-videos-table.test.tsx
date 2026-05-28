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
import type { Video, VideoListItem } from "@/types";

function video(overrides: Partial<VideoListItem> = {}): VideoListItem {
  return {
    id: "v1",
    title: "Test video",
    topic_info: "info",
    workflow_id: "comfyui",
    status: "done",
    current_step: null,
    failed_step: null,
    failed_reason: null,
    started_at: 1,
    finished_at: 2,
    output_path: "projects/v1/final.mp4",
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

let writeTextMock: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  writeTextMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: writeTextMock },
    configurable: true,
  });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function renderRows(
  videos: VideoListItem[],
  onDelete: (v: Video) => void = () => {},
): Promise<void> {
  const { FinishedVideosTable } = await import(
    "@/app/videos/finished-videos-table"
  );
  render(
    <FinishedVideosTable
      rows={videos}
      projectsDir="/tmp/projects"
      onDelete={onDelete}
    />,
  );
}

describe("FinishedVideosTable", () => {
  it("writes <projectsDir>/<videoId>/ to clipboard on Copy path click", async () => {
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    const btn = within(row).getByRole("button", { name: /copy path/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(writeTextMock).toHaveBeenCalledWith("/tmp/projects/abc123/");
  });

  it("shows copied feedback for 2 seconds after click", async () => {
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    let btn = within(row).getByRole("button", { name: /copy path/i });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    btn = within(row).getByRole("button", { name: /copied/i });
    expect(btn).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2001);
    });
    btn = within(row).getByRole("button", { name: /copy path/i });
    expect(btn).toBeTruthy();
  });

  it("title links to /videos/:id", async () => {
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    const link = within(row).getByRole("link", { name: /test video/i });
    expect(link.getAttribute("href")).toBe("/videos/abc123");
  });

  it("renders empty state when no rows", async () => {
    await renderRows([]);
    expect(screen.getByText(/no finished videos/i)).not.toBeNull();
  });

  it("renders a Time column rounded down to whole minutes (no seconds)", async () => {
    await renderRows([
      video({ id: "abc123", runtime_ms: 3_725_000 }),
    ]);
    expect(
      screen.getByRole("columnheader", { name: /^time$/i }),
    ).toBeTruthy();
    const row = screen.getByTestId("finished-row-abc123");
    const cells = within(row).getAllByRole("cell");
    // Title | Finished | Time | Actions
    expect(cells[2].textContent).toBe("1h 2m");
  });

  it("shows '—' in the Time column when runtime_ms is 0 (defensive)", async () => {
    await renderRows([video({ id: "abc123", runtime_ms: 0 })]);
    const row = screen.getByTestId("finished-row-abc123");
    const cells = within(row).getAllByRole("cell");
    expect(cells[2].textContent).toBe("—");
  });

  it("formats Finished column as '<d> <Mon> <yyyy>, <HH>:<MM>'", async () => {
    // 2026-05-15T21:23:45 local time → "15 May 2026, 21:23"
    const ts = new Date(2026, 4, 15, 21, 23, 45).getTime();
    await renderRows([video({ id: "abc123", finished_at: ts })]);
    const row = screen.getByTestId("finished-row-abc123");
    const cells = within(row).getAllByRole("cell");
    expect(cells[1].textContent).toBe("15 May 2026, 21:23");
  });

  it("calls onDelete with the row when the trash button is clicked", async () => {
    const onDelete = vi.fn();
    await renderRows([video({ id: "abc123" })], onDelete);
    const row = screen.getByTestId("finished-row-abc123");
    const btn = within(row).getByRole("button", { name: /delete/i });
    fireEvent.click(btn);
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onDelete.mock.calls[0][0].id).toBe("abc123");
  });

  it("renders a 'Ready script' badge when provided_script is set", async () => {
    await renderRows([video({ id: "abc123", provided_script: "Hello." })]);
    const row = screen.getByTestId("finished-row-abc123");
    expect(within(row).getByText(/ready script/i)).not.toBeNull();
  });

  it("does NOT render the 'Ready script' badge when provided_script is null", async () => {
    await renderRows([video({ id: "abc123", provided_script: null })]);
    const row = screen.getByTestId("finished-row-abc123");
    expect(within(row).queryByText(/ready script/i)).toBeNull();
  });

  it("POSTs /api/videos/:id/open-folder when Open folder is clicked", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    const btn = within(row).getByRole("button", { name: /open folder/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/videos/abc123/open-folder");
    expect(init.method).toBe("POST");
  });

  it("leaves the Open folder label unchanged on a 200 response", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    const btn = within(row).getByRole("button", { name: /open folder/i });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(
      within(row).getByRole("button", { name: /open folder/i }),
    ).toBeTruthy();
    expect(
      within(row).queryByRole("button", { name: /folder missing/i }),
    ).toBeNull();
  });

  it("swaps to 'Folder missing' for 2s on 410, then reverts", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "folder_missing", message: "gone" }),
        { status: 410 },
      ),
    );
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    let btn = within(row).getByRole("button", { name: /open folder/i });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    btn = within(row).getByRole("button", { name: /folder missing/i });
    expect(btn).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2001);
    });
    btn = within(row).getByRole("button", { name: /open folder/i });
    expect(btn).toBeTruthy();
  });

  it("swaps to 'Folder missing' when fetch rejects (network error)", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    const btn = within(row).getByRole("button", { name: /open folder/i });
    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
    });
    expect(
      within(row).getByRole("button", { name: /folder missing/i }),
    ).toBeTruthy();
  });

  it("orders Actions buttons as [Open folder, Copy path, Delete]", async () => {
    await renderRows([video({ id: "abc123" })]);
    const row = screen.getByTestId("finished-row-abc123");
    const buttons = within(row).getAllByRole("button");
    expect(buttons[0].getAttribute("aria-label")).toBe("Open folder");
    expect(buttons[1].getAttribute("aria-label")).toBe("Copy path");
    expect(buttons[2].getAttribute("aria-label")).toBe("Delete");
  });
});
