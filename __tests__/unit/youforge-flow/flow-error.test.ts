import { describe, it, expect, vi } from "vitest";
import { loadClassicScript } from "../../helpers/load-classic-script";

type ParsedFlowError = {
  reason: string;
  httpStatus: number | null;
  errorCode: number | null;
  message: string;
  category: string;
  retryable: boolean;
  isContentPolicy: boolean;
  contentPolicyTag: string | null;
  retryAfterMs: number | null;
  isSessionExpired: boolean;
};

type FlowApiError = Error & ParsedFlowError;

type FlowErrorModule = {
  parseFlowApiError: (
    response: { status: number; headers?: { get: (name: string) => string | null } } | null,
    body: unknown,
  ) => ParsedFlowError;
  makeFlowApiError: (parsed: Partial<ParsedFlowError>) => FlowApiError;
  throwFlowApiError: (parsed: Partial<ParsedFlowError>) => Promise<never>;
  throwFromResponse: (args: {
    httpStatus: number;
    body?: string | null;
    retryAfterHeader?: string | null;
    contextLabel?: string;
    urlForStaleProjectCheck?: string | null;
    categoryOverride?: string;
  }) => Promise<never>;
  isContentPolicyReason: (reason: string | null | undefined) => boolean;
  triggerRateLimitCooldown?: (err: FlowApiError) => Promise<void> | void;
};

function load() {
  return loadClassicScript<FlowErrorModule>(
    "extensions/youforge-flow/src/flow-error.js",
  );
}

function fakeResponse(
  status: number,
  headers: Record<string, string> = {},
): { status: number; headers: { get: (name: string) => string | null } } {
  const lower: Record<string, string> = {};
  for (const k of Object.keys(headers)) lower[k.toLowerCase()] = headers[k];
  return {
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
  };
}

describe("parseFlowApiError", () => {
  it("extracts reason and message from Google's error envelope", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(429), {
      error: {
        message: "Quota exceeded.",
        details: [{ reason: "RESOURCE_EXHAUSTED" }],
      },
    });
    expect(result.reason).toBe("RESOURCE_EXHAUSTED");
    expect(result.message).toBe("Quota exceeded.");
    expect(result.httpStatus).toBe(429);
    expect(result.category).toBe("rate_limit");
    expect(result.retryable).toBe(true);
  });

  it("flags HTTP 401 as session-expired regardless of body content", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(401), null);
    expect(result.isSessionExpired).toBe(true);
    expect(result.category).toBe("auth");
    expect(result.retryable).toBe(false);
  });

  it("flags UNAUTHENTICATED reason as session-expired even on non-401 status", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(403), {
      error: {
        message: "Token invalid",
        details: [{ reason: "UNAUTHENTICATED" }],
      },
    });
    expect(result.isSessionExpired).toBe(true);
    expect(result.category).toBe("auth");
  });

  it("classifies Google's 403 anti-abuse 'Sorry...' page as rate_limit, not auth", () => {
    // Real fetch off the wire when Google's anti-abuse heuristics flag the
    // session mid-poll: HTTP 403 + an HTML page (no JSON envelope) starting
    // `<html><head><meta...><title>Sorry...</title>`. Routing through `auth`
    // would let poll-video.js's catch-and-continue swallow it for the full
    // attempts budget, producing a generic timeout that loses the signal.
    const { parseFlowApiError } = load();
    const html =
      `<html><head><meta http-equiv="content-type" content="text/html; charset=utf-8"/>` +
      `<title>Sorry...</title><style>body{font-family:verdana}</style></head>` +
      `<body><div>We're sorry...</div></body></html>`;
    const result = parseFlowApiError(fakeResponse(403), html);
    expect(result.category).toBe("rate_limit");
    expect(result.retryable).toBe(true);
    expect(result.isSessionExpired).toBe(false);
  });

  it("matches anti-abuse variant pages by 'unusual traffic' body copy", () => {
    const { parseFlowApiError } = load();
    const html =
      `<html><body>Our systems have detected unusual traffic from your computer network.</body></html>`;
    const result = parseFlowApiError(fakeResponse(403), html);
    expect(result.category).toBe("rate_limit");
  });

  it("preserves 403 + PERMISSION_DENIED JSON envelope as auth (not rate_limit)", () => {
    // Real auth failures (envelope present, real PERMISSION_DENIED reason)
    // must keep classifying as `auth` — the override is gated on a missing
    // envelope so it can't fire when Google returned a structured error.
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(403), {
      error: { message: "Permission denied", details: [{ reason: "PERMISSION_DENIED" }] },
    });
    expect(result.category).toBe("auth");
    expect(result.retryable).toBe(false);
  });

  it("classifies PUBLIC_ERROR_HIGH_TRAFFIC as service_overload (not content_policy)", () => {
    // Mirrors the server classifier branch from src/lib/flow-error-classify.ts.
    // PUBLIC_ERROR_HIGH_TRAFFIC is a Veo backend-saturation signal: the
    // SW must emit `errorCategory: 'service_overload'` on the v2 webhook
    // so the HistForge handler can route to the per-account minute-scale
    // pause path instead of permanent-failing the task.
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(503), {
      error: {
        message: "high traffic",
        details: [{ reason: "PUBLIC_ERROR_HIGH_TRAFFIC" }],
      },
    });
    expect(result.reason).toBe("PUBLIC_ERROR_HIGH_TRAFFIC");
    expect(result.category).toBe("service_overload");
    expect(result.isContentPolicy).toBe(false);
    expect(result.contentPolicyTag).toBeNull();
  });

  it("tags every documented content-policy reason and marks not retryable", () => {
    const { parseFlowApiError } = load();
    const reasons = [
      "CHILD_DANGER",
      "SAFETY",
      "PERSON_GENERATION",
      "VIOLENCE",
      "ADULT",
      "PROFANITY",
      "CONTENT_POLICY_VIOLATION",
    ];
    for (const reason of reasons) {
      const result = parseFlowApiError(fakeResponse(400), {
        error: { message: "blocked", details: [{ reason }] },
      });
      expect(result.category).toBe("content_policy");
      expect(result.isContentPolicy).toBe(true);
      expect(result.contentPolicyTag).toBe(reason);
      expect(result.retryable).toBe(false);
    }
  });

  it("reads numeric Retry-After header as milliseconds", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(
      fakeResponse(429, { "retry-after": "60" }),
      null,
    );
    expect(result.retryAfterMs).toBe(60_000);
  });

  it("reads HTTP-date Retry-After header relative to now", () => {
    const { parseFlowApiError } = load();
    const future = new Date(Date.now() + 30_000).toUTCString();
    const result = parseFlowApiError(
      fakeResponse(429, { "retry-after": future }),
      null,
    );
    expect(result.retryAfterMs).not.toBeNull();
    expect(result.retryAfterMs!).toBeGreaterThan(25_000);
    expect(result.retryAfterMs!).toBeLessThanOrEqual(30_000);
  });

  it("returns retryAfterMs null when header absent", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(500), null);
    expect(result.retryAfterMs).toBeNull();
  });

  it("maps 5xx without an envelope reason to transient/retryable", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(503), "Service Unavailable");
    expect(result.category).toBe("transient");
    expect(result.retryable).toBe(true);
  });

  it("parses body when given as a JSON string", () => {
    const { parseFlowApiError } = load();
    const body = JSON.stringify({
      error: { message: "bad", details: [{ reason: "INVALID_ARGUMENT" }] },
    });
    const result = parseFlowApiError(fakeResponse(400), body);
    expect(result.reason).toBe("INVALID_ARGUMENT");
    expect(result.category).toBe("invalid_argument");
    expect(result.retryable).toBe(false);
  });

  it("falls back gracefully when body is not parseable", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(418), "I'm a teapot");
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(result.httpStatus).toBe(418);
  });

  it("parses numeric error.code from Google's envelope", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(403), {
      error: {
        code: 7,
        message: "Permission denied",
        details: [{ reason: "PERMISSION_DENIED" }],
      },
    });
    expect(result.errorCode).toBe(7);
    expect(result.reason).toBe("PERMISSION_DENIED");
  });

  it("returns errorCode null when envelope omits code", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(fakeResponse(429), {
      error: {
        message: "Quota exceeded.",
        details: [{ reason: "RESOURCE_EXHAUSTED" }],
      },
    });
    expect(result.errorCode).toBeNull();
  });

  it("works without a response (synthesized errors)", () => {
    const { parseFlowApiError } = load();
    const result = parseFlowApiError(null, null);
    expect(result.httpStatus).toBeNull();
    expect(result.category).toBe("unknown");
    expect(result.retryable).toBe(false);
    expect(result.isSessionExpired).toBe(false);
  });
});

describe("makeFlowApiError", () => {
  it("returns an Error with all parsed fields attached", () => {
    const { makeFlowApiError } = load();
    const err = makeFlowApiError({
      reason: "NO_URL",
      category: "not_found",
      message: "No URL after polling",
      httpStatus: null,
    });
    expect(err.name).toBe("Error");
    expect(typeof err.stack).toBe("string");
    expect(err.reason).toBe("NO_URL");
    expect(err.category).toBe("not_found");
    expect(err.httpStatus).toBeNull();
    expect(err.retryable).toBe(false);
    expect(err.isSessionExpired).toBe(false);
    expect(err.message).toContain("No URL after polling");
  });

  it("infers retryable from category when not explicitly passed", () => {
    const { makeFlowApiError } = load();
    expect(
      makeFlowApiError({ reason: "X", category: "transient" }).retryable,
    ).toBe(true);
    expect(
      makeFlowApiError({ reason: "X", category: "rate_limit" }).retryable,
    ).toBe(true);
    expect(
      makeFlowApiError({ reason: "X", category: "quota" }).retryable,
    ).toBe(true);
    expect(
      makeFlowApiError({ reason: "X", category: "auth" }).retryable,
    ).toBe(false);
  });

  it("preserves isSessionExpired when set on the parsed input", () => {
    const { makeFlowApiError } = load();
    const err = makeFlowApiError({
      reason: "UNAUTHENTICATED",
      category: "auth",
      isSessionExpired: true,
      httpStatus: 401,
    });
    expect(err.isSessionExpired).toBe(true);
  });
});

describe("isContentPolicyReason", () => {
  it("recognizes the documented content-policy reason vocabulary", () => {
    const { isContentPolicyReason } = load();
    for (const reason of [
      "CHILD_DANGER",
      "SAFETY",
      "PERSON_GENERATION",
      "VIOLENCE",
      "ADULT",
      "PROFANITY",
      "CONTENT_POLICY_VIOLATION",
    ]) {
      expect(isContentPolicyReason(reason)).toBe(true);
    }
  });

  it("recognizes all three PUBLIC_ERROR filter suffix shapes", () => {
    const { isContentPolicyReason } = load();
    // _FILTER_FAILED (legacy), _FILTER (new), _FILTERED (new — Veo 3 audio)
    expect(isContentPolicyReason("PUBLIC_ERROR_SAFETY_FILTER_FAILED")).toBe(true);
    expect(isContentPolicyReason("PUBLIC_ERROR_DANGER_FILTER")).toBe(true);
    expect(isContentPolicyReason("PUBLIC_ERROR_AUDIO_FILTERED")).toBe(true);
    // Forward-compat: a hypothetical future filter still gets caught.
    expect(isContentPolicyReason("PUBLIC_ERROR_NEW_FUTURE_FILTER")).toBe(true);
  });

  it("excludes non-filter PUBLIC_ERROR variants the backend handles separately", () => {
    const { isContentPolicyReason } = load();
    // Quota / bot-detection variants must NOT be classified as content_policy
    // — they route to handleQuota (account pause) instead of failTask.
    expect(isContentPolicyReason("PUBLIC_ERROR_QUOTA")).toBe(false);
    expect(isContentPolicyReason("PUBLIC_ERROR_UNUSUAL_ACTIVITY")).toBe(false);
  });

  it("returns false for unknown / unrelated reasons", () => {
    const { isContentPolicyReason } = load();
    expect(isContentPolicyReason("RESOURCE_EXHAUSTED")).toBe(false);
    expect(isContentPolicyReason("UNAUTHENTICATED")).toBe(false);
    expect(isContentPolicyReason(null)).toBe(false);
    expect(isContentPolicyReason(undefined)).toBe(false);
    expect(isContentPolicyReason("")).toBe(false);
  });
});

describe("throwFlowApiError", () => {
  it("throws an Error built from the parsed shape", async () => {
    const mod = load();
    await expect(
      mod.throwFlowApiError({
        reason: "INVALID_ARGUMENT",
        category: "invalid_argument",
        httpStatus: 400,
        message: "bad request",
      }),
    ).rejects.toMatchObject({
      reason: "INVALID_ARGUMENT",
      category: "invalid_argument",
      httpStatus: 400,
      message: "bad request",
    });
  });

  it("arms triggerRateLimitCooldown before throwing when category is rate_limit", async () => {
    const mod = load();
    const trigger = vi.fn().mockResolvedValue(undefined);
    (mod as Record<string, unknown>).triggerRateLimitCooldown = trigger;

    let thrown: unknown = null;
    try {
      await mod.throwFlowApiError({
        reason: "RESOURCE_EXHAUSTED",
        category: "rate_limit",
        httpStatus: 429,
        message: "rate limited",
      });
    } catch (e) {
      thrown = e;
    }

    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toBe(thrown);
    expect((thrown as FlowApiError).category).toBe("rate_limit");
  });

  it("does not call triggerRateLimitCooldown for non rate_limit categories", async () => {
    const mod = load();
    const trigger = vi.fn().mockResolvedValue(undefined);
    (mod as Record<string, unknown>).triggerRateLimitCooldown = trigger;

    await expect(
      mod.throwFlowApiError({
        reason: "UNAUTHENTICATED",
        category: "auth",
        httpStatus: 401,
        message: "session expired",
        isSessionExpired: true,
      }),
    ).rejects.toMatchObject({ category: "auth", isSessionExpired: true });

    expect(trigger).not.toHaveBeenCalled();
  });

  it("throws cleanly when triggerRateLimitCooldown is not defined", async () => {
    const mod = load();
    // No triggerRateLimitCooldown injected — typeof guard must skip it.
    await expect(
      mod.throwFlowApiError({
        reason: "RESOURCE_EXHAUSTED",
        category: "rate_limit",
        httpStatus: 429,
        message: "no cooldown wired",
      }),
    ).rejects.toMatchObject({ category: "rate_limit" });
  });

  it("swallows trigger failures and still throws the parsed error", async () => {
    const mod = load();
    const trigger = vi.fn().mockRejectedValue(new Error("trigger boom"));
    (mod as Record<string, unknown>).triggerRateLimitCooldown = trigger;

    await expect(
      mod.throwFlowApiError({
        reason: "RESOURCE_EXHAUSTED",
        category: "rate_limit",
        httpStatus: 429,
        message: "advisory swallow",
      }),
    ).rejects.toMatchObject({
      category: "rate_limit",
      message: "advisory swallow",
    });
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe("throwFromResponse", () => {
  it("throws using parseFlowApiError's defaults and supports categoryOverride", async () => {
    const mod = load();
    await expect(
      mod.throwFromResponse({
        httpStatus: 400,
        body: "bad request",
        contextLabel: "createProject",
        categoryOverride: "create_project_failed",
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      reason: "HTTP_400",
      category: "create_project_failed",
      retryable: false,
      message: "createProject HTTP 400: bad request",
    });
  });

  it("prefixes the contextLabel even when the body envelope already supplies a message", async () => {
    const mod = load();
    await expect(
      mod.throwFromResponse({
        httpStatus: 503,
        body: '{"error":{"message":"backend down","details":[]}}',
        contextLabel: "createProject",
      }),
    ).rejects.toMatchObject({
      httpStatus: 503,
      category: "transient",
      retryable: true,
      message: "createProject HTTP 503: backend down",
    });
  });

  it("tags category as stale_project_id on 404 from a /projects/<id>/... URL", async () => {
    const mod = load();
    await expect(
      mod.throwFromResponse({
        httpStatus: 404,
        body: "",
        contextLabel: "generation",
        urlForStaleProjectCheck:
          "https://aisandbox-pa.googleapis.com/v1/projects/proj-123/scenes/foo",
      }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      category: "stale_project_id",
    });
  });

  it("does not tag stale_project_id when URL is missing or unrelated", async () => {
    const mod = load();
    await expect(
      mod.throwFromResponse({
        httpStatus: 404,
        body: "",
        contextLabel: "generation",
        urlForStaleProjectCheck: "https://aisandbox-pa.googleapis.com/v1/credits",
      }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      category: "not_found",
    });
  });

  it("arms triggerRateLimitCooldown for 429 (delegates through throwFlowApiError)", async () => {
    const mod = load();
    const trigger = vi.fn().mockResolvedValue(undefined);
    (mod as Record<string, unknown>).triggerRateLimitCooldown = trigger;

    let thrown: unknown = null;
    try {
      await mod.throwFromResponse({
        httpStatus: 429,
        body: '{"error":{"message":"too many"}}',
        retryAfterHeader: "30",
        contextLabel: "createProject",
      });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as FlowApiError).category).toBe("rate_limit");
    expect((thrown as FlowApiError).httpStatus).toBe(429);
    expect((thrown as FlowApiError).retryAfterMs).toBe(30_000);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger.mock.calls[0][0]).toBe(thrown);
  });

  it("preserves isSessionExpired and synthesizes a SESSION_EXPIRED fallback message on 401", async () => {
    const mod = load();
    await expect(
      mod.throwFromResponse({
        httpStatus: 401,
        body: "",
        contextLabel: "createProject",
      }),
    ).rejects.toMatchObject({
      httpStatus: 401,
      category: "auth",
      isSessionExpired: true,
      message: "SESSION_EXPIRED: createProject",
    });
  });
});
