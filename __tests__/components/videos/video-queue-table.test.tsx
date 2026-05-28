import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { QueueState, Video, VideoListItem } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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

const WORKFLOWS = [
  {
    id: "comfyui",
    shortLabel: "ComfyUI",
    label: "ComfyUI full label",
    kind: "narrative" as const,
  },
];

afterEach(cleanup);

async function renderRow(
  v: VideoListItem,
  opts: {
    queueState?: QueueState;
    rowInflight?: {
      id: string;
      action: "start" | "pause" | "resume";
    } | null;
    now?: number;
    onPause?: (v: Video) => void;
    onResume?: (v: Video) => void;
  } = {}
): Promise<void> {
  const { VideoQueueTable } = await import(
    "@/app/videos/video-queue-table"
  );
  render(
    <VideoQueueTable
      rows={[v]}
      workflows={WORKFLOWS}
      queueState={opts.queueState ?? "running"}
      rowInflight={opts.rowInflight ?? null}
      now={opts.now ?? 0}
      onEdit={() => {}}
      onDelete={() => {}}
      onPause={opts.onPause ?? (() => {})}
      onResume={opts.onResume ?? (() => {})}
    />
  );
}

function rowFor(id: string): HTMLElement {
  const row = screen.getByTestId(`queue-row-${id}`);
  return row as HTMLElement;
}

describe("VideoQueueTable actions per status", () => {
  it("queued: Edit enabled (not yet started), Delete enabled", async () => {
    await renderRow(video({ id: "v1", status: "queued" }));
    const row = rowFor("v1");
    const edit = within(row).getByRole("button", { name: /edit/i });
    const del = within(row).getByRole("button", { name: /delete/i });
    expect((edit as HTMLButtonElement).disabled).toBe(false);
    expect((del as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders a 'Ready script' badge when provided_script is set", async () => {
    await renderRow(video({ id: "v1", provided_script: "Hello." }));
    const row = rowFor("v1");
    expect(within(row).getByText(/ready script/i)).not.toBeNull();
  });

  it("does NOT render the 'Ready script' badge when provided_script is null", async () => {
    await renderRow(video({ id: "v1", provided_script: null }));
    const row = rowFor("v1");
    expect(within(row).queryByText(/ready script/i)).toBeNull();
  });

  it("in_progress: Edit hidden, Delete enabled", async () => {
    await renderRow(video({ id: "v1", status: "in_progress" }));
    const row = rowFor("v1");
    expect(within(row).queryByRole("button", { name: /edit/i })).toBeNull();
    const del = within(row).getByRole("button", { name: /delete/i });
    expect((del as HTMLButtonElement).disabled).toBe(false);
  });

  it("in_progress + delete_requested=1: replaces Delete with a Deleting… indicator + spinner", async () => {
    await renderRow(
      video({ id: "v1", status: "in_progress", delete_requested: 1 })
    );
    const row = rowFor("v1");
    expect(within(row).queryByRole("button", { name: /delete/i })).toBeNull();
    const label = within(row).getByText(/deleting/i);
    const wrapper = label.closest("span");
    expect(wrapper?.querySelector(".animate-spin")).not.toBeNull();
  });

  it("failed: Edit hidden, Delete enabled", async () => {
    await renderRow(
      video({ id: "v1", status: "failed", failed_step: "voiceover" })
    );
    const row = rowFor("v1");
    expect(within(row).queryByRole("button", { name: /edit/i })).toBeNull();
    const del = within(row).getByRole("button", { name: /delete/i });
    expect((del as HTMLButtonElement).disabled).toBe(false);
  });

  it("renders workflow shortLabel in the cell with full label in tooltip", async () => {
    await renderRow(video({ id: "v1", status: "queued" }));
    const row = rowFor("v1");
    const cell = within(row).getByText("ComfyUI");
    expect(cell.getAttribute("title")).toBe("ComfyUI full label");
  });

  it("title links to /videos/:id", async () => {
    await renderRow(video({ id: "abc123", status: "queued" }));
    const row = rowFor("abc123");
    const link = within(row).getByRole("link", { name: /test video/i });
    expect(link.getAttribute("href")).toBe("/videos/abc123");
  });
});

describe("VideoQueueTable pause/resume", () => {
  it("in_progress + paused=0 + delete_requested=0: shows Pause button, invokes onPause", async () => {
    const onPause = vi.fn();
    await renderRow(video({ id: "v1", status: "in_progress" }), { onPause });
    const row = rowFor("v1");
    const pause = within(row).getByRole("button", { name: /^pause$/i });
    expect((pause as HTMLButtonElement).disabled).toBe(false);
    expect(within(row).queryByRole("button", { name: /^resume$/i })).toBeNull();
    fireEvent.click(pause);
    expect(onPause).toHaveBeenCalledTimes(1);
    expect((onPause.mock.calls[0] as [Video])[0].id).toBe("v1");
  });

  it("queued: does NOT show Pause button (only the running video gets Pause)", async () => {
    await renderRow(video({ id: "v1", status: "queued" }));
    const row = rowFor("v1");
    expect(within(row).queryByRole("button", { name: /^pause$/i })).toBeNull();
  });

  it("paused=1 with no running step: shows Resume button + Paused badge, hides Pause; invokes onResume", async () => {
    const onResume = vi.fn();
    await renderRow(
      video({
        id: "v1",
        status: "in_progress",
        paused: 1,
        running_step_started_at: null,
      }),
      { onResume }
    );
    const row = rowFor("v1");
    expect(within(row).queryByRole("button", { name: /^pause$/i })).toBeNull();
    const resume = within(row).getByRole("button", { name: /^resume$/i });
    expect((resume as HTMLButtonElement).disabled).toBe(false);
    expect(within(row).getByText(/^paused$/i)).not.toBeNull();
    expect(within(row).queryByText(/pausing/i)).toBeNull();
    fireEvent.click(resume);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect((onResume.mock.calls[0] as [Video])[0].id).toBe("v1");
  });

  it("paused=1 while a step is still running: shows Pausing… with spinner (not Paused)", async () => {
    // The worker only checks the pause flag between steps, so there is a
    // window where `paused=1` but a step is still executing. The list row
    // must surface this as a transitional state. `running_step_started_at`
    // is non-null exactly when a step is mid-execution.
    await renderRow(
      video({
        id: "v1",
        status: "in_progress",
        paused: 1,
        running_step_started_at: 10_000,
      }),
    );
    const row = rowFor("v1");
    const label = within(row).getByText(/pausing/i);
    expect(label.querySelector(".animate-spin")).not.toBeNull();
    expect(within(row).queryByText(/^paused$/i)).toBeNull();
    // Resume button still surfaces — clicking it during the pausing
    // window is a valid undo.
    expect(
      within(row).getByRole("button", { name: /^resume$/i }),
    ).not.toBeNull();
  });

  it("paused=1 + queueState=paused: disables Resume with a tooltip", async () => {
    await renderRow(
      video({ id: "v1", status: "in_progress", paused: 1 }),
      { queueState: "paused" }
    );
    const row = rowFor("v1");
    const resume = within(row).getByRole("button", { name: /^resume$/i });
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    expect(resume.getAttribute("title")).toMatch(/globally paused/i);
  });

  it("delete_requested=1 + paused=1: hides Pause/Resume, shows Deleting (delete wins)", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "in_progress",
        paused: 1,
        delete_requested: 1,
      })
    );
    const row = rowFor("v1");
    expect(within(row).queryByRole("button", { name: /^pause$/i })).toBeNull();
    expect(within(row).queryByRole("button", { name: /^resume$/i })).toBeNull();
    expect(within(row).queryByText(/^paused$/i)).toBeNull();
    expect(within(row).getByText(/deleting/i)).not.toBeNull();
  });

});

describe("VideoQueueTable Step column", () => {
  it("shows the current step slug for an in_progress row", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "in_progress",
        current_step: "voiceover",
      }),
    );
    const row = rowFor("v1");
    // Title | Workflow | Status | Step | Time | Actions
    const cells = within(row).getAllByRole("cell");
    expect(cells[3].textContent).toBe("voiceover");
  });

  it("shows '—' for a queued row that has not started any step", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "queued",
        current_step: null,
        failed_step: null,
      }),
    );
    const row = rowFor("v1");
    const cells = within(row).getAllByRole("cell");
    expect(cells[3].textContent).toBe("—");
  });

  it("prefers failed_step over a stale current_step on a failed row", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "failed",
        current_step: "voiceover",
        failed_step: "render",
      }),
    );
    const row = rowFor("v1");
    const cells = within(row).getAllByRole("cell");
    expect(cells[3].textContent).toBe("render");
  });
});

describe("VideoQueueTable Time column", () => {
  it("renders a Time column header", async () => {
    await renderRow(video({ id: "v1" }));
    expect(
      screen.getByRole("columnheader", { name: /^time$/i }),
    ).toBeTruthy();
  });

  it("shows '—' for a queued video that has not started any step", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "queued",
        runtime_ms: 0,
        running_step_started_at: null,
      }),
    );
    const row = rowFor("v1");
    // Walk the cells: Title | Workflow | Status | Step | Time | Actions
    const cells = within(row).getAllByRole("cell");
    expect(cells[4].textContent).toBe("—");
  });

  it("shows the frozen runtime when no step is currently running", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "failed",
        runtime_ms: 65_000,
        running_step_started_at: null,
      }),
    );
    const row = rowFor("v1");
    const cells = within(row).getAllByRole("cell");
    expect(cells[4].textContent).toBe("1m 5s");
  });

  it("extrapolates the timer to `now` for an in-progress video with a running step", async () => {
    await renderRow(
      video({
        id: "v1",
        status: "in_progress",
        runtime_ms: 60_000,
        running_step_started_at: 10_000,
      }),
      { now: 15_000 },
    );
    const row = rowFor("v1");
    const cells = within(row).getAllByRole("cell");
    expect(cells[4].textContent).toBe("1m 5s");
  });
});
