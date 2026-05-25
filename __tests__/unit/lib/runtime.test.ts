import { describe, it, expect } from "vitest";
import {
  computeRuntimeMs,
  formatDuration,
  videoTimerLabel,
} from "@/lib/runtime";
import type { VideoStep } from "@/types";

function step(overrides: Partial<VideoStep> = {}): VideoStep {
  return {
    video_id: "v1",
    step_name: "step",
    status: "pending",
    started_at: null,
    finished_at: null,
    ...overrides,
  };
}

describe("formatDuration", () => {
  it("renders sub-second durations as '<1s'", () => {
    expect(formatDuration(0)).toBe("<1s");
    expect(formatDuration(999)).toBe("<1s");
  });

  it("renders second-only durations as 'Xs'", () => {
    expect(formatDuration(1000)).toBe("1s");
    expect(formatDuration(45_000)).toBe("45s");
  });

  it("renders minute+second durations as 'Xm Ys'", () => {
    expect(formatDuration(60_000)).toBe("1m 0s");
    expect(formatDuration(125_000)).toBe("2m 5s");
  });

  it("renders hour+minute+second durations as 'Xh Ym Zs'", () => {
    expect(formatDuration(3_600_000)).toBe("1h 0m 0s");
    expect(formatDuration(3_725_000)).toBe("1h 2m 5s");
  });
});

describe("computeRuntimeMs", () => {
  it("returns null when no step has started", () => {
    expect(computeRuntimeMs([], 5_000)).toBeNull();
    expect(
      computeRuntimeMs([step({ status: "pending" })], 5_000),
    ).toBeNull();
  });

  it("sums (finished - started) for completed steps", () => {
    const steps = [
      step({
        step_name: "a",
        status: "done",
        started_at: 1_000,
        finished_at: 4_000,
      }),
      step({
        step_name: "b",
        status: "done",
        started_at: 5_000,
        finished_at: 8_500,
      }),
    ];
    expect(computeRuntimeMs(steps, 10_000)).toBe(6_500);
  });

  it("extrapolates a running step to `now`", () => {
    const steps = [
      step({
        step_name: "a",
        status: "running",
        started_at: 1_000,
        finished_at: null,
      }),
    ];
    expect(computeRuntimeMs(steps, 4_000)).toBe(3_000);
  });

  it("treats failed steps like completed (uses their finished_at)", () => {
    const steps = [
      step({
        step_name: "a",
        status: "failed",
        started_at: 1_000,
        finished_at: 2_500,
      }),
    ];
    expect(computeRuntimeMs(steps, 9_999)).toBe(1_500);
  });

  it("combines completed + running across many steps", () => {
    const steps = [
      step({
        step_name: "a",
        status: "done",
        started_at: 1_000,
        finished_at: 2_000,
      }),
      step({
        step_name: "b",
        status: "done",
        started_at: 3_000,
        finished_at: 5_000,
      }),
      step({
        step_name: "c",
        status: "running",
        started_at: 6_000,
        finished_at: null,
      }),
      step({ step_name: "d", status: "pending" }),
    ];
    expect(computeRuntimeMs(steps, 9_000)).toBe(1_000 + 2_000 + 3_000);
  });
});

describe("videoTimerLabel", () => {
  it("returns null for a never-started video so the caller can render '—'", () => {
    expect(
      videoTimerLabel(
        { runtime_ms: 0, running_step_started_at: null },
        10_000,
      ),
    ).toBeNull();
  });

  it("formats `runtime_ms` directly when no step is running (frozen)", () => {
    expect(
      videoTimerLabel(
        { runtime_ms: 65_000, running_step_started_at: null },
        99_999,
      ),
    ).toBe("1m 5s");
  });

  it("extrapolates a running step to `now`", () => {
    expect(
      videoTimerLabel(
        { runtime_ms: 60_000, running_step_started_at: 10_000 },
        13_000,
      ),
    ).toBe("1m 3s");
  });

  it("clamps a backwards `now` to the baseline runtime_ms (clock skew)", () => {
    expect(
      videoTimerLabel(
        { runtime_ms: 60_000, running_step_started_at: 10_000 },
        9_000,
      ),
    ).toBe("1m 0s");
  });
});
