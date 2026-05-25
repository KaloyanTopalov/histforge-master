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
// assertNotStopped (src/stop-flag.js), buildClientContext
// (src/client-context.js — loaded AFTER page-call in the importScripts
// chain, which is safe because uploadImageViaPage is never called at
// module-parse time; the reference resolves when the executor invokes it),
// sessionExpiredError (flow-api.js — same forward-ref rule: loaded after
// page-call, consumed at call time).

// MAIN-world fetch: POSTs `body` to `url` with Bearer auth. Returns parsed
// JSON on success. On HTTP 401, throws a session-expired error so the
// session-guard wrapper halts polling and notifies HistForge (same
// contract as flow-api.js:checkVideoStatus / getCredits). Any other
// non-ok status throws a plain `${status}: ${body}` Error.
async function apiCallViaPage({ tabId, authToken, url, body }) {
  assertNotStopped();
  safeLog('Executing API call via page context:', url.substring(url.lastIndexOf('/') + 1));
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
          return { error: `${resp.status}: ${text.substring(0, 500)}`, status: resp.status };
        }
        return { data: JSON.parse(text) };
      } catch (e) {
        return { error: e.message };
      }
    },
    args: [url, body, authToken]
  });
  const result = results?.[0]?.result;
  if (result?.status === 401) {
    throw sessionExpiredError(url);
  }
  if (result?.error) {
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

  // Step 1: Fetch image in background worker
  const imgResponse = await fetch(imageUrl);
  if (!imgResponse.ok) {
    throw new Error(`Image download failed: ${imgResponse.status}`);
  }
  const imgBlob = await imgResponse.blob();
  const mimeType = imgBlob.type || 'image/png';
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

  const uploadResp = await fetch('https://aisandbox-pa.googleapis.com/v1/flow/uploadImage', {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${authToken}`,
      'content-type': 'text/plain;charset=UTF-8',
      'origin': 'https://labs.google',
      'referer': 'https://labs.google/'
    },
    body: JSON.stringify(uploadBody)
  });

  if (!uploadResp.ok) {
    const errText = await uploadResp.text();
    throw new Error(`Upload failed (${uploadResp.status}): ${errText.substring(0, 300)}`);
  }

  const result = await uploadResp.json();
  const mediaId = result.media?.name;
  safeLog('Image uploaded, mediaId:', mediaId, 'raw:', JSON.stringify(result).substring(0, 200));
  return mediaId;
}
