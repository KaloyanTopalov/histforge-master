import { describe, it, expect } from "vitest";
import { getAccountStatus } from "@/lib/flow-account-status";

interface StatusInput {
  enabled: 0 | 1;
  paused_until: number | null;
  last_seen_at: number | null;
  recovery_reason: string | null;
  recovery_required_at: number | null;
}

function acc(overrides: Partial<StatusInput> = {}): StatusInput {
  return {
    enabled: 1,
    paused_until: null,
    last_seen_at: null,
    recovery_reason: null,
    recovery_required_at: null,
    ...overrides,
  };
}

const NOW = 1_700_000_000;

describe("getAccountStatus — online", () => {
  it("enabled account with recent last_seen_at is online with 'seen Ns ago'", () => {
    const result = getAccountStatus(
      acc({ last_seen_at: NOW - 3 }),
      NOW
    );
    expect(result.kind).toBe("online");
    expect(result.label).toBe("seen 3s ago");
  });
});

describe("getAccountStatus — disabled", () => {
  it("enabled === 0 returns stopped/'disabled' regardless of paused_until or last_seen_at", () => {
    const result = getAccountStatus(
      acc({
        enabled: 0,
        paused_until: NOW + 3600,
        last_seen_at: NOW - 5,
      }),
      NOW
    );
    expect(result).toEqual({ kind: "stopped", label: "disabled" });
  });
});

describe("getAccountStatus — paused", () => {
  it("paused_until in the future returns kind=paused with 'paused Xh Ym left'", () => {
    const result = getAccountStatus(
      acc({
        paused_until: NOW + 2 * 3600 + 5 * 60,
        last_seen_at: NOW - 5,
      }),
      NOW
    );
    expect(result.kind).toBe("paused");
    expect(result.label).toBe("paused 2h 5m left");
  });

  it("paused_until in the past defers to online/stopped logic", () => {
    const result = getAccountStatus(
      acc({ paused_until: NOW - 10, last_seen_at: NOW - 2 }),
      NOW
    );
    expect(result.kind).toBe("online");
    expect(result.label).toBe("seen 2s ago");
  });

  it("paused_until less than a minute away formats in seconds", () => {
    const result = getAccountStatus(
      acc({ paused_until: NOW + 30, last_seen_at: NOW - 1 }),
      NOW
    );
    expect(result.label).toBe("paused 30s left");
  });
});

describe("getAccountStatus — stopped (stale or never seen)", () => {
  it("null last_seen_at on an enabled account returns stopped with 'polling stopped · last seen never'", () => {
    const result = getAccountStatus(
      acc({ last_seen_at: null }),
      NOW
    );
    expect(result.kind).toBe("stopped");
    expect(result.label).toBe("polling stopped · last seen never");
  });

  it("last_seen_at older than 10 min (DEFAULT_STALE_ACCOUNT_MINUTES) returns stopped with relative time", () => {
    const result = getAccountStatus(
      acc({ last_seen_at: NOW - 11 * 60 }),
      NOW
    );
    expect(result.kind).toBe("stopped");
    expect(result.label).toBe("polling stopped · last seen 11m ago");
  });

  it("last_seen_at at exactly the stale threshold is still online (strict >)", () => {
    const result = getAccountStatus(
      acc({ last_seen_at: NOW - 10 * 60 }),
      NOW
    );
    expect(result.kind).toBe("online");
  });
});

describe("getAccountStatus — recovery_needed", () => {
  it("recovery_reason set with recent timestamp returns kind=recovery_needed with 'reCAPTCHA recovery needed (Xs)' format", () => {
    const result = getAccountStatus(
      acc({
        recovery_reason: "captcha",
        recovery_required_at: NOW - 45,
        last_seen_at: NOW - 2,
      }),
      NOW
    );
    expect(result.kind).toBe("recovery_needed");
    expect(result.label).toBe("reCAPTCHA recovery needed (45s)");
  });

  it("formats minutes-ago durations", () => {
    const result = getAccountStatus(
      acc({
        recovery_reason: "captcha",
        recovery_required_at: NOW - 47 * 60,
      }),
      NOW
    );
    expect(result.label).toBe("reCAPTCHA recovery needed (47m)");
  });

  it("formats hours-ago durations", () => {
    const result = getAccountStatus(
      acc({
        recovery_reason: "captcha",
        recovery_required_at: NOW - 3 * 3600,
      }),
      NOW
    );
    expect(result.label).toBe("reCAPTCHA recovery needed (3h)");
  });

  it("recovery_needed wins over a future paused_until (recovery gate sits before time-pause)", () => {
    const result = getAccountStatus(
      acc({
        recovery_reason: "captcha",
        recovery_required_at: NOW - 60,
        paused_until: NOW + 3600,
      }),
      NOW
    );
    expect(result.kind).toBe("recovery_needed");
  });

  it("recovery_needed wins over a stale last_seen_at (the recovery flag is the more actionable signal)", () => {
    const result = getAccountStatus(
      acc({
        recovery_reason: "captcha",
        recovery_required_at: NOW - 60,
        last_seen_at: NOW - 30 * 60, // well past the 10m stale threshold
      }),
      NOW
    );
    expect(result.kind).toBe("recovery_needed");
  });

  it("!enabled still wins over recovery_needed (disabled accounts never dispatch, regardless of state)", () => {
    const result = getAccountStatus(
      acc({
        enabled: 0,
        recovery_reason: "captcha",
        recovery_required_at: NOW - 60,
      }),
      NOW
    );
    expect(result).toEqual({ kind: "stopped", label: "disabled" });
  });
});
