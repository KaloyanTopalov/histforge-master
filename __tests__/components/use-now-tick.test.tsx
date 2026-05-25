import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { useState } from "react";

const FIXED_NOW = 1_700_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

type HarnessProps = { initialActive?: boolean };

async function makeHarness(): Promise<{
  Harness: (p: HarnessProps) => JSX.Element;
  setActive: { current: ((next: boolean) => void) | null };
}> {
  const { useNowTick } = await import("@/lib/use-now-tick");
  const setActive: { current: ((next: boolean) => void) | null } = {
    current: null,
  };

  function Harness({ initialActive = true }: HarnessProps): JSX.Element {
    const [active, set] = useState(initialActive);
    setActive.current = set;
    // Pass `Date.now()` as the initial-render value the same way a real
    // caller would forward a Server-Component-supplied `serverNow`. Under
    // fake timers this is `FIXED_NOW`, keeping the existing assertions
    // valid.
    const now = useNowTick(active, Date.now());
    return <div data-testid="now">{now}</div>;
  }

  return { Harness, setActive };
}

function readNow(): number {
  return Number(screen.getByTestId("now").textContent);
}

describe("useNowTick", () => {
  it("returns the current time on mount", async () => {
    const { Harness } = await makeHarness();
    render(<Harness initialActive={false} />);
    expect(readNow()).toBe(FIXED_NOW);
  });

  it("when active, advances `now` by ~1s on each second tick", async () => {
    const { Harness } = await makeHarness();
    render(<Harness initialActive={true} />);

    expect(readNow()).toBe(FIXED_NOW);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(readNow()).toBe(FIXED_NOW + 1000);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(readNow()).toBe(FIXED_NOW + 2000);
  });

  it("when inactive, `now` does not update despite time passing", async () => {
    const { Harness } = await makeHarness();
    render(<Harness initialActive={false} />);
    const initial = readNow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readNow()).toBe(initial);
  });

  it("toggling active false → true starts ticking", async () => {
    const { Harness, setActive } = await makeHarness();
    render(<Harness initialActive={false} />);
    const initial = readNow();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(readNow()).toBe(initial);

    act(() => {
      setActive.current?.(true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(readNow()).toBeGreaterThan(initial);
  });

  it("toggling active true → false stops ticking", async () => {
    const { Harness, setActive } = await makeHarness();
    render(<Harness initialActive={true} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    const tickedTo = readNow();
    expect(tickedTo).toBeGreaterThan(FIXED_NOW);

    act(() => {
      setActive.current?.(false);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(readNow()).toBe(tickedTo);
  });
});
