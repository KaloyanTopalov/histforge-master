// YouForge Flow - page-context API helpers
// Pure helpers extracted from the closures that used to live inside
// executeTaskViaAPI. Callers pass tabId/authToken/projectId explicitly
// (no hidden closure state), so executors become plain top-level modules.
//
// Why MAIN-world: reCAPTCHA tokens minted by the labs.google page must
// be consumed from the same execution world that generated them — the
// service-worker fetch API can't see those tokens. executeScript with
// world:'MAIN' is the only cross-origin-safe bridge we have.
//
// Runtime deps (resolved at call time): safeLog (src/logger.js),
// assertNotStopped (src/stop-flag.js), throwFromResponse (src/flow-error.js
// — both error branches route through it so parseFlowApiError + the
// stale-project-id 404 override + the rate-limit cool-off arming are
// funneled through one path), buildClientContext (src/client-context.js
// — loaded AFTER page-call in the importScripts chain, which is safe
// because uploadImageViaPage is never called at module-parse time; the
// reference resolves when the executor invokes it), sessionExpiredError
// (flow-api.js — same forward-ref rule: loaded after page-call, consumed
// at call time).

// MIME magic-byte signatures (Phase 2 task 2.7). Read the first 12 bytes
// of a blob and match against well-known image headers; default to
// image/jpeg when no signature matches. The 12-byte slice is enough for
// every signature we recognize today (WEBP needs bytes 0-3 = "RIFF" and
// 8-11 = "WEBP").
async function _detectMimeFromMagicBytes(blob) {
  try {
    const head = blob.slice ? blob.slice(0, 12) : blob;
    const buf = await head.arrayBuffer();
    const b = new Uint8Array(buf);
    if (b.length >= 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47 &&
      b[4] === 0x0D && b[5] === 0x0A && b[6] === 0x1A && b[7] === 0x0A) {
      return 'image/png';
    }
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) {
      return 'image/jpeg';
    }
    if (b.length >= 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) {
      return 'image/webp';
    }
    if (b.length >= 6 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
      (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61) {
      return 'image/gif';
    }
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) {
      return 'image/bmp';
    }
  } catch (_e) { /* fall through */ }
  return 'image/jpeg';
}

// MAIN-world fetch: POSTs `body` to `url` with Bearer auth. Returns parsed
// JSON on success. On any non-ok status the MAIN-world func returns
// { error: humanString, status, body, retryAfter }; the SW then runs
// parseFlowApiError so the thrown error carries reason/category/httpStatus/
// isSessionExpired (see docs/plans/2026-04-24-youforge-flow-flow2api-improvements.md
// task 1.1). Older builds returned only { error: humanString }; that
// shape still works — we fall back to a plain Error.
async function apiCallViaPage({ tabId, authToken, url, body }) {
  assertNotStopped();
  safeLog('Executing API call via page context:', url.substring(url.lastIndexOf('/') + 1));
  const _vStart = Date.now();
  let bodySize = 0;
  try { bodySize = JSON.stringify(body).length; } catch (_e) { bodySize = 0; }
  verboseLog('apiCallViaPage →', url, 'body:', bodySize, 'bytes');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    world: 'MAIN',
    func: async (apiUrl, reqBody, bearer) => {
      try {
        const resp = await fetch(apiUrl, {
          method: 'POST',
          headers: {
            'content-type': 'text/plain;charset=UTF-8',
            'authorization': `Bearer ${bearer}`
          },
          body: JSON.stringify(reqBody)
        });
        const text = await resp.text();
        if (!resp.ok) {
          return {
            error: `${resp.status}: ${text.substring(0, 500)}`,
            status: resp.status,
            body: text,
            retryAfter: resp.headers && typeof resp.headers.get === 'function'
              ? resp.headers.get('retry-after')
              : null,
          };
        }
        return { data: JSON.parse(text) };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [url, body, authToken]
  });
  const result = results?.[0]?.result;
  const _vStatus = result?.status || (result?.error ? 'err' : 'ok');
  verboseLog('apiCallViaPage ←', url, 'status:', _vStatus, 'duration:', (Date.now() - _vStart) + 'ms');
  if (result?.error) {
    if (typeof result.status === 'number') {
      // throwFromResponse owns the parse + stale-project-id 404 override
      // (HistForge's submit-result classifier branches on stale_project_id
      // to wipe the (video, account) row and requeue) + cool-off arming.
      await throwFromResponse({
        httpStatus: result.status,
        body: result.body,
        retryAfterHeader: result.retryAfter,
        contextLabel: url,
        urlForStaleProjectCheck: url,
      });
    }
    throw new Error(result.error);
  }
  return result.data;
}

// Upload an image to the Flow API:
//   1. Background fetches `imageUrl` (no CORS issues from here).
//   2. Convert to base64.
//   3. POST with imageBytes + filename to flow/uploadImage.
// Returns the `media.name` identifier.
async function uploadImageViaPage({ tabId, authToken, projectId, imageUrl, filename }) {
  assertNotStopped();
  safeLog('Downloading image in background:', imageUrl?.substring(0, 80));
  const _vStart = Date.now();
  verboseLog('uploadImageViaPage → fetching:', imageUrl);

  // Wrap the whole download → base64 → upload sequence in retryWithBackoff.
  // Documented trade-off (plan task 2.3): retrying re-downloads the source
  // image, which is cheaper than threading retry state through the inner
  // base64 step. retries: 2 → 3 attempts max; baseMs: 500, capMs: 5000.
  return await retryWithBackoff(async (attempt) => {
    assertNotStopped();
    if (attempt > 0) safeLog(`[upload] Retrying upload (attempt ${attempt + 1}/3)`);

    // Step 1: Fetch image in background worker
    const imgFetchTimeoutMs = getMediaFetchTimeoutSec() * 1000;
    const imgResponse = await fetchWithTimeout(imageUrl, undefined, imgFetchTimeoutMs);
    if (!imgResponse.ok) {
      const e = new Error(`Image download failed: HTTP ${imgResponse.status}`);
      e.httpStatus = imgResponse.status;
      // Mark transient (5xx) as retryable so shouldRetry picks it up; 4xx
      // (except 429) is treated as permanent and bubbles up.
      if (imgResponse.status >= 500 || imgResponse.status === 429) {
        e.retryable = true;
      }
      throw e;
    }
    const imgBlob = await imgResponse.blob();
    // MIME magic-byte fallback (Phase 2 task 2.7). When blob.type is empty,
    // generic (`application/octet-stream`), or wrong (`text/html` from a
    // misconfigured CDN), sniff the first 12 bytes against known image
    // signatures. Defaults to image/jpeg if no signature matches.
    const reportedType = imgBlob.type || '';
    const looksValid = /^image\/(png|jpeg|jpg|webp|gif|bmp)$/i.test(reportedType);
    let mimeType;
    if (looksValid) {
      mimeType = reportedType;
    } else {
      mimeType = await _detectMimeFromMagicBytes(imgBlob);
      safeLog('MIME magic-byte fallback: reported=' + (reportedType || 'empty') + ' detected=' + mimeType);
    }
    safeLog('Image downloaded:', imgBlob.size, 'bytes, type:', mimeType);

    // Step 2: Convert to base64
    const arrayBuffer = await imgBlob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    let binary = '';
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i]);
    }
    const base64 = btoa(binary);
    safeLog('Image converted to base64, length:', base64.length);

    // Step 3: Upload via JSON body (HAR shows this is the correct format)
    const uploadBody = {
      clientContext: buildClientContext({ projectId }),
      imageBytes: base64,
      isUserUploaded: true,
      isHidden: false,
      mimeType: mimeType,
      fileName: filename
    };

    const uploadTimeoutMs = getUploadTimeoutSec() * 1000;
    const uploadResp = await fetchWithTimeout('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
      method: 'POST',
      headers: {
        'authorization': `Bearer ${authToken}`,
        'content-type': 'text/plain;charset=UTF-8',
        'origin': 'https://labs.google',
        'referer': 'https://labs.google/'
      },
      body: JSON.stringify(uploadBody)
    }, uploadTimeoutMs);

    if (!uploadResp.ok) {
      let errText = '';
      try { errText = await uploadResp.text(); } catch (_e) { errText = ''; }
      const retryAfter = (uploadResp.headers && typeof uploadResp.headers.get === 'function')
        ? uploadResp.headers.get('retry-after')
        : null;
      // throwFromResponse arms the rate-limit cool-off before throwing,
      // so the wrapping retryWithBackoff's shouldRetry sees the
      // rate_limit category and skips — otherwise the next 2 retries
      // would hammer the same 429 endpoint. The uploadImage URL is not
      // a /projects/<id>/... path, so urlForStaleProjectCheck is omitted.
      await throwFromResponse({
        httpStatus: uploadResp.status,
        body: errText,
        retryAfterHeader: retryAfter,
        contextLabel: 'uploadImage',
      });
    }

    const result = await uploadResp.json();
    const mediaId = result.media?.name;
    safeLog('Image uploaded, mediaId:', mediaId, 'raw:', JSON.stringify(result).substring(0, 200));
    verboseLog('uploadImageViaPage ←', 'status:', uploadResp.status, 'duration:', (Date.now() - _vStart) + 'ms');
    return mediaId;
  }, {
    retries: getUploadMaxRetries(),
    baseMs: 500,
    capMs: 5000,
    jitter: true,
    // Default shouldRetry reads err.retryable, which makeFlowApiError sets
    // for upload-side 5xx/429 and which we set on the download error above.
    // TIMEOUT errors from fetchWithTimeout are also retried. Phase 3 fix #1:
    // skip rate_limit retries — the throw branch above already armed the
    // cooldown and the next retry would hit the same 429.
    shouldRetry: (e) => !!e && (
      (e.retryable === true && e.category !== 'rate_limit') ||
      (typeof e.message === 'string' && e.message.startsWith('TIMEOUT:'))
    ),
  });
}
