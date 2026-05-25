import { describe, it, expect } from "vitest";

import { predicateForRow } from "@/app/videos/_shared";

describe("predicateForRow", () => {
  type Row = { id: string; paused: 0 | 1 };

  it("satisfies when getRow returns undefined (vanish-as-satisfied)", () => {
    const predicate = predicateForRow<Row>(
      () => undefined,
      (r) => r.paused === 1,
    );
    expect(predicate()).toBe(true);
  });

  it("satisfies when getRow returns null (vanish-as-satisfied)", () => {
    const predicate = predicateForRow<Row>(
      () => null,
      (r) => r.paused === 1,
    );
    expect(predicate()).toBe(true);
  });

  it("delegates to condition when row exists — true keeps satisfied", () => {
    const predicate = predicateForRow<Row>(
      () => ({ id: "v1", paused: 1 }),
      (r) => r.paused === 1,
    );
    expect(predicate()).toBe(true);
  });

  it("delegates to condition when row exists — false keeps waiting", () => {
    const predicate = predicateForRow<Row>(
      () => ({ id: "v1", paused: 0 }),
      (r) => r.paused === 1,
    );
    expect(predicate()).toBe(false);
  });

  it("re-reads getRow on every call so callers can close over a live ref", () => {
    let row: Row | undefined = { id: "v1", paused: 0 };
    const predicate = predicateForRow<Row>(
      () => row,
      (r) => r.paused === 1,
    );
    expect(predicate()).toBe(false);
    row = { id: "v1", paused: 1 };
    expect(predicate()).toBe(true);
    row = undefined;
    expect(predicate()).toBe(true);
  });
});
