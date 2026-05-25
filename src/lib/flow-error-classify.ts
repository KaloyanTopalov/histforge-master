/**
 * Shared content-policy classifier for Google Flow error reasons.
 *
 * Two callers:
 *   - submit-result/route.ts uses {@link classifyError} as the legacy
 *     fallback when the v2 envelope's `errorCategory` is missing.
 *   - The moderation loop inside runGoogleFlowStep uses
 *     {@link isContentPolicyError} to filter `failed` queue rows worth
 *     rewriting, and {@link extractContentPolicyTag} to surface the
 *     canonical policy code to the moderator LLM and the dashboard.
 *
 * `classifyError` and `isContentPolicyError` answer DIFFERENT questions
 * and intentionally diverge for one shape:
 *
 *   - `classifyError(raw)` answers "how should submit-result route
 *     this — captcha / quota / service_overload / content_policy /
 *     transient?". For an ambiguous Veo refusal like
 *     `MEDIA_GENERATION_STATUS_FAILED:
 *     {"code":13,"message":"INTERNAL"}` with no explicit tag, the right
 *     answer is "transient" — Veo's backend might genuinely have
 *     hiccuped, and burning the retry budget is the safe default.
 *   - `isContentPolicyError(reason)` answers "is this `failed` row
 *     worth handing to the moderator?". By the time a row reaches
 *     `failed`, the transient retries are already exhausted; a row
 *     that failed N times with the same MEDIA_GENERATION_STATUS_FAILED
 *     is almost certainly deterministic (policy-driven or
 *     prompt-shape-driven), not transient. The moderator deserves a
 *     shot at rewriting it even when Veo withheld the explicit reason.
 *
 * Why a coarse classifier is sufficient on `error_reason` of failed
 * rows: the route never calls failTask for quota / auth / rate_limit /
 * stale_project / create_project_failed / service_overload paths —
 * those all requeue. So `failed` rows are either content-policy or
 * transient-exhausted.
 * Transient-exhausted errors match YouForge's TRANSIENT_RE
 * (/5\d\d|TIMEOUT|UNAVAILABLE|ECONNRESET|FETCH|ABORT|NETWORK|UPSTREAM/),
 * which has empty intersection with every content-policy match shape
 * defined below — the inline `SAFETY|CHILD_DANGER|PUBLIC_ERROR_` branch
 * in {@link classifyError}, the {@link CONTENT_POLICY_REASONS} named
 * list, the {@link PUBLIC_ERROR_FILTER_RE} family pattern, and the
 * {@link MEDIA_GENERATION_FAILURE_RE} fall-through used by
 * {@link isContentPolicyError}. New entries added to any of those must
 * preserve that invariant.
 */

export type ErrorClass =
  | "content_policy"
  | "quota"
  | "service_overload"
  | "transient"
  | "captcha";

/**
 * Canonical list of Google Flow content-policy reason codes the system
 * has actually seen.
 *
 * Source of truth: the extension's `FLOW_CONTENT_POLICY_REASONS` Set in
 * `extensions/youforge-flow/src/flow-error.js:19-35`. New reasons are
 * observed by the extension first (it sits closest to the live wire),
 * so the extension's Set is canonical and this list mirrors it. The two
 * MUST stay in sync — the divergence test in
 * `__tests__/unit/lib/flow-error-classify.test.ts` fails loudly when
 * they drift.
 */
export const CONTENT_POLICY_REASONS = [
  "CHILD_DANGER",
  "SAFETY",
  "VIOLENCE",
  "PERSON_GENERATION",
  "ADULT",
  "PROFANITY",
  "CONTENT_POLICY_VIOLATION",
  "POLICY_VIOLATION",
  "PROHIBITED_CONTENT",
  "BLOCKED_REASON_SAFETY",
  "PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED",
  "PUBLIC_ERROR_SAFETY_FILTER_FAILED",
  "PUBLIC_ERROR_CHILD_FILTER_FAILED",
  "PUBLIC_ERROR_DANGER_FILTER",
  "PUBLIC_ERROR_AUDIO_FILTERED",
] as const;

/**
 * Pattern for the broader PUBLIC_ERROR_*_FILTER* family. Three observed
 * suffix shapes: `_FILTER` (PUBLIC_ERROR_DANGER_FILTER), `_FILTERED`
 * (PUBLIC_ERROR_AUDIO_FILTERED), `_FILTER_FAILED`
 * (PUBLIC_ERROR_SAFETY_FILTER_FAILED). Excludes PUBLIC_ERROR_QUOTA /
 * PUBLIC_ERROR_UNUSUAL_ACTIVITY which the quota branch handles.
 */
export const PUBLIC_ERROR_FILTER_RE = /PUBLIC_ERROR_[A-Z_]+_FILTER(?:ED|_FAILED)?/g;

/**
 * Pattern for Veo's generic "I tried to generate and refused" signal.
 * Used only by {@link isContentPolicyError}, not by
 * {@link classifyError} — see the divergence rationale at the top of
 * this file. A row whose `error_reason` contains this substring after
 * the transient retry budget is exhausted is almost certainly
 * deterministic (policy or prompt-shape), so the moderator gets a
 * rewrite shot. Excludes the explicit PUBLIC_ERROR_* shapes which are
 * already caught by the canonical content-policy match.
 */
const MEDIA_GENERATION_FAILURE_RE = /MEDIA_GENERATION_STATUS_FAILED/;

/**
 * The legacy classifier extracted verbatim from
 * src/app/api/flow/submit-result/[token]/route.ts. Order matters:
 *  1. captcha — RECAPTCHA failures are operator-gated (see ADR-0003)
 *     and must not fall through into quota's time-based pause path.
 *  2. quota — wins over the PUBLIC_ERROR_* catch-all because upstream
 *     emits PUBLIC_ERROR_QUOTA / PUBLIC_ERROR_UNUSUAL_ACTIVITY variants
 *     that must route to the pause path rather than permanent-fail.
 *  3. service_overload — PUBLIC_ERROR_HIGH_TRAFFIC. Same load-bearing
 *     ordering as quota: must sit BEFORE the PUBLIC_ERROR_ catch-all so
 *     the minute-scale per-account pause path wins over content_policy's
 *     permanent-fail. See ADR-0004 for why this is its own class rather
 *     than folded into quota.
 *  4. content_policy — Safety/policy refusals.
 *  5. transient — fallback.
 */
export function classifyError(raw: string): ErrorClass {
  const s = raw.toUpperCase();
  if (/RECAPTCHA/.test(s)) return "captcha";
  if (/429|RESOURCE_EXHAUSTED|QUOTA|UNUSUAL_ACTIVITY/.test(s)) return "quota";
  if (/HIGH_TRAFFIC/.test(s)) return "service_overload";
  if (/SAFETY|CHILD_DANGER|PUBLIC_ERROR_/.test(s)) return "content_policy";
  return "transient";
}

/**
 * True iff `reason` belongs to a `failed` queue row worth handing to
 * the moderator. Matches every shape {@link classifyError} would call
 * `content_policy` PLUS the ambiguous MEDIA_GENERATION_STATUS_FAILED
 * fall-through that classifyError leaves as transient — see the
 * divergence rationale at the top of this file.
 */
export function isContentPolicyError(reason: string): boolean {
  if (classifyError(reason) === "content_policy") return true;
  return MEDIA_GENERATION_FAILURE_RE.test(reason);
}

/**
 * Scan `reason` for the first canonical policy code. Returns null when
 * no code is found — the moderation loop falls back to the full
 * `error_reason` for the moderator's `reason_tag`, which is acceptable.
 */
export function extractContentPolicyTag(reason: string): string | null {
  if (!reason) return null;
  // Match the broader PUBLIC_ERROR_*_FILTER* family first so a string
  // like PUBLIC_ERROR_SAFETY_FILTER_FAILED returns the full code rather
  // than the bare-code substring "SAFETY".
  PUBLIC_ERROR_FILTER_RE.lastIndex = 0;
  const match = PUBLIC_ERROR_FILTER_RE.exec(reason);
  if (match) return match[0];
  for (const code of CONTENT_POLICY_REASONS) {
    if (reason.includes(code)) return code;
  }
  return null;
}
