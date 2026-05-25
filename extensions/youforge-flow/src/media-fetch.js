// YouForge Flow - media payload fetcher
// Resolves a task's resultUrl (which may be an HTTP URL, a
// comma-separated list, or an inline `data:` URL) into HistForge-shaped
// `MediaFile[]` entries: { base64, mimeType, size, originalUrl }.
//
// HTTP URLs are fetched from the Flow tab's MAIN world so Google's
// session cookies follow the request — the background worker can't see
// them from its own fetch. Data URLs are decoded inline without any
// network round-trip (they come from the image-upscale path).
//
// Decomposition: decodeDataUrl parses a single inline data: URL into a
// MediaFile; fetchOneMediaViaPage does a single-attempt MAIN-world fetch
// of one HTTP URL; fetchMediaFiles orchestrates URL splitting, the
// data/http branch, and the 3-retry loop with stop-flag re-checks.
//
// Runtime deps (resolved at call time): getStopFlag (src/stop-flag.js),
// safeLog (src/logger.js).

// Splits `resultUrl` on commas while preserving data: URL payloads
// (which themselves contain a literal comma between the media type and
// the base64 body).
function _splitResultUrls(resultUrl) {
  const rawParts = (resultUrl || '').split(',');
  const urls = [];
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i];
    if (part.startsWith('http')) {
      urls.push(part);
      continue;
    }
    if (part.startsWith('data:')) {
      const next = rawParts[i + 1];
      if (next !== undefined && !next.startsWith('http') && !next.startsWith('data:')) {
        urls.push(part + ',' + next);
        i++;
      } else {
        urls.push(part);
      }
    }
  }
  return urls;
}

// Background-worker fetch + base64 encode for an arbitrary image URL.
// Used by content scripts (via the `fetchImage` message) when they need
// an image but Google cookies would block a direct page-context fetch.
async function fetchImageAsBase64(imageUrl) {
  try {
    safeLog('Background fetching image:', imageUrl);
    const timeoutMs = getMediaFetchTimeoutSec() * 1000;
    const response = await fetchWithTimeout(imageUrl, undefined, timeoutMs);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const blob = await response.blob();
    const reader = new FileReader();
    return new Promise((resolve) => {
      reader.onloadend = () => {
        safeLog('Image fetched successfully, size:', blob.size);
        resolve({
          success: true,
          base64: reader.result,
          type: blob.type,
          size: blob.size,
        });
      };
      reader.onerror = () => {
        safeLog('FileReader error');
        resolve({ success: false, error: 'FileReader error' });
      };
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    safeLog('Background fetch error:', error);
    return { success: false, error: error.message };
  }
}

// Decode an inline `data:` URL into a MediaFile entry. Throws if the URL
// is malformed (missing comma or mime header).
function decodeDataUrl(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mimeType = header.split(':')[1].split(';')[0];
  const size = Math.round(b64.length * 3 / 4);
  return { base64: b64, mimeType, size, originalUrl: '(upscaled-image)' };
}

// MAIN-world function executed in the Flow tab to fetch a URL with the
// tab's session cookies, size-guard the response, and base64-encode it.
// Must be self-contained — executeScript stringifies it across worlds.
async function _mainWorldFetchAsBase64(mediaUrl) {
  try {
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      return { error: `HTTP ${response.status} ${response.statusText}` };
    }
    const blob = await response.blob();
    if (blob.size > 50 * 1024 * 1024) {
      return { error: `Too large: ${(blob.size / 1024 / 1024).toFixed(1)}MB` };
    }
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve({
        base64: reader.result.split(',')[1],
        mimeType: blob.type || 'application/octet-stream',
        size: blob.size,
      });
      reader.onerror = () => resolve({ error: 'FileReader failed' });
      reader.readAsDataURL(blob);
    });
  } catch (e) {
    return { error: e.message || 'Unknown fetch error' };
  }
}

// Single-attempt fetch of one HTTP media URL via the Flow tab's MAIN
// world. Returns a MediaFile on success, throws on failure. Errors
// originating from the MAIN-world function (HTTP, size-guard, FileReader)
// are tagged with `.mainWorldError = true` so the caller can distinguish
// them from executeScript-level throws (tab gone, worker race, etc.).
// The 3-retry arithmetic lives in fetchMediaFiles.
async function fetchOneMediaViaPage(tabId, url) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: _mainWorldFetchAsBase64,
    args: [url],
  });
  const mediaData = results?.[0]?.result;
  if (mediaData && mediaData.base64) {
    return {
      base64: mediaData.base64,
      mimeType: mediaData.mimeType,
      size: mediaData.size,
      originalUrl: url,
    };
  }
  const err = new Error(mediaData?.error || 'unknown');
  err.mainWorldError = true;
  throw err;
}

async function fetchMediaFiles(resultUrl) {
  const mediaFiles = [];
  try {
    const tabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
    if (tabs.length === 0) {
      safeLog('No Flow tab for media fetch');
      return mediaFiles;
    }

    const urls = _splitResultUrls(resultUrl);
    safeLog(`[media] Fetching ${urls.length} media file(s) as base64 (MAIN world)...`);

    for (const url of urls) {
      if (url.startsWith('data:')) {
        try {
          const mf = decodeDataUrl(url);
          mediaFiles.push(mf);
          safeLog(`[media] ✓ Upscaled image from data URL: ${(mf.size / 1024).toFixed(0)}KB (${mf.mimeType})`);
        } catch (e) {
          safeLog('Failed to parse data URL:', e.message);
        }
        continue;
      }

      try {
        const mf = await retryWithBackoff(async (attempt) => {
          if (getStopFlag()) throw new Error('STOP_REQUESTED');
          const freshTabs = await chrome.tabs.query({ url: 'https://labs.google/*' });
          if (freshTabs.length === 0) {
            const noTab = new Error('No Flow tab for media fetch');
            noTab.noTab = true;
            throw noTab;
          }
          if (attempt > 0) safeLog(`[media] Media fetch retry ${attempt + 1}/4`);
          return await fetchOneMediaViaPage(freshTabs[0].id, url);
        }, {
          retries: 3,
          baseMs: 3000,
          capMs: 15000,
          jitter: true,
          shouldRetry: (e) => {
            if (!e) return false;
            if (e.noTab) return false;
            // 4xx (except 429) is a clear client error — don't retry.
            if (e.mainWorldError && /HTTP 4(?!29)\d\d/.test(e.message || '')) return false;
            return true;
          },
        });
        mediaFiles.push(mf);
        safeLog(`[media] ✓ Fetched media: ${(mf.size / 1024).toFixed(0)}KB (${mf.mimeType})`);
      } catch (e) {
        if (e && e.message === 'STOP_REQUESTED') break;
        if (e && e.noTab) {
          safeLog('No Flow tab for media fetch');
          break;
        }
        safeLog(`[media] ⚠ Media fetch failed: ${e.message}`);
      }
    }
  } catch (e) {
    safeLog('Could not fetch media:', e.message);
  }
  return mediaFiles;
}
