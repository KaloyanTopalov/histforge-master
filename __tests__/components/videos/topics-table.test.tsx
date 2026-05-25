import { describe, it, expect, vi, afterEach } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { Video } from "@/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
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
  v: Video,
  opts: {
    rowInflight?: {
      id: string;
      action: "start" | "pause" | "resume";
    } | null;
    onStart?: (v: Video) => void;
    onEdit?: (v: Video) => void;
    onDelete?: (v: Video) => void;
  } = {}
): Promise<void> {
  const { TopicsTable } = await import("@/app/videos/topics-table");
  render(
    <TopicsTable
      rows={[v]}
      workflows={WORKFLOWS}
      rowInflight={opts.rowInflight ?? null}
      onStart={opts.onStart ?? (() => {})}
      onEdit={opts.onEdit ?? (() => {})}
      onDelete={opts.onDelete ?? (() => {})}
    />
  );
}

function rowFor(id: string): HTMLElement {
  return screen.getByTestId(`topic-row-${id}`) as HTMLElement;
}

describe("TopicsTable", () => {
  it("shows Add to queue + Edit + Delete buttons for a new topic", async () => {
    await renderRow(video({ id: "v1" }));
    const row = rowFor("v1");
    const addToQueue = within(row).getByRole("button", {
      name: /add to queue/i,
    });
    const edit = within(row).getByRole("button", { name: /edit/i });
    const del = within(row).getByRole("button", { name: /delete/i });
    expect((addToQueue as HTMLButtonElement).disabled).toBe(false);
    expect((edit as HTMLButtonElement).disabled).toBe(false);
    expect((del as HTMLButtonElement).disabled).toBe(false);
  });

  it("invokes onStart when Add to queue is clicked", async () => {
    const onStart = vi.fn();
    await renderRow(video({ id: "v1" }), { onStart });
    const row = rowFor("v1");
    fireEvent.click(within(row).getByRole("button", { name: /add to queue/i }));
    expect(onStart).toHaveBeenCalledTimes(1);
    expect((onStart.mock.calls[0] as [Video])[0].id).toBe("v1");
  });

  it("invokes onEdit when Edit is clicked", async () => {
    const onEdit = vi.fn();
    await renderRow(video({ id: "v1" }), { onEdit });
    const row = rowFor("v1");
    fireEvent.click(within(row).getByRole("button", { name: /edit/i }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("invokes onDelete when Delete is clicked", async () => {
    const onDelete = vi.fn();
    await renderRow(video({ id: "v1" }), { onDelete });
    const row = rowFor("v1");
    fireEvent.click(within(row).getByRole("button", { name: /delete/i }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("disables Add to queue button when that row has an in-flight start", async () => {
    await renderRow(video({ id: "v1" }), {
      rowInflight: { id: "v1", action: "start" },
    });
    const row = rowFor("v1");
    const addToQueue = within(row).getByRole("button", {
      name: /add to queue/i,
    });
    expect((addToQueue as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders empty-state message when no topics exist", async () => {
    const { TopicsTable } = await import("@/app/videos/topics-table");
    render(
      <TopicsTable
        rows={[]}
        workflows={WORKFLOWS}
        rowInflight={null}
        onStart={() => {}}
        onEdit={() => {}}
        onDelete={() => {}}
      />
    );
    expect(screen.getByText(/no topics yet/i)).not.toBeNull();
  });

  it("renders workflow shortLabel with full label in tooltip", async () => {
    await renderRow(video({ id: "v1" }));
    const row = rowFor("v1");
    const cell = within(row).getByText("ComfyUI");
    expect(cell.getAttribute("title")).toBe("ComfyUI full label");
  });

  it("title links to /videos/:id", async () => {
    await renderRow(video({ id: "abc123" }));
    const row = rowFor("abc123");
    const link = within(row).getByRole("link", { name: /test video/i });
    expect(link.getAttribute("href")).toBe("/videos/abc123");
  });

  it("renders a 'Ready script' badge in the Title cell when provided_script is set", async () => {
    await renderRow(video({ id: "v1", provided_script: "Hello." }));
    const row = rowFor("v1");
    expect(within(row).getByText(/ready script/i)).not.toBeNull();
  });

  it("does NOT render the 'Ready script' badge when provided_script is null", async () => {
    await renderRow(video({ id: "v1", provided_script: null }));
    const row = rowFor("v1");
    expect(within(row).queryByText(/ready script/i)).toBeNull();
  });
});
