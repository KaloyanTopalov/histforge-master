import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { VideoStatus } from "@/types";

import { installRadixJsdomPolyfills } from "../../../helpers/radix-jsdom";

const routerRefreshMock = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: routerRefreshMock }),
}));

const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastErrorMock(...args),
    success: (...args: unknown[]) => toastSuccessMock(...args),
  },
}));

// IMPORTANT: import the warning-text constant from the component itself.
// This is the irreversibility-warning pin — tests assert against the
// imported constant, never a literal string copy. A future wording
// change requires touching `cleanup-section.tsx`, which surfaces in code
// review.
import {
  CleanupSection,
  CLEANUP_CONFIRM_TEXT,
} from "@/app/videos/[id]/cleanup-section";

beforeEach(() => {
  installRadixJsdomPolyfills();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, already_clean: false }),
    })) as unknown as typeof fetch
  );
  routerRefreshMock.mockClear();
  toastErrorMock.mockClear();
  toastSuccessMock.mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

interface RenderOpts {
  videoId?: string;
  status?: VideoStatus;
  intermediatesPresent?: boolean;
}

function renderSection(opts: RenderOpts = {}): RenderOpts {
  const props = {
    videoId: opts.videoId ?? "v1",
    status: opts.status ?? ("done" as VideoStatus),
    intermediatesPresent: opts.intermediatesPresent ?? true,
  };
  render(<CleanupSection {...props} />);
  return props;
}

describe("CleanupSection", () => {
  it.each([
    "queued" as VideoStatus,
    "in_progress" as VideoStatus,
    "failed" as VideoStatus,
  ])("renders nothing when video.status === %s (not 'done')", (status) => {
    const { container } = render(
      <CleanupSection videoId="v1" status={status} intermediatesPresent={true} />
    );
    // Component should return null on non-done statuses, mirroring the
    // route's three 409 not_done cases — single source of truth via
    // isCleanupable.
    expect(container.firstChild).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a DISABLED button when status='done' AND intermediatesPresent=false", () => {
    renderSection({ status: "done", intermediatesPresent: false });
    const btn = screen.getByRole("button", { name: /cleanup intermediates/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    // No dialog initially.
    expect(screen.queryByText(CLEANUP_CONFIRM_TEXT)).toBeNull();
    // Click attempt is a no-op (disabled buttons don't fire onClick).
    fireEvent.click(btn);
    expect(screen.queryByText(CLEANUP_CONFIRM_TEXT)).toBeNull();
  });

  it("renders an ENABLED button when status='done' AND intermediatesPresent=true; clicking opens dialog containing CLEANUP_CONFIRM_TEXT", () => {
    renderSection({ status: "done", intermediatesPresent: true });
    const btn = screen.getByRole("button", { name: /cleanup intermediates/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
    // Dialog not visible until click.
    expect(screen.queryByText(CLEANUP_CONFIRM_TEXT)).toBeNull();
    fireEvent.click(btn);
    // Dialog body is the imported constant verbatim — pins the
    // irreversibility warning text.
    expect(screen.getByText(CLEANUP_CONFIRM_TEXT)).toBeTruthy();
  });

  it("confirm in dialog POSTs /api/videos/<id>/cleanup", async () => {
    renderSection({ videoId: "abc123", status: "done", intermediatesPresent: true });
    fireEvent.click(
      screen.getByRole("button", { name: /cleanup intermediates/i })
    );
    // Dialog open. Confirm button — name must NOT match the opener
    // ("cleanup intermediates"); the dialog's confirm label is the
    // shorter "Cleanup" so it's distinguishable in screen queries.
    const confirmBtn = screen.getByRole("button", { name: /^cleanup$/i });
    fireEvent.click(confirmBtn);
    // Await the in-flight fetch microtask so the spy records the call.
    await Promise.resolve();
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/videos/abc123/cleanup");
    expect(init.method).toBe("POST");
  });

  it("cancel in dialog does NOT POST and closes the dialog", () => {
    renderSection({ status: "done", intermediatesPresent: true });
    fireEvent.click(
      screen.getByRole("button", { name: /cleanup intermediates/i })
    );
    expect(screen.getByText(CLEANUP_CONFIRM_TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    // No fetch fired.
    const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock).not.toHaveBeenCalled();
    // Dialog closed.
    expect(screen.queryByText(CLEANUP_CONFIRM_TEXT)).toBeNull();
  });
});
