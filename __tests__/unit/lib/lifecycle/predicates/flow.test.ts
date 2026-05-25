import { describe, it, expect } from "vitest";
import type { GoogleFlowAccount } from "@/types";
import * as flowPredicates from "@/lib/lifecycle/predicates/flow";

function makeAccount(
  overrides: Partial<GoogleFlowAccount> = {}
): GoogleFlowAccount {
  return {
    id: "acc1",
    name: "primary",
    token: "tok",
    paused_until: null,
    last_seen_at: null,
    credits: null,
    credits_updated_at: null,
    enabled: 1,
    recovery_reason: null,
    recovery_required_at: null,
    created_at: 0,
    ...overrides,
  };
}

const NOW = 1_700_000_000;

describe("flowPredicates.accountIsPaused", () => {
  it("true when paused_until is in the future", () => {
    expect(
      flowPredicates.accountIsPaused(
        makeAccount({ paused_until: NOW + 60 }),
        NOW
      )
    ).toBe(true);
  });

  it("false when paused_until has elapsed", () => {
    expect(
      flowPredicates.accountIsPaused(
        makeAccount({ paused_until: NOW - 60 }),
        NOW
      )
    ).toBe(false);
  });

  it("false when paused_until is null", () => {
    expect(
      flowPredicates.accountIsPaused(makeAccount({ paused_until: null }), NOW)
    ).toBe(false);
  });
});

describe("flowPredicates.accountNeedsRecovery", () => {
  it("true when recovery_reason is set", () => {
    expect(
      flowPredicates.accountNeedsRecovery(
        makeAccount({ recovery_reason: "captcha" })
      )
    ).toBe(true);
  });

  it("false when recovery_reason is null", () => {
    expect(
      flowPredicates.accountNeedsRecovery(
        makeAccount({ recovery_reason: null })
      )
    ).toBe(false);
  });
});

describe("flowPredicates.accountIsDispatchable", () => {
  it("true when enabled, no recovery, and no active pause", () => {
    expect(
      flowPredicates.accountIsDispatchable(makeAccount(), NOW)
    ).toBe(true);
  });

  it("true when paused_until has elapsed", () => {
    expect(
      flowPredicates.accountIsDispatchable(
        makeAccount({ paused_until: NOW - 60 }),
        NOW
      )
    ).toBe(true);
  });

  it("false when account is disabled (first-match-wins)", () => {
    expect(
      flowPredicates.accountIsDispatchable(makeAccount({ enabled: 0 }), NOW)
    ).toBe(false);
  });

  it("false when recovery_reason is set (sits before time-pause)", () => {
    expect(
      flowPredicates.accountIsDispatchable(
        makeAccount({
          recovery_reason: "captcha",
          paused_until: null,
        }),
        NOW
      )
    ).toBe(false);
  });

  it("false when paused_until is in the future", () => {
    expect(
      flowPredicates.accountIsDispatchable(
        makeAccount({ paused_until: NOW + 60 }),
        NOW
      )
    ).toBe(false);
  });

  it("false when recovery_reason is set even if paused_until has elapsed", () => {
    expect(
      flowPredicates.accountIsDispatchable(
        makeAccount({
          recovery_reason: "captcha",
          paused_until: NOW - 60,
        }),
        NOW
      )
    ).toBe(false);
  });
});
