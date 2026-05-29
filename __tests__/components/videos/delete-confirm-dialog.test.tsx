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
import type { Video } from "@/types";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
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
    magnific_motion_prompt: null,
    suno_style_prompt: null,
    song_count: null,
    repeat_factor: null,
    image_chunk_target_seconds: null,
    image_chunk_min_seconds: null,
    image_chunk_max_seconds: null,
    magnific_project_id: null,
    created_at: 1000,
    ...overrides,
  };
}

beforeEach(() => {
  refreshMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderDialog(props: {
  video: Video;
  onClose?: () => void;
}): Promise<void> {
  const { DeleteConfirmDialog } = await import(
    "@/app/videos/delete-confirm-dialog"
  );
  render(
    <DeleteConfirmDialog
      video={props.video}
      onClose={props.onClose ?? (() => {})}
    />
  );
}

describe("DeleteConfirmDialog", () => {
  it("renders 'Delete video?' title", async () => {
    await renderDialog({ video: video() });
    expect(screen.getByText(/delete video\?/i)).not.toBeNull();
  });

  it("shows in_progress-specific message", async () => {
    await renderDialog({ video: video({ status: "in_progress" }) });
    expect(screen.getByText(/being generated/i)).not.toBeNull();
  });

  it("shows queued/failed message about files being removed", async () => {
    await renderDialog({ video: video({ status: "queued" }) });
    expect(screen.getByText(/generated files/i)).not.toBeNull();
  });

  it("shows done message about files being removed", async () => {
    await renderDialog({
      video: video({ status: "done", finished_at: 123 }),
    });
    expect(screen.getByText(/generated files/i)).not.toBeNull();
  });

  it("shows new-specific message", async () => {
    await renderDialog({ video: video({ status: "new" }) });
    expect(screen.getByText(/video entry/i)).not.toBeNull();
  });

  it("Cancel closes without fetch", async () => {
    const onClose = vi.fn();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await renderDialog({ video: video(), onClose });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Delete button DELETEs /api/videos/:id and closes on success", async () => {
    const onClose = vi.fn();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    await renderDialog({
      video: video({ id: "v42", status: "queued" }),
      onClose,
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v42");
    expect(calls[0][1].method).toBe("DELETE");
    expect(onClose).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });
});
