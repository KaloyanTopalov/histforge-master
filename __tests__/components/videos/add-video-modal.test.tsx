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
import type { Video } from "@/types";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

beforeEach(() => {
  installRadixJsdomPolyfills();
});

/**
 * Open the Radix Select trigger (via keyboard — pointer events in jsdom
 * don't always propagate the open state) and click the option whose
 * accessible name matches `optionName`.
 */
async function selectWorkflow(
  triggerName: RegExp,
  optionName: RegExp,
): Promise<void> {
  const trigger = screen.getByRole("combobox", { name: triggerName });
  await act(async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
  });
  const option = await screen.findByRole("option", { name: optionName });
  await act(async () => {
    fireEvent.click(option);
  });
}

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
];

const VISUAL_STYLES = [
  { id: "vs-noir", title: "Cinematic noir", prompt: "Noir prompt body" },
  { id: "vs-painterly", title: "Painterly", prompt: "Painterly prompt body" },
];

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: "v1",
    title: "Existing",
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

async function renderModal(props: {
  mode: "add" | "edit";
  video?: Video;
  onClose?: () => void;
  visualStyles?: { id: string; title: string; prompt: string }[];
}): Promise<void> {
  const { AddVideoModal } = await import("@/app/videos/add-video-modal");
  render(
    <AddVideoModal
      mode={props.mode}
      video={props.video}
      workflows={WORKFLOWS}
      visualStyles={props.visualStyles ?? VISUAL_STYLES}
      onClose={props.onClose ?? (() => {})}
    />
  );
}

describe("AddVideoModal", () => {
  it("renders Title + Topic info + Workflow fields", async () => {
    await renderModal({ mode: "add" });
    expect(screen.getByLabelText(/title/i)).not.toBeNull();
    expect(screen.getByLabelText(/topic info/i)).not.toBeNull();
    expect(screen.getByLabelText(/workflow/i)).not.toBeNull();
  });

  it("workflow select has a placeholder and no default selection", async () => {
    await renderModal({ mode: "add" });
    const trigger = screen.getByRole("combobox", { name: /workflow/i });
    // Placeholder is rendered inside the trigger until a value is picked.
    expect(trigger.textContent).toMatch(/select a workflow/i);
  });

  it("submit is disabled until all three fields are filled", async () => {
    await renderModal({ mode: "add" });
    const submit = screen.getByRole("button", {
      name: /create|save/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "t" },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/topic info/i), {
      target: { value: "i" },
    });
    expect(submit.disabled).toBe(true);

    await selectWorkflow(/workflow/i, /comfyui full label/i);
    expect(submit.disabled).toBe(false);
  });

  it("add mode POSTs to /api/videos with the form body", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: video() }), { status: 201 })
    );

    await renderModal({ mode: "add" });
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "My title" },
    });
    fireEvent.change(screen.getByLabelText(/topic info/i), {
      target: { value: "My info" },
    });
    await selectWorkflow(/workflow/i, /google flow full label/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create|save/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos");
    expect(calls[0][1].method).toBe("POST");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({
      title: "My title",
      topic_info: "My info",
      workflow_id: "google-flow",
      visual_style_id: null,
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("edit mode pre-fills values and PATCHes /api/videos/:id", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: video() }), { status: 200 })
    );

    await renderModal({
      mode: "edit",
      video: video({ id: "v42", title: "Pre", topic_info: "PreInfo" }),
    });
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe(
      "Pre"
    );
    expect(
      (screen.getByLabelText(/topic info/i) as HTMLTextAreaElement).value
    ).toBe("PreInfo");
    // Radix Select trigger shows the selected option's label, not the
    // placeholder, once a value is bound.
    const workflowTrigger = screen.getByRole("combobox", { name: /workflow/i });
    expect(workflowTrigger.textContent).toMatch(/comfyui full label/i);

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "Updated" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v42");
    expect(calls[0][1].method).toBe("PATCH");
  });

  it("renders a Visual style select defaulting to 'Default (no style)'", async () => {
    await renderModal({ mode: "add" });
    const trigger = screen.getByRole("combobox", { name: /visual style/i });
    expect(trigger.textContent).toMatch(/default \(no style\)/i);
  });

  it("POSTs visual_style_id: null when no style is picked", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: video() }), { status: 201 })
    );

    await renderModal({ mode: "add" });
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByLabelText(/topic info/i), {
      target: { value: "I" },
    });
    await selectWorkflow(/workflow/i, /comfyui full label/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create|save/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.visual_style_id).toBeNull();
  });

  it("POSTs the picked visual_style_id when a style is selected", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: video() }), { status: 201 })
    );

    await renderModal({ mode: "add" });
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByLabelText(/topic info/i), {
      target: { value: "I" },
    });
    await selectWorkflow(/workflow/i, /comfyui full label/i);
    await selectWorkflow(/visual style/i, /cinematic noir/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create|save/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.visual_style_id).toBe("vs-noir");
  });

  it("'Show prompt' disclosure reveals the selected style's prompt text", async () => {
    await renderModal({ mode: "add" });
    await selectWorkflow(/visual style/i, /painterly/i);

    // Collapsed by default — prompt text not visible.
    expect(screen.queryByText(/painterly prompt body/i)).toBeNull();

    const toggle = screen.getByRole("button", { name: /show prompt/i });
    await act(async () => {
      fireEvent.click(toggle);
    });
    expect(screen.getByText(/painterly prompt body/i)).not.toBeNull();
  });

  it("edit mode pre-fills visual_style_id from the video row", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: video() }), { status: 200 })
    );
    await renderModal({
      mode: "edit",
      video: video({ id: "v42", visual_style_id: "vs-painterly" }),
    });

    const trigger = screen.getByRole("combobox", { name: /visual style/i });
    expect(trigger.textContent).toMatch(/painterly/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.visual_style_id).toBe("vs-painterly");
  });

  it("Cancel closes without calling fetch", async () => {
    const onClose = vi.fn();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await renderModal({ mode: "add", onClose });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
