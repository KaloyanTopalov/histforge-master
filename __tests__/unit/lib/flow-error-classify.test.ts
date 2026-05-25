import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyError,
  isContentPolicyError,
  extractContentPolicyTag,
  CONTENT_POLICY_REASONS,
  PUBLIC_ERROR_FILTER_RE,
} from "@/lib/flow-error-classify";

describe("classifyError", () => {
  it("returns 'quota' for 429 / RESOURCE_EXHAUSTED / UNUSUAL_ACTIVITY", () => {
    expect(classifyError("HTTP 429 too many requests")).toBe("quota");
    expect(classifyError("RESOURCE_EXHAUSTED")).toBe("quota");
    expect(classifyError("PUBLIC_ERROR_QUOTA exceeded")).toBe("quota");
    expect(classifyError("UNUSUAL_ACTIVITY detected")).toBe("quota");
  });

  it("returns 'captcha' for RECAPTCHA error shapes (and does NOT fall through to quota)", () => {
    expect(classifyError("solve recaptcha please")).toBe("captcha");
    expect(classifyError("HTTP 403: reCAPTCHA evaluation failed")).toBe(
      "captcha"
    );
    expect(classifyError("RECAPTCHA")).toBe("captcha");
  });

  it("returns 'content_policy' for SAFETY / CHILD_DANGER / PUBLIC_ERROR_* (when not quota)", () => {
    expect(classifyError("SAFETY filter triggered")).toBe("content_policy");
    expect(classifyError("CHILD_DANGER")).toBe("content_policy");
    expect(
      classifyError(
        'Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":3,"message":"PUBLIC_ERROR_DANGER_FILTER"}'
      )
    ).toBe("content_policy");
    expect(classifyError("PUBLIC_ERROR_AUDIO_FILTERED")).toBe(
      "content_policy"
    );
  });

  it("returns 'transient' for everything else", () => {
    expect(classifyError("UNAVAILABLE")).toBe("transient");
    expect(classifyError("TIMEOUT")).toBe("transient");
    expect(classifyError("download_failed: ECONNRESET")).toBe("transient");
    expect(classifyError("HTTP 503 service unavailable")).toBe("transient");
  });

  it("returns 'service_overload' for PUBLIC_ERROR_HIGH_TRAFFIC and wins over the PUBLIC_ERROR_ content-policy catch-all", () => {
    // Bug fix: without the service_overload branch, PUBLIC_ERROR_HIGH_TRAFFIC
    // is mis-routed to content_policy by the PUBLIC_ERROR_ catch-all on the
    // next line, which permanently fails the task. The branch must sit
    // BEFORE the catch-all, parallel to how quota wins over it.
    expect(classifyError("PUBLIC_ERROR_HIGH_TRAFFIC")).toBe("service_overload");
    expect(
      classifyError(
        'MEDIA_GENERATION_STATUS_FAILED: {"code":8,"message":"PUBLIC_ERROR_HIGH_TRAFFIC"}'
      )
    ).toBe("service_overload");
  });

  it("captcha and quota still win over service_overload (ordering invariant)", () => {
    // Compound-string defensive check. If Google ever returns a string
    // containing both signals, the higher-priority branch must still win:
    // captcha (operator-gated) and quota (hour-scale) are both more
    // consequential than the minute-scale service_overload pause.
    expect(classifyError("RECAPTCHA + HIGH_TRAFFIC")).toBe("captcha");
    expect(classifyError("RESOURCE_EXHAUSTED HIGH_TRAFFIC")).toBe("quota");
  });

  it("leaves Veo MEDIA_GENERATION_STATUS_FAILED with a generic INTERNAL as transient", () => {
    // The retry-routing question is intentionally separate from the
    // moderator-eligibility question — see the divergence rationale at
    // the top of flow-error-classify.ts.
    expect(
      classifyError(
        'Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":13,"message":"INTERNAL"}'
      )
    ).toBe("transient");
  });
});

describe("isContentPolicyError", () => {
  it("returns true for representative content-policy reasons", () => {
    expect(isContentPolicyError("PUBLIC_ERROR_DANGER_FILTER")).toBe(true);
    expect(isContentPolicyError("PUBLIC_ERROR_AUDIO_FILTERED")).toBe(true);
    expect(
      isContentPolicyError(
        'MEDIA_GENERATION_STATUS_FAILED: {"message":"CHILD_DANGER"}'
      )
    ).toBe(true);
    expect(isContentPolicyError("SAFETY")).toBe(true);
  });

  it("returns false for transient / quota / unrelated strings", () => {
    expect(isContentPolicyError("UNAVAILABLE")).toBe(false);
    expect(isContentPolicyError("TIMEOUT")).toBe(false);
    expect(isContentPolicyError("HTTP 503 server error")).toBe(false);
    expect(isContentPolicyError("download_failed: ECONNRESET")).toBe(false);
    // quota-shaped strings carry no policy signal even though they share the
    // PUBLIC_ERROR_ prefix family — the moderation loop must not pick them up
    expect(isContentPolicyError("PUBLIC_ERROR_QUOTA")).toBe(false);
    expect(isContentPolicyError("PUBLIC_ERROR_UNUSUAL_ACTIVITY")).toBe(false);
  });

  it("returns false for PUBLIC_ERROR_HIGH_TRAFFIC (service_overload is classifyError-only)", () => {
    // Backend-saturation signal, not a content-policy signal — see the
    // divergence rationale at the top of flow-error-classify.ts. A
    // service_overload row never lands in `failed` (handleServiceOverload
    // requeues), so this is defense-in-depth: even if one slipped through,
    // it must not be handed to the moderator.
    expect(isContentPolicyError("PUBLIC_ERROR_HIGH_TRAFFIC")).toBe(false);
  });

  it("returns true for Veo's generic MEDIA_GENERATION_STATUS_FAILED even with no explicit policy tag", () => {
    // After transient retries are exhausted, a row whose error_reason
    // is `code:13 INTERNAL` (or any other generic Veo refusal under
    // MEDIA_GENERATION_STATUS_FAILED) is almost certainly deterministic
    // and worth handing to the moderator — see the divergence rationale
    // at the top of flow-error-classify.ts.
    expect(
      isContentPolicyError(
        'Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":13,"message":"INTERNAL"}'
      )
    ).toBe(true);
    expect(
      isContentPolicyError(
        'MEDIA_GENERATION_STATUS_FAILED: {"code":3,"message":"INVALID_ARGUMENT"}'
      )
    ).toBe(true);
  });
});

describe("extractContentPolicyTag", () => {
  it("returns the canonical code embedded in a Veo error envelope", () => {
    expect(
      extractContentPolicyTag(
        'Video generation failed: MEDIA_GENERATION_STATUS_FAILED: {"code":3,"message":"PUBLIC_ERROR_DANGER_FILTER"}'
      )
    ).toBe("PUBLIC_ERROR_DANGER_FILTER");
    expect(
      extractContentPolicyTag(
        "Video generation failed: PUBLIC_ERROR_AUDIO_FILTERED"
      )
    ).toBe("PUBLIC_ERROR_AUDIO_FILTERED");
  });

  it("returns the bare canonical code for plain reasons", () => {
    expect(extractContentPolicyTag("CHILD_DANGER")).toBe("CHILD_DANGER");
    expect(extractContentPolicyTag("SAFETY")).toBe("SAFETY");
    expect(extractContentPolicyTag("VIOLENCE")).toBe("VIOLENCE");
    expect(extractContentPolicyTag("PERSON_GENERATION")).toBe(
      "PERSON_GENERATION"
    );
  });

  it("returns null when no policy code is present", () => {
    expect(extractContentPolicyTag("UNAVAILABLE")).toBeNull();
    expect(extractContentPolicyTag("download_failed: ECONNRESET")).toBeNull();
    expect(extractContentPolicyTag("")).toBeNull();
  });

  it("matches the broader PUBLIC_ERROR_*_FILTER family", () => {
    expect(
      extractContentPolicyTag("PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED")
    ).toBe("PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED");
    expect(extractContentPolicyTag("PUBLIC_ERROR_SAFETY_FILTER_FAILED")).toBe(
      "PUBLIC_ERROR_SAFETY_FILTER_FAILED"
    );
  });
});

describe("content-policy reason list parity (extension <-> server)", () => {
  // The extension's FLOW_CONTENT_POLICY_REASONS Set is the canonical
  // source of truth (declared in extensions/youforge-flow/src/flow-error.js
  // and documented at the top of CONTENT_POLICY_REASONS in
  // src/lib/flow-error-classify.ts). The Chrome service-worker module
  // can't be `import`ed from a Node test runner — it depends on globals
  // injected via importScripts — so we read the source as text and
  // parse the Set literal out.
  const jsPath = path.resolve(
    process.cwd(),
    "extensions/youforge-flow/src/flow-error.js"
  );
  const jsSource = readFileSync(jsPath, "utf-8");

  it("server CONTENT_POLICY_REASONS contains every entry from the canonical extension Set", () => {
    const setMatch = jsSource.match(
      /FLOW_CONTENT_POLICY_REASONS\s*=\s*new Set\(\[([\s\S]*?)\]\)/
    );
    if (!setMatch) {
      throw new Error(
        "Could not locate FLOW_CONTENT_POLICY_REASONS Set literal in extension source"
      );
    }
    const extensionCodes = Array.from(
      setMatch[1].matchAll(/['"]([A-Z_][A-Z0-9_]*)['"]/g),
      (m) => m[1]
    );
    expect(extensionCodes.length).toBeGreaterThan(0);

    const serverCodes = CONTENT_POLICY_REASONS as readonly string[];
    const missing = extensionCodes.filter(
      (code) => !serverCodes.includes(code)
    );
    expect(
      missing,
      `Server CONTENT_POLICY_REASONS is out of sync with the canonical extension list. Missing entries: ${missing.join(", ")}. Add them to src/lib/flow-error-classify.ts.`
    ).toEqual([]);
  });

  it("server PUBLIC_ERROR_FILTER_RE matches the source pattern from extension FLOW_CONTENT_POLICY_PATTERNS[0]", () => {
    const extReMatch = jsSource.match(
      /FLOW_CONTENT_POLICY_PATTERNS\s*=\s*\[\s*\/([^/]+)\/[gimsy]*/
    );
    if (!extReMatch) {
      throw new Error(
        "Could not locate FLOW_CONTENT_POLICY_PATTERNS regex literal in extension source"
      );
    }
    // The extension uses ^...$ for whole-string matching (against an
    // isolated reason field); the server's substring extractor at
    // PUBLIC_ERROR_FILTER_RE is unanchored. Strip the anchors before
    // comparing the inner pattern bodies.
    const extPatternBody = extReMatch[1]
      .replace(/^\^/, "")
      .replace(/\$$/, "");
    expect(PUBLIC_ERROR_FILTER_RE.source).toBe(extPatternBody);
  });
});
