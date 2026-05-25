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
import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";

// next/navigation is an npm package — legitimate boundary mock so the
// client component's router hook doesn't crash under jsdom.
const routerMocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  replace: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => routerMocks,
}));

interface AccountListItem {
  id: string;
  name: string;
  token_display: string;
  paused_until: number | null;
  last_seen_at: number | null;
  credits: number | null;
  credits_updated_at: number | null;
  enabled: 0 | 1;
  recovery_reason: string | null;
  recovery_required_at: number | null;
  created_at: number;
}

function acc(overrides: Partial<AccountListItem> = {}): AccountListItem {
  return {
    id: "acc_01",
    name: "Primary",
    token_display: "…Ab12",
    paused_until: null,
    last_seen_at: null,
    credits: null,
    credits_updated_at: null,
    enabled: 1,
    recovery_reason: null,
    recovery_required_at: null,
    created_at: 1_700_000_000,
    ...overrides,
  };
}

function accountsResponse(accounts: AccountListItem[]): Response {
  return new Response(JSON.stringify({ accounts }), { status: 200 });
}

async function renderComponent(): Promise<void> {
  const { GoogleFlowAccounts } = await import(
    "@/app/settings/google-flow-accounts"
  );
  await act(async () => {
    render(<GoogleFlowAccounts />);
  });
}

beforeEach(() => {
  installRadixJsdomPolyfills();
  routerMocks.refresh.mockReset();
  routerMocks.replace.mockReset();
  routerMocks.push.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => accountsResponse([])) as unknown as typeof fetch
  );
  const writeText = vi.fn(async () => {});
  Object.defineProperty(globalThis.navigator, "clipboard", {
    value: { writeText },
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fetchMock(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
}

describe("GoogleFlowAccounts — listing", () => {
  it("fetches /api/flow/accounts on mount and shows an empty-state message when no accounts exist", async () => {
    await renderComponent();

    expect(fetchMock()).toHaveBeenCalledWith("/api/flow/accounts");
    expect(
      screen.getByText(/no accounts|add your first account/i)
    ).toBeTruthy();
  });

  it("renders one row per account with the account name and last-4 token display", async () => {
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({ id: "acc_01", name: "Primary", token_display: "…Ab12" }),
        acc({ id: "acc_02", name: "Secondary", token_display: "…Cd34" }),
      ])
    );

    await renderComponent();

    await waitFor(() =>
      expect(screen.getByText("Primary")).toBeTruthy()
    );
    expect(screen.getByText("Secondary")).toBeTruthy();
    expect(screen.getByText("…Ab12")).toBeTruthy();
    expect(screen.getByText("…Cd34")).toBeTruthy();
  });
});

describe("GoogleFlowAccounts — add account", () => {
  it("posts the name and opens a token-reveal modal with the minted token", async () => {
    // First call: initial list (empty). Second call: POST result.
    const mintedResponse = new Response(
      JSON.stringify({
        id: "acc_03",
        name: "Third",
        token: "the-real-token-only-shown-once",
        pollUrl: "http://localhost/api/flow/next-task/the-real-token-only-shown-once",
        resultUrl:
          "http://localhost/api/flow/submit-result/the-real-token-only-shown-once",
        statusUrl:
          "http://localhost/api/flow/status/the-real-token-only-shown-once",
        projectUrl:
          "http://localhost/api/flow/project/the-real-token-only-shown-once",
      }),
      { status: 201 }
    );
    fetchMock()
      .mockResolvedValueOnce(accountsResponse([]))
      .mockResolvedValueOnce(mintedResponse)
      .mockResolvedValueOnce(accountsResponse([acc({ id: "acc_03", name: "Third" })]));

    await renderComponent();

    const nameInput = screen.getByLabelText(/account name/i);
    fireEvent.change(nameInput, { target: { value: "Third" } });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add account/i }));
    });

    const [, postCall] = fetchMock().mock.calls[1] as [string, RequestInit];
    expect(fetchMock().mock.calls[1][0]).toBe("/api/flow/accounts");
    expect(postCall.method).toBe("POST");
    expect(JSON.parse(postCall.body as string)).toEqual({ name: "Third" });

    const modal = await screen.findByRole("dialog");
    expect(
      within(modal).getByText("the-real-token-only-shown-once")
    ).toBeTruthy();
    expect(
      within(modal).getByRole("button", { name: /copy token/i })
    ).toBeTruthy();
  });

  it("Copy token writes the minted token to the clipboard", async () => {
    const minted = new Response(
      JSON.stringify({
        id: "acc_03",
        name: "Third",
        token: "tok-XYZ",
        pollUrl: "http://h/api/flow/next-task/tok-XYZ",
        resultUrl: "http://h/api/flow/submit-result/tok-XYZ",
        statusUrl: "http://h/api/flow/status/tok-XYZ",
        projectUrl: "http://h/api/flow/project/tok-XYZ",
      }),
      { status: 201 }
    );
    fetchMock()
      .mockResolvedValueOnce(accountsResponse([]))
      .mockResolvedValueOnce(minted)
      .mockResolvedValueOnce(accountsResponse([]));

    await renderComponent();
    fireEvent.change(screen.getByLabelText(/account name/i), {
      target: { value: "Third" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /add account/i }));
    });

    const modal = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(
        within(modal).getByRole("button", { name: /copy token/i })
      );
    });

    const writeText = navigator.clipboard
      .writeText as unknown as ReturnType<typeof vi.fn>;
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe("tok-XYZ");
  });
});

describe("GoogleFlowAccounts — per-row actions", () => {
  it("displays a paused account with the 'paused, Xh Ym left' format and calls router.refresh after resume", async () => {
    const oneHourAhead = Math.floor(Date.now() / 1000) + 3610;
    fetchMock()
      .mockResolvedValueOnce(
        accountsResponse([
          acc({ id: "acc_01", name: "Primary", paused_until: oneHourAhead }),
        ])
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(accountsResponse([acc({ id: "acc_01" })]));

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    expect(screen.getByText(/paused\s+1h\s+left/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });

    // router.refresh() must fire on patch success so server-rendered
    // pieces (e.g. the relogin banner) pick up side effects.
    await waitFor(() =>
      expect(routerMocks.refresh).toHaveBeenCalled()
    );
  });

  it("Pause 4h PATCHes paused_until_iso ~4 hours in the future", async () => {
    fetchMock()
      .mockResolvedValueOnce(accountsResponse([acc({ id: "acc_01" })]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(
        accountsResponse([
          acc({ id: "acc_01", paused_until: Date.now() / 1000 + 4 * 3600 }),
        ])
      );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /pause 4h/i }));
    });

    const patchCall = fetchMock().mock.calls[1] as [string, RequestInit];
    expect(patchCall[0]).toBe("/api/flow/accounts/acc_01");
    expect(patchCall[1].method).toBe("PATCH");
    const body = JSON.parse(patchCall[1].body as string) as {
      paused_until_iso: string;
    };
    const targetMs = Date.parse(body.paused_until_iso);
    const fourHoursFromNow = Date.now() + 4 * 3600 * 1000;
    expect(Math.abs(targetMs - fourHoursFromNow)).toBeLessThan(60_000);
  });

  it("clicking the name cell enters edit mode and Enter PATCHes the new name", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        accountsResponse([acc({ id: "acc_01", name: "Primary" })])
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(
        accountsResponse([acc({ id: "acc_01", name: "Renamed" })])
      );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    // Click the name cell to enter edit mode.
    fireEvent.click(screen.getByText("Primary"));
    const input = screen.getByLabelText(/edit name acc_01/i) as HTMLInputElement;
    expect(input).toBeTruthy();

    fireEvent.change(input, { target: { value: "Renamed" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    });

    const patchCall = fetchMock().mock.calls[1] as [string, RequestInit];
    expect(patchCall[0]).toBe("/api/flow/accounts/acc_01");
    expect(patchCall[1].method).toBe("PATCH");
    expect(JSON.parse(patchCall[1].body as string)).toEqual({
      name: "Renamed",
    });
  });

  it("Escape cancels inline-edit without PATCHing", async () => {
    fetchMock().mockResolvedValueOnce(
      accountsResponse([acc({ id: "acc_01", name: "Primary" })])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());
    fireEvent.click(screen.getByText("Primary"));
    const input = screen.getByLabelText(/edit name acc_01/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Typo" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape", code: "Escape" });
    });

    // No PATCH fetched — first and only fetch was the initial list.
    expect(fetchMock().mock.calls).toHaveLength(1);
    // Name reverts to original.
    expect(screen.getByText("Primary")).toBeTruthy();
  });

  it("Resume PATCHes paused_until_iso: null", async () => {
    fetchMock()
      .mockResolvedValueOnce(
        accountsResponse([
          acc({ id: "acc_01", paused_until: Date.now() / 1000 + 3600 }),
        ])
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(accountsResponse([acc({ id: "acc_01" })]));

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^resume$/i }));
    });

    const patchCall = fetchMock().mock.calls[1] as [string, RequestInit];
    expect(patchCall[0]).toBe("/api/flow/accounts/acc_01");
    expect(patchCall[1].method).toBe("PATCH");
    expect(JSON.parse(patchCall[1].body as string)).toEqual({
      paused_until_iso: null,
    });
  });

  it("Delete opens an alert dialog and DELETEs on confirm", async () => {
    fetchMock()
      .mockResolvedValueOnce(accountsResponse([acc({ id: "acc_01" })]))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))
      .mockResolvedValueOnce(accountsResponse([]));

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    });

    const dialog = await screen.findByRole("alertdialog");
    await act(async () => {
      fireEvent.click(
        within(dialog).getByRole("button", { name: /confirm|delete/i })
      );
    });

    const deleteCall = fetchMock().mock.calls.find(
      ([, init]) => (init as RequestInit)?.method === "DELETE"
    ) as [string, RequestInit] | undefined;
    expect(deleteCall).toBeDefined();
    expect(deleteCall![0]).toBe("/api/flow/accounts/acc_01");
  });
});

describe("GoogleFlowAccounts — credits cell", () => {
  it("renders the credit count with a relative timestamp when credits are known", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          credits: 123,
          credits_updated_at: nowSec - 30, // 30 s ago — comfortably fresh
          last_seen_at: nowSec - 5,
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    expect(screen.getByText("123")).toBeTruthy();
    expect(screen.getByText(/\(\d+s ago\)/)).toBeTruthy();
  });

  it("renders 'polling stopped' when credits are null and last_seen_at is older than 10 min", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          credits: null,
          credits_updated_at: null,
          last_seen_at: nowSec - 11 * 60, // 11 min ago — stale
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    // Credits column shows the same polling-stopped fallback as the Paused
    // column (severity scheme covers both); scope the assertion to the
    // Credits cell so this test only checks the renderCreditsCell branch.
    const row = screen.getByText("Primary").closest("tr") as HTMLElement;
    const creditsCell = row.querySelectorAll("td")[2] as HTMLElement;
    expect(creditsCell.textContent).toMatch(/polling stopped/i);
    expect(creditsCell.textContent).toMatch(/last seen/i);
  });

  it("renders 'awaiting first poll' when credits are null but last_seen_at is fresh", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          credits: null,
          credits_updated_at: null,
          last_seen_at: nowSec - 30, // 30 s ago — well within the 10-min window
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    expect(screen.getByText(/awaiting first poll/i)).toBeTruthy();
    expect(screen.queryByText(/polling stopped/i)).toBeNull();
  });

  it("renders 'polling stopped · last seen never' when last_seen_at is null", async () => {
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          credits: null,
          credits_updated_at: null,
          last_seen_at: null,
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    // Scope to the Credits cell — see same-named branch above for why.
    const row = screen.getByText("Primary").closest("tr") as HTMLElement;
    const creditsCell = row.querySelectorAll("td")[2] as HTMLElement;
    expect(creditsCell.textContent).toMatch(/polling stopped.*never/i);
  });
});

describe("GoogleFlowAccounts — Paused column severity scheme", () => {
  it("recovery_needed: red-colored label + alert icon in the Paused cell", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          last_seen_at: nowSec - 5,
          recovery_reason: "captcha",
          recovery_required_at: nowSec - 47 * 60,
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    const label = screen.getByText(/reCAPTCHA recovery needed/i);
    // Climb to the cell to assert color + icon presence.
    const cell = label.closest("td") as HTMLElement;
    expect(cell.innerHTML).toMatch(/text-red-/);
    expect(cell.querySelectorAll("svg").length).toBeGreaterThan(0);
  });

  it("paused: amber-colored label in the Paused cell", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          last_seen_at: nowSec - 5,
          paused_until: nowSec + 3610,
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    const label = screen.getByText(/paused\s+1h\s+left/i);
    const cell = label.closest("td") as HTMLElement;
    expect(cell.innerHTML).toMatch(/text-amber-/);
  });

  it("online: renders an em-dash with no severity color in the Paused cell", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    fetchMock().mockResolvedValueOnce(
      accountsResponse([
        acc({
          id: "acc_01",
          name: "Primary",
          last_seen_at: nowSec - 5,
        }),
      ])
    );

    await renderComponent();
    await waitFor(() => expect(screen.getByText("Primary")).toBeTruthy());

    // Find the row, then locate the Paused cell (4th — Name, Token, Credits, Paused).
    const row = screen.getByText("Primary").closest("tr") as HTMLElement;
    const cells = row.querySelectorAll("td");
    const pausedCell = cells[3] as HTMLElement;
    expect(pausedCell.textContent).toBe("—");
    expect(pausedCell.innerHTML).not.toMatch(/text-amber-/);
    expect(pausedCell.innerHTML).not.toMatch(/text-red-/);
  });
});
