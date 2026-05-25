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
} from "@testing-library/react";
import type { VisualStyle } from "@/types";

import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

/**
 * Build a route table over fetch. Keys: "GET /api/visual-styles" etc.
 * Each handler receives the parsed request body (or undefined for GET)
 * and returns a JSON-serialisable response body. Status defaults to 200
 * for non-DELETE methods, 204 for DELETE.
 */
type Handler = (
  body: unknown,
  url: string
) => { status?: number; json?: unknown };

function makeFetchMock(routes: Record<string, Handler>) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    // Try exact key first, then a prefix-match on the path part (so
    // "/api/visual-styles/abc" can be matched by "PATCH /api/visual-styles/:id").
    const exact = routes[`${method} ${url}`];
    let handler: Handler | undefined = exact;
    if (!handler) {
      for (const key of Object.keys(routes)) {
        const [m, pattern] = key.split(" ");
        if (m !== method) continue;
        if (pattern.endsWith("/:id")) {
          const prefix = pattern.slice(0, -"/:id".length) + "/";
          if (url.startsWith(prefix) && url.length > prefix.length) {
            handler = routes[key];
            break;
          }
        }
      }
    }
    if (!handler) {
      throw new Error(`unrouted ${method} ${url}`);
    }
    const body = init?.body
      ? JSON.parse(String(init.body))
      : undefined;
    const result = handler(body, url);
    const status = result.status ?? (method === "DELETE" ? 204 : 200);
    if (status === 204 || result.json === undefined) {
      return new Response(null, { status });
    }
    return new Response(JSON.stringify(result.json), { status });
  });
}

function makeStyle(overrides: Partial<VisualStyle> = {}): VisualStyle {
  return {
    id: "01HXSTYLE000000000000ABC",
    title: "Cinematic Noir",
    prompt: "moody, low-key lighting, grain",
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  installRadixJsdomPolyfills();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function renderGallery(
  routes: Record<string, Handler>,
  props: {
    onDirtyChange?: ReturnType<typeof vi.fn>;
    registerConfirmDiscard?: ReturnType<typeof vi.fn>;
  } = {}
): Promise<void> {
  vi.stubGlobal("fetch", makeFetchMock(routes));
  const { VisualStyleGallery } = await import(
    "@/app/settings/visual-style-gallery"
  );
  await act(async () => {
    render(
      <VisualStyleGallery
        onDirtyChange={props.onDirtyChange}
        registerConfirmDiscard={props.registerConfirmDiscard}
      />
    );
  });
}

describe("VisualStyleGallery — initial load", () => {
  it("renders the empty-state placeholder when the gallery is empty", async () => {
    await renderGallery({
      "GET /api/visual-styles": () => ({ json: { visual_styles: [] } }),
    });
    expect(
      await screen.findByText(/no styles yet/i)
    ).toBeTruthy();
    // Right pane shows its placeholder until something is selected.
    expect(
      screen.getByText(/select a style on the left/i)
    ).toBeTruthy();
  });

  it("renders existing styles alphabetically (NOCASE) in the left rail", async () => {
    await renderGallery({
      "GET /api/visual-styles": () => ({
        json: {
          visual_styles: [
            makeStyle({ id: "a", title: "zen garden" }),
            makeStyle({ id: "b", title: "Aqua Punk" }),
            makeStyle({ id: "c", title: "Moody" }),
          ],
        },
      }),
    });

    const options = await screen.findAllByRole("option");
    const titles = options.map((o) => o.textContent?.trim());
    expect(titles).toEqual(["Aqua Punk", "Moody", "zen garden"]);
  });

  it("auto-selects the first style and populates the right pane", async () => {
    await renderGallery({
      "GET /api/visual-styles": () => ({
        json: {
          visual_styles: [
            makeStyle({ id: "a", title: "Alpha", prompt: "alpha prompt" }),
            makeStyle({ id: "b", title: "Beta" }),
          ],
        },
      }),
    });

    const titleInput = (await screen.findByLabelText(
      /\[visual_style_title\]/
    )) as HTMLInputElement;
    expect(titleInput.value).toBe("Alpha");
    const promptInput = screen.getByLabelText(
      /\[visual_style_prompt\]/
    ) as HTMLTextAreaElement;
    expect(promptInput.value).toBe("alpha prompt");
  });
});

describe("VisualStyleGallery — selection & dirty state", () => {
  it("clicking a different row swaps the right-pane content", async () => {
    await renderGallery({
      "GET /api/visual-styles": () => ({
        json: {
          visual_styles: [
            makeStyle({ id: "a", title: "Alpha", prompt: "p1" }),
            makeStyle({ id: "b", title: "Bravo", prompt: "p2" }),
          ],
        },
      }),
    });

    await screen.findByDisplayValue("Alpha");
    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));

    const titleInput = screen.getByLabelText(
      /\[visual_style_title\]/
    ) as HTMLInputElement;
    expect(titleInput.value).toBe("Bravo");
    expect(
      (screen.getByLabelText(/\[visual_style_prompt\]/) as HTMLTextAreaElement)
        .value
    ).toBe("p2");
  });

  it("reports isDirty=true via onDirtyChange once the form differs from the loaded row", async () => {
    const onDirtyChange = vi.fn();
    await renderGallery(
      {
        "GET /api/visual-styles": () => ({
          json: { visual_styles: [makeStyle({ id: "a", title: "Alpha" })] },
        }),
      },
      { onDirtyChange }
    );

    await screen.findByDisplayValue("Alpha");
    onDirtyChange.mockClear();

    fireEvent.change(screen.getByLabelText(/\[visual_style_title\]/), {
      target: { value: "Alpha edited" },
    });

    expect(onDirtyChange).toHaveBeenCalledWith(true);
  });

  it("registers a confirm-discard callback that returns true when not dirty", async () => {
    const registerConfirmDiscard = vi.fn();
    await renderGallery(
      {
        "GET /api/visual-styles": () => ({
          json: { visual_styles: [makeStyle({ id: "a", title: "Alpha" })] },
        }),
      },
      { registerConfirmDiscard }
    );
    await screen.findByDisplayValue("Alpha");

    const fn = registerConfirmDiscard.mock.calls.find(
      (c) => typeof c[0] === "function"
    )?.[0] as () => boolean;
    expect(fn).toBeTruthy();
    expect(fn()).toBe(true);
  });

  it("confirm-discard callback returns false when dirty and user cancels", async () => {
    const registerConfirmDiscard = vi.fn();
    await renderGallery(
      {
        "GET /api/visual-styles": () => ({
          json: { visual_styles: [makeStyle({ id: "a", title: "Alpha" })] },
        }),
      },
      { registerConfirmDiscard }
    );
    await screen.findByDisplayValue("Alpha");

    fireEvent.change(screen.getByLabelText(/\[visual_style_title\]/), {
      target: { value: "Alpha edited" },
    });

    vi.stubGlobal("confirm", vi.fn(() => false));
    const fn = registerConfirmDiscard.mock.calls.find(
      (c) => typeof c[0] === "function"
    )?.[0] as () => boolean;
    expect(fn()).toBe(false);
  });

  it("row-switch on a dirty pane prompts window.confirm and stays put on cancel", async () => {
    vi.stubGlobal("confirm", vi.fn(() => false));
    await renderGallery({
      "GET /api/visual-styles": () => ({
        json: {
          visual_styles: [
            makeStyle({ id: "a", title: "Alpha" }),
            makeStyle({ id: "b", title: "Bravo" }),
          ],
        },
      }),
    });
    await screen.findByDisplayValue("Alpha");
    fireEvent.change(screen.getByLabelText(/\[visual_style_title\]/), {
      target: { value: "Alpha edited" },
    });

    fireEvent.click(screen.getByRole("option", { name: "Bravo" }));

    expect(globalThis.confirm as unknown as ReturnType<typeof vi.fn>)
      .toHaveBeenCalled();
    expect(
      (screen.getByLabelText(
        /\[visual_style_title\]/
      ) as HTMLInputElement).value
    ).toBe("Alpha edited");
  });
});

describe("VisualStyleGallery — create flow", () => {
  it('"Add new" opens an empty pane with title/prompt cleared', async () => {
    await renderGallery({
      "GET /api/visual-styles": () => ({
        json: {
          visual_styles: [makeStyle({ id: "a", title: "Alpha", prompt: "p" })],
        },
      }),
    });
    await screen.findByDisplayValue("Alpha");

    fireEvent.click(screen.getByRole("button", { name: /add new/i }));

    const titleInput = screen.getByLabelText(
      /\[visual_style_title\]/
    ) as HTMLInputElement;
    expect(titleInput.value).toBe("");
    expect(
      (screen.getByLabelText(
        /\[visual_style_prompt\]/
      ) as HTMLTextAreaElement).value
    ).toBe("");
    // No Delete button while drafting a new style.
    expect(
      screen.queryByRole("button", { name: /delete/i })
    ).toBeNull();
  });

  it("POSTs the new style, re-fetches the list, and auto-selects the new row", async () => {
    let listCalls = 0;
    const created = makeStyle({ id: "new1", title: "Brand new" });
    await renderGallery({
      "GET /api/visual-styles": () => {
        listCalls += 1;
        return {
          json: {
            visual_styles:
              listCalls === 1
                ? [makeStyle({ id: "a", title: "Alpha" })]
                : [makeStyle({ id: "a", title: "Alpha" }), created],
          },
        };
      },
      "POST /api/visual-styles": (body) => {
        expect(body).toEqual({ title: "Brand new", prompt: "fresh" });
        return { status: 201, json: { visual_style: created } };
      },
    });
    await screen.findByDisplayValue("Alpha");

    fireEvent.click(screen.getByRole("button", { name: /add new/i }));
    fireEvent.change(screen.getByLabelText(/\[visual_style_title\]/), {
      target: { value: "Brand new" },
    });
    fireEvent.change(screen.getByLabelText(/\[visual_style_prompt\]/), {
      target: { value: "fresh" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    await waitFor(() => {
      expect(
        screen.getByRole("option", { name: "Brand new" }).getAttribute(
          "aria-selected"
        )
      ).toBe("true");
    });
    // Delete is now available — the new row exists server-side.
    expect(screen.getByRole("button", { name: /delete/i })).toBeTruthy();
  });
});

describe("VisualStyleGallery — edit flow", () => {
  it("PATCHes the edited style and refreshes the form snapshot (no longer dirty)", async () => {
    let listCalls = 0;
    const onDirtyChange = vi.fn();
    await renderGallery(
      {
        "GET /api/visual-styles": () => {
          listCalls += 1;
          return {
            json: {
              visual_styles: [
                makeStyle({
                  id: "a",
                  title: listCalls === 1 ? "Alpha" : "Alpha edited",
                  prompt: listCalls === 1 ? "p1" : "p1",
                }),
              ],
            },
          };
        },
        "PATCH /api/visual-styles/:id": (body, url) => {
          expect(url).toMatch(/\/api\/visual-styles\/a$/);
          expect(body).toEqual({ title: "Alpha edited", prompt: "p1" });
          return {
            json: {
              visual_style: makeStyle({
                id: "a",
                title: "Alpha edited",
                prompt: "p1",
              }),
            },
          };
        },
      },
      { onDirtyChange }
    );
    await screen.findByDisplayValue("Alpha");

    fireEvent.change(screen.getByLabelText(/\[visual_style_title\]/), {
      target: { value: "Alpha edited" },
    });
    onDirtyChange.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^save$/i }));
    });

    await waitFor(() => {
      // After save, the freshly-loaded row becomes the new snapshot —
      // dirty flips back to false.
      const calls = onDirtyChange.mock.calls.map((c) => c[0]);
      expect(calls).toContain(false);
    });
    expect(
      (screen.getByLabelText(
        /\[visual_style_title\]/
      ) as HTMLInputElement).value
    ).toBe("Alpha edited");
  });
});

describe("VisualStyleGallery — delete flow", () => {
  it("shows ConfirmDialog, DELETEs on confirm, and falls back to the next row", async () => {
    let listCalls = 0;
    let deletedId: string | null = null;
    await renderGallery({
      "GET /api/visual-styles": () => {
        listCalls += 1;
        const fullList = [
          makeStyle({ id: "a", title: "Alpha" }),
          makeStyle({ id: "b", title: "Bravo" }),
        ];
        return {
          json: {
            visual_styles:
              listCalls === 1
                ? fullList
                : fullList.filter((s) => s.id !== deletedId),
          },
        };
      },
      "DELETE /api/visual-styles/:id": (_body, url) => {
        const match = url.match(/\/api\/visual-styles\/([^/]+)$/);
        deletedId = match?.[1] ?? null;
        return { status: 204 };
      },
    });

    await screen.findByDisplayValue("Alpha");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    // ConfirmDialog renders title text — assert it appears before confirming.
    expect(
      await screen.findByText(/delete visual style\?/i)
    ).toBeTruthy();

    await act(async () => {
      // The dialog renders a second "Delete" button as confirmLabel —
      // grab the one inside the alertdialog role.
      const dialog = screen.getByRole("alertdialog");
      const confirmBtn = within(dialog).getByRole("button", {
        name: /^delete$/i,
      });
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(deletedId).toBe("a");
    });
    // Bravo is the only remaining row; it should auto-select.
    await waitFor(() => {
      expect(
        screen
          .getByRole("option", { name: "Bravo" })
          .getAttribute("aria-selected")
      ).toBe("true");
    });
  });

  it("deleting the last entry clears the right pane to the empty state", async () => {
    let listCalls = 0;
    await renderGallery({
      "GET /api/visual-styles": () => {
        listCalls += 1;
        return {
          json: {
            visual_styles:
              listCalls === 1 ? [makeStyle({ id: "a", title: "Alpha" })] : [],
          },
        };
      },
      "DELETE /api/visual-styles/:id": () => ({ status: 204 }),
    });
    await screen.findByDisplayValue("Alpha");

    fireEvent.click(screen.getByRole("button", { name: /delete/i }));
    await act(async () => {
      const dialog = screen.getByRole("alertdialog");
      const confirmBtn = within(dialog).getByRole("button", {
        name: /^delete$/i,
      });
      fireEvent.click(confirmBtn);
    });

    await waitFor(() => {
      expect(
        screen.getByText(/select a style on the left/i)
      ).toBeTruthy();
    });
  });
});
