import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

type ControlPanel = {
  openControlPanel: () => Promise<void>;
};

function loadControlPanel() {
  const src = readFileSync(
    path.resolve(process.cwd(), "extensions/youforge-flow/src/control-panel.js"),
    "utf8",
  );
  const windows: Array<{ id: number; params: unknown }> = [];
  const removedListeners: Array<(id: number) => void> = [];
  const actionClickedListeners: Array<() => void> = [];
  let nextId = 100;
  const chromeStub = {
    runtime: { getURL: (p: string) => `chrome-extension://test/${p}` },
    windows: {
      get: vi.fn(async (id: number) => {
        const w = windows.find((x) => x.id === id);
        if (!w) throw new Error("no window");
        return w;
      }),
      update: vi.fn(async (_id: number, _p: unknown) => {}),
      create: vi.fn(async (params: unknown) => {
        const id = nextId++;
        const w = { id, params };
        windows.push(w);
        return w;
      }),
      onRemoved: {
        addListener: (fn: (id: number) => void) => removedListeners.push(fn),
        removeListener: (fn: (id: number) => void) => {
          const i = removedListeners.indexOf(fn);
          if (i >= 0) removedListeners.splice(i, 1);
        },
      },
    },
    action: {
      onClicked: {
        addListener: (fn: () => void) => actionClickedListeners.push(fn),
      },
    },
  };
  const sandbox: Record<string, unknown> = {
    console: { log: () => {} },
    chrome: chromeStub,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return {
    mod: sandbox as unknown as ControlPanel,
    chromeStub,
    windows,
    removedListeners,
    actionClickedListeners,
  };
}

describe("control-panel", () => {
  let ctx: ReturnType<typeof loadControlPanel>;
  beforeEach(() => {
    ctx = loadControlPanel();
  });

  it("registers the chrome.action.onClicked listener at load", () => {
    expect(ctx.actionClickedListeners).toHaveLength(1);
  });

  it("creates a popup window on first call with expected params", async () => {
    await ctx.mod.openControlPanel();

    expect(ctx.chromeStub.windows.create).toHaveBeenCalledOnce();
    const call = ctx.chromeStub.windows.create.mock.calls[0][0] as {
      url: string;
      type: string;
      width: number;
      height: number;
      top: number;
      left: number;
    };
    expect(call.url).toBe("chrome-extension://test/popup.html");
    expect(call.type).toBe("popup");
    expect(call.width).toBe(550);
    expect(call.height).toBe(720);
  });

  it("focuses existing window on second call (no new window)", async () => {
    await ctx.mod.openControlPanel();
    await ctx.mod.openControlPanel();

    expect(ctx.chromeStub.windows.create).toHaveBeenCalledOnce();
    expect(ctx.chromeStub.windows.update).toHaveBeenCalledOnce();
    expect(ctx.chromeStub.windows.update.mock.calls[0][1]).toEqual({
      focused: true,
    });
  });

  it("creates fresh window if chrome.windows.get throws for cached id", async () => {
    await ctx.mod.openControlPanel();
    // Simulate window being closed externally by making `get` reject again.
    ctx.chromeStub.windows.get.mockRejectedValueOnce(new Error("not found"));
    await ctx.mod.openControlPanel();

    expect(ctx.chromeStub.windows.create).toHaveBeenCalledTimes(2);
  });

  it("resets cached id when the popup window is closed", async () => {
    await ctx.mod.openControlPanel();
    const firstId = ctx.windows[0].id;
    // Fire all onRemoved listeners registered during the first open
    for (const listener of ctx.removedListeners.slice()) listener(firstId);

    // After reset, next open must create a new window rather than focus
    await ctx.mod.openControlPanel();
    expect(ctx.chromeStub.windows.create).toHaveBeenCalledTimes(2);
  });
});
