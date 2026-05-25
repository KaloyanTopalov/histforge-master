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
  within,
  type RenderResult,
} from "@testing-library/react";
import type { WorkflowApiSummary } from "@/lib/workflows-api";

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

import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

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

function row(overrides: Partial<WorkflowApiSummary> = {}): WorkflowApiSummary {
  return {
    id: "comfyui",
    label: "ComfyUI (local)",
    shortLabel: "ComfyUI",
    description: null,
    isBuiltin: 1,
    enabled: 1,
    version: 1,
    providers: {
      script: "openrouter",
      tts: "ai33",
      image: "comfyui",
      video: "comfyui",
    },
    stepCount: 4,
    ...overrides,
  };
}

async function renderTable(rows: WorkflowApiSummary[]): Promise<void> {
  const { WorkflowsTable } = await import(
    "@/app/workflows/workflows-table"
  );
  render(<WorkflowsTable rows={rows} />);
}

function rowFor(id: string): HTMLElement {
  return screen.getByTestId(`workflow-row-${id}`);
}

describe("WorkflowsTable rendering", () => {
  it("renders one row per workflow with label, shortLabel, providers, and step count", async () => {
    await renderTable([
      row({ id: "comfyui", label: "ComfyUI (local)", shortLabel: "ComfyUI" }),
      row({
        id: "google-flow",
        label: "Google Flow (cloud)",
        shortLabel: "Google Flow",
        isBuiltin: 1,
        version: 2,
        providers: {
          script: "openrouter",
          tts: "ai33",
          image: "google_flow",
          video: "google_flow",
        },
        stepCount: 5,
      }),
    ]);
    const comfy = rowFor("comfyui");
    expect(within(comfy).getByText("ComfyUI")).toBeTruthy();
    expect(within(comfy).getByText("openrouter")).toBeTruthy();
    expect(within(comfy).getByText(/^4$/)).toBeTruthy();

    const flow = rowFor("google-flow");
    // image + video columns both render "google_flow", so use getAllByText
    expect(within(flow).getAllByText(/google_flow/).length).toBeGreaterThanOrEqual(2);
    expect(within(flow).getByText(/^5$/)).toBeTruthy();
  });

  it("flags built-in vs custom rows", async () => {
    await renderTable([
      row({ id: "comfyui", isBuiltin: 1, label: "Builtin row" }),
      row({ id: "custom-1", isBuiltin: 0, label: "Custom row" }),
    ]);
    expect(within(rowFor("comfyui")).getByText(/built-in/i)).toBeTruthy();
    // The Custom badge shares text with the row label; just check the row
    // does NOT show "Built-in" — the Custom badge is enough as the negative.
    expect(within(rowFor("custom-1")).queryByText(/built-in/i)).toBeNull();
  });
});

describe("WorkflowsTable action buttons", () => {
  it("Edit link points at /workflows/[id]/edit", async () => {
    await renderTable([row({ id: "abc-123", label: "Edit me" })]);
    const link = within(rowFor("abc-123")).getByRole("link", {
      name: /edit/i,
    });
    expect(link.getAttribute("href")).toBe("/workflows/abc-123/edit");
  });

  it("built-in rows show Reset and hide Delete", async () => {
    await renderTable([
      row({ id: "comfyui", isBuiltin: 1, label: "Builtin row" }),
    ]);
    const r = rowFor("comfyui");
    expect(within(r).getByRole("button", { name: /reset/i })).toBeTruthy();
    expect(
      within(r).queryByRole("button", { name: /^delete$/i })
    ).toBeNull();
  });

  it("custom rows show Delete and hide Reset", async () => {
    await renderTable([
      row({ id: "custom-1", isBuiltin: 0, label: "Custom row" }),
    ]);
    const r = rowFor("custom-1");
    expect(within(r).getByRole("button", { name: /^delete$/i })).toBeTruthy();
    expect(within(r).queryByRole("button", { name: /reset/i })).toBeNull();
  });

  it("Export link points at /api/workflows/[id]/export with download attribute", async () => {
    await renderTable([row({ id: "comfyui", label: "Exportable" })]);
    const link = within(rowFor("comfyui")).getByRole("link", {
      name: /export/i,
    });
    expect(link.getAttribute("href")).toBe("/api/workflows/comfyui/export");
    expect(link.hasAttribute("download")).toBe(true);
  });
});

describe("WorkflowsTable toggle enabled", () => {
  function mockFetchOnce(payload: unknown, status = 200): void {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status })
    );
  }

  it("clicking the enabled toggle PATCHes with expected_version + flipped enabled", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({
      workflow: { ...row({ id: "comfyui", version: 2, enabled: 0 }) },
    });

    await renderTable([row({ id: "comfyui", version: 1, enabled: 1, label: "Toggle me" })]);
    const r = rowFor("comfyui");
    const toggle = within(r).getByRole("button", { name: /disable|enable/i });
    await act(async () => {
      fireEvent.click(toggle);
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/workflows/comfyui");
    expect(calls[0][1].method).toBe("PATCH");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({ enabled: false, expected_version: 1 });
  });

  it("on 409 version_conflict, shows refresh-prompt toast and calls router.refresh", async () => {
    mockFetchOnce(
      { error: "version_conflict", current_version: 5 },
      409
    );

    await renderTable([row({ id: "comfyui", version: 1, label: "Stale row" })]);
    const r = rowFor("comfyui");
    await act(async () => {
      fireEvent.click(within(r).getByRole("button", { name: /disable|enable/i }));
    });

    expect(toastErrorMock).toHaveBeenCalled();
    const msg = String(toastErrorMock.mock.calls[0][0]);
    expect(msg).toMatch(/modified elsewhere/i);
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("WorkflowsTable clone dialog", () => {
  function mockFetchOnce(payload: unknown, status = 201): void {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status })
    );
  }

  it("clicking Clone opens a dialog with a slug input", async () => {
    await renderTable([row({ id: "comfyui", label: "Clone source" })]);
    const r = rowFor("comfyui");
    fireEvent.click(within(r).getByRole("button", { name: /clone/i }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByLabelText(/new id/i)).toBeTruthy();
  });

  it("submitting the clone dialog POSTs /api/workflows/[id]/clone with new_id", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({ workflow: row({ id: "comfyui-copy" }) });

    await renderTable([row({ id: "comfyui", label: "Clone source" })]);
    const r = rowFor("comfyui");
    fireEvent.click(within(r).getByRole("button", { name: /clone/i }));

    fireEvent.change(screen.getByLabelText(/new id/i), {
      target: { value: "comfyui-copy" },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^clone$/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/workflows/comfyui/clone");
    expect(calls[0][1].method).toBe("POST");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body.new_id).toBe("comfyui-copy");
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("WorkflowsTable delete confirm", () => {
  function mockFetchOnce(payload: unknown, status = 200): void {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status })
    );
  }

  it("clicking Delete opens a confirm dialog with the workflow id", async () => {
    await renderTable([row({ id: "custom-1", isBuiltin: 0, label: "Custom row" })]);
    fireEvent.click(
      within(rowFor("custom-1")).getByRole("button", { name: /^delete$/i })
    );
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByText(/custom-1/)).toBeTruthy();
  });

  it("on confirm, DELETE /api/workflows/[id] and refresh on 200", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({ deleted: true });

    await renderTable([row({ id: "custom-1", isBuiltin: 0, label: "Custom row" })]);
    fireEvent.click(
      within(rowFor("custom-1")).getByRole("button", { name: /^delete$/i })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/workflows/custom-1");
    expect(calls[0][1].method).toBe("DELETE");
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });

  it("on 409 workflow_in_use, shows toast with video count and closes dialog", async () => {
    mockFetchOnce({ error: "workflow_in_use", videos_count: 3 }, 409);

    await renderTable([row({ id: "custom-1", isBuiltin: 0, label: "In use" })]);
    fireEvent.click(
      within(rowFor("custom-1")).getByRole("button", { name: /^delete$/i })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    expect(toastErrorMock).toHaveBeenCalled();
    const msg = String(toastErrorMock.mock.calls[0][0]);
    expect(msg).toMatch(/3 videos?/i);
    // Dialog closes
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("removes the row from the DOM after a successful delete + parent re-render with new initialRows", async () => {
    // Regression test: after router.refresh() re-runs the parent server
    // component, new initialRows arrive as a prop. The component must
    // sync local state to the new prop — otherwise the deleted row stays
    // in the rendered table until a hard reload.
    mockFetchOnce({ deleted: true });
    const { WorkflowsTable } = await import("@/app/workflows/workflows-table");
    const initial = [row({ id: "custom-1", isBuiltin: 0, label: "Doomed row" })];
    let view: RenderResult;
    await act(async () => {
      view = render(<WorkflowsTable rows={initial} />);
    });
    expect(rowFor("custom-1")).toBeTruthy();

    fireEvent.click(
      within(rowFor("custom-1")).getByRole("button", { name: /^delete$/i })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });
    expect(refreshMock).toHaveBeenCalled();

    // Simulate the parent server-component re-render that router.refresh()
    // would trigger — fresh, deleted-row-free rows arrive as a new prop.
    await act(async () => {
      view!.rerender(<WorkflowsTable rows={[]} />);
    });
    expect(screen.queryByText(/doomed row/i)).toBeNull();
  });
});

describe("WorkflowsTable reset confirm", () => {
  function mockFetchOnce(payload: unknown, status = 200): void {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status })
    );
  }

  it("clicking Reset opens a confirm dialog mentioning customizations being lost", async () => {
    await renderTable([row({ id: "comfyui", isBuiltin: 1, label: "Builtin row" })]);
    fireEvent.click(
      within(rowFor("comfyui")).getByRole("button", { name: /reset/i })
    );
    expect(screen.getByText(/customization/i)).toBeTruthy();
  });

  it("on confirm, POSTs /api/workflows/[id]/reset and refreshes on success", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({ workflow: row({ id: "comfyui", version: 5 }) });

    await renderTable([row({ id: "comfyui", isBuiltin: 1, label: "Builtin row" })]);
    fireEvent.click(
      within(rowFor("comfyui")).getByRole("button", { name: /reset/i })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^reset$/i }));
    });

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/workflows/comfyui/reset");
    expect(calls[0][1].method).toBe("POST");
    expect(toastSuccessMock).toHaveBeenCalled();
    expect(refreshMock).toHaveBeenCalled();
  });
});

describe("WorkflowsTable import", () => {
  function mockFetchOnce(payload: unknown, status = 201): void {
    (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      new Response(JSON.stringify(payload), { status })
    );
  }

  function fileWith(content: string): File {
    const file = new File([content], "workflow.json", {
      type: "application/json",
    });
    // jsdom's Blob.text() can be unreliable — patch to return the literal
    // string so the import handler reads back what the test passed in.
    Object.defineProperty(file, "text", {
      value: async () => content,
    });
    return file;
  }

  it("renders an Import workflow header button", async () => {
    await renderTable([]);
    expect(
      screen.getByRole("button", { name: /import workflow/i })
    ).toBeTruthy();
  });

  it("on file pick, POSTs the parsed JSON to /api/workflows/import and toasts on success", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    mockFetchOnce({ workflow: row({ id: "imported-1" }) });

    await renderTable([]);
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const json = JSON.stringify({ id: "imported-1", label: "Hi" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [fileWith(json)] } });
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/workflows/import");
    expect(calls[0][1].method).toBe("POST");
    const body = JSON.parse(calls[0][1].body as string);
    expect(body).toEqual({ id: "imported-1", label: "Hi" });
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();
  });

  it("on 409 workflow_id_exists, opens overwrite confirm; confirming retries with ?overwrite=1", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    // First call: 409
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "workflow_id_exists",
          current_version: 2,
        }),
        { status: 409 }
      )
    );
    // Second call: 200 overwrote
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ workflow: row({ id: "comfyui" }) }), {
        status: 200,
      })
    );

    await renderTable([]);
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const json = JSON.stringify({ id: "comfyui", label: "X" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [fileWith(json)] } });
    });

    // Overwrite confirm dialog appears asynchronously after file.text()/fetch
    const confirm = await screen.findByRole("button", { name: /overwrite/i });
    await act(async () => {
      fireEvent.click(confirm);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(calls[0][0]).toBe("/api/workflows/import");
    expect(calls[1][0]).toBe("/api/workflows/import?overwrite=1");
    expect(calls[1][1].method).toBe("POST");
    await waitFor(() => expect(toastSuccessMock).toHaveBeenCalled());
    expect(refreshMock).toHaveBeenCalled();
  });

  it("on invalid JSON, shows an error toast and does not POST", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    await renderTable([]);
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    await act(async () => {
      fireEvent.change(input, {
        target: { files: [fileWith("not-json")] },
      });
    });
    expect(toastErrorMock).toHaveBeenCalled();
    expect(String(toastErrorMock.mock.calls[0][0])).toMatch(/invalid json/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("on 400 invalid_input, shows a Zod issue message in the toast", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "invalid_input",
          issues: [{ path: ["label"], message: "label is required" }],
        }),
        { status: 400 }
      )
    );

    await renderTable([]);
    const input = document.querySelector(
      'input[type="file"]'
    ) as HTMLInputElement;
    const json = JSON.stringify({ id: "x" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [fileWith(json)] } });
    });
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());

    expect(String(toastErrorMock.mock.calls[0][0])).toMatch(/label is required/);
    void fetchMock;
  });
});
