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
import type { Video } from "@/types";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

beforeEach(() => {
  installRadixJsdomPolyfills();
});

async function selectWorkflow(
  triggerName: RegExp,
  optionName: RegExp
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

const SENTINEL = "[ready script — generation skipped]";

beforeEach(() => {
  refreshMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function video(overrides: Partial<Video> = {}): Video {
  return {
    id: "v1",
    title: "Existing",
    topic_info: SENTINEL,
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
    provided_script: "Pre-existing script.",
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
    created_at: 1000,
    ...overrides,
  };
}

async function renderModal(
  props: {
    mode?: "add" | "edit";
    video?: Video;
    onClose?: () => void;
    visualStyles?: { id: string; title: string; prompt: string }[];
  } = {}
): Promise<void> {
  const { AddReadyScriptModal } = await import(
    "@/app/videos/add-ready-script-modal"
  );
  render(
    <AddReadyScriptModal
      mode={props.mode ?? "add"}
      video={props.video}
      workflows={WORKFLOWS}
      visualStyles={props.visualStyles ?? VISUAL_STYLES}
      onClose={props.onClose ?? (() => {})}
    />
  );
}

describe("AddReadyScriptModal", () => {
  it("renders Title + Script + Workflow fields and a Load-from-file control", async () => {
    await renderModal();
    expect(screen.getByLabelText(/title/i)).not.toBeNull();
    expect(screen.getByLabelText(/^script$/i)).not.toBeNull();
    expect(screen.getByLabelText(/workflow/i)).not.toBeNull();
    expect(
      screen.getByRole("button", { name: /load from file/i })
    ).not.toBeNull();
  });

  it("submit is disabled until title, script, and workflow are all set", async () => {
    await renderModal();
    const submit = screen.getByRole("button", {
      name: /create/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "t" },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/^script$/i), {
      target: { value: "Hello." },
    });
    expect(submit.disabled).toBe(true);

    await selectWorkflow(/workflow/i, /comfyui full label/i);
    expect(submit.disabled).toBe(false);
  });

  it("POSTs /api/videos with the sentinel topic_info and the form body", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ video: { id: "v1" } }),
        { status: 201 }
      )
    );

    await renderModal();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "My Ready Script Video" },
    });
    fireEvent.change(screen.getByLabelText(/^script$/i), {
      target: { value: "Lived—seventeen talents." },
    });
    await selectWorkflow(/workflow/i, /google flow full label/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos");
    expect(calls[0][1].method).toBe("POST");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({
      title: "My Ready Script Video",
      topic_info: SENTINEL,
      workflow_id: "google-flow",
      // Sanitization is server-side — the modal posts the raw text.
      provided_script: "Lived—seventeen talents.",
      visual_style_id: null,
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("Load from file populates the script textarea with the file contents", async () => {
    await renderModal();
    const fileInput = screen
      .getByLabelText(/^script$/i)
      .closest("div")!
      .parentElement!.querySelector(
        "input[type='file']"
      ) as HTMLInputElement;
    expect(fileInput).not.toBeNull();

    const file = new File(["Loaded from disk."], "script.md", {
      type: "text/markdown",
    });
    await act(async () => {
      fireEvent.change(fileInput, { target: { files: [file] } });
    });

    // FileReader resolves asynchronously; wait for the textarea to update.
    await waitFor(() => {
      const textarea = screen.getByLabelText(
        /^script$/i
      ) as HTMLTextAreaElement;
      expect(textarea.value).toBe("Loaded from disk.");
    });
  });

  it("Cancel closes without calling fetch", async () => {
    const onClose = vi.fn();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await renderModal({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("edit mode pre-fills title, script, and workflow from the video prop", async () => {
    await renderModal({
      mode: "edit",
      video: video({
        id: "v42",
        title: "Pre",
        provided_script: "Pre-existing body.",
        workflow_id: "google-flow",
      }),
    });
    expect((screen.getByLabelText(/title/i) as HTMLInputElement).value).toBe(
      "Pre"
    );
    expect(
      (screen.getByLabelText(/^script$/i) as HTMLTextAreaElement).value
    ).toBe("Pre-existing body.");
    const workflowTrigger = screen.getByRole("combobox", { name: /workflow/i });
    expect(workflowTrigger.textContent).toMatch(/google flow full label/i);
  });

  it("edit mode PATCHes /api/videos/:id with the form body (no topic_info)", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: { id: "v42" } }), { status: 200 })
    );

    await renderModal({
      mode: "edit",
      video: video({ id: "v42", provided_script: "Old." }),
    });
    fireEvent.change(screen.getByLabelText(/^script$/i), {
      target: { value: "New body." },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /save/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos/v42");
    expect(calls[0][1].method).toBe("PATCH");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({
      title: "Existing",
      workflow_id: "comfyui",
      provided_script: "New body.",
      visual_style_id: null,
    });
  });

  it("renders a Visual style select defaulting to 'Default (no style)'", async () => {
    await renderModal();
    const trigger = screen.getByRole("combobox", { name: /visual style/i });
    expect(trigger.textContent).toMatch(/default \(no style\)/i);
  });

  it("POSTs the picked visual_style_id when a style is selected", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: { id: "v1" } }), { status: 201 })
    );

    await renderModal();
    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByLabelText(/^script$/i), {
      target: { value: "Body." },
    });
    await selectWorkflow(/workflow/i, /comfyui full label/i);
    await selectWorkflow(/visual style/i, /cinematic noir/i);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.visual_style_id).toBe("vs-noir");
  });

  it("edit mode pre-fills visual_style_id and sends it on PATCH", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ video: { id: "v42" } }), { status: 200 })
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
});
