import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";
import type {
  WorkflowEditRow,
  ScriptStepMeta,
} from "@/app/workflows/[id]/edit/edit-form";

const refreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: refreshMock }),
}));

const toastSuccessMock = vi.fn();
const toastErrorMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccessMock(...args),
    error: (...args: unknown[]) => toastErrorMock(...args),
  },
}));

beforeEach(() => {
  installRadixJsdomPolyfills();
  refreshMock.mockClear();
  toastSuccessMock.mockClear();
  toastErrorMock.mockClear();
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const baseRow: WorkflowEditRow = {
  id: "comfyui-test",
  label: "ComfyUI Test",
  short_label: "CFY",
  description: "Test description",
  script_llm_provider: "openrouter",
  tts_provider: "ai33",
  image_provider: "comfyui",
  video_provider: "comfyui",
  enabled: true,
  version: 3,
  is_builtin: false,
  chunker_step: "chunk_clips_then_images",
};

const baseSteps = [
  { step_name: "research_outline" },
  { step_name: "write_hook" },
  { step_name: "write_chapters" },
];

const baseCatalog: readonly ScriptStepMeta[] = [
  {
    name: "research_outline",
    label: "Research outline",
    description: "Outline research",
    for_each: null,
  },
  {
    name: "write_hook",
    label: "Write hook",
    description: "Hook writing",
    for_each: null,
  },
  {
    name: "write_chapters",
    label: "Write chapters",
    description: "Chapters",
    for_each: "chapters",
  },
];

async function renderForm(
  overrides: { row?: Partial<WorkflowEditRow>; steps?: { step_name: string }[] } = {}
): Promise<void> {
  const { EditForm } = await import("@/app/workflows/[id]/edit/edit-form");
  const row = { ...baseRow, ...overrides.row };
  const steps = overrides.steps ?? [...baseSteps];
  render(
    <EditForm
      initialRow={row}
      initialSteps={steps}
      scriptCatalog={baseCatalog}
    />
  );
}

function mockFetchOnce(payload: unknown, status = 200): void {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
    new Response(JSON.stringify(payload), { status })
  );
}

function dirtyFormByEditingShortLabel(): void {
  // CFY is unique among initial values so getByDisplayValue is unambiguous.
  fireEvent.change(screen.getByDisplayValue("CFY"), {
    target: { value: "CFY2" },
  });
}

async function clickSave(): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
  });
}

async function clickValidateNow(): Promise<void> {
  await act(async () => {
    fireEvent.click(
      screen.getByRole("button", { name: /^validate now$/i })
    );
  });
}

describe("EditForm script_llm_provider Select", () => {
  it("offers Claude CLI without the legacy '(coming in Phase 4)' suffix", async () => {
    await renderForm();

    const trigger = screen.getByRole("combobox", {
      name: /script_llm_provider/i,
    });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /^Claude CLI$/ })
    ).toBeTruthy();
    // The legacy suffix must not appear anywhere in the option list.
    expect(
      screen.queryByRole("option", { name: /coming in Phase 4/i })
    ).toBeNull();
  });
});

describe("EditForm tts_provider Select", () => {
  it("offers Chatterbox alongside AI33 and GenAIPro", async () => {
    await renderForm();

    const trigger = screen.getByRole("combobox", { name: /tts_provider/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /^Chatterbox$/ })
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: /^AI33$/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^GenAIPro$/ })).toBeTruthy();
  });

  it("offers Chatterbox (fast) — the parallel sidecar option", async () => {
    await renderForm();

    const trigger = screen.getByRole("combobox", { name: /tts_provider/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /^Chatterbox \(fast\)$/ })
    ).toBeTruthy();
  });
});

describe("EditForm image_provider Select", () => {
  it("reflects image_provider='magnific' in the initial selector value (the seeded narrative-magnific-nano-banana case)", async () => {
    await renderForm({ row: { image_provider: "magnific" } });

    const trigger = screen.getByRole("combobox", { name: /image_provider/i });
    expect(trigger.textContent).toMatch(/magnific/i);
  });

  it("offers all three image providers — ComfyUI, Google Flow, Magnific", async () => {
    await renderForm();

    const trigger = screen.getByRole("combobox", { name: /image_provider/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /^ComfyUI$/ })
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Google Flow$/ })).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Magnific$/ })).toBeTruthy();
  });

  it("reflects image_provider='google_flow' in the initial selector value (regression)", async () => {
    await renderForm({ row: { image_provider: "google_flow" } });

    const trigger = screen.getByRole("combobox", { name: /image_provider/i });
    expect(trigger.textContent).toMatch(/google flow/i);
  });

  it("reflects image_provider='comfyui' in the initial selector value (regression)", async () => {
    await renderForm({ row: { image_provider: "comfyui" } });

    const trigger = screen.getByRole("combobox", { name: /image_provider/i });
    expect(trigger.textContent).toMatch(/comfyui/i);
  });

  it("selecting Magnific includes image_provider in the PATCH body", async () => {
    mockFetchOnce({ workflow: { version: 4 }, warnings: [] });

    await renderForm(); // baseRow image_provider = comfyui

    const trigger = screen.getByRole("combobox", { name: /image_provider/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });
    const option = await screen.findByRole("option", { name: /^Magnific$/ });
    await act(async () => {
      fireEvent.click(option);
    });

    await clickSave();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.image_provider).toBe("magnific");
    expect(body.expected_version).toBe(3);
  });
});

describe("EditForm video_provider Select", () => {
  it("offers only ComfyUI and Google Flow — never Magnific (narrative schema rejects video=magnific)", async () => {
    await renderForm();

    const trigger = screen.getByRole("combobox", { name: /video_provider/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /^ComfyUI$/ })
    ).toBeTruthy();
    expect(screen.getByRole("option", { name: /^Google Flow$/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /^Magnific$/ })).toBeNull();
  });
});

describe("EditForm chunker_step Select", () => {
  it("offers the three chunker variants", async () => {
    await renderForm();

    const trigger = screen.getByRole("combobox", { name: /chunker_step/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });

    expect(
      await screen.findByRole("option", { name: /clips \+ images/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /^images only$/i })
    ).toBeTruthy();
    expect(
      screen.getByRole("option", { name: /^clips only$/i })
    ).toBeTruthy();
  });

  it("reflects the row's chunker_step in the initial selector value", async () => {
    await renderForm({
      row: { chunker_step: "chunk_images_only" },
    });

    const trigger = screen.getByRole("combobox", { name: /chunker_step/i });
    expect(trigger.textContent).toMatch(/images only/i);
  });

  it("changing the selector includes chunker_step in the PATCH body", async () => {
    mockFetchOnce({ workflow: { version: 4 }, warnings: [] });

    await renderForm();

    const trigger = screen.getByRole("combobox", { name: /chunker_step/i });
    await act(async () => {
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "Enter", code: "Enter" });
    });
    const option = await screen.findByRole("option", { name: /^images only$/i });
    await act(async () => {
      fireEvent.click(option);
    });

    await clickSave();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.chunker_step).toBe("chunk_images_only");
    expect(body.expected_version).toBe(3);
  });

  it("renders consistency warnings (step_name === chunker slug) under the chunker selector", async () => {
    mockFetchOnce({
      workflow: { version: 4 },
      warnings: [
        {
          step_name: "chunk_clips_then_images",
          missing_input: "image_provider",
          message: "chunk_clips_then_images requires image_provider to be set.",
        },
      ],
    });

    await renderForm({ row: { image_provider: null } });
    dirtyFormByEditingShortLabel();
    await clickSave();

    expect(
      screen.getByText(
        /chunk_clips_then_images requires image_provider to be set\./
      )
    ).toBeTruthy();
  });
});

describe("EditForm save returns warnings", () => {
  it("renders the warning message after a successful save with warnings", async () => {
    mockFetchOnce({
      workflow: { version: 4 },
      warnings: [
        {
          step_name: "write_chapters",
          missing_input: "script/01_outline.md",
          message:
            "Write chapters needs 'script/01_outline.md' but no prior step produces it",
        },
      ],
    });

    await renderForm();
    dirtyFormByEditingShortLabel();
    await clickSave();

    expect(
      screen.getByText(
        /Write chapters needs 'script\/01_outline\.md' but no prior step produces it/
      )
    ).toBeTruthy();
  });

  it("clears prior warnings when a subsequent save returns an empty warnings array", async () => {
    mockFetchOnce({
      workflow: { version: 4 },
      warnings: [
        {
          step_name: "write_chapters",
          missing_input: "script/01_outline.md",
          message: "first warning text",
        },
      ],
    });
    mockFetchOnce({ workflow: { version: 5 }, warnings: [] });

    await renderForm();
    dirtyFormByEditingShortLabel();
    await clickSave();
    expect(screen.getByText(/first warning text/)).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("CFY2"), {
      target: { value: "CFY3" },
    });
    await clickSave();

    expect(screen.queryByText(/first warning text/)).toBeNull();
  });

  it("stacks multiple warnings on the same step", async () => {
    mockFetchOnce({
      workflow: { version: 4 },
      warnings: [
        {
          step_name: "write_chapters",
          missing_input: "script/01_outline.md",
          message: "missing outline",
        },
        {
          step_name: "write_chapters",
          missing_input: "script/03_hook.md",
          message: "missing hook",
        },
      ],
    });

    await renderForm();
    dirtyFormByEditingShortLabel();
    await clickSave();

    expect(screen.getByText(/missing outline/)).toBeTruthy();
    expect(screen.getByText(/missing hook/)).toBeTruthy();
  });

  it("does not touch warnings on 409 version_conflict", async () => {
    // First save: returns warnings.
    mockFetchOnce({
      workflow: { version: 4 },
      warnings: [
        {
          step_name: "write_chapters",
          missing_input: "script/01_outline.md",
          message: "persistent warning",
        },
      ],
    });
    // Second save: 409 conflict.
    mockFetchOnce({ error: "version_conflict", current_version: 99 }, 409);

    await renderForm();
    dirtyFormByEditingShortLabel();
    await clickSave();
    expect(screen.getByText(/persistent warning/)).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("CFY2"), {
      target: { value: "CFY3" },
    });
    await clickSave();

    expect(screen.getByText(/persistent warning/)).toBeTruthy();
  });
});

describe("EditForm Validate now button", () => {
  it("Validate now is enabled even with empty steps and a clean form", async () => {
    await renderForm({ steps: [] });
    const button = screen.getByRole("button", {
      name: /^validate now$/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
  });

  it("clicking Validate now POSTs the four providers + chunker_step + steps to /api/workflows/validate", async () => {
    mockFetchOnce({ warnings: [] });

    await renderForm();
    await clickValidateNow();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/workflows/validate");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      script_llm_provider: "openrouter",
      tts_provider: "ai33",
      image_provider: "comfyui",
      video_provider: "comfyui",
      chunker_step: "chunk_clips_then_images",
      steps: baseSteps,
    });
  });

  it("renders warnings from /api/workflows/validate on 200", async () => {
    mockFetchOnce({
      warnings: [
        {
          step_name: "write_chapters",
          missing_input: "script/01_outline.md",
          message: "validate-now-warning",
        },
      ],
    });

    await renderForm();
    await clickValidateNow();

    expect(screen.getByText(/validate-now-warning/)).toBeTruthy();
  });

  it("toasts 'Validation passed' on a clean 200 response", async () => {
    mockFetchOnce({ warnings: [] });

    await renderForm();
    await clickValidateNow();

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(String(toastSuccessMock.mock.calls[0][0])).toMatch(
      /^Validation passed$/
    );
  });

  it("toasts the warning count on a 200 response with warnings", async () => {
    mockFetchOnce({
      warnings: [
        {
          step_name: "assemble_script",
          missing_input: "script/03_hook.md",
          message: "w1",
        },
        {
          step_name: "assemble_script",
          missing_input: "script/04_chapter_01.md",
          message: "w2",
        },
      ],
    });

    await renderForm();
    await clickValidateNow();

    expect(toastSuccessMock).toHaveBeenCalledTimes(1);
    expect(String(toastSuccessMock.mock.calls[0][0])).toMatch(
      /^Validation found 2 warnings$/
    );
  });

  it("uses singular 'warning' in the toast when there is exactly one", async () => {
    mockFetchOnce({
      warnings: [
        {
          step_name: "assemble_script",
          missing_input: "script/03_hook.md",
          message: "only one",
        },
      ],
    });

    await renderForm();
    await clickValidateNow();

    expect(String(toastSuccessMock.mock.calls[0][0])).toMatch(
      /^Validation found 1 warning$/
    );
  });

  it("does not toast success on a 400 response", async () => {
    mockFetchOnce(
      {
        error: "invalid_input",
        issues: [{ path: ["steps"], message: "bad" }],
      },
      400
    );

    await renderForm();
    await clickValidateNow();

    expect(toastSuccessMock).not.toHaveBeenCalled();
  });

  it("toasts the first Zod issue message on 400", async () => {
    mockFetchOnce(
      {
        error: "invalid_input",
        issues: [{ path: ["steps"], message: "steps must be an array" }],
      },
      400
    );

    await renderForm();
    await clickValidateNow();

    expect(toastErrorMock).toHaveBeenCalled();
    expect(String(toastErrorMock.mock.calls[0][0])).toMatch(
      /steps must be an array/
    );
  });

  it("Validate now does not PATCH /api/workflows/[id]", async () => {
    mockFetchOnce({ warnings: [] });

    await renderForm();
    await clickValidateNow();

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const calls = fetchMock.mock.calls as [string, RequestInit][];
    for (const [url, init] of calls) {
      const isPatch = init?.method === "PATCH";
      expect(isPatch && url.startsWith("/api/workflows/comfyui-test")).toBe(
        false
      );
    }
  });

  it("a Validate now response replaces warnings left over from a prior Save", async () => {
    // First: Save returns a warning.
    mockFetchOnce({
      workflow: { version: 4 },
      warnings: [
        {
          step_name: "write_chapters",
          missing_input: "script/01_outline.md",
          message: "save-era warning",
        },
      ],
    });
    // Then: Validate-now returns a different warning on a different step.
    mockFetchOnce({
      warnings: [
        {
          step_name: "write_hook",
          missing_input: "script/01_outline.md",
          message: "validate-era warning",
        },
      ],
    });

    await renderForm();
    dirtyFormByEditingShortLabel();
    await clickSave();
    expect(screen.getByText(/save-era warning/)).toBeTruthy();

    await clickValidateNow();

    expect(screen.queryByText(/save-era warning/)).toBeNull();
    expect(screen.getByText(/validate-era warning/)).toBeTruthy();
  });
});
