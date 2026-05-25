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
    id: "music-video-magnific-suno",
    shortLabel: "Magnific × Suno",
    label: "Music video (Magnific × Suno)",
    kind: "music_video" as const,
  },
];

beforeEach(() => {
  refreshMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderModal(props: { onClose?: () => void } = {}): Promise<void> {
  const { AddMusicVideoModal } = await import(
    "@/app/videos/add-music-video-modal"
  );
  render(
    <AddMusicVideoModal
      workflows={WORKFLOWS}
      onClose={props.onClose ?? (() => {})}
    />,
  );
}

async function fillRequired(): Promise<void> {
  fireEvent.change(screen.getByLabelText(/title/i), {
    target: { value: "My MV" },
  });
  fireEvent.change(screen.getByLabelText(/magnific image prompt/i), {
    target: { value: "an epic poster" },
  });
  fireEvent.change(screen.getByLabelText(/magnific motion prompt/i), {
    target: { value: "aggressive push-in, swirling debris" },
  });
  fireEvent.change(screen.getByLabelText(/suno style prompt/i), {
    target: { value: "synthwave pop" },
  });
  await selectWorkflow(/workflow/i, /magnific × suno/i);
}

describe("AddMusicVideoModal", () => {
  it("renders Title, Workflow, Magnific prompt, Suno style prompt, Song count, Repeat factor", async () => {
    await renderModal();
    expect(screen.getByLabelText(/title/i)).not.toBeNull();
    expect(screen.getByLabelText(/workflow/i)).not.toBeNull();
    expect(screen.getByLabelText(/magnific image prompt/i)).not.toBeNull();
    expect(screen.getByLabelText(/suno style prompt/i)).not.toBeNull();
    expect(screen.getByLabelText(/song count/i)).not.toBeNull();
    expect(screen.getByLabelText(/repeat factor/i)).not.toBeNull();
  });

  it("renders a Magnific motion prompt textarea with the suggested-motion placeholder", async () => {
    await renderModal();
    const motion = screen.getByLabelText(
      /magnific motion prompt/i,
    ) as HTMLTextAreaElement;
    expect(motion).not.toBeNull();
    expect(motion.tagName).toBe("TEXTAREA");
    expect(motion.getAttribute("placeholder")).toBe(
      "slow cinematic motion, smooth loop, looping camera",
    );
    // Value starts blank — the placeholder is a hint, not a default.
    expect(motion.value).toBe("");
  });

  it("does NOT render the narrative-only Topic info or Visual style fields", async () => {
    await renderModal();
    expect(screen.queryByLabelText(/topic info/i)).toBeNull();
    expect(screen.queryByLabelText(/visual style/i)).toBeNull();
  });

  it("song count defaults to 10 and repeat factor defaults to 3", async () => {
    await renderModal();
    const songCount = screen.getByLabelText(/song count/i) as HTMLInputElement;
    const repeatFactor = screen.getByLabelText(
      /repeat factor/i,
    ) as HTMLInputElement;
    expect(songCount.value).toBe("10");
    expect(repeatFactor.value).toBe("3");
  });

  it("filters the workflow dropdown to kind=music_video options only", async () => {
    await renderModal();
    const trigger = screen.getByRole("combobox", { name: /workflow/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });
    // Narrative workflow is filtered out.
    expect(
      screen.queryByRole("option", { name: /comfyui full label/i }),
    ).toBeNull();
    // Music-video workflow is present.
    expect(
      await screen.findByRole("option", { name: /magnific × suno/i }),
    ).not.toBeNull();
  });

  it("submit disabled until title, all three prompts, and workflow are set", async () => {
    await renderModal();
    const submit = screen.getByRole("button", {
      name: /create/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "T" },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/magnific image prompt/i), {
      target: { value: "P" },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/magnific motion prompt/i), {
      target: { value: "M" },
    });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/suno style prompt/i), {
      target: { value: "S" },
    });
    expect(submit.disabled).toBe(true);

    await selectWorkflow(/workflow/i, /magnific × suno/i);
    expect(submit.disabled).toBe(false);
  });

  it("submit stays disabled when only the motion prompt is blank", async () => {
    await renderModal();
    const submit = screen.getByRole("button", {
      name: /create/i,
    }) as HTMLButtonElement;

    fireEvent.change(screen.getByLabelText(/title/i), {
      target: { value: "T" },
    });
    fireEvent.change(screen.getByLabelText(/magnific image prompt/i), {
      target: { value: "P" },
    });
    fireEvent.change(screen.getByLabelText(/suno style prompt/i), {
      target: { value: "S" },
    });
    await selectWorkflow(/workflow/i, /magnific × suno/i);
    // Every required field is set EXCEPT the motion prompt — submit must stay
    // disabled, proving canSubmit gates on the new field.
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/magnific motion prompt/i), {
      target: { value: "M" },
    });
    expect(submit.disabled).toBe(false);
  });

  it("POSTs to /api/videos with kind=music_video + the music-video tuple", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 201 }),
    );

    await renderModal();
    await fillRequired();
    fireEvent.change(screen.getByLabelText(/song count/i), {
      target: { value: "5" },
    });
    fireEvent.change(screen.getByLabelText(/repeat factor/i), {
      target: { value: "2" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/videos");
    expect(calls[0][1].method).toBe("POST");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({
      kind: "music_video",
      title: "My MV",
      workflow_id: "music-video-magnific-suno",
      magnific_image_prompt: "an epic poster",
      magnific_motion_prompt: "aggressive push-in, swirling debris",
      suno_style_prompt: "synthwave pop",
      song_count: 5,
      repeat_factor: 2,
    });
    expect(refreshMock).toHaveBeenCalled();
  });

  it("Cancel closes without firing fetch", async () => {
    const onClose = vi.fn();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await renderModal({ onClose });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders server error message on non-OK response", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: "kind/workflow mismatch" }), {
        status: 400,
      }),
    );

    await renderModal();
    await fillRequired();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /create/i }));
    });

    expect(screen.getByRole("alert").textContent).toMatch(
      /kind\/workflow mismatch/,
    );
  });
});
