import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useEffect, useRef, useState } from "react";

import { installRadixJsdomPolyfills } from "../../helpers/radix-jsdom";
import { useOverwriteConfirm } from "@/app/workflows/use-import-with-overwrite";

beforeEach(() => {
  installRadixJsdomPolyfills();
});

afterEach(() => {
  cleanup();
});

interface HarnessApi {
  request: (slug: string) => Promise<boolean>;
  end: () => void;
}

/**
 * Test harness — drives the hook through its public surface so tests
 * exercise the dialog as the user sees it (rendered JSX) rather than
 * peeking at internal state.
 */
function Harness({
  onResult,
  onReady,
}: {
  onResult?: (proceed: boolean) => void;
  onReady?: (api: HarnessApi) => void;
}): JSX.Element {
  const { requestConfirm, endRequest, dialog } = useOverwriteConfirm();
  const [last, setLast] = useState<string>("(none)");
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  useEffect(() => {
    readyRef.current?.({
      request: async (slug: string) => {
        const r = await requestConfirm(slug);
        setLast(r ? "yes" : "no");
        onResult?.(r);
        return r;
      },
      end: endRequest,
    });
  }, [requestConfirm, endRequest, onResult]);

  return (
    <>
      <div data-testid="last-result">{last}</div>
      {dialog}
    </>
  );
}

describe("useOverwriteConfirm", () => {
  it("renders no dialog before requestConfirm is called", () => {
    render(<Harness />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("requestConfirm opens a dialog showing the slug", async () => {
    let api: HarnessApi | null = null;
    render(<Harness onReady={(a) => (api = a)} />);
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      void api!.request("my-workflow");
    });
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toMatch(/my-workflow/);
  });

  it("dialog uses destructive styling on the confirm action", async () => {
    let api: HarnessApi | null = null;
    render(<Harness onReady={(a) => (api = a)} />);
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      void api!.request("doomed");
    });
    const overwrite = await screen.findByRole("button", { name: /overwrite/i });
    // ConfirmDialog applies the destructive button variant via class names —
    // look for the destructive class as the observable signal.
    expect(overwrite.className).toMatch(/destructive/);
  });

  it("cancel resolves false and unmounts the dialog immediately", async () => {
    let api: HarnessApi | null = null;
    const onResult = vi.fn();
    render(<Harness onReady={(a) => (api = a)} onResult={onResult} />);
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      void api!.request("foo");
    });
    await screen.findByRole("alertdialog");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(false));
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("confirm resolves true and keeps the dialog mounted with busy state", async () => {
    let api: HarnessApi | null = null;
    const onResult = vi.fn();
    render(<Harness onReady={(a) => (api = a)} onResult={onResult} />);
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      void api!.request("bar");
    });
    const overwrite = await screen.findByRole("button", { name: /overwrite/i });
    await act(async () => {
      fireEvent.click(overwrite);
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledWith(true));
    // Dialog is still mounted — caller is responsible for the retry POST and
    // the user must see a spinner.
    expect(screen.queryByRole("alertdialog")).not.toBeNull();
    // Confirm button is now disabled (busy = true).
    const confirmBtn = screen.getByRole("button", { name: /overwrite/i });
    expect(confirmBtn.hasAttribute("disabled")).toBe(true);
  });

  it("endRequest unmounts the dialog after a confirmed request", async () => {
    let api: HarnessApi | null = null;
    render(<Harness onReady={(a) => (api = a)} />);
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      void api!.request("baz");
    });
    const overwrite = await screen.findByRole("button", { name: /overwrite/i });
    await act(async () => {
      fireEvent.click(overwrite);
    });
    expect(screen.queryByRole("alertdialog")).not.toBeNull();

    await act(async () => {
      api!.end();
    });
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("clicking confirm twice does not double-resolve (busy guard)", async () => {
    let api: HarnessApi | null = null;
    const onResult = vi.fn();
    render(<Harness onReady={(a) => (api = a)} onResult={onResult} />);
    await waitFor(() => expect(api).not.toBeNull());

    await act(async () => {
      void api!.request("guarded");
    });
    const overwrite = await screen.findByRole("button", { name: /overwrite/i });
    await act(async () => {
      fireEvent.click(overwrite);
      fireEvent.click(overwrite);
    });

    await waitFor(() => expect(onResult).toHaveBeenCalledTimes(1));
    expect(onResult).toHaveBeenCalledWith(true);
  });
});
