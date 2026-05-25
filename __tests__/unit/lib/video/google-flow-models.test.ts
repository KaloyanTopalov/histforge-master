import { describe, it, expect } from "vitest";
import { resolveHookVideoModelKey } from "@/lib/video/google-flow-models";

// Per docs/google-flow/clips-length-seconds.md — the base→variant mapping
// is not a clean suffix concat. These tests pin the exact key strings so a
// future edit to the lookup table that breaks one row fails the matching
// expectation rather than silently dispatching a stale model.
describe("resolveHookVideoModelKey", () => {
  it("8s identity: returns the base model key for every base model", () => {
    expect(resolveHookVideoModelKey("veo_3_1_t2v_lite", "8")).toBe(
      "veo_3_1_t2v_lite"
    );
    expect(resolveHookVideoModelKey("veo_3_1_t2v_fast_ultra", "8")).toBe(
      "veo_3_1_t2v_fast_ultra"
    );
    expect(resolveHookVideoModelKey("veo_3_1_t2v", "8")).toBe("veo_3_1_t2v");
    expect(
      resolveHookVideoModelKey("veo_3_1_t2v_lite_low_priority", "8")
    ).toBe("veo_3_1_t2v_lite_low_priority");
  });

  it("4s maps each base to its declared 4s variant", () => {
    expect(resolveHookVideoModelKey("veo_3_1_t2v_lite", "4")).toBe(
      "veo_3_1_t2v_lite_4s"
    );
    expect(resolveHookVideoModelKey("veo_3_1_t2v_fast_ultra", "4")).toBe(
      "veo_3_1_t2v_fast_4s"
    );
    expect(resolveHookVideoModelKey("veo_3_1_t2v", "4")).toBe(
      "veo_3_1_t2v_quality_4s"
    );
    expect(
      resolveHookVideoModelKey("veo_3_1_t2v_lite_low_priority", "4")
    ).toBe("veo_3_1_t2v_lite_4s_low_priority");
  });

  it("6s maps each base to its declared 6s variant", () => {
    expect(resolveHookVideoModelKey("veo_3_1_t2v_lite", "6")).toBe(
      "veo_3_1_t2v_lite_6s"
    );
    expect(resolveHookVideoModelKey("veo_3_1_t2v_fast_ultra", "6")).toBe(
      "veo_3_1_t2v_fast_6s"
    );
    expect(resolveHookVideoModelKey("veo_3_1_t2v", "6")).toBe(
      "veo_3_1_t2v_quality_6s"
    );
    expect(
      resolveHookVideoModelKey("veo_3_1_t2v_lite_low_priority", "6")
    ).toBe("veo_3_1_t2v_lite_6s_low_priority");
  });
});
