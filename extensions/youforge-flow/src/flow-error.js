// YouForge Flow - structured error parser for Google Flow / aisandbox-pa
// responses.
//
// parseFlowApiError walks the Google API error envelope:
//   { error: { message, status, code, details: [{ reason, ... }] } }
// and returns a flat object the rest of the extension can branch on.
// makeFlowApiError lifts that object onto a real Error so callers can
// `throw` without losing the structured fields. Plain Error subclassing
// would force every existing catch site to re-instanceof; instead we
// keep `error.reason / error.category / error.httpStatus / error.isSessionExpired`
// as documented in docs/plans/2026-04-24-youforge-flow-flow2api-improvements.md
// task 1.1.
//
// Loaded via importScripts right after logger.js so every downstream
// module can call it.

// Reason vocabulary observed in Google's error.details[].reason for Flow
// traffic. This Set is the canonical source of truth for content-policy
// reason codes — new reasons land here first because the extension sits
// closest to the live wire. The server-side mirror at
// `src/lib/flow-error-classify.ts:CONTENT_POLICY_REASONS` MUST be kept
// in sync with it; the divergence test in
// `__tests__/unit/lib/flow-error-classify.test.ts` fails loudly when
// they drift. Extend this Set first, then propagate to the server.
const FLOW_CONTENT_POLICY_REASONS = new Set([
  'CHILD_DANGER',
  'SAFETY',
  'PERSON_GENERATION',
  'VIOLENCE',
  'ADULT',
  'PROFANITY',
  'CONTENT_POLICY_VIOLATION',
  'POLICY_VIOLATION',
  'PROHIBITED_CONTENT',
  'BLOCKED_REASON_SAFETY',
  'PUBLIC_ERROR_PROMINENT_PEOPLE_FILTER_FAILED',
  'PUBLIC_ERROR_SAFETY_FILTER_FAILED',
  'PUBLIC_ERROR_CHILD_FILTER_FAILED',
  'PUBLIC_ERROR_DANGER_FILTER',
  'PUBLIC_ERROR_AUDIO_FILTERED',
]);

// Pattern for the broader PUBLIC_ERROR_*_FILTER* family — Google keeps
// adding filter variants we haven't enumerated, in three observed
// suffix shapes: `_FILTER` (PUBLIC_ERROR_DANGER_FILTER), `_FILTERED`
// (PUBLIC_ERROR_AUDIO_FILTERED — Veo 3 audio safety), and the older
// `_FILTER_FAILED` (PUBLIC_ERROR_SAFETY_FILTER_FAILED). Excludes
// PUBLIC_ERROR_QUOTA / PUBLIC_ERROR_UNUSUAL_ACTIVITY which the backend
// route.ts:55-69 already classifies elsewhere.
const FLOW_CONTENT_POLICY_PATTERNS = [
  /^PUBLIC_ERROR_[A-Z_]+_FILTER(?:ED|_FAILED)?$/,
];

function isContentPolicyReason(reason) {
  if (!reason || typeof reason !== 'string') return false;
  if (FLOW_CONTENT_POLICY_REASONS.has(reason)) return true;
  return FLOW_CONTENT_POLICY_PATTERNS.some((re) => re.test(reason));
}

// Scans `text` for any documented content-policy reason and returns the
// first match. Used for failure messages that embed the reason in
// `error.message` rather than `error.details[].reason` (some Google
// Flow failure paths surface only the message string).
function findContentPolicyReasonInString(text) {
  if (!text || typeof text !== 'string') return null;
  for (const r of FLOW_CONTENT_POLICY_REASONS) {
    if (text.includes(r)) return r;
  }
  for (const re of FLOW_CONTENT_POLICY_PATTERNS) {
    const m = text.match(new RegExp(re.source.replace(/^\^|\$$/g, ''), 'g'));
    if (m && m.length > 0) return m[0];
  }
  return null;
}

function _parseRetryAfter(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return null;
}

function _coerceBody(body) {
  if (body == null) return { parsed: null, text: '' };
  if (typeof body === 'string') {
    const text = body;
    try {
      return { parsed: JSON.parse(text), text };
    } catch (_e) {
      return { parsed: null, text };
    }
  }
  if (typeof body === 'object') {
    let text = '';
    try { text = JSON.stringify(body); } catch (_e) { text = ''; }
    return { parsed: body, text };
  }
  return { parsed: null, text: String(body) };
}

function _categorize(reason, httpStatus) {
  if (reason && isContentPolicyReason(reason)) return 'content_policy';
  if (reason === 'UNAUTHENTICATED' || httpStatus === 401) return 'auth';
  if (reason === 'PERMISSION_DENIED' || httpStatus === 403) return 'auth';
  if (reason === 'RESOURCE_EXHAUSTED' || httpStatus === 429) return 'rate_limit';
  if (reason === 'QUOTA_EXCEEDED') return 'quota';
  if (reason === 'PUBLIC_ERROR_HIGH_TRAFFIC') return 'service_overload';
  if (reason === 'INVALID_ARGUMENT' || (httpStatus === 400 && !reason)) return 'invalid_argument';
  if (reason === 'NOT_FOUND' || httpStatus === 404) return 'not_found';
  if (reason === 'FAILED_PRECONDITION') return 'invalid_argument';
  if (typeof httpStatus === 'number' && httpStatus >= 500 && httpStatus <= 599) return 'transient';
  if (reason === 'UNAVAILABLE' || reason === 'DEADLINE_EXCEEDED' || reason === 'INTERNAL') {
    return 'transient';
  }
  return 'unknown';
}

// Google's anti-abuse / "Sorry..." page is served with HTTP 403 + an HTML
// body (no JSON envelope) when their heuristics flag unusual activity —
// CAPTCHA gate, automated-traffic warning, etc. The user is still
// authenticated and the request started fine; treating this as `auth`
// (the default for bare 403s) is wrong because:
//   1. poll-video.js's catch block only re-throws `rate_limit`, so `auth`
//      gets swallowed and the poller spins for the full attempts budget,
//      then surfaces a generic "timed out" error with no category — by
//      which point HistForge has lost the signal and falls back to
//      `transient`, exhausting retry_count for nothing.
//   2. HistForge's `auth` branch is for session-expired flips
//      (relogin_needed) which doesn't apply here.
// Classifying as `rate_limit` ends the poll loop promptly, arms the SW's
// rate-limit cool-off, and routes through HistForge's account-cooldown +
// requeue path (no retry_count bump).
function _isGoogleAntiAbusePage(text) {
  if (!text || typeof text !== 'string') return false;
  return /<title>\s*Sorry\.{0,3}\s*<\/title>/i.test(text)
    || /unusual traffic from your computer network/i.test(text)
    || /our systems have detected unusual traffic/i.test(text);
}

function _isRetryable(category) {
  return category === 'transient' || category === 'rate_limit' || category === 'quota';
}

function parseFlowApiError(response, body) {
  const httpStatus = (response && typeof response.status === 'number') ? response.status : null;
  const { parsed, text } = _coerceBody(body);

  let reason = null;
  let message = '';
  let errorCode = null;

  if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
    const errInfo = parsed.error;
    if (typeof errInfo.message === 'string') message = errInfo.message;
    if (typeof errInfo.code === 'number') errorCode = errInfo.code;
    const details = Array.isArray(errInfo.details) ? errInfo.details : [];
    for (const d of details) {
      if (d && typeof d.reason === 'string' && d.reason) {
        reason = d.reason;
        break;
      }
    }
    if (!reason && typeof errInfo.status === 'string' && errInfo.status) {
      reason = errInfo.status;
    }
  } else if (text) {
    message = text.length > 500 ? text.slice(0, 500) : text;
  }

  const isSessionExpired = (httpStatus === 401) || (reason === 'UNAUTHENTICATED');
  let category = _categorize(reason, httpStatus);
  // Override before _isRetryable: a 403 whose body is the HTML anti-abuse
  // page (no JSON envelope, hence `parsed` is null) is not auth — see
  // _isGoogleAntiAbusePage above.
  if (httpStatus === 403 && !parsed && _isGoogleAntiAbusePage(text)) {
    category = 'rate_limit';
  }
  const retryable = _isRetryable(category);
  const contentPolicyTag = (category === 'content_policy') ? reason : null;
  const isContentPolicy = category === 'content_policy';

  let retryAfterMs = null;
  if (response && response.headers && typeof response.headers.get === 'function') {
    retryAfterMs = _parseRetryAfter(response.headers.get('retry-after'));
  }

  return {
    reason: reason || (httpStatus ? `HTTP_${httpStatus}` : 'UNKNOWN'),
    httpStatus,
    errorCode,
    message,
    category,
    retryable,
    isContentPolicy,
    contentPolicyTag,
    retryAfterMs,
    isSessionExpired,
  };
}

// Sanctioned throw site for Flow API errors. Builds the Error via
// makeFlowApiError, fires triggerRateLimitCooldown *before* throwing
// when parsed.category is 'rate_limit', and then throws. Arming
// pre-throw is the contract: downstream retryWithBackoff loops read
// pauseReason via shouldRetry's rate_limit skip, so the next retry
// won't hammer the same 429 endpoint.
//
// Most callers go through throwFromResponse (below) so parseFlowApiError
// + the stale-project-id 404 override + contextLabel message shaping
// are funneled through one path. Direct callers of throwFlowApiError
// only exist for synthesized errors with no HTTP response in hand
// (e.g. JSON-shape failures inside project-mgmt). Use makeFlowApiError
// directly for non-HTTP synthesized errors that must NOT trigger a
// cool-off (e.g. sessionExpiredError).
async function throwFlowApiError(parsed) {
  const err = makeFlowApiError(parsed);
  if (parsed && parsed.category === 'rate_limit') {
    try { await triggerRateLimitCooldown(err); } catch (_e) { /* advisory */ }
  }
  throw err;
}

// Single funnel for "I have a status, body, and retry-after string —
// classify and throw." Used by callers (project-mgmt's createProject
// rungs, future page-call paths) where the underlying fetch happened in
// a MAIN-world script and what the SW receives is a serialized
// {status, body, retryAfter} blob — not a real Response. Synthesizes
// the Response shape parseFlowApiError needs, applies the same
// stale-project-id 404 override that flow-api.js:_throwFlowApiError and
// page-call.js:apiCallViaPage use, and routes through throwFlowApiError
// so the rate-limit cool-off is armed before the throw.
//
// categoryOverride exists because parseFlowApiError's classification
// doesn't always match what the call site needs: createProject's 4xx
// rung (Issue #5 / Phase 2 of the SOLID plan) wants
// 'create_project_failed' instead of parseFlowApiError's
// 'invalid_argument' default — that distinction is what HistForge's
// classifier branches on to flag the account.
//
// Message shape: when contextLabel is set, the final error.message is
// always prefixed with `${contextLabel} HTTP ${status}: ` (or
// `SESSION_EXPIRED: ${contextLabel}` when the parser flagged
// isSessionExpired). The body's parsed message is preserved as the
// suffix when present, falling back to the truncated raw body. This
// keeps logs identifying which call site failed even when Google's
// envelope already provided a message.
async function throwFromResponse({
  httpStatus,
  body,
  retryAfterHeader,
  contextLabel,
  urlForStaleProjectCheck,
  categoryOverride,
}) {
  const fakeResponse = {
    status: httpStatus,
    headers: {
      get: (name) => (
        name && name.toLowerCase() === 'retry-after'
          ? (retryAfterHeader || null)
          : null
      ),
    },
  };
  const parsed = parseFlowApiError(fakeResponse, body);

  if (parsed.httpStatus === 404
      && typeof urlForStaleProjectCheck === 'string'
      && /\/projects\/[^/]+\//.test(urlForStaleProjectCheck)) {
    parsed.category = 'stale_project_id';
  }

  if (typeof categoryOverride === 'string' && categoryOverride) {
    parsed.category = categoryOverride;
  }

  const bodyStr = typeof body === 'string' ? body : '';
  const truncated = bodyStr.length > 500 ? bodyStr.slice(0, 500) : bodyStr;
  const label = contextLabel || 'request';
  if (parsed.isSessionExpired) {
    parsed.message = `SESSION_EXPIRED: ${label}`;
  } else {
    const detail = parsed.message || truncated;
    parsed.message = `${label} HTTP ${httpStatus}: ${detail}`;
  }

  await throwFlowApiError(parsed);
}

// Thrown by the image executor when characterLockReference is set but
// not a valid Flow media ID (UUID 8-4-4-4-12 lowercase hex). Defensive
// — the popup validates before persisting, so a bad value reaching the
// executor implies storage corruption or a direct chrome.storage.local
// write that bypassed the popup. Fails the task loudly rather than
// silently dropping the lock.
function makeBadCharacterLockError(value) {
  const err = new Error(
    `Character lock reference is malformed: expected UUID (8-4-4-4-12 hex), got "${value}"`,
  );
  err.code = 'BAD_CHARACTER_LOCK';
  err.reason = 'BAD_CHARACTER_LOCK';
  err.category = 'invalid_argument';
  err.value = value;
  err.retryable = false;
  return err;
}

function makeFlowApiError(parsed) {
  const p = parsed || {};
  const reason = p.reason || 'UNKNOWN';
  const category = p.category || 'unknown';
  const httpStatus = (typeof p.httpStatus === 'number') ? p.httpStatus : null;
  const messageBase = p.message || `${reason}${httpStatus ? ` (${httpStatus})` : ''}`;

  const err = new Error(messageBase);
  err.reason = reason;
  err.category = category;
  err.httpStatus = httpStatus;
  err.errorCode = (typeof p.errorCode === 'number') ? p.errorCode : null;
  err.retryable = (typeof p.retryable === 'boolean') ? p.retryable : _isRetryable(category);
  err.isContentPolicy = (typeof p.isContentPolicy === 'boolean')
    ? p.isContentPolicy
    : (category === 'content_policy');
  err.contentPolicyTag = p.contentPolicyTag || (err.isContentPolicy ? reason : null);
  err.retryAfterMs = (typeof p.retryAfterMs === 'number') ? p.retryAfterMs : null;
  err.isSessionExpired = (typeof p.isSessionExpired === 'boolean')
    ? p.isSessionExpired
    : false;
  return err;
}
