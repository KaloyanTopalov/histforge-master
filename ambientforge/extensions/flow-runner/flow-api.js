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
// distinguish session expiry from generic 4xx/5xx errors.
function sessionExpiredError(endpoint) {
  const err = new Error(`SESSION_EXPIRED: ${endpoint}`);
  err.isSessionExpired = true;
  return err;
}

// ============================================================
// VIDEO STATUS POLLING
// Endpoint: video:batchCheckAsyncVideoGenerationStatus
// States: MEDIA_GENERATION_STATUS_PENDING / _SUCCESSFUL / _FAILED
// ============================================================

async function checkVideoStatus(authToken, mediaIds) {
  const url = `${AISANDBOX_BASE}/video:batchCheckAsyncVideoGenerationStatus`;
  const response = await fetch(url, {
    method: 'POST',
    headers: apiHeaders(authToken),
    body: JSON.stringify({ media: mediaIds })
  });

  if (response.status === 401) throw sessionExpiredError(url);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Video status check failed (${response.status}): ${errorText.substring(0, 300)}`);
  }

  const result = await response.json();

  // Log raw response on first successful result to find URL location
  const rawStr = JSON.stringify(result);
  if (rawStr.includes('SUCCESSFUL')) {
    safeLog('Video status raw (SUCCESSFUL):', rawStr.substring(0, 1500));
  }

  return (result.media || []).map(m => {
    const video = m.video || {};
    const gen = video.generatedVideo || {};
    const meta = m.mediaMetadata || {};
    const status = meta.mediaStatus?.mediaGenerationStatus || 'UNKNOWN';

    // Try multiple paths for the URL
    const url = gen.fifeUrl
      || gen.videoUrl
      || gen.url
      || video.fifeUrl
      || m.fifeUrl
      || null;

    // Also try to build URL from media name using getMediaUrlRedirect
    const mediaName = m.name;

    return {
      name: mediaName,
      state: status,
      url: url,
      seed: gen.seed,
      model: gen.model,
      hasAudio: gen.hasAudio || false,
      error: meta.mediaStatus?.error || null,
      failureReasons: meta.mediaStatus?.failureReasons || [],
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
  const response = await fetch(url, { headers: apiHeaders(authToken) });
  if (response.status === 401) throw sessionExpiredError(url);
  if (!response.ok) return null;
  const result = await response.json();
  return { credits: result.credits, tier: result.userPaygateTier, sku: result.sku, serviceTier: result.serviceTier };
}
