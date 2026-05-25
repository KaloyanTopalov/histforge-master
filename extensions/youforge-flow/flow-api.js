// YouForge Flow - Google Flow API Wrapper
// Based on click-tracker recon data (2026-03-15)
// All direct API calls to aisandbox-pa.googleapis.com

const AISANDBOX_BASE = 'https://aisandbox-pa.googleapis.com/v1';

function apiHeaders(authToken) {
  return {
    'authorization': `Bearer ${authToken}`,
    'content-type': 'text/plain;charset=UTF-8',
    'origin': 'https://labs.google',
    'referer': 'https://labs.google/'
  };
}

// Raised when a Flow API call returns 401 — caller uses the flag to
// distinguish session expiry from generic 4xx/5xx errors. Kept for
// callers that synthesize a session-expired error without an HTTP
// response in hand (e.g. trpc helpers in src/auth.js).
function sessionExpiredError(endpoint) {
  return makeFlowApiError({
    reason: 'UNAUTHENTICATED',
    category: 'auth',
    message: `SESSION_EXPIRED: ${endpoint}`,
    httpStatus: 401,
    isSessionExpired: true,
  });
}

// Real-Response adapter for throwFromResponse: reads the body and
// retry-after header off the Response object and delegates to the
// shared funnel. The stale-project-id 404 override and contextLabel
// message shaping live in throwFromResponse so all three call sites
// (this, page-call.js, project-mgmt.js) produce uniform errors.
async function _throwFlowApiError(response, contextLabel) {
  let bodyText = '';
  try { bodyText = await response.text(); } catch (_e) { bodyText = ''; }
  const retryAfter = (response && response.headers && typeof response.headers.get === 'function')
    ? response.headers.get('retry-after')
    : null;
  const reqUrl = (response && typeof response.url === 'string') ? response.url : '';
  await throwFromResponse({
    httpStatus: response.status,
    body: bodyText,
    retryAfterHeader: retryAfter,
    contextLabel,
    urlForStaleProjectCheck: reqUrl,
  });
}

// ============================================================
// VIDEO STATUS POLLING
// Endpoint: video:batchCheckAsyncVideoGenerationStatus
// States: MEDIA_GENERATION_STATUS_PENDING / _SUCCESSFUL / _FAILED
// ============================================================

async function checkVideoStatus(authToken, mediaIds, tabId) {
  const url = `${AISANDBOX_BASE}/video:batchCheckAsyncVideoGenerationStatus`;
  const _vStart = Date.now();

  // Operations-shape request body. Recon from extensions/flow2api
  // (src/services/flow_client.py:1853 and generation_handler.py:1717-1721)
  // shows Google embeds the result URL at
  // operations[].operation.metadata.video.fifeUrl when polled with
  // {operations:[{operation:{name}}]}. The legacy {media:[{name,projectId}]}
  // shape stopped populating any URL field around 2026-04 — the same
  // endpoint silently returns a different response shape based on which
  // request key is used. sceneId/status are optional; name alone suffices.
  const operations = (mediaIds || []).map((m) => ({
    operation: { name: m.name }
  }));
  const body = { operations };

  // Route through MAIN-world page-call when a tabId is available so the
  // request inherits the labs.google tab's Origin/Referer fingerprint.
  // Plain SW fetch from chrome-extension:// origin can't set Referer
  // (forbidden header per Fetch spec; see commit 18246c5 and the
  // getCredits comment below) — that fingerprint mismatch trips Google's
  // anti-abuse heuristic on this high-frequency endpoint, returning the
  // HTML "Sorry..." 403 that flow-error.js's _isGoogleAntiAbusePage
  // catches. apiCallViaPage owns its own throw funnel
  // (throwFromResponse → cool-off arming) so error semantics match the
  // SW path.
  let result;
  if (tabId != null) {
    result = await apiCallViaPage({ tabId, authToken, url, body });
    verboseLog('checkVideoStatus ← (page)', 'operations:', operations.length,
      'duration:', (Date.now() - _vStart) + 'ms');
  } else {
    const timeoutMs = getVideoRequestTimeoutSec() * 1000;
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: apiHeaders(authToken),
      body: JSON.stringify(body)
    }, timeoutMs);

    verboseLog('checkVideoStatus ←', 'operations:', operations.length, 'status:', response.status,
      'duration:', (Date.now() - _vStart) + 'ms');

    if (!response.ok) {
      await _throwFlowApiError(response, 'Video status check');
    }

    result = await response.json();
  }

  // Diagnostic: keep the SUCCESSFUL dump so we can confirm the URL is now
  // populated (and spot any further upstream drift). Truncated.
  const rawStr = JSON.stringify(result);
  if (rawStr.includes('SUCCESSFUL')) {
    safeLog('Video status raw (SUCCESSFUL):', rawStr.substring(0, 1500));
  }

  return (result.operations || []).map((entry) => {
    const op = entry.operation || {};
    const meta = op.metadata || {};
    const video = meta.video || {};
    // status lives at the top level of each entry in the operations
    // shape; legacy fallbacks kept for resilience.
    const status = entry.status
      || meta.mediaGenerationStatus
      || meta.mediaStatus?.mediaGenerationStatus
      || 'UNKNOWN';

    // URL: primary path is operation.metadata.video.fifeUrl per flow2api
    // recon. Fallbacks cover any future field rename.
    const url = video.fifeUrl
      || video.videoUrl
      || video.url
      || meta.fifeUrl
      || null;

    // Diagnostic only — should now be silent for SUCCESSFUL entries.
    if (status === 'MEDIA_GENERATION_STATUS_SUCCESSFUL' && !url) {
      safeLog(
        '[checkVideoStatus] SUCCESSFUL operation with no URL — name:',
        op.name,
        '\n  keys(operation):', Object.keys(op).join(','),
        '\n  keys(metadata):', Object.keys(meta).join(','),
        '\n  keys(video):', Object.keys(video).join(','),
        '\n  raw entry:', JSON.stringify(entry).substring(0, 1500)
      );
    }

    return {
      name: op.name,
      state: status,
      url: url,
      seed: video.seed,
      model: video.videoModelKey || video.model,
      hasAudio: video.hasAudio || false,
      // Error path: flow2api recon (generation_handler.py:1826) reads
      // operation.error first; we add that as the primary, with metadata
      // and top-level fallbacks. Many MEDIA_GENERATION_STATUS_FAILED
      // entries come back with `{}` — that's a genuine upstream failure
      // with no detail, not a parsing miss.
      error: op.error || meta.error || meta.mediaStatus?.error || entry.error || null,
      failureReasons: meta.failureReasons
        || meta.mediaStatus?.failureReasons
        || op.failureReasons
        || entry.failureReasons
        || [],
      visibility: meta.visibility || null
    };
  });
}


// ============================================================
// CREDITS
// ============================================================

async function getCredits(authToken) {
  // No ?key= param: the key is restricted to labs.google-origin requests
  // via HTTP-Referer rules, and service-worker fetch cannot set Referer
  // (forbidden header per Fetch spec — Chrome strips it). Other
  // aisandbox-pa calls authenticate with bearer-only; try the same here.
  const url = `${AISANDBOX_BASE}/credits`;
  const timeoutMs = getImageRequestTimeoutSec() * 1000;
  const response = await fetchWithTimeout(url, { headers: apiHeaders(authToken) }, timeoutMs);
  if (response.status === 401) {
    await _throwFlowApiError(response, url);
  }
  if (!response.ok) return null;
  const result = await response.json();
  return { credits: result.credits, tier: result.userPaygateTier, sku: result.sku, serviceTier: result.serviceTier };
}
